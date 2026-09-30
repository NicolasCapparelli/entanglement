import 'dart:async';

import 'canonical.dart';
import 'digest.dart';
import 'merge.dart';
import 'protocol.dart';
import 'schema.dart';
import 'store.dart';
import 'sync_types.dart';

/// The server's state could not be reconciled with itself: a checkpoint or
/// commit chain whose content does not match its recorded digest.
class SyncIntegrityException implements Exception {
  SyncIntegrityException(this.message);

  final String message;

  @override
  String toString() => 'SyncIntegrityException: $message';
}

/// An operation that needs a usable account was called without one.
class SyncUnavailableException implements Exception {
  SyncUnavailableException(this.relation);

  final SyncRelation relation;

  @override
  String toString() => 'SyncUnavailableException: sync is $relation';
}

class _DigestMismatch implements Exception {}

/// The remote side of a pull: either the commits since the base, or a whole
/// state when history is unavailable (spec §12.1).
class _RemoteSide {
  _RemoteSide.incremental(this.commits) : state = null;

  _RemoteSide.full(this.state) : commits = const [];

  final List<Commit> commits;
  final Map<DocKey, String>? state;
  bool migrated = false;

  bool get isFull => state != null;
}

enum _Choice { clean, hold, local, remote }

/// Drives synchronisation for one [EntanglementStore] (spec §11–§16, §20).
///
/// Every operation runs through one queue, so cycles, restores and account
/// switches never overlap. Local writes never wait for it.
class SyncEngine {
  SyncEngine({
    required this.store,
    required this.backend,
    required this.accounts,
    this.options = const SyncOptions(),
  }) : _mode = options.defaultMode;

  final EntanglementStore store;
  final SyncBackend backend;
  final AccountSource accounts;
  final SyncOptions options;

  Schema get schema => store.schema;

  final _queue = _Queue();
  final _statusController = StreamController<SyncStatus>.broadcast();
  final List<StreamSubscription<Object?>> _subscriptions = [];
  StreamSubscription<void>? _hintSubscription;
  Timer? _pollTimer;
  Timer? _autoPushTimer;
  Timer? _debounceTimer;
  Timer? _maxDelayTimer;
  Timer? _retryTimer;

  SyncMode _mode;
  String? _account;
  bool _accountMismatch = false;
  bool _remoteTooNew = false;
  bool _headChecked = false;
  int? _knownHead;
  DateTime? _lastCheckedAt;
  DateTime? _lastSyncedAt;
  SyncActivity _activity = SyncActivity.idle;
  SyncProblem? _problem;
  int _failures = 0;
  bool _cycleQueued = false;
  bool _started = false;
  bool _disposed = false;

  SyncStatus _status = const SyncStatus(
    relation: SyncRelation.signedOut,
    activity: SyncActivity.idle,
    problem: null,
    mode: SyncMode.vcs,
    account: null,
    pendingCount: 0,
    heldCount: 0,
    conflictCount: 0,
    baseRevision: 0,
    knownHeadRevision: null,
    lastCheckedAt: null,
    lastSyncedAt: null,
  );

  SyncStatus get status => _status;

  /// The current status, then every change.
  Stream<SyncStatus> get statusChanges => _statusController.stream;

  SyncMode get mode => _mode;

  bool get _ready => _account != null && !_accountMismatch;

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  Future<void> start() async {
    if (_started) return;
    _started = true;
    final stored = await store.read((reader) => reader.meta('mode'));
    _mode = SyncMode.fromName(stored) ?? options.defaultMode;
    _subscriptions.add(store.changes.listen(_onLocalChange));
    _subscriptions.add(accounts.accountChanges.listen(_onAccount));
    await _onAccount(accounts.currentAccount);
  }

  Future<void> dispose() async {
    _disposed = true;
    _cancelTimers();
    await _hintSubscription?.cancel();
    for (final subscription in _subscriptions) {
      await subscription.cancel();
    }
    await _queue.run(() async {});
    await _statusController.close();
  }

  /// Call when the app returns to the foreground.
  Future<void> resume() async {
    await store.checkExternalChanges();
    if (!_ready) return;
    if (_mode == SyncMode.realtime) {
      _requestCycle();
    } else {
      unawaited(_guard(checkRemote));
    }
  }

  /// Call when the app goes to the background. Realtime makes a best-effort
  /// final push.
  Future<void> pause() async {
    _cancelTimers();
    if (_ready && _mode == SyncMode.realtime) {
      await _guard(
        () => push().timeout(const Duration(seconds: 10), onTimeout: () {}),
      );
    }
  }

  Future<void> setMode(SyncMode mode) async {
    if (mode == _mode) return;
    await store.transact((txn) => txn.setMeta('mode', mode.name));
    _mode = mode;
    _schedule();
    await _publishStatus();
    if (_ready && mode == SyncMode.realtime) _requestCycle();
  }

  ConflictPolicy get conflictPolicy => _policyFor(_mode);

  ConflictPolicy _policyFor(SyncMode mode) =>
      _policyOverrides[mode] ??
      (mode == SyncMode.vcs
          ? options.vcs.conflictPolicy
          : options.realtime.conflictPolicy);

  final Map<SyncMode, ConflictPolicy> _policyOverrides = {};

  /// Overrides the conflict policy for [mode] on this device.
  Future<void> setConflictPolicy(ConflictPolicy policy, {SyncMode? mode}) async {
    final target = mode ?? _mode;
    _policyOverrides[target] = policy;
    await store.transact(
      (txn) => txn.setMeta('conflict_policy_${target.name}', policy.name),
    );
  }

  Future<void> _loadPolicies() async {
    for (final mode in SyncMode.values) {
      final stored = await store.read(
        (reader) => reader.meta('conflict_policy_${mode.name}'),
      );
      final policy = ConflictPolicy.fromName(stored);
      if (policy != null) _policyOverrides[mode] = policy;
    }
  }

  // ---------------------------------------------------------------------------
  // Accounts (spec §16)
  // ---------------------------------------------------------------------------

  Future<void> _onAccount(String? account) async {
    if (_disposed) return;
    _cancelTimers();
    await _hintSubscription?.cancel();
    _hintSubscription = null;
    _account = null;
    _accountMismatch = false;
    _headChecked = false;
    _knownHead = null;
    _problem = null;
    if (account == null) {
      await _publishStatus();
      return;
    }
    await _loadPolicies();
    final owner = await store.read((reader) => reader.meta('owner_account'));
    if (owner == null) {
      // Data created while signed out belongs to whoever signs in first; its
      // base is revision 0, so the first sync publishes or merges it.
      await store.transact((txn) => txn.setMeta('owner_account', account));
    } else if (owner != account) {
      _accountMismatch = true;
      _account = account;
      await _publishStatus();
      return;
    }
    _account = account;
    _schedule();
    await _publishStatus();
    if (_mode == SyncMode.realtime) {
      _requestCycle();
    } else {
      unawaited(_guard(checkRemote));
    }
  }

