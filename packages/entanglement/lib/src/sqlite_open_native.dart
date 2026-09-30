import 'package:sqlite3/common.dart';
import 'package:sqlite3/sqlite3.dart';

CommonDatabase openFile(String path) {
  final db = sqlite3.open(path);
  db.execute('PRAGMA journal_mode = WAL');
  // In WAL mode NORMAL is still crash-safe (a power cut can only drop the
  // last commits, never corrupt the file) and skips the fsync on every
  // commit, which on the UI isolate made each write a visible stall.
  db.execute('PRAGMA synchronous = NORMAL');
  db.execute('PRAGMA busy_timeout = 5000');
  return db;
}

CommonDatabase openMemory() => sqlite3.openInMemory();
