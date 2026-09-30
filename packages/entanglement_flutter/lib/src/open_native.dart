import 'package:entanglement/entanglement.dart';
import 'package:entanglement/sqlite.dart';
import 'package:path_provider/path_provider.dart';
import 'package:sqlite3_flutter_libs/sqlite3_flutter_libs.dart';

/// Opens [fileName] in the app's support directory with the SQLite bundled by
/// `sqlite3_flutter_libs`, so every platform runs the same SQLite.
Future<SqlExecutor> openAppDatabase(String fileName) async {
  await applyWorkaroundToOpenSqlite3OnOldAndroidVersions();
  final directory = await getApplicationSupportDirectory();
  return SqliteExecutor.open('${directory.path}/$fileName');
}