  /// Moves this device to the signed-in account when local data belongs to a
  /// different one (spec §16.2). Unpublished changes are backed up locally
  /// first; refused unless [discardUnpublished] when there are any.
  Future<void> switchAccount({bool discardUnpublished = false}) async {
    final account = accounts.currentAccount;
    if (account == null) throw SyncUnavailableException(SyncRelation.signedOut);
    await _queue.run(() async {
      await store.transact((txn) async {
        final pending = await txn.allPending();
        if (pending.isNotEmpty && !discardUnpublished) {
          throw StateError(
            '${pending.length} unpublished change(s) belong to the previous '
            'account. Pass discardUnpublished: true to switch anyway (a local '
            'backup is kept).',
          );
        }
        await txn.writeBackup(
          'Before switching account',
          keep: options.history.localBackups,
        );
        final state = await txn.currentState();
        for (final key in state.keys) {
          await txn.writeUnjournaled(key, null);
        }
        for (final row in await txn.allPending()) {
          await txn.deletePending(row.key);
        }
        await txn.clearConflicts();
        await txn.setInflight(null);
        await txn.setBase(SyncBase.none);
        await txn.setMeta('owner_account', account);
        txn.origin = ChangeOrigin.remote;
      });
    });
    await _onAccount(account);
  }

  // ---------------------------------------------------------------------------
  // Public operations
  // ---------------------------------------------------------------------------

  /// Checks (metadata only) whether the remote moved. Never applies anything.
  Future<void> checkRemote() => _operation(SyncActivity.checking, () async {
    final head = await backend.head();
    _noteHead(head);
  });

  /// Publishes local changes (spec §11). If the remote moved, pulls and
  /// merges first; held conflicts stay local while everything else publishes.
  /// A user-initiated push is a restore point, labelled with [message].
  Future<void> push({String? message, bool userInitiated = true}) =>
      _operation(SyncActivity.pushing, () async {
        await _pushLocked(
          message: message,
          restorePoint: userInitiated && _mode == SyncMode.vcs,
        );
        await _afterSuccessfulCycle();
      });

  /// Fetches and merges remote changes (spec §12).
  Future<void> pull() => _operation(SyncActivity.pulling, () async {
    await _pullLocked();
    await _afterSuccessfulCycle();
  });

  /// Pull, then push.
  Future<void> sync() => _operation(SyncActivity.pulling, () async {
    await _pullLocked();
    await _pushLocked(restorePoint: false);
    await _afterSuccessfulCycle();
  });

  /// Throws away unpublished local changes (backed up first) and pulls
  /// (spec §13.5).
  Future<void> discardLocalAndPull() =>
      _operation(SyncActivity.pulling, () async {
        await _resolveInflight();
        await store.transact((txn) async {
          await txn.writeBackup(
            'Before discarding local changes',
            keep: options.history.localBackups,
          );
          for (final row in await txn.allPending()) {
            await txn.writeUnjournaled(row.key, row.before);
            await txn.deletePending(row.key);
          }
          await txn.clearConflicts();
          txn.origin = ChangeOrigin.remote;
        });
        await _pullLocked();
      });

  /// Makes the remote exactly this device's current state, through the normal
  /// compare-and-swap path (spec §13.5). The replaced state stays restorable.
  Future<void> overwriteRemoteWithLocal() =>
      _operation(SyncActivity.pushing, () async {
        await _resolveInflight();
        final target = await store.read((reader) => reader.currentState());
        await _applyTarget(
          target,
          RestorePointKind.beforeOverwrite,
          'Before overwrite from ${options.deviceLabel ?? 'another device'}',
        );
      });

  // ---------------------------------------------------------------------------
  // Importing existing data
  // ---------------------------------------------------------------------------

  /// Brings data from another system (a previous sync design, an export) into
  /// the account, merging correctly however many devices import.
  ///
  /// [puts] are documents this device holds; [deletes] are documents it has a
  /// *record* of deleting. Anything in neither is left alone: absence alone
  /// cannot tell "deleted" from "never seen here".
  ///
  /// The first device to import (the account has no head) publishes its data
  /// and pins that revision as a restore point labelled [label]. Every later
  /// importer uses that pinned revision as the common ancestor: it rebuilds
  /// the state there, applies its own data as local edits on top, and pulls
  /// — an ordinary three-way merge. Changes a later device made after the
  /// first import merge in; data both hold identically merges to nothing.
  /// Without the pin (history lost), the ancestor is the empty state and any
  /// document both sides hold differently becomes a conflict.
  ///
  /// Local synced data is replaced, so call this on a fresh store.
  Future<void> importState({
    required Map<DocKey, String> puts,
    Set<DocKey> deletes = const {},
    String label = 'Imported data',
  }) => _operation(SyncActivity.pushing, () async {
    await _resolveInflight();
    final head = await backend.head();
    _noteHead(head);
    if (_remoteTooNew) {
      throw SyncUnavailableException(SyncRelation.remoteSchemaTooNew);
    }

    var anchor = 0;
    var anchorState = <DocKey, String>{};
    if (head != null) {
      final points = await backend.restorePoints();
      final markers = points
          .where((point) => point.pinned && point.label == label)
          .map((point) => point.revision);
      if (markers.isNotEmpty) {
        anchor = markers.reduce((a, b) => a < b ? a : b);
        anchorState = await _stateAt(anchor);
      }
    }

    await store.transact((txn) async {
      txn.origin = ChangeOrigin.migration;
      for (final key in (await txn.currentState()).keys) {
        await txn.writeUnjournaled(key, null);
      }
      for (final row in await txn.allPending()) {
        await txn.deletePending(row.key);
      }
      await txn.clearConflicts();
      for (final entry in anchorState.entries) {
        await txn.writeUnjournaled(entry.key, entry.value);
      }
      await txn.setBase(
        SyncBase(
          anchor,
          StateDigest.of([
            for (final entry in anchorState.entries)
              (entry.key.collection, entry.key.id, entry.value),
          ]),
        ),
      );
      for (final entry in puts.entries) {
        final value = _carryUnknownFields(
          entry.key,
          entry.value,
          anchorState[entry.key],
        );
        if (anchorState[entry.key] != value) {
          await txn.put(entry.key, value, isolated: true);
        }
      }
      for (final key in deletes) {
        if (!puts.containsKey(key) && anchorState.containsKey(key)) {
          await txn.put(key, null, isolated: true);
        }
      }
      // Imported data predates reference checking; merges still check it.
      txn.validateIntegrity = false;
    });

    if (head == null) {
      await _pushLocked(message: label, restorePoint: false);
      final base = await store.read((reader) => reader.base());
      if (base.revision > 0) {
        await backend.putRestorePoint(
          RestorePoint(
            revision: base.revision,
            kind: RestorePointKind.manual,
            label: label,
            pinned: true,
            deviceLabel: options.deviceLabel,
            createdAt: DateTime.now().toUtc(),
          ),
        );
      }
    } else {
      await _pullLocked();
      await _pushLocked(restorePoint: false);
    }
    await _afterSuccessfulCycle();
  });

