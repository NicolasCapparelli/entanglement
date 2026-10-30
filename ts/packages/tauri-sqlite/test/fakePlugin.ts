import { DatabaseSync } from "node:sqlite";

import type { TauriInvoke } from "../src/index.js";

/**
 * An in-process stand-in for the Rust plugin: the same command names, wire
 * encoding and connection-per-database-name behaviour, over node:sqlite.
 */
export class FakePlugin {
  private readonly dbs = new Map<string, DatabaseSync>();

  constructor(
    private readonly resolvePath: (name: string) => string = () => ":memory:",
    private readonly busyTimeoutMs = 5000,
  ) {}

  readonly invoke: TauriInvoke = async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    const name = command.replace("plugin:entanglement-sqlite|", "");
    const db = this.open(String(args.db));
    const sql = args.sql as string;
    const params = ((args.args as unknown[] | undefined) ?? []).map(toSql);
    switch (name) {
      case "select":
        const stmt = db.prepare(sql);
        stmt.setReadBigInts(true);
        return stmt.all(...params).map((row) => fromRow(row)) as T;
      case "execute":
        if (params.length === 0) db.exec(sql);
        else db.prepare(sql).run(...params);
        return undefined as T;
      case "begin":
        db.exec("BEGIN IMMEDIATE");
        return undefined as T;
      case "commit":
        db.exec("COMMIT");
        return undefined as T;
      case "rollback":
        db.exec("ROLLBACK");
        return undefined as T;
      case "data_version":
        return (db.prepare("PRAGMA data_version").get() as { data_version: number }).data_version as T;
      case "close":
        db.close();
        this.dbs.delete(String(args.db));
        return undefined as T;
      default:
        throw new Error(`unknown command ${command}`);
    }
  };

  private open(name: string): DatabaseSync {
    let db = this.dbs.get(name);
    if (!db) {
      db = new DatabaseSync(this.resolvePath(name));
      db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = ${this.busyTimeoutMs};`);
      this.dbs.set(name, db);
    }
    return db;
  }
}

function toSql(wire: unknown): null | number | bigint | string | Uint8Array {
  if (wire !== null && typeof wire === "object") {
    const w = wire as { $blob?: string; $int?: string };
    if (w.$blob !== undefined) return new Uint8Array(Buffer.from(w.$blob, "base64"));
    if (w.$int !== undefined) return BigInt(w.$int);
  }
  return wire as null | number | string;
}

function fromRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value instanceof Uint8Array) out[key] = { $blob: Buffer.from(value).toString("base64") };
    else if (typeof value === "bigint") out[key] = Math.abs(Number(value)) <= Number.MAX_SAFE_INTEGER ? Number(value) : { $int: value.toString() };
    else out[key] = value;
  }
  return out;
}
