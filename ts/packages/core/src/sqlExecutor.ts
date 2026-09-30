export type SqlValue = string | number | bigint | Uint8Array | null;

export type Row = Record<string, SqlValue>;

/**
 * The only way the core touches SQLite (spec §6.3). Mirrors the Dart
 * interface, so every platform — sql.js in Obsidian or a browser, op-sqlite
 * in React Native, better-sqlite3 in Node — implements the same five methods
 * over the same SQL.
 */
export interface SqlExecutor {
  select(sql: string, args?: readonly SqlValue[]): Promise<Row[]>;

  execute(sql: string, args?: readonly SqlValue[]): Promise<void>;

  /**
   * Runs `body` inside `BEGIN IMMEDIATE … COMMIT`, rolling back if it throws.
   * Never nested: the store serialises all access.
   */
  transaction<T>(body: () => Promise<T>): Promise<T>;

  /** `PRAGMA data_version`: changes when another connection commits. */
  dataVersion(): Promise<number>;

  close(): Promise<void>;
}
