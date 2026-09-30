import 'dart:async';

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
class EntanglementDb {
  EntanglementDb._(this.store, this.sync);

  static Future<EntanglementDb> open({
    required SqlExecutor executor,
    required Schema schema,
    SyncBackend? backend,
    AccountSource? accounts,
    SyncOptions options = const SyncOptions(),
    SyncRole role = SyncRole.leader,
  }) async {
    final store = await EntanglementStore.open(executor, schema);
    SyncEngine? engine;
    if (backend != null && accounts != null && role == SyncRole.leader) {
      engine = SyncEngine(
        store: store,
        backend: backend,
        accounts: accounts,
        options: options,
      );
      await engine.start();
    }
    return EntanglementDb._(store, engine);
  }

  final EntanglementStore store;

  /// Sync controls, or null for a local-only or passive instance.
  final SyncEngine? sync;

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
