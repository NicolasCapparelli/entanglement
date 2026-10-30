import type { Row, SqlExecutor, SqlValue } from "@entanglement/core";

/** The shape of `invoke` from `@tauri-apps/api/core`. */
export type TauriInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export interface TauriSqliteOptions {
  /** Override `invoke` (tests, or a custom IPC bridge). Defaults to `@tauri-apps/api/core`. */
  invoke?: TauriInvoke;
}

const PLUGIN = "plugin:entanglement-sqlite|";

// Wire encoding (matches the Rust plugin): null, numbers and strings are plain
// JSON; blobs are {"$blob": base64}; 64-bit integers outside JS's safe range
// are {"$int": "<decimal>"}.
type Wire = null | number | string | { $blob: string } | { $int: string };

function encode(value: SqlValue): Wire {
  if (value === null || typeof value === "number" || typeof value === "string") return value;
  if (typeof value === "bigint") return { $int: value.toString() };
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return { $blob: btoa(binary) };
}

function decode(value: unknown): SqlValue {
  if (value !== null && typeof value === "object") {
    const wire = value as { $blob?: string; $int?: string };
    if (typeof wire.$blob === "string") {
      const binary = atob(wire.$blob);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes;
    }
    if (typeof wire.$int === "string") return BigInt(wire.$int);
  }
  return value as SqlValue;
}

/**
 * [SqlExecutor] over the `tauri-plugin-entanglement-sqlite` Rust plugin. The
 * plugin keeps one serialized connection per database name, so a transaction
 * (`begin` .. `commit`) spans calls on the same connection. The file lives in
 * the app data directory.
 *
 * ```ts
 * const executor = await TauriSqliteExecutor.create("mille.db");
 * ```
 */
export class TauriSqliteExecutor implements SqlExecutor {
  private constructor(
    private readonly db: string,
    private readonly invoke: TauriInvoke,
  ) {}

  static async create(db: string, options: TauriSqliteOptions = {}): Promise<TauriSqliteExecutor> {
    const invoke = options.invoke ?? ((await import("@tauri-apps/api/core")).invoke as TauriInvoke);
    return new TauriSqliteExecutor(db, invoke);
  }

  private call<T>(command: string, extra: Record<string, unknown> = {}): Promise<T> {
    return this.invoke<T>(PLUGIN + command, { db: this.db, ...extra });
  }

  async select(sql: string, args: readonly SqlValue[] = []): Promise<Row[]> {
    const rows = await this.call<Record<string, unknown>[]>("select", { sql, args: args.map(encode) });
    return rows.map((row) => {
      const out: Row = {};
      for (const [key, value] of Object.entries(row)) out[key] = decode(value);
      return out;
    });
  }

  async execute(sql: string, args: readonly SqlValue[] = []): Promise<void> {
    await this.call<void>("execute", { sql, args: args.map(encode) });
  }

  async transaction<T>(body: () => Promise<T>): Promise<T> {
    await this.call<void>("begin");
    try {
      const result = await body();
      await this.call<void>("commit");
      return result;
    } catch (error) {
      try {
        await this.call<void>("rollback");
      } catch {
        // The original failure matters more than a failed rollback.
      }
      throw error;
    }
  }

  async dataVersion(): Promise<number> {
    return Number(await this.call<number>("data_version"));
  }

  async close(): Promise<void> {
    await this.call<void>("close");
  }
}