  // ---------------------------------------------------------------------------
  // Conflicts (spec §13)
  // ---------------------------------------------------------------------------

  Future<List<ConflictUnit>> conflicts() => store.read((reader) async {
    final records = await reader.conflicts();
    final units = <String, List<ConflictRecord>>{};
    for (final record in records) {
      (units[record.unitId] ??= []).add(record);
    }
    return [
      for (final entry in units.entries)
        ConflictUnit(
          id: entry.key,
          detectedAt: DateTime.fromMillisecondsSinceEpoch(
            entry.value.first.detectedAt,
          ),
          entries: [
            for (final record in entry.value)
              ConflictEntry(
                key: record.key,
                ancestor: _decodeOrNull(record.ancestor),
                local: await reader.getJson(record.key),
                remote: _decodeOrNull(record.remote),
                reasons: record.reasons,
              ),
          ],
        ),
    ];
  });

  Stream<List<ConflictUnit>> watchConflicts() async* {
    yield await conflicts();
    await for (final _ in _statusController.stream) {
      yield await conflicts();
    }
  }

  /// Decides a held conflict unit (spec §13.2).
  Future<void> resolve(String unitId, Resolution resolution) async {
    await store.transact((txn) async {
      final records = (await txn.conflicts())
          .where((record) => record.unitId == unitId)
          .toList();
      if (records.isEmpty) throw StateError('No conflict unit $unitId.');
      for (final record in records) {
        final row = await txn.pending(record.key);
        if (row != null) {
          row.heldUnit = null;
          await txn.savePending(row);
        }
      }
      final discarded = <DocKey, String?>{};
      final choice = switch (resolution) {
        KeepLocal() => 'keepLocal',
        KeepRemote() => 'keepRemote',
        CustomResolution() => 'custom',
      };
      for (final record in records) {
        final current = await txn.getRaw(record.key);
        final String? chosen;
        switch (resolution) {
          case KeepLocal():
            chosen = current;
          case KeepRemote():
            chosen = record.remote;
          case CustomResolution(:final values):
            if (!values.containsKey(record.key)) {
              throw ArgumentError(
                'A custom resolution must give a value for '
                '${record.key.collection}/${record.key.id}.',
              );
            }
            final value = values[record.key];
            chosen = value == null ? null : canonicalJson(value);
        }
        if (current != chosen) discarded[record.key] = current;
        if (record.remote != chosen) discarded[record.key] ??= record.remote;
        if (chosen != current) await txn.put(record.key, chosen);
      }
      await txn.deleteConflictUnit(unitId);
      if (await _writeLog(
        txn,
        automatic: false,
        choice: choice,
        discarded: discarded,
      )) {
        await _pruneLog(txn);
      }
      txn.origin = ChangeOrigin.resolution;
    });
    await _publishStatus();
    if (_ready && _mode == SyncMode.realtime) _requestCycle();
  }

  Future<List<SyncLogEntry>> log() => store.read((reader) async {
    final rows = await reader.sql.select(
      'SELECT doc FROM "c_$syncLogCollection" ORDER BY "ix_at" DESC, id DESC',
    );
    return [
      for (final row in rows)
        SyncLogEntry.fromJson(decodeDocument(row['doc']! as String)),
    ];
  });

  /// Writes back the values a logged decision discarded, as an ordinary local
  /// edit that syncs normally.
  Future<void> reinstate(String logEntryId) async {
    await store.transact((txn) async {
      final raw = await txn.getRaw(docKey(syncLogCollection, logEntryId));
      if (raw == null) throw StateError('No sync log entry $logEntryId.');
      final entry = SyncLogEntry.fromJson(decodeDocument(raw));
      for (final (key, value) in entry.discarded) {
        await txn.put(key, value == null ? null : canonicalJson(value));
      }
    });
  }

  // ---------------------------------------------------------------------------
  // History (spec §15)
  // ---------------------------------------------------------------------------

  Future<List<RestorePoint>> restorePoints() => backend.restorePoints();

  /// Labels the current state as a restore point, pushing first.
  Future<void> mark(String label, {bool pinned = false}) =>
      _operation(SyncActivity.pushing, () async {
        await _pushLocked(restorePoint: false);
        final base = await store.read((reader) => reader.base());
        if (base.revision == 0) {
          throw StateError('Nothing has been committed yet.');
        }
        await backend.putRestorePoint(
          RestorePoint(
            revision: base.revision,
            kind: RestorePointKind.manual,
            label: label,
            pinned: pinned,
            deviceLabel: options.deviceLabel,
            createdAt: DateTime.now().toUtc(),
          ),
        );
      });

  /// Keeps the top-level keys of [anchor] that this build does not declare,
  /// as every ordinary write does (spec §5.5): a client importing its data
  /// must not strip another client's fields from the shared documents.
  String _carryUnknownFields(DocKey key, String value, String? anchor) {
    final known = store.defOrNull(key.collection)?.fields;
    if (known == null || anchor == null) return value;
    final stored = decodeDocument(anchor);
    return canonicalJson({
      for (final entry in stored.entries)
        if (!known.contains(entry.key)) entry.key: entry.value,
      ...decodeDocument(value),
    });
  }

  /// Pins or unpins a restore point. Pinned points are never pruned, and
  /// history cannot be compacted past them, so unpin one once it is no longer
  /// needed (for example the anchor [importState] pins, after every device
  /// has imported).
  Future<void> setPinned(RestorePoint point, bool pinned) =>
      backend.putRestorePoint(
        RestorePoint(
          revision: point.revision,
          kind: point.kind,
          label: point.label,
          pinned: pinned,
          deviceLabel: point.deviceLabel,
          createdAt: point.createdAt,
        ),
      );

  /// Restores [point]'s state as a new, forward commit (spec §15.5).
  Future<void> restore(RestorePoint point) =>
      _operation(SyncActivity.restoring, () async {
        await _resolveInflight();
        final target = await _stateAt(point.revision);
        await _applyTarget(
          target,
          RestorePointKind.beforeRestore,
          'Before restoring ${point.label ?? 'revision ${point.revision}'}',
        );
      });

  Future<List<Map<String, Object?>>> localBackups() =>
      store.read((reader) => reader.backups());

