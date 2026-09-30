import 'dart:async';
import 'dart:math';

import 'canonical.dart';
import 'digest.dart';
import 'schema.dart';
import 'sql_executor.dart';

/// Where a change came from, so apps can skip side effects for changes they
/// did not make (spec §8.2).
enum ChangeOrigin { local, remote, resolution, restore, migration, external }

class ChangeEvent {
  const ChangeEvent({
    required this.collections,
    required this.keys,
    required this.origin,
  });

  final Set<String> collections;
  final Set<DocKey> keys;
  final ChangeOrigin origin;

  @override
  String toString() => 'ChangeEvent($origin, $collections)';
}

/// A reference that does not hold.
class Violation {
  const Violation(this.from, this.to, this.reason);

  final DocKey from;
  final DocKey to;
  final String reason;

  @override
  String toString() =>
      '${from.collection}/${from.id} -> ${to.collection}/${to.id}: $reason';
}

/// A transaction was rolled back because it would leave a reference broken.
/// The application must write cascades explicitly (spec §5.4).
class IntegrityViolation implements Exception {
  IntegrityViolation(this.violations);

  final List<Violation> violations;

  @override
  String toString() => 'IntegrityViolation(${violations.join('; ')})';
}

/// The local database was written by a newer build (downgrade guard).
class LocalSchemaTooNew implements Exception {
  LocalSchemaTooNew(this.stored, this.supported);

  final int stored;
  final int supported;

  @override
  String toString() =>
      'LocalSchemaTooNew: database is at schema $stored, this build supports '
      '$supported.';
}

/// One row of the pending overlay (spec §7.3).
class PendingRow {
  PendingRow({
    required this.key,
    required this.before,
    required this.grp,
    required this.seq,
    this.inflightSeq,
    this.heldUnit,
  });

  final DocKey key;

  /// Canonical value at the base revision; null when the document did not
  /// exist there.
  String? before;
  int grp;
  int seq;
  int? inflightSeq;
  String? heldUnit;
}

/// The revision this device last agreed with, and the digest of that state.
class SyncBase {
  const SyncBase(this.revision, this.digest);

  static final SyncBase none = SyncBase(0, StateDigest.empty);

  final int revision;
  final StateDigest digest;
}

/// A stored conflict entry (spec §13.1).
class ConflictRecord {
  ConflictRecord({
    required this.key,
    required this.unitId,
    required this.ancestor,
    required this.local,
    required this.remote,
    required this.reasons,
    required this.detectedAt,
  });

  final DocKey key;
  String unitId;
  final String? ancestor;
  final String? local;
  String? remote;
  final List<String> reasons;
  final int detectedAt;
}

const String syncLogCollection = 'ent_sync_log';

/// The framework-owned local database (spec §6).
///
/// All access is serialised through one lock, so a transaction never observes
/// another in progress on this connection. Other connections and processes
/// are serialised by SQLite itself; the overlay, groups and counters live in
/// the database and are written in the same transaction as the data, so
/// their writes are journaled correctly too.
class EntanglementStore {
  EntanglementStore._(this._sql, this.schema);

  static Future<EntanglementStore> open(SqlExecutor sql, Schema schema) async {
    final store = EntanglementStore._(sql, schema);
    try {
      await store._initialise();
    } catch (_) {
      await sql.close();
      rethrow;
    }
    return store;
  }

  final SqlExecutor _sql;
  final Schema schema;
  final Map<String, CollectionDef> _defs = {};
  final _lock = _Lock();
  final _changes = StreamController<ChangeEvent>.broadcast(sync: false);
  int? _dataVersion;
  late final String deviceId;

  /// Synced collections that exist in the database but not in this build's
  /// schema: written by a newer build, or since removed from the schema. Kept
  /// and synced untouched so no data is ever dropped.
  final Set<String> _opaque = {};

  /// Opaque collections registered by the transaction in progress, forgotten
  /// again if it rolls back (their tables roll back with it).
  final List<String> _adoptedInTxn = [];

  Stream<ChangeEvent> get changes => _changes.stream;

  CollectionDef def(String name) {
    final def = _defs[name];
    if (def == null) throw ArgumentError('Unknown collection "$name".');
    return def;
  }

  CollectionDef? defOrNull(String name) => _defs[name];

