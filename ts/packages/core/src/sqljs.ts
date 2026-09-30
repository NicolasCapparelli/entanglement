import type { Database } from "sql.js";

import type { Row, SqlExecutor, SqlValue } from "./sqlExecutor.js";

export interface SqlJsExecutorOptions {
  /**
   * Saves the whole database file. sql.js keeps the database in memory, so
   * this is what makes it durable: called after committed transactions
   * (debounced) and on close. For Obsidian, write the bytes to the plugin
   * folder with the vault adapter.
   */
  persist?: (bytes: Uint8Array) => Promise<void> | void;

  /** Quiet period before persisting, so bursts of writes save once. */
  persistDelayMs?: number;
}

/**
 * [SqlExecutor] over sql.js (SQLite compiled to WebAssembly). Runs anywhere
 * JavaScript does — Obsidian desktop and mobile, browsers, Node — with the
 * same SQLite on every platform.
 *
 * Datasets are small, so persisting means exporting the whole file. Writes are
 * durable once `persist` has run; a crash inside the debounce window loses
 * those writes locally, exactly like closing an app before it saves.
 */
export class SqlJsExecutor implements SqlExecutor {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private saving: Promise<void> = Promise.resolve();
  private readonly persistDelayMs: number;

  constructor(
    private readonly db: Database,
    private readonly options: SqlJsExecutorOptions = {},
  ) {
    this.persistDelayMs = options.persistDelayMs ?? 500;
  }

  async select(sql: string, args: readonly SqlValue[] = []): Promise<Row[]> {
    const statement = this.db.prepare(sql);
    try {
      statement.bind(bindable(args));
      const rows: Row[] = [];
      while (statement.step()) rows.push(statement.getAsObject() as Row);
      return rows;
    } finally {
      statement.free();
    }
  }

  async execute(sql: string, args: readonly SqlValue[] = []): Promise<void> {
    this.db.run(sql, bindable(args));
  }

  async transaction<T>(body: () => Promise<T>): Promise<T> {
    this.db.run("BEGIN IMMEDIATE");
    let result: T;
    try {
      result = await body();
      this.db.run("COMMIT");
    } catch (error) {
      this.db.run("ROLLBACK");
      throw error;
    }
    this.schedulePersist();
    return result;
  }

  async dataVersion(): Promise<number> {
    const rows = await this.select("PRAGMA data_version");
    return Number(rows[0]?.data_version ?? 0);
  }

  /** Persists now if anything changed since the last save. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const persist = this.options.persist;
    if (!persist || !this.dirty) return this.saving;
    this.dirty = false;
    const bytes = this.db.export();
    this.saving = this.saving.then(() => persist(bytes));
    return this.saving;
  }

  async close(): Promise<void> {
    await this.flush();
    this.db.close();
  }

  private schedulePersist(): void {
    if (!this.options.persist) return;
    this.dirty = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.persistDelayMs);
  }
}

function bindable(args: readonly SqlValue[]): (string | number | Uint8Array | null)[] {
  return args.map((value) => (typeof value === "bigint" ? Number(value) : value));
}