  /// Applies a local backup as the target state and publishes it.
  Future<void> restoreLocalBackup(String id) =>
      _operation(SyncActivity.restoring, () async {
        final backup = await store.read((reader) => reader.backup(id));
        if (backup == null) throw StateError('No local backup $id.');
        final payload = decodeDocument(backup['payload']! as String);
        final target = <DocKey, String>{};
        for (final collection in payload.entries) {
          for (final doc in (collection.value! as Map).entries) {
            target[docKey(collection.key, doc.key as String)] = canonicalJson(
              doc.value,
            );
          }
        }
        await _resolveInflight();
        await _applyTarget(
          target,
          RestorePointKind.beforeRestore,
          'Before restoring a local backup',
        );
      });

  /// Gives up on a commit stuck on a permanent transport failure. Safe: if it
  /// was in fact accepted, it arrives later as a remote commit equal to the
  /// local values and merges cleanly (spec §11.2).
  Future<void> abandonInflight() => _queue.run(() async {
    await store.transact((txn) async {
      final request = await txn.inflight();
      if (request == null) return;
      await txn.writeBackup('Before abandoning an upload', keep: options.history.localBackups);
      await _clearInflightMarks(txn, CommitRequest.fromJson(request));
    });
  });

  /// Forces the full-state pull path, rebuilding the local base (spec §12.6).
  Future<void> rebuildBase() => _operation(SyncActivity.pulling, () async {
    await _pullLocked(forceFull: true);
  });

  // ---------------------------------------------------------------------------
  // Push (spec §11)
  // ---------------------------------------------------------------------------

  Future<void> _pushLocked({String? message, required bool restorePoint}) async {
    await _resolveInflight();
    for (var attempt = 0; attempt < 5; attempt++) {
      final request = await _prepareCommit(message);
      if (request == null) {
        if (message != null) await _labelBase(message);
        return;
      }
      final result = await _submitAndSettle(request);
      switch (result) {
        case SubmitAccepted(:final revision):
          _knownHead = revision;
          _headChecked = true;
          if (restorePoint && message == null) {
            await _guardBackend(
              () => backend.putRestorePoint(
                RestorePoint(
                  revision: revision,
                  kind: RestorePointKind.commit,
                  label: null,
                  pinned: false,
                  deviceLabel: options.deviceLabel,
                  createdAt: DateTime.now().toUtc(),
                ),
              ),
            );
          }
          return;
        case SubmitConflict():
          await _pullLocked();
        case SubmitRejected(:final reason):
          if (reason == RejectReason.schemaTooOld) _remoteTooNew = true;
          throw FatalBackendException('Commit rejected: ${reason.name}');
      }
    }
    throw const TransientBackendException(
      'Another device kept committing first; will retry.',
    );
  }

  Future<void> _labelBase(String message) async {
    final base = await store.read((reader) => reader.base());
    if (base.revision == 0) return;
    await backend.putRestorePoint(
      RestorePoint(
        revision: base.revision,
        kind: RestorePointKind.commit,
        label: message,
        pinned: false,
        deviceLabel: options.deviceLabel,
        createdAt: DateTime.now().toUtc(),
      ),
    );
  }

  /// Builds a commit from every publishable pending row and records it as in
  /// flight, durably, before anything is sent.
  Future<CommitRequest?> _prepareCommit(String? message) =>
      store.transact((txn) async {
        final rows = await txn.allPending();
        final excluded = {
          for (final row in rows)
            if (row.heldUnit != null) row.grp,
        };
        var selected = <PendingRow>[];
        // Held units are left out, but later edits can depend on held data
        // (a task created on a board whose conflict is unresolved). The state
        // this commit would produce — held documents at their head value,
        // everything else as published — must satisfy every reference, so any
        // group that would break one is held back too until the conflict is
        // resolved.
        while (true) {
          selected = [
            for (final row in rows)
              if (!excluded.contains(row.grp)) row,
          ];
          if (selected.isEmpty) return null;
          final held = {
            for (final row in rows)
              if (excluded.contains(row.grp)) row.key: row.before,
          };
          if (held.isEmpty) break;
          final selectedKeys = {for (final row in selected) row.key};
          final violations = await txn.findViolations(
            {...selectedKeys, ...held.keys},
            (key) async =>
                held.containsKey(key) ? held[key] : await txn.getRaw(key),
          );
          final more = {
            for (final violation in violations)
              for (final key in [violation.from, violation.to])
                if (selectedKeys.contains(key))
                  selected.firstWhere((row) => row.key == key).grp,
          };
          if (more.isEmpty) break;
          excluded.addAll(more);
        }

        final base = await txn.base();
        final groupIndex = <int, int>{};
        var digest = base.digest;
        final changes = <Change>[];
        for (final row in selected) {
          final value = await txn.getRaw(row.key);
          digest = digest.replace(
            row.key.collection,
            row.key.id,
            row.before,
            value,
          );
          changes.add(
            Change(
              collection: row.key.collection,
              id: row.key.id,
              value: value,
              group: groupIndex.putIfAbsent(row.grp, () => groupIndex.length),
            ),
          );
          row.inflightSeq = row.seq;
          await txn.savePending(row);
        }
        final request = CommitRequest(
          commitId: newId(),
          parent: base.revision,
          schemaVersion: schema.version,
          compatibleSince: schema.compatibleSince,
          deviceId: store.deviceId,
          deviceLabel: options.deviceLabel,
          clientTime: DateTime.now().millisecondsSinceEpoch,
          message: message,
          stateDigest: digest,
          changes: changes,
        );
        await txn.setInflight(request.toJson());
        return request;
      });

  /// Resends a commit left in flight by a crash or lost response. Must run
  /// before any pull: merging while an accepted-but-unacknowledged commit is
  /// outstanding would count its changes twice.
  Future<void> _resolveInflight() async {
    final stored = await store.read((reader) => reader.inflight());
    if (stored == null) return;
    final result = await _submitAndSettle(CommitRequest.fromJson(stored));
    if (result is SubmitAccepted) _knownHead = result.revision;
  }

  Future<SubmitResult> _submitAndSettle(CommitRequest request) async {
    final result = await backend.submit(request);
    await store.transact((txn) async {
      switch (result) {
        case SubmitAccepted(:final revision):
          for (final change in request.changes) {
            final row = await txn.pending(change.key);
            if (row == null) continue;
            if (row.inflightSeq != null && row.seq == row.inflightSeq) {
              await txn.deletePending(change.key);
              continue;
            }
            // Edited again while the upload was in flight: the committed value
            // is now the base, and the newer edit stays pending on top of it.
            row.before = change.value;
            row.inflightSeq = null;
            final current = await txn.getRaw(change.key);
            if (current == row.before && row.heldUnit == null) {
              await txn.deletePending(change.key);
            } else {
              await txn.savePending(row);
            }
          }
          await txn.setBase(SyncBase(revision, request.stateDigest));
          await txn.setInflight(null);
        case SubmitConflict() || SubmitRejected():
          await _clearInflightMarks(txn, request);
      }
    });
    await _publishStatus();
    return result;
  }