  Iterable<CollectionDef> get syncedCollections =>
      _defs.values.where((def) => def.sync);

  // ---------------------------------------------------------------------------
  // Setup
  // ---------------------------------------------------------------------------

  Future<void> _initialise() async {
    for (final def in schema.collections) {
      _defs[def.name] = def;
    }
    _defs[syncLogCollection] = CollectionDef(
      syncLogCollection,
      indexes: const {'at'},
    );

    await _lock.run(
      () => _sql.transaction(() async {
        for (final statement in _frameworkTables) {
          await _sql.execute(statement);
        }
        for (final def in _defs.values) {
          await _ensureTable(def);
        }
        final device = await _meta('device_id');
        if (device == null) {
          await _setMeta('device_id', newId());
        }
        deviceId = (await _meta('device_id'))!;

        // Synced collections this database has ever held. A table in this set
        // but not in the schema is opaque; one outside it was local-only and is
        // ignored, so it can never leak into the synced state.
        final known = _decodeStringList(await _meta('synced_collections'));
        for (final name in known) {
          if (!_defs.containsKey(name)) {
            _opaque.add(name);
            _defs[name] = CollectionDef.opaque(name);
          }
        }
        final synced = {...known, ..._defs.values.where((d) => d.sync).map((d) => d.name)};
        await _setMeta('synced_collections', canonicalJson(synced.toList()..sort()));
        await _migrateLocalSchema();
      }),
    );
    _dataVersion = await _sql.dataVersion();
  }

  Future<void> _ensureTable(CollectionDef def) async {
    await _sql.execute(
      'CREATE TABLE IF NOT EXISTS "${def.table}" '
      '(id TEXT PRIMARY KEY, doc TEXT NOT NULL)',
    );
    final columns = await _sql.select('PRAGMA table_xinfo("${def.table}")');
    final existing = {
      for (final column in columns)
        if ((column['name']! as String).startsWith('ix_'))
          (column['name']! as String).substring(3),
    };
    for (final field in def.indexes.difference(existing)) {
      await _sql.execute(
        'ALTER TABLE "${def.table}" ADD COLUMN "ix_$field" '
        "GENERATED ALWAYS AS (json_extract(doc, '\$.$field')) VIRTUAL",
      );
      await _sql.execute(
        'CREATE INDEX IF NOT EXISTS "${def.table}__$field" '
        'ON "${def.table}" ("ix_$field")',
      );
    }
    for (final field in existing.difference(def.indexes)) {
      await _sql.execute('DROP INDEX IF EXISTS "${def.table}__$field"');
      await _sql.execute('ALTER TABLE "${def.table}" DROP COLUMN "ix_$field"');
    }
  }

  /// Registers a synced collection first seen in remote data (written by a
  /// newer build). Must run inside a transaction.
  Future<CollectionDef> _adoptOpaque(String name) async {
    final existing = _defs[name];
    if (existing != null) return existing;
    final def = CollectionDef.opaque(name);
    await _ensureTable(def);
    _defs[name] = def;
    _opaque.add(name);
    _adoptedInTxn.add(name);
    final known = _decodeStringList(await _meta('synced_collections'))
      ..add(name);
    await _setMeta('synced_collections', canonicalJson(known.toList()..sort()));
    return def;
  }

