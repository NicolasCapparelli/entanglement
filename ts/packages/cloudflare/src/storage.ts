/**
 * The slice of Durable Object SQLite storage the server uses. A Durable
 * Object's `ctx.storage` satisfies it as-is; tests satisfy it with node:sqlite.
 */
export interface SqlCursorLike {
  toArray(): Record<string, unknown>[];
}

export interface SqlStorageLike {
  exec(query: string, ...bindings: unknown[]): SqlCursorLike;
}

export interface SyncStorage {
  readonly sql: SqlStorageLike;
  /** Runs `body` atomically; it must not await. */
  transactionSync<T>(body: () => T): T;
}