  Future<void> _clearInflightMarks(StoreTxn txn, CommitRequest request) async {
    for (final change in request.changes) {
      final row = await txn.pending(change.key);
      if (row == null || row.inflightSeq == null) continue;
      row.inflightSeq = null;
      // Coalescing was suppressed while in flight; re-evaluate it now.
      final current = await txn.getRaw(change.key);
      if (current == row.before && row.heldUnit == null) {
        await txn.deletePending(change.key);
      } else {
        await txn.savePending(row);
      }
    }
    await txn.setInflight(null);
  }

  // ---------------------------------------------------------------------------
  // Pull (spec §12)
  // ---------------------------------------------------------------------------

  Future<void> _pullLocked({bool forceFull = false}) async {
    await _resolveInflight();
    final head = await backend.head();
    _noteHead(head);
    if (head == null || _remoteTooNew) return;
    final base = await store.read((reader) => reader.base());
    if (head.revision == base.revision && !forceFull) return;

    _RemoteSide remote;
    if (forceFull || head.revision < base.revision) {
      remote = await _fetchFull(head);
    } else {
      try {
        remote = await _fetchIncremental(base.revision, head.revision);
      } on HistoryUnavailableException {
        remote = await _fetchFull(head);
      }
    }
    try {
      await _applyRemote(head, remote);
    } on _DigestMismatch {
      // The incremental result does not reproduce the head's digest: the local
      // base is wrong somehow. The full-state path rebuilds it exactly.
      await _applyRemote(head, await _fetchFull(head));
    }
    _lastSyncedAt = DateTime.now();
  }

  void _noteHead(Head? head) {
    _headChecked = true;
    _lastCheckedAt = DateTime.now();
    _knownHead = head?.revision;
    _remoteTooNew = head != null && head.minVersion > schema.version;
  }

  Future<_RemoteSide> _fetchIncremental(int from, int to) async {
    final commits = <Commit>[];
    var after = from;
    while (after < to) {
      final page = await backend.commits(after: after, upTo: to);
      // Each page must continue exactly where the last ended; a gap means
      // commits were compacted mid-read, whatever the backend reported.
      if (page.isEmpty || page.first.revision != after + 1) {
        throw const HistoryUnavailableException('Commit history has a gap.');
      }
      commits.addAll(page);
      after = page.last.revision;
    }
    final side = _RemoteSide.incremental(commits);
    side.migrated = commits.any(
      (commit) => _needsMigration(commit.request.schemaVersion),
    );
    return side;
  }

  Future<_RemoteSide> _fetchFull(Head head) async {
    final state = await _stateAt(head.revision);
    final digest = StateDigest.of([
      for (final entry in state.entries)
        (entry.key.collection, entry.key.id, entry.value),
    ]);
    final side = _RemoteSide.full(state);
    if (digest != head.stateDigest && !_lastStateAtMigrated) {
      _problem = const SyncProblem(
        SyncProblemKind.integrity,
        'The cloud copy does not match its own fingerprint.',
      );
      throw SyncIntegrityException(
        'State at revision ${head.revision} does not match the head digest.',
      );
    }
    side.migrated = _lastStateAtMigrated;
    return side;
  }

  bool _lastStateAtMigrated = false;

  /// The complete state at [revision]: nearest checkpoint plus the commits
  /// after it (spec §15.4).
  Future<Map<DocKey, String>> _stateAt(int revision) async {
    _lastStateAtMigrated = false;
    final checkpoint = await backend.checkpoint(atOrBefore: revision);
    final state = <DocKey, String>{};
    var from = 0;
    if (checkpoint != null) {
      from = checkpoint.revision;
      final migrate = _needsMigration(checkpoint.schemaVersion);
      _lastStateAtMigrated |= migrate;
      for (final entity in checkpoint.entities) {
        final value = migrate
            ? _migrate(entity.collection, entity.value, checkpoint.schemaVersion)
            : entity.value;
        if (value != null) state[entity.key] = value;
      }
      if (!migrate) {
        final digest = StateDigest.of([
          for (final entry in state.entries)
            (entry.key.collection, entry.key.id, entry.value),
        ]);
        if (digest != checkpoint.stateDigest) {
          throw SyncIntegrityException(
            'Checkpoint ${checkpoint.revision} does not match its digest.',
          );
        }
      }
    }
    var after = from;
    while (after < revision) {
      final page = await backend.commits(after: after, upTo: revision);
      if (page.isEmpty || page.first.revision != after + 1) {
        throw HistoryUnavailableException(
          'Revision $revision cannot be reconstructed.',
        );
      }
      for (final commit in page) {
        final version = commit.request.schemaVersion;
        final migrate = _needsMigration(version);
        _lastStateAtMigrated |= migrate;
        for (final change in commit.request.changes) {
          final value = migrate
              ? _migrate(change.collection, change.value, version)
              : change.value;
          if (value == null) {
            state.remove(change.key);
          } else {
            state[change.key] = value;
          }
        }
      }
      after = page.last.revision;
    }
    return state;
  }

  bool _needsMigration(int fromVersion) {
    if (fromVersion >= schema.version) return false;
    for (var version = fromVersion + 1; version <= schema.version; version++) {
      if (schema.migrations.containsKey(version)) return true;
    }
    return false;
  }

  /// Ingestion migration (spec §17.4).
  String? _migrate(String collection, String? value, int fromVersion) {
    if (value == null) return null;
    Json? doc = decodeDocument(value);
    for (var version = fromVersion + 1; version <= schema.version; version++) {
      final step = schema.migrations[version];
      if (step == null || doc == null) continue;
      doc = step(collection, doc);
    }
    return doc == null ? null : canonicalJson(doc);
  }

