import 'package:entanglement/entanglement.dart';
import 'package:entanglement/sqlite.dart';

final boards = Collection.json(
  'boards',
  fields: {'id', 'name', 'color'},
  merge: const MergePolicy.fieldwise(),
);

final tasks = Collection.json(
  'tasks',
  fields: {'id', 'title', 'boardId', 'done', 'order'},
  indexes: {'boardId'},
  refs: (doc) => [Ref('boards', doc['boardId']! as String)],
  merge: const MergePolicy.fieldwise(),
);

final notes = Collection.json('notes', fields: {'id', 'text'});

final prefs = Collection.json('prefs', sync: false);

Schema testSchema({int version = 1, int? compatibleSince, Map<int, DocumentMigration> migrations = const {}}) =>
    Schema(
      version: version,
      compatibleSince: compatibleSince,
      collections: [boards, tasks, notes, prefs],
      migrations: migrations,
    );

const quietOptions = SyncOptions(
  deviceLabel: 'test',
  vcs: VcsOptions(remoteCheckEvery: null),
  history: HistoryOptions(dailyRestorePoints: false),
);

/// One simulated device: its own database, signed in to a shared server.
class Device {
  Device._(this.name, this.db, this.accounts);

  static Future<Device> create(
    InMemoryServer server, {
    String name = 'device',
    String? account = 'alice',
    SyncOptions options = quietOptions,
    Schema? schema,
    SqlExecutor? executor,
  }) async {
    final accounts = ManualAccountSource(account);
    final db = await EntanglementDb.open(
      executor: executor ?? SqliteExecutor.memory(),
      schema: schema ?? testSchema(),
      backend: InMemoryBackend(server, accounts),
      accounts: accounts,
      options: SyncOptions(
        defaultMode: options.defaultMode,
        vcs: options.vcs,
        realtime: options.realtime,
        history: options.history,
        deviceLabel: name,
      ),
    );
    return Device._(name, db, accounts);
  }

  final String name;
  final EntanglementDb db;
  final ManualAccountSource accounts;

  SyncEngine get sync => db.sync!;

  Future<void> addBoard(String id, String name) =>
      db.write((tx) => tx.put(boards, {'id': id, 'name': name}));

  Future<void> addTask(String id, String title, String boardId, {int order = 0}) =>
      db.write(
        (tx) => tx.put(tasks, {
          'id': id,
          'title': title,
          'boardId': boardId,
          'done': false,
          'order': order,
        }),
      );

  Future<Json?> task(String id) => db.get(tasks, id);

  Future<Json?> board(String id) => db.get(boards, id);

  /// Every synced document, for convergence checks.
  Future<Map<DocKey, String>> state() =>
      db.store.read((reader) => reader.currentState());

  Future<void> close() => db.close();
}
