import 'dart:async';

import 'cipher.dart';
import 'engine.dart';
import 'protocol.dart';
import 'query.dart';
import 'schema.dart';
import 'sql_executor.dart';
import 'store.dart';
import 'sync_types.dart';
import 'tx.dart';

/// Whether this instance syncs (spec §8.3). Exactly one instance per device
/// should be the leader; others — a widget isolate, a background task — open
/// as passive: they read and write, but never talk to the backend.
enum SyncRole { leader, passive }

/// A local-first database that syncs (spec §21).
///
/// ```dart
/// final db = await EntanglementDb.open(
///   executor: SqliteExecutor.open(path),
///   schema: Schema(version: 1, collections: [tasks, boards]),
///   backend: backend,
///   accounts: accounts,
/// );
/// await db.write((tx) async => tx.put(tasks, task));
/// db.query(tasks).where('boardId', isEqualTo: id).watch();
/// await db.sync!.push(message: 'Before the trip');
/// ```
/// What [EntanglementDb.attachSync] does when the remote already has history
/// and this device has local data it has never synced.
enum RemoteHistoryChoice {
  /// Throw [SyncRemoteHasHistoryException]; nothing changes.
  refuse,

  /// Ordinary three-way merge against an empty ancestor.
  merge,

  /// `discardLocalAndPull` (local changes are backed up first).
  useRemote,

  /// `overwriteRemoteWithLocal` (the remote is restore-pointed first).
  useLocal,
}

/// Thrown by [EntanglementDb.attachSync] when the remote has history that this
/// device's local data was never part of.
class SyncRemoteHasHistoryException implements Exception {
  SyncRemoteHasHistoryException(this.remoteRevision, this.localChanges);

  final int remoteRevision;
  final int localChanges;

  @override
  String toString() =>
      'SyncRemoteHasHistoryException: the remote already has history (revision '
      '$remoteRevision) and this device holds $localChanges unsynced '
      "document(s). Pass ifRemoteHasHistory: merge, useRemote or useLocal.";
}

class EntanglementDb {
  EntanglementDb._(this.store, this._sync, this._role);

  final SyncRole _role;
  SyncEngine? _sync;

  static Future<EntanglementDb> open({
    required SqlExecutor executor,
    required Schema schema,
    SyncBackend? backend,
    AccountSource? accounts,
    SyncOptions options = const SyncOptions(),
    SyncRole role = SyncRole.leader,

    /// Encrypts everything sent to [backend] (spec/cipher.md).
    Cipher? cipher,
  }) async {
    final store = await EntanglementStore.open(executor, schema);
    SyncEngine? engine;
    if (backend != null && accounts != null && role == SyncRole.leader) {
      engine = SyncEngine(
        store: store,
        backend: cipher == null ? backend : EncryptedBackend(backend, cipher),
        accounts: accounts,
        options: options,
      );
      await engine.start();
    }
    return EntanglementDb._(store, engine, role);
  }

  final EntanglementStore store;

  /// Sync controls, or null for a local-only or passive instance (changes
  /// with [attachSync] and [detachSync]).
  SyncEngine? get sync => _sync;

  /// Turns sync on for an open, local-only database. Local history is kept:
  /// unsynced documents are published by the first cycle (an empty remote
  /// receives them as revision 1). If the remote already has commits and this
  /// device has never-synced data, [ifRemoteHasHistory] decides (default:
  /// throw, leaving the database untouched). Returns the new engine.
  Future<SyncEngine> attachSync({
    required SyncBackend backend,
    required AccountSource accounts,
    SyncOptions options = const SyncOptions(),
    Cipher? cipher,
    RemoteHistoryChoice ifRemoteHasHistory = RemoteHistoryChoice.refuse,
  }) async {
    if (_sync != null) {
      throw StateError('Sync is already attached; call detachSync() first.');
    }
    if (_role != SyncRole.leader) {
      throw StateError('Only the leader instance can sync.');
    }
    final wrapped = cipher == null ? backend : EncryptedBackend(backend, cipher);
    final (base, pending) = await store.read((reader) async => (
      await reader.base(),
      await reader.allPending(),
    ));
    final unsynced = base.revision == 0 ? pending.length : 0;
    var needsChoice = false;
    if (unsynced > 0 && ifRemoteHasHistory != RemoteHistoryChoice.merge) {
      final head = await wrapped.head();
      if (head != null) {
        if (ifRemoteHasHistory == RemoteHistoryChoice.refuse) {
          throw SyncRemoteHasHistoryException(head.revision, unsynced);
        }
        needsChoice = true;
      }
    }
    final engine = SyncEngine(
      store: store,
      backend: wrapped,
      accounts: accounts,
      options: options,
    );
    await engine.start(hold: needsChoice);
    if (needsChoice) {
      try {
        if (ifRemoteHasHistory == RemoteHistoryChoice.useRemote) {
          await engine.discardLocalAndPull();
        } else {
          await engine.overwriteRemoteWithLocal();
        }
      } catch (_) {
        await engine.dispose();
        rethrow;
      }
      engine.release();
    }
    _sync = engine;
    return engine;
  }

  /// Turns sync off. Local data, pending changes and the sync base stay, so
  /// [attachSync] later continues where it left off.
  Future<void> detachSync() async {
    final engine = _sync;
    if (engine == null) return;
    _sync = null;
    await engine.dispose();
  }

  /// Runs [body] as one atomic, coupled transaction (spec §7.1).
  Future<T> write<T>(Future<T> Function(Tx tx) body) =>
      store.transact((txn) => body(Tx(txn)));

  Future<T?> get<T>(Collection<T> collection, String id) => store.read(
    (reader) async {
      final json = await reader.getJson(docKey(collection.name, id));
      return json == null ? null : collection.decode(json);
    },
  );

  Future<List<T>> getAll<T>(Collection<T> collection) =>
      query(collection).get();

  Query<T> query<T>(Collection<T> collection) => Query(store, collection);

  Stream<List<T>> watchAll<T>(Collection<T> collection) =>
      query(collection).watch();

  /// Every committed change, with its origin (spec §8.2).
  Stream<ChangeEvent> get changes => store.changes;

  /// Picks up writes made by other connections or processes (spec §8.3).
  Future<bool> checkForExternalChanges() => store.checkExternalChanges();

  Future<void> close() async {
    await sync?.dispose();
    await store.close();
  }
}