  /// Brings stored documents up to [Schema.version] (spec §17.3).
  ///
  /// Current documents and pending `before` values are transformed together,
  /// so the base stays "the head state, in the new shape", and the base digest
  /// is recomputed from that. Nothing is journaled: untouched documents are
  /// not republished.
  Future<void> _migrateLocalSchema() async {
    final storedText = await _meta('local_schema_version');
    if (storedText == null) {
      await _setMeta('local_schema_version', '${schema.version}');
      return;
    }
    final stored = int.parse(storedText);
    if (stored > schema.version) throw LocalSchemaTooNew(stored, schema.version);
    if (stored == schema.version) return;

    final steps = [
      for (var version = stored + 1; version <= schema.version; version++)
        ?schema.migrations[version],
    ];
    if (steps.isNotEmpty) {
      String? migrate(String collection, String? value) {
        if (value == null) return null;
        Json? doc = decodeDocument(value);
        for (final step in steps) {
          if (doc == null) break;
          doc = step(collection, doc);
        }
        return doc == null ? null : canonicalJson(doc);
      }

      for (final def in _defs.values.where((d) => !_opaque.contains(d.name))) {
        if (def.name == syncLogCollection) continue;
        final rows = await _sql.select('SELECT id, doc FROM "${def.table}"');
        for (final row in rows) {
          final key = docKey(def.name, row['id']! as String);
          final next = migrate(def.name, row['doc']! as String);
          await _writeRow(key, next);
        }
      }
      final pending = await _sql.select(
        'SELECT collection, id, before FROM ent_pending',
      );
      for (final row in pending) {
        await _sql.execute(
          'UPDATE ent_pending SET before = ? WHERE collection = ? AND id = ?',
          [
            migrate(row['collection']! as String, row['before'] as String?),
            row['collection'],
            row['id'],
          ],
        );
      }
      final base = await _readBase();
      final baseState = await _baseState();
      await _writeBase(
        SyncBase(
          base.revision,
          StateDigest.of([
            for (final entry in baseState.entries)
              (entry.key.collection, entry.key.id, entry.value),
          ]),
        ),
      );
    }
    await _setMeta('local_schema_version', '${schema.version}');
  }

  // ---------------------------------------------------------------------------
  // Access
  // ---------------------------------------------------------------------------

  /// Runs [body] in one write transaction. Integrity is validated before
  /// commit; a change event with [origin] is emitted after.
  Future<T> transact<T>(
    Future<T> Function(StoreTxn txn) body, {
    ChangeOrigin origin = ChangeOrigin.local,
  }) => _lock.run(() async {
    final txn = StoreTxn._(this);
    _adoptedInTxn.clear();
    final T result;
    try {
      result = await _sql.transaction(() async {
        final value = await body(txn);
        await txn._validate();
        return value;
      });
    } catch (_) {
      for (final name in _adoptedInTxn) {
        _defs.remove(name);
        _opaque.remove(name);
      }
      rethrow;
    }
    if (txn._touched.isNotEmpty) {
      _changes.add(
        ChangeEvent(
          collections: {for (final key in txn._touched) key.collection},
          keys: Set.unmodifiable(txn._touched),
          origin: txn._originOverride ?? origin,
        ),
      );
    }
    return result;
  });

  /// Runs read-only [body]. Reads see only committed data.
  Future<T> read<T>(Future<T> Function(StoreReader reader) body) =>
      _lock.run(() => body(StoreReader._(this)));

  /// Detects commits made by other connections or processes (a widget
  /// isolate, a passive instance) and notifies watchers. Returns whether
  /// anything changed.
  Future<bool> checkExternalChanges() => _lock.run(() async {
    final version = await _sql.dataVersion();
    if (version == _dataVersion) return false;
    _dataVersion = version;
    _changes.add(
      ChangeEvent(
        collections: {for (final def in _defs.values) def.name},
        keys: const {},
        origin: ChangeOrigin.external,
      ),
    );
    return true;
  });

  Future<void> close() async {
    await _lock.run(() async {
      await _changes.close();
      await _sql.close();
    });
  }

  // ---------------------------------------------------------------------------
  // Primitives (callers hold the lock)
  // ---------------------------------------------------------------------------

  Future<String?> _meta(String key) async {
    final rows = await _sql.select(
      'SELECT value FROM ent_meta WHERE key = ?',
      [key],
    );
    return rows.isEmpty ? null : rows.first['value'] as String?;
  }

  Future<void> _setMeta(String key, String? value) async {
    if (value == null) {
      await _sql.execute('DELETE FROM ent_meta WHERE key = ?', [key]);
    } else {
      await _sql.execute(
        'INSERT INTO ent_meta (key, value) VALUES (?, ?) '
        'ON CONFLICT (key) DO UPDATE SET value = excluded.value',
        [key, value],
      );
    }
  }

  Future<int> _nextCounter(String key) async {
    final value = int.parse(await _meta(key) ?? '0') + 1;
    await _setMeta(key, '$value');
    return value;
  }

  Future<String?> _getRaw(DocKey key) async {
    final def = _defs[key.collection];
    if (def == null) return null;
    final rows = await _sql.select(
      'SELECT doc FROM "${def.table}" WHERE id = ?',
      [key.id],
    );
    return rows.isEmpty ? null : rows.first['doc']! as String;
  }

