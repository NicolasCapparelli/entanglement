/// The only way the core touches SQLite (spec §6.3).
///
/// Keeping this surface tiny is what makes the core portable: a React Native
/// port implements the same five methods over op-sqlite or expo-sqlite and
/// runs the same SQL.
abstract interface class SqlExecutor {
  Future<List<Map<String, Object?>>> select(
    String sql, [
    List<Object?> args = const [],
  ]);

  Future<void> execute(String sql, [List<Object?> args = const []]);

  /// Runs [body] inside `BEGIN IMMEDIATE … COMMIT`, rolling back if it throws.
  /// Never nested: the store serialises all access.
  Future<T> transaction<T>(Future<T> Function() body);

  /// `PRAGMA data_version`: changes when another connection commits.
  Future<int> dataVersion();

  Future<void> close();
}
