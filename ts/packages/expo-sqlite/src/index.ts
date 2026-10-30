import type { Row, SqlExecutor, SqlValue } from "@entanglement/core";

/**
 * The slice of expo-sqlite's `SQLiteDatabase` (the async API) this executor
 * uses. Declared structurally so the package needs no build-time dependency
 * on expo-sqlite and tests can supply a shim.
 */
export interface ExpoSqliteDatabase {
  execAsync(source: string): Promise<void>;
  runAsync(source: string, params: (string | number | Uint8Array | null)[]): Promise<unknown>;
  getAllAsync<T>(source: string, params: (string | number | Uint8Array | null)[]): Promise<T[]>;
  closeAsync(): Promise<void>;
}

export interface ExpoSqliteExecutorOptions {
  /** Skip the connection pragmas (WAL, NORMAL sync, busy timeout) if you set your own. */
  skipPragmas?: boolean;
}

/**
 * [SqlExecutor] over expo-sqlite, for React Native (iOS and Android).
 *
 * ```ts
 * const db = await SQLite.openDatabaseAsync("app.db");
 * const executor = await ExpoSqliteExecutor.create(db);
 * ```
 *
 * Transactions are `BEGIN IMMEDIATE … COMMIT` on this one connection, so the
 * write lock is taken up front and a second process fails fast instead of
 * deadlocking at COMMIT. (`withExclusiveTransactionAsync` is deliberately not
 * used: it runs on a separate connection, which cannot see the store's work
 * between calls.) The store serialises access, so transactions never nest.
 */
export class ExpoSqliteExecutor implements SqlExecutor {
  private constructor(private readonly db: ExpoSqliteDatabase) {}

  static async create(db: ExpoSqliteDatabase, options: ExpoSqliteExecutorOptions = {}): Promise<ExpoSqliteExecutor> {
    if (!options.skipPragmas) {
      await db.execAsync("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
    }
    return new ExpoSqliteExecutor(db);
  }

  select(sql: string, args: readonly SqlValue[] = []): Promise<Row[]> {
    return this.db.getAllAsync<Row>(sql, bindable(args));
  }

  async execute(sql: string, args: readonly SqlValue[] = []): Promise<void> {
    await this.db.runAsync(sql, bindable(args));
  }

  async transaction<T>(body: () => Promise<T>): Promise<T> {
    await this.db.execAsync("BEGIN IMMEDIATE");
    try {
      const result = await body();
      await this.db.execAsync("COMMIT");
      return result;
    } catch (error) {
      try {
        await this.db.execAsync("ROLLBACK");
      } catch {
        // The original failure matters more than a failed rollback.
      }
      throw error;
    }
  }

  async dataVersion(): Promise<number> {
    const rows = await this.db.getAllAsync<Record<string, unknown>>("PRAGMA data_version", []);
    return Number(rows[0]?.data_version ?? 0);
  }

  close(): Promise<void> {
    return this.db.closeAsync();
  }
}

// expo-sqlite binds numbers, strings, blobs and null; 64-bit ints come as numbers.
function bindable(args: readonly SqlValue[]): (string | number | Uint8Array | null)[] {
  return args.map((value) => (typeof value === "bigint" ? Number(value) : value));
}