  /// Writes the row and keeps the reference index in step. No journaling.
  Future<void> _writeRow(DocKey key, String? value) async {
    final def = _defs[key.collection] ?? await _adoptOpaque(key.collection);
    if (value == null) {
      await _sql.execute('DELETE FROM "${def.table}" WHERE id = ?', [key.id]);
    } else {
      await _sql.execute(
        'INSERT INTO "${def.table}" (id, doc) VALUES (?, ?) '
        'ON CONFLICT (id) DO UPDATE SET doc = excluded.doc',
        [key.id, value],
      );
    }
    await _sql.execute(
      'DELETE FROM ent_refs WHERE from_collection = ? AND from_id = ?',
      [key.collection, key.id],
    );
    if (value != null && def.refs != null) {
      final refs = def.refsOf(decodeDocument(value));
      for (final ref in refs) {
        await _sql.execute(
          'INSERT OR IGNORE INTO ent_refs '
          '(from_collection, from_id, to_collection, to_id) VALUES (?, ?, ?, ?)',
          [key.collection, key.id, ref.collection, ref.id],
        );
      }
    }
  }

  Future<PendingRow?> _pending(DocKey key) async {
    final rows = await _sql.select(
      'SELECT * FROM ent_pending WHERE collection = ? AND id = ?',
      [key.collection, key.id],
    );
    return rows.isEmpty ? null : _pendingFrom(rows.first);
  }

  Future<List<PendingRow>> _allPending() async {
    final rows = await _sql.select(
      'SELECT * FROM ent_pending ORDER BY collection, id',
    );
    return rows.map(_pendingFrom).toList();
  }

  PendingRow _pendingFrom(Map<String, Object?> row) => PendingRow(
    key: docKey(row['collection']! as String, row['id']! as String),
    before: row['before'] as String?,
    grp: row['grp']! as int,
    seq: row['seq']! as int,
    inflightSeq: row['inflight_seq'] as int?,
    heldUnit: row['held_unit'] as String?,
  );

  Future<void> _savePending(PendingRow row) => _sql.execute(
    'INSERT INTO ent_pending '
    '(collection, id, before, grp, seq, inflight_seq, held_unit) '
    'VALUES (?, ?, ?, ?, ?, ?, ?) '
    'ON CONFLICT (collection, id) DO UPDATE SET before = excluded.before, '
    'grp = excluded.grp, seq = excluded.seq, '
    'inflight_seq = excluded.inflight_seq, held_unit = excluded.held_unit',
    [
      row.key.collection,
      row.key.id,
      row.before,
      row.grp,
      row.seq,
      row.inflightSeq,
      row.heldUnit,
    ],
  );

  Future<void> _deletePending(DocKey key) => _sql.execute(
    'DELETE FROM ent_pending WHERE collection = ? AND id = ?',
    [key.collection, key.id],
  );

  Future<SyncBase> _readBase() async {
    final revision = int.tryParse(await _meta('base_revision') ?? '');
    final digest = await _meta('base_digest');
    if (revision == null || digest == null) return SyncBase.none;
    return SyncBase(revision, StateDigest.parse(digest));
  }

  Future<void> _writeBase(SyncBase base) async {
    await _setMeta('base_revision', '${base.revision}');
    await _setMeta('base_digest', base.digest.hex);
  }

  /// Every synced document, as canonical strings.
  Future<Map<DocKey, String>> _currentState() async {
    final state = <DocKey, String>{};
    for (final def in syncedCollections) {
      final rows = await _sql.select('SELECT id, doc FROM "${def.table}"');
      for (final row in rows) {
        state[docKey(def.name, row['id']! as String)] = row['doc']! as String;
      }
    }
    return state;
  }

  /// The exact state at the base revision: current with pending reverted
  /// (spec §7.4).
  Future<Map<DocKey, String>> _baseState() async {
    final state = await _currentState();
    for (final row in await _allPending()) {
      if (row.before == null) {
        state.remove(row.key);
      } else {
        state[row.key] = row.before!;
      }
    }
    return state;
  }

  Future<List<DocKey>> _referrers(DocKey key) async {
    final rows = await _sql.select(
      'SELECT from_collection, from_id FROM ent_refs '
      'WHERE to_collection = ? AND to_id = ?',
      [key.collection, key.id],
    );
    return [
      for (final row in rows)
        docKey(row['from_collection']! as String, row['from_id']! as String),
    ];
  }

