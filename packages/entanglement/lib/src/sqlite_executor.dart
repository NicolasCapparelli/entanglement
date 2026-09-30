import 'package:sqlite3/common.dart';

import 'sql_executor.dart';
import 'sqlite_open_stub.dart'
    if (dart.library.ffi) 'sqlite_open_native.dart'
    as platform;

/// [SqlExecutor] over `package:sqlite3`'s [CommonDatabase], running on the
/// calling isolate.
///
/// [CommonDatabase] is the API shared by native SQLite and the WebAssembly
/// build, so the same executor serves every platform; only opening differs.
/// Datasets are small and the API is already asynchronous, so a
/// background-isolate executor can replace this later without core changes.
class SqliteExecutor implements SqlExecutor {
  SqliteExecutor(this._db);

  /// Opens (or creates) a database file in WAL mode. Native platforms only;
  /// on the web, open a WASM database and pass it to the constructor.
  factory SqliteExecutor.open(String path) =>
      SqliteExecutor(platform.openFile(path));

  /// A private in-memory database, for tests. Native platforms only.
  factory SqliteExecutor.memory() => SqliteExecutor(platform.openMemory());

  final CommonDatabase _db;

  @override
  Future<List<Map<String, Object?>>> select(
    String sql, [
    List<Object?> args = const [],
  ]) async {
    final result = _db.select(sql, args);
    return [
      for (final row in result)
        {for (final column in result.columnNames) column: row[column]},
    ];
  }

  @override
  Future<void> execute(String sql, [List<Object?> args = const []]) async {
    _db.execute(sql, args);
  }

  @override
  Future<T> transaction<T>(Future<T> Function() body) async {
    _db.execute('BEGIN IMMEDIATE');
    try {
      final result = await body();
      _db.execute('COMMIT');
      return result;
    } catch (_) {
      _db.execute('ROLLBACK');
      rethrow;
    }
  }

  @override
  Future<int> dataVersion() async =>
      _db.select('PRAGMA data_version').first.columnAt(0) as int;

  @override
  Future<void> close() async => _db.dispose();
}
