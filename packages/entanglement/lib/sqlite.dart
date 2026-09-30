/// [SqlExecutor] over `package:sqlite3`. Separate from the core library so the
/// core never imports a SQLite binding (spec §3.3).
library;

export 'src/sqlite_executor.dart';