  /// Finds broken references among [keys], viewing documents through
  /// [valueOf] (spec §5.4, §12.4).
  ///
  /// Checks the outgoing references of every key with a value, and the
  /// references into every key held by documents outside [keys] (found
  /// through the reverse index). Shared by write-time validation and the
  /// merge's integrity pass, which view the data differently.
  Future<List<Violation>> findViolations(
    Set<DocKey> keys,
    Future<String?> Function(DocKey key) valueOf,
  ) async {
    final violations = <Violation>[];

    Future<void> checkRef(DocKey from, Ref ref) async {
      final fromDef = _defs[from.collection];
      final targetDef = _defs[ref.collection];
      if (targetDef == null) {
        violations.add(Violation(from, ref.key, 'unknown collection'));
        return;
      }
      if ((fromDef?.sync ?? true) && !targetDef.sync) {
        violations.add(
          Violation(from, ref.key, 'synced document references local-only data'),
        );
        return;
      }
      final target = await valueOf(ref.key);
      if (target == null) {
        violations.add(Violation(from, ref.key, 'target does not exist'));
        return;
      }
      final check = ref.check;
      if (check != null && !check(decodeDocument(target))) {
        violations.add(Violation(from, ref.key, 'target check failed'));
      }
    }

    for (final key in keys) {
      final def = _defs[key.collection];
      if (def?.refs == null) continue;
      final value = await valueOf(key);
      if (value == null) continue;
      for (final ref in def!.refsOf(decodeDocument(value))) {
        await checkRef(key, ref);
      }
    }
    for (final key in keys) {
      for (final referrer in await _referrers(key)) {
        if (keys.contains(referrer)) continue;
        final value = await valueOf(referrer);
        if (value == null) continue;
        final def = _defs[referrer.collection]!;
        for (final ref in def.refsOf(decodeDocument(value))) {
          if (ref.key == key) await checkRef(referrer, ref);
        }
      }
    }
    return violations;
  }
}

/// Read-only access to committed data.
class StoreReader {
  StoreReader._(this._store);

  final EntanglementStore _store;

  SqlExecutor get sql => _store._sql;

  Future<String?> getRaw(DocKey key) => _store._getRaw(key);

  Future<Json?> getJson(DocKey key) async {
    final raw = await _store._getRaw(key);
    return raw == null ? null : decodeDocument(raw);
  }

  Future<String?> meta(String key) => _store._meta(key);

  Future<SyncBase> base() => _store._readBase();

  Future<List<PendingRow>> allPending() => _store._allPending();

  Future<PendingRow?> pending(DocKey key) => _store._pending(key);

  Future<Map<DocKey, String>> currentState() => _store._currentState();

  Future<Map<DocKey, String>> baseState() => _store._baseState();

  Future<Map<String, Object?>?> inflight() async {
    final rows = await _store._sql.select(
      'SELECT request FROM ent_inflight WHERE id = 1',
    );
    if (rows.isEmpty) return null;
    return (decodeJson(rows.first['request']! as String)! as Map)
        .cast<String, Object?>();
  }

  Future<List<ConflictRecord>> conflicts() async {
    final rows = await _store._sql.select(
      'SELECT * FROM ent_conflicts ORDER BY detected_at, unit_id, collection, id',
    );
    return [
      for (final row in rows)
        ConflictRecord(
          key: docKey(row['collection']! as String, row['id']! as String),
          unitId: row['unit_id']! as String,
          ancestor: row['ancestor'] as String?,
          local: row['local'] as String?,
          remote: row['remote'] as String?,
          reasons: _decodeStringList(row['reasons'] as String?).toList(),
          detectedAt: row['detected_at']! as int,
        ),
    ];
  }

  Future<List<Map<String, Object?>>> backups() => _store._sql.select(
    'SELECT id, created_at, reason FROM ent_backups ORDER BY created_at DESC',
  );

  Future<Map<String, Object?>?> backup(String id) async {
    final rows = await _store._sql.select(
      'SELECT * FROM ent_backups WHERE id = ?',
      [id],
    );
    return rows.isEmpty ? null : rows.first;
  }
}

/// Read-write access inside one transaction.
class StoreTxn extends StoreReader {
  StoreTxn._(super.store) : super._();