  /// Merges the remote side into local state and rebases the overlay onto
  /// head, in one transaction (spec §12.2–§12.5).
  Future<void> _applyRemote(Head head, _RemoteSide remote) async {
    final policy = conflictPolicy;
    await store.transact((txn) async {
      txn.origin = ChangeOrigin.remote;
      final base = await txn.base();
      final pending = {for (final row in await txn.allPending()) row.key: row};

      // The remote net change per document, and the coupling groups it came in.
      final net = <DocKey, String?>{};
      final remoteGroups = <List<DocKey>>[];
      if (remote.isFull) {
        final baseState = await txn.baseState();
        for (final key in {...baseState.keys, ...remote.state!.keys}) {
          if (baseState[key] != remote.state![key]) {
            net[key] = remote.state![key];
          }
        }
      } else {
        for (final commit in remote.commits) {
          final byGroup = <int, List<DocKey>>{};
          final version = commit.request.schemaVersion;
          for (final change in commit.request.changes) {
            net[change.key] = _needsMigration(version)
                ? _migrate(change.collection, change.value, version)
                : change.value;
            (byGroup[change.group] ??= []).add(change.key);
          }
          remoteGroups.addAll(byGroup.values);
        }
      }
      for (final key in net.keys) {
        await txn.ensureCollection(key.collection);
      }

      final touched = {...pending.keys, ...net.keys};
      final b = <DocKey, String?>{};
      final l = <DocKey, String?>{};
      final r = <DocKey, String?>{};
      for (final key in touched) {
        final current = await txn.getRaw(key);
        final row = pending[key];
        l[key] = current;
        b[key] = row != null ? row.before : current;
        r[key] = net.containsKey(key) ? net[key] : b[key];
      }

      // Verify before changing anything (spec §12.6).
      final StateDigest newDigest;
      if (remote.isFull || remote.migrated) {
        var digest = base.digest;
        for (final key in net.keys) {
          digest = digest.replace(key.collection, key.id, b[key], r[key]);
        }
        newDigest = remote.migrated ? digest : head.stateDigest;
      } else {
        var digest = base.digest;
        for (final key in net.keys) {
          digest = digest.replace(key.collection, key.id, b[key], r[key]);
        }
        if (digest != head.stateDigest) throw _DigestMismatch();
        newDigest = digest;
      }

      final decisions = <DocKey, Decision>{
        for (final key in touched)
          key: decide(
            base: b[key],
            local: l[key],
            remote: r[key],
            policy:
                store.defOrNull(key.collection)?.merge ??
                MergePolicy.wholeDocument,
          ),
      };

      // Units (spec §12.4).
      final units = UnionFind<DocKey>();
      touched.forEach(units.add);
      final localGroups = <int, List<DocKey>>{};
      final heldGroups = <String, List<DocKey>>{};
      for (final row in pending.values) {
        (localGroups[row.grp] ??= []).add(row.key);
        if (row.heldUnit != null) (heldGroups[row.heldUnit!] ??= []).add(row.key);
      }
      localGroups.values.forEach(units.unionAll);
      heldGroups.values.forEach(units.unionAll);
      remoteGroups.forEach(units.unionAll);

      final integrityFlagged = <DocKey>{};
      var remaining = const <Violation>[];
      late Map<DocKey, List<DocKey>> components;
      late Map<DocKey, _Choice> choices;
      late Map<DocKey, String?> merged;

      String? decidedValue(DocKey key) => switch (decisions[key]!) {
        TakeLocal() => l[key],
        TakeRemote() => r[key],
        TakeMerged(:final value) => value,
        ConflictDecision() => l[key],
      };

      for (var round = 0; ; round++) {
        if (round > touched.length + 2) {
          throw StateError('Merge integrity pass did not converge.');
        }
        components = units.components();
        choices = {};
        for (final entry in components.entries) {
          final keys = entry.value;
          final held = keys.any((key) => pending[key]?.heldUnit != null);
          final conflicted =
              held ||
              keys.any(
                (key) =>
                    decisions[key] is ConflictDecision ||
                    integrityFlagged.contains(key),
              );
          choices[entry.key] = !conflicted
              ? _Choice.clean
              : held
              ? _Choice.hold
              : switch (policy) {
                  ConflictPolicy.ask => _Choice.hold,
                  ConflictPolicy.preferRemote => _Choice.remote,
                  ConflictPolicy.preferLocal => _Choice.local,
                };
        }
        merged = {
          for (final key in touched)
            key: switch (choices[units.find(key)]!) {
              _Choice.clean => decidedValue(key),
              _Choice.remote => r[key],
              _Choice.local || _Choice.hold => l[key],
            },
        };
        final violations = await txn.findViolations(
          touched,
          (key) async =>
              touched.contains(key) ? merged[key] : await txn.getRaw(key),
        );
        var changed = false;
        for (final violation in violations) {
          if (touched.contains(violation.from) &&
              touched.contains(violation.to)) {
            changed |= units.union(violation.from, violation.to);
          }
          for (final key in [violation.from, violation.to]) {
            if (touched.contains(key)) changed |= integrityFlagged.add(key);
          }
        }
        if (!changed) {
          remaining = violations;
          break;
        }
      }

      // Anything still broken must already be broken in the head state
      // itself — written by a buggy or older client. This device cannot repair
      // that by choosing sides, and refusing the pull would wedge it forever,
      // so those are tolerated. A violation the merge introduced is a bug.
      if (remaining.isNotEmpty) {
        final inHead = await txn.findViolations(
          touched,
          (key) async => touched.contains(key) ? r[key] : await txn.getRaw(key),
        );
        final inherited = {for (final violation in inHead) '$violation'};
        final introduced = remaining.where(
          (violation) => !inherited.contains('$violation'),
        );
        if (introduced.isNotEmpty) {
          throw StateError('Merge produced broken references: $introduced');
        }
        txn.validateIntegrity = false;
      }

      // Apply: rebase the overlay onto head (spec §12.5).
      final existingRecords = {
        for (final record in await txn.conflicts()) record.key: record,
      };
      final now = DateTime.now().millisecondsSinceEpoch;
      var logged = false;
      for (final entry in components.entries) {
        final keys = entry.value..sort(_compareKeys);
        final choice = choices[entry.key]!;
        final group = await txn.newGroup();
        String? unitId;
        if (choice == _Choice.hold) {
          final existing = keys
              .map((key) => pending[key]?.heldUnit)
              .whereType<String>()
              .toList();
          unitId = existing.isEmpty ? newId() : existing.first;
        }
        for (final key in keys) {
          final value = merged[key];
          if (value != l[key]) await txn.writeUnjournaled(key, value);
          if (value == r[key]) {
            if (pending.containsKey(key)) await txn.deletePending(key);
          } else {
            await txn.savePending(
              PendingRow(
                key: key,
                before: r[key],
                grp: group,
                seq: pending[key]?.seq ?? await txn.seq(),
                heldUnit: unitId,
              ),
            );
          }
          if (unitId != null) {
            final record = existingRecords[key];
            if (record != null) {
              record.unitId = unitId;
              record.remote = r[key];
              await txn.saveConflict(record);
            } else {
              final decision = decisions[key];
              await txn.saveConflict(
                ConflictRecord(
                  key: key,
                  unitId: unitId,
                  ancestor: b[key],
                  local: l[key],
                  remote: r[key],
                  reasons: [
                    if (decision is ConflictDecision) decision.reason.name,
                    if (integrityFlagged.contains(key))
                      ConflictReason.integrity.name,
                  ],
                  detectedAt: now,
                ),
              );
            }
          }
        }
        if (choice == _Choice.remote || choice == _Choice.local) {
          final discarded = <DocKey, String?>{
            for (final key in keys)
              if (l[key] != r[key])
                key: choice == _Choice.remote ? l[key] : r[key],
          };
          logged |= await _writeLog(
            txn,
            automatic: true,
            choice: choice == _Choice.remote ? 'keepRemote' : 'keepLocal',
            discarded: discarded,
          );
        }
      }
      // Pruned only once every unit is applied, so a log entry that arrived in
      // this pull is never rewritten by the loop above after being pruned.
      if (logged) await _pruneLog(txn);
      await txn.setBase(SyncBase(head.revision, newDigest));
    });
  }

