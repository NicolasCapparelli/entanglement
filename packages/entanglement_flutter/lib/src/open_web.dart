import 'package:entanglement/entanglement.dart';
import 'package:entanglement/sqlite.dart';
import 'package:sqlite3/wasm.dart';

/// Opens [fileName] in the browser: SQLite compiled to WebAssembly, loaded
/// from `sqlite3.wasm` at the web root, with the file kept in IndexedDB.
///
/// The app must serve a `sqlite3.wasm` matching `package:sqlite3`'s version
/// (the same file Drift's web setup uses).
Future<SqlExecutor> openAppDatabase(String fileName) async {
  final sqlite3 = await WasmSqlite3.loadFromUrl(Uri.parse('sqlite3.wasm'));
  final fileSystem = await IndexedDbFileSystem.open(dbName: 'entanglement');
  sqlite3.registerVirtualFileSystem(fileSystem, makeDefault: true);
  return SqliteExecutor(sqlite3.open('/$fileName'));
}
