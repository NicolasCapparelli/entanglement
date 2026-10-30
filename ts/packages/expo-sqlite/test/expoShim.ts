import { DatabaseSync } from "node:sqlite";

import type { ExpoSqliteDatabase } from "../src/index.js";

/**
 * expo-sqlite cannot run in Node, so this implements its async database API
 * over Node's built-in SQLite. Same SQLite engine, same call shapes
 * (positional params, rows as objects, multi-statement execAsync).
 */
export class NodeExpoShim implements ExpoSqliteDatabase {
  private readonly db: DatabaseSync;

  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
  }

  async execAsync(source: string): Promise<void> {
    this.db.exec(source);
  }

  async runAsync(source: string, params: (string | number | Uint8Array | null)[]): Promise<unknown> {
    return this.db.prepare(source).run(...params);
  }

  async getAllAsync<T>(source: string, params: (string | number | Uint8Array | null)[]): Promise<T[]> {
    return this.db.prepare(source).all(...params).map((row) => ({ ...row })) as T[];
  }

  async closeAsync(): Promise<void> {
    this.db.close();
  }
}