  /// Records a decision and the values it discarded. Returns whether an entry
  /// was written (a decision that discarded nothing is not logged).
  Future<bool> _writeLog(
    StoreTxn txn, {
    required bool automatic,
    required String choice,
    required Map<DocKey, String?> discarded,
  }) async {
    if (discarded.isEmpty) return false;
    final id = newId();
    await txn.put(
      docKey(syncLogCollection, id),
      canonicalJson(
        SyncLogEntry.encode(
          id: id,
          deviceLabel: options.deviceLabel,
          automatic: automatic,
          choice: choice,
          discarded: discarded,
        ),
      ),
    );
    return true;
  }

  /// Applies the sync log's retention (spec §13.4): keeps the newest
  /// `syncLogRetention` entries plus any younger than `syncLogMaxAge`, and
  /// deletes the rest as ordinary, isolated deletes that sync like any edit.
  Future<void> _pruneLog(StoreTxn txn) async {
    final history = options.history;
    final cutoff = DateTime.now()
        .subtract(history.syncLogMaxAge)
        .millisecondsSinceEpoch;
    final table = '"c_$syncLogCollection"';
    final rows = await txn.sql.select(
      'SELECT id FROM $table WHERE "ix_at" < ? AND id NOT IN '
      '(SELECT id FROM $table ORDER BY "ix_at" DESC, id DESC LIMIT ?)',
      [cutoff, history.syncLogRetention],
    );
    for (final row in rows) {
      await txn.put(
        docKey(syncLogCollection, row['id']! as String),
        null,
        isolated: true,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Target-state application (spec §13.5, §15.5)
  // ---------------------------------------------------------------------------

  Future<void> _applyTarget(
    Map<DocKey, String> target,
    RestorePointKind beforeKind,
    String beforeLabel,
  ) async {
    final hasPending = await store.read(
      (reader) async => (await reader.allPending()).isNotEmpty,
    );
    if (hasPending) {
      await store.transact(
        (txn) => txn.writeBackup(beforeLabel, keep: options.history.localBackups),
      );
    }
    await _pullLocked();
    final base = await store.read((reader) => reader.base());
    if (base.revision > 0) {
      await backend.putRestorePoint(
        RestorePoint(
          revision: base.revision,
          kind: beforeKind,
          label: beforeLabel,
          pinned: false,
          deviceLabel: options.deviceLabel,
          createdAt: DateTime.now().toUtc(),
        ),
      );
    }
    for (var attempt = 0; attempt < 5; attempt++) {
      await store.transact((txn) async {
        txn.origin = ChangeOrigin.restore;
        for (final row in await txn.allPending()) {
          if (row.heldUnit != null) {
            row.heldUnit = null;
            await txn.savePending(row);
          }
        }
        await txn.clearConflicts();
        final current = await txn.currentState();
        for (final key in {...current.keys, ...target.keys}) {
          if (current[key] != target[key]) await txn.put(key, target[key]);
        }
      });
      final request = await _prepareCommit(null);
      if (request == null) return;
      final result = await _submitAndSettle(request);
      switch (result) {
        case SubmitAccepted(:final revision):
          _knownHead = revision;
          return;
        case SubmitConflict():
          // Someone committed meanwhile: take their head, then re-apply the
          // target on top, which preserves the explicit intent.
          await _pullLocked();
        case SubmitRejected(:final reason):
          throw FatalBackendException('Commit rejected: ${reason.name}');
      }
    }
    throw const TransientBackendException(
      'Another device kept committing first; will retry.',
    );
  }

  // ---------------------------------------------------------------------------
  // Maintenance after a successful cycle (spec §15.1–§15.3)
  // ---------------------------------------------------------------------------

  Future<void> _afterSuccessfulCycle() async {
    final base = await store.read((reader) => reader.base());
    if (base.revision == 0 || _knownHead != base.revision) return;
    final held = await store.read(
      (reader) async =>
          (await reader.allPending()).any((row) => row.heldUnit != null),
    );
    if (held) return;
    await _guardBackend(() => _maybeDailyRestorePoint(base));
    await _guardBackend(() => _maybeCheckpoint(base));
  }

  Future<void> _maybeDailyRestorePoint(SyncBase base) async {
    final history = options.history;
    if (!history.dailyRestorePoints) return;
    final now = DateTime.now();
    final today =
        '${now.year}-${now.month.toString().padLeft(2, '0')}-'
        '${now.day.toString().padLeft(2, '0')}';
    final last = await store.read((reader) => reader.meta('last_daily_point'));
    if (last == today) return;
    await backend.putRestorePoint(
      RestorePoint(
        revision: base.revision,
        kind: RestorePointKind.daily,
        label: today,
        pinned: false,
        deviceLabel: options.deviceLabel,
        createdAt: now.toUtc(),
      ),
    );
    await store.transact((txn) => txn.setMeta('last_daily_point', today));
  }

  Future<void> _maybeCheckpoint(SyncBase base) async {
    final history = options.history;
    final latest = await backend.checkpoint(atOrBefore: base.revision);
    final since = base.revision - (latest?.revision ?? 0);
    final stale =
        latest != null &&
        since > 0 &&
        DateTime.now().difference(latest.createdAt) > history.checkpointMaxAge;
    if (since < history.checkpointEvery && !stale) return;

    final state = await store.read((reader) => reader.baseState());
    final keys = state.keys.toList()..sort(_compareKeys);
    await backend.putCheckpoint(
      Checkpoint(
        revision: base.revision,
        schemaVersion: schema.version,
        stateDigest: base.digest,
        entities: [
          for (final key in keys)
            Change(collection: key.collection, id: key.id, value: state[key]),
        ],
        createdAt: DateTime.now().toUtc(),
      ),
    );
    await _compact();
  }

  Future<void> _compact() async {
    final points = await backend.restorePoints();
    final unpinned = points.where((point) => !point.pinned).toList()
      ..sort((a, b) => b.revision.compareTo(a.revision));
    final keep = options.history.keepRestorePoints;
    final dropped = unpinned.skip(keep).toList();
    if (dropped.isNotEmpty) {
      await backend.deleteRestorePoints([for (final point in dropped) point.key]);
    }
    final retained = [
      ...points.where((point) => point.pinned),
      ...unpinned.take(keep),
    ];
    final base = await store.read((reader) => reader.base());
    final oldest = retained.isEmpty
        ? base.revision
        : retained.map((point) => point.revision).reduce((a, b) => a < b ? a : b);
    final anchor = await backend.checkpoint(atOrBefore: oldest);
    if (anchor != null && anchor.revision > 0) {
      await backend.compact(anchor: anchor.revision);
    }
  }

  // ---------------------------------------------------------------------------
  // Scheduling (spec §14, §20)
  // ---------------------------------------------------------------------------

  void _schedule() {
    _cancelTimers();
    unawaited(_hintSubscription?.cancel());
    _hintSubscription = null;
    if (!_ready || _disposed) return;
    if (_mode == SyncMode.vcs) {
      final check = options.vcs.remoteCheckEvery;
      if (check != null) {
        _pollTimer = Timer.periodic(check, (_) => unawaited(_guard(checkRemote)));
      }
      final autoPush = options.vcs.autoPushEvery;
      if (autoPush != null) {
        _autoPushTimer = Timer.periodic(autoPush, (_) async {
          if (_status.pendingCount > 0) {
            await _guard(() => push(userInitiated: false));
          }
        });
      }
    } else {
      final poll = options.realtime.poll;
      if (poll != null) {
        _pollTimer = Timer.periodic(poll, (_) => _requestCycle());
      }
      _hintSubscription = backend.hints?.listen((_) {
        _debounceTimer?.cancel();
        _debounceTimer = Timer(options.realtime.hintDelay, _requestCycle);
      });
    }
  }

  void _onLocalChange(ChangeEvent event) {
    unawaited(_publishStatus());
    if (!_ready || _mode != SyncMode.realtime) return;
    if (event.origin == ChangeOrigin.remote) return;
    _debounceTimer?.cancel();
    _debounceTimer = Timer(options.realtime.debounce, _fireLocalPush);
    _maxDelayTimer ??= Timer(options.realtime.maxDelay, _fireLocalPush);
  }

  void _fireLocalPush() {
    _debounceTimer?.cancel();
    _maxDelayTimer?.cancel();
    _maxDelayTimer = null;
    _requestCycle();
  }

  /// Runs one sync cycle soon, collapsing requests that arrive while one is
  /// already queued.
  void _requestCycle() {
    if (!_ready || _disposed || _cycleQueued) return;
    _cycleQueued = true;
    scheduleMicrotask(() async {
      _cycleQueued = false;
      await _guard(sync);
    });
  }

  /// Runs an automatic operation, turning failures into status and a
  /// backed-off retry instead of an unhandled error.
  Future<void> _guard(Future<void> Function() body) async {
    try {
      await body();
      _failures = 0;
      _retryTimer?.cancel();
    } on SyncUnavailableException {
      // Nothing to do until the account situation changes.
    } catch (_) {
      _failures++;
      final seconds = 1 << (_failures - 1).clamp(0, 8);
      final delay = Duration(seconds: seconds > 300 ? 300 : seconds);
      _retryTimer?.cancel();
      if (!_disposed && _ready) {
        _retryTimer = Timer(delay, () {
          if (_mode == SyncMode.realtime) {
            _requestCycle();
          } else {
            unawaited(_guard(checkRemote));
          }
        });
      }
    }
  }

  Future<void> _guardBackend(Future<void> Function() body) async {
    try {
      await body();
    } on BackendException {
      // Maintenance is best-effort; the next successful cycle retries it.
    }
  }

  void _cancelTimers() {
    _pollTimer?.cancel();
    _autoPushTimer?.cancel();
    _debounceTimer?.cancel();
    _maxDelayTimer?.cancel();
    _maxDelayTimer = null;
    _retryTimer?.cancel();
  }

  // ---------------------------------------------------------------------------
  // Operations and status
  // ---------------------------------------------------------------------------

  Future<void> _operation(
    SyncActivity activity,
    Future<void> Function() body,
  ) => _queue.run(() async {
    if (!_ready) {
      throw SyncUnavailableException(
        _account == null
            ? SyncRelation.signedOut
            : SyncRelation.accountMismatch,
      );
    }
    _activity = activity;
    await _publishStatus();
    try {
      await body();
      _problem = null;
    } on TransientBackendException catch (error) {
      _problem = SyncProblem(SyncProblemKind.offline, error.message);
      rethrow;
    } on AuthRequiredException catch (error) {
      _problem = SyncProblem(SyncProblemKind.authRequired, error.message);
      rethrow;
    } on SyncIntegrityException catch (error) {
      _problem = SyncProblem(SyncProblemKind.integrity, error.message);
      rethrow;
    } catch (error) {
      _problem = SyncProblem(SyncProblemKind.error, '$error');
      rethrow;
    } finally {
      _activity = SyncActivity.idle;
      await _publishStatus();
    }
  });

  Future<void> _publishStatus() async {
    if (_disposed) return;
    final (base, pending) = await store.read(
      (reader) async => (await reader.base(), await reader.allPending()),
    );
    final heldGroups = {
      for (final row in pending)
        if (row.heldUnit != null) row.grp,
    };
    final held = pending.where((row) => heldGroups.contains(row.grp)).length;
    final publishable = pending.length - held;
    final conflictUnits = await store.read(
      (reader) async =>
          (await reader.conflicts()).map((record) => record.unitId).toSet(),
    );
    final head = _headChecked ? (_knownHead ?? 0) : base.revision;

    final SyncRelation relation;
    if (_account == null) {
      relation = SyncRelation.signedOut;
    } else if (_accountMismatch) {
      relation = SyncRelation.accountMismatch;
    } else if (_remoteTooNew) {
      relation = SyncRelation.remoteSchemaTooNew;
    } else if (conflictUnits.isNotEmpty) {
      relation = SyncRelation.conflicted;
    } else if (_headChecked && _knownHead == null) {
      relation = SyncRelation.remoteEmpty;
    } else if (publishable > 0 && head > base.revision) {
      relation = SyncRelation.diverged;
    } else if (publishable > 0) {
      relation = SyncRelation.localAhead;
    } else if (head > base.revision) {
      relation = SyncRelation.remoteAhead;
    } else {
      relation = SyncRelation.upToDate;
    }

    _status = SyncStatus(
      relation: relation,
      activity: _activity,
      problem: _problem,
      mode: _mode,
      account: _account,
      pendingCount: publishable,
      heldCount: held,
      conflictCount: conflictUnits.length,
      baseRevision: base.revision,
      knownHeadRevision: _headChecked ? _knownHead : null,
      lastCheckedAt: _lastCheckedAt,
      lastSyncedAt: _lastSyncedAt,
    );
    if (!_statusController.isClosed) _statusController.add(_status);
  }
}

Json? _decodeOrNull(String? value) =>
    value == null ? null : decodeDocument(value);

int _compareKeys(DocKey a, DocKey b) {
  final byCollection = a.collection.compareTo(b.collection);
  return byCollection != 0 ? byCollection : a.id.compareTo(b.id);
}

class _Queue {
  Future<void> _last = Future<void>.value();

  Future<T> run<T>(Future<T> Function() body) {
    final done = Completer<void>();
    final previous = _last;
    _last = done.future;
    return previous.then((_) => body()).whenComplete(done.complete);
  }
}
