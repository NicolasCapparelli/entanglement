import 'package:sqlite3/common.dart';

Never _unsupported() => throw UnsupportedError(
  'Opening a database by path needs native SQLite. On the web, open a WASM '
  'database (package:sqlite3/wasm.dart) and pass it to SqliteExecutor(...).',
);

CommonDatabase openFile(String path) => _unsupported();

CommonDatabase openMemory() => _unsupported();