  final Set<DocKey> _touched = {};
  int? _seq;
  int? _group;
  ChangeOrigin? _originOverride;

  /// Whether to check references before commit. Only the engine turns this
  /// off, after checking a merge itself.
  bool validateIntegrity = true;

  /// Reports this transaction's changes with a different origin than the one
  /// it was started with.
  set origin(ChangeOrigin origin) => _originOverride = origin;

  /// This transaction's sequence number, allocated on first use.
  Future<int> seq() async => _seq ??= await _store._nextCounter('txn_seq');

  /// This transaction's coupling group, allocated on first use.
  Future<int> group() async => _group ??= await newGroup();

  Future<int> newGroup() => _store._nextCounter('next_group');

  Future<void> setMeta(String key, String? value) => _store._setMeta(key, value);

  /// The journaled write path (spec §7.3). [value] is canonical JSON, or null
  /// to delete.
  ///
  /// [isolated] gives this write a coupling group of its own instead of the
  /// transaction's, for bulk writes (an import) whose documents are
  /// independent: one conflicting document must not drag the rest into its
  /// conflict unit.
  Future<void> put(DocKey key, String? value, {bool isolated = false}) async {
    final def = _store._defs[key.collection] ?? await _store._adoptOpaque(key.collection);
    final old = await _store._getRaw(key);
    if (old == value) return;
    await _store._writeRow(key, value);
    _touched.add(key);
    if (!def.sync) return;

    final group = isolated ? await newGroup() : await this.group();
    final seq = await this.seq();
    var row = await _store._pending(key);
    if (row == null) {
      row = PendingRow(key: key, before: old, grp: group, seq: seq);
    } else {
      if (row.grp != group) {
        // Coupling is transitive until published: everything already grouped
        // with this document joins this transaction's group (spec §7.2).
        await _store._sql.execute(
          'UPDATE ent_pending SET grp = ? WHERE grp = ?',
          [group, row.grp],
        );
        row.grp = group;
      }
      row.seq = seq;
    }
    if (value == row.before &&
        row.inflightSeq == null &&
        row.heldUnit == null) {
      await _store._deletePending(key);
    } else {
      await _store._savePending(row);
    }
  }

  /// Writes the document without touching the overlay. The engine uses this
  /// when applying merges, where it manages pending rows itself.
  Future<void> writeUnjournaled(DocKey key, String? value) async {
    final old = await _store._getRaw(key);
    if (old == value) return;
    await _store._writeRow(key, value);
    _touched.add(key);
  }

  Future<void> savePending(PendingRow row) => _store._savePending(row);

  Future<void> deletePending(DocKey key) => _store._deletePending(key);

  Future<void> setBase(SyncBase base) => _store._writeBase(base);

  Future<void> setInflight(Map<String, Object?>? request) async {
    if (request == null) {
      await _store._sql.execute('DELETE FROM ent_inflight WHERE id = 1');
    } else {
      await _store._sql.execute(
        'INSERT OR REPLACE INTO ent_inflight (id, request, created_at) '
        'VALUES (1, ?, ?)',
        [canonicalJson(request), DateTime.now().millisecondsSinceEpoch],
      );
    }
  }

  Future<void> saveConflict(ConflictRecord record) => _store._sql.execute(
    'INSERT OR REPLACE INTO ent_conflicts '
    '(collection, id, unit_id, ancestor, local, remote, reasons, detected_at) '
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [
      record.key.collection,
      record.key.id,
      record.unitId,
      record.ancestor,
      record.local,
      record.remote,
      canonicalJson(record.reasons),
      record.detectedAt,
    ],
  );

  Future<void> deleteConflictUnit(String unitId) => _store._sql.execute(
    'DELETE FROM ent_conflicts WHERE unit_id = ?',
    [unitId],
  );

  Future<void> clearConflicts() =>
      _store._sql.execute('DELETE FROM ent_conflicts');

  Future<CollectionDef> ensureCollection(String name) async =>
      _store._defs[name] ?? await _store._adoptOpaque(name);

  Future<List<Violation>> findViolations(
    Set<DocKey> keys,
    Future<String?> Function(DocKey key) valueOf,
  ) => _store.findViolations(keys, valueOf);

  /// Saves a full copy of the synced collections (spec §15.6), keeping the
  /// newest [keep].
  Future<String> writeBackup(String reason, {int keep = 3}) async {
    final state = await _store._currentState();
    final payload = <String, Map<String, Object?>>{};
    for (final entry in state.entries) {
      (payload[entry.key.collection] ??= {})[entry.key.id] = decodeDocument(
        entry.value,
      );
    }
    final id = newId();
    await _store._sql.execute(
      'INSERT INTO ent_backups (id, created_at, reason, payload) '
      'VALUES (?, ?, ?, ?)',
      [id, DateTime.now().millisecondsSinceEpoch, reason, canonicalJson(payload)],
    );
    await _store._sql.execute(
      'DELETE FROM ent_backups WHERE id NOT IN '
      '(SELECT id FROM ent_backups ORDER BY created_at DESC LIMIT ?)',
      [keep],
    );
    return id;
  }

  Future<void> _validate() async {
    if (_touched.isEmpty || !validateIntegrity) return;
    final violations = await _store.findViolations(_touched, _store._getRaw);
    if (violations.isNotEmpty) throw IntegrityViolation(violations);
  }
}

const List<String> _frameworkTables = [
  'CREATE TABLE IF NOT EXISTS ent_meta '
      '(key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS ent_pending ('
      'collection TEXT NOT NULL, id TEXT NOT NULL, before TEXT, '
      'grp INTEGER NOT NULL, seq INTEGER NOT NULL, inflight_seq INTEGER, '
      'held_unit TEXT, PRIMARY KEY (collection, id))',
  'CREATE INDEX IF NOT EXISTS ent_pending_grp ON ent_pending (grp)',
  'CREATE TABLE IF NOT EXISTS ent_refs ('
      'from_collection TEXT NOT NULL, from_id TEXT NOT NULL, '
      'to_collection TEXT NOT NULL, to_id TEXT NOT NULL, '
      'PRIMARY KEY (from_collection, from_id, to_collection, to_id))',
  'CREATE INDEX IF NOT EXISTS ent_refs_to ON ent_refs (to_collection, to_id)',
  'CREATE TABLE IF NOT EXISTS ent_inflight ('
      'id INTEGER PRIMARY KEY CHECK (id = 1), request TEXT NOT NULL, '
      'created_at INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS ent_conflicts ('
      'collection TEXT NOT NULL, id TEXT NOT NULL, unit_id TEXT NOT NULL, '
      'ancestor TEXT, local TEXT, remote TEXT, reasons TEXT NOT NULL, '
      'detected_at INTEGER NOT NULL, PRIMARY KEY (collection, id))',
  'CREATE TABLE IF NOT EXISTS ent_backups ('
      'id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, reason TEXT NOT NULL, '
      'payload TEXT NOT NULL)',
];

Set<String> _decodeStringList(String? text) {
  if (text == null) return {};
  return (decodeJson(text)! as List).cast<String>().toSet();
}

final Random _random = Random.secure();

/// A UUIDv7: time-ordered, so ids created on one device sort by creation.
String newId() {
  final bytes = List<int>.generate(16, (_) => _random.nextInt(256));
  final millis = DateTime.now().millisecondsSinceEpoch;
  for (var index = 0; index < 6; index++) {
    bytes[index] = (millis >> (8 * (5 - index))) & 0xFF;
  }
  bytes[6] = (bytes[6] & 0x0F) | 0x70;
  bytes[8] = (bytes[8] & 0x3F) | 0x80;
  final hex = bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
  return '${hex.substring(0, 8)}-${hex.substring(8, 12)}-'
      '${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}';
}

/// Serialises database access. Re-entrant use — starting a read or write
/// from inside a transaction on the same store — would wait on itself forever,
/// so it is detected through a zone marker and fails fast instead.
class _Lock {
  final Object _held = Object();
  Future<void> _last = Future<void>.value();

  Future<T> run<T>(Future<T> Function() body) {
    if (Zone.current[_held] == true) {
      throw StateError(
        'Re-entrant database access: a read or write was started from inside '
        'a transaction. Inside db.write, use the Tx methods (tx.get, '
        'tx.query) instead of db.get or db.query.',
      );
    }
    final done = Completer<void>();
    final previous = _last;
    _last = done.future;
    return previous
        .then((_) => runZoned(body, zoneValues: {_held: true}))
        .whenComplete(done.complete);
  }
}
