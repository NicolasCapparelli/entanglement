import { EncryptedBackend, type Cipher } from "./cipher.js";
import type { Unsubscribe } from "./emitter.js";
import { SyncEngine } from "./engine.js";
import type { AccountSource, SyncBackend } from "./protocol.js";
import { Query } from "./query.js";
import { keyString, type Collection, type Schema } from "./schema.js";
import type { SqlExecutor } from "./sqlExecutor.js";
import { EntanglementStore, type ChangeEvent } from "./store.js";
import type { SyncOptions } from "./syncTypes.js";
import { Tx } from "./tx.js";

/**
 * Whether this instance syncs (spec §8.3). One instance per device should be
 * the leader; others read and write but never talk to the backend.
 */
export type SyncRole = "leader" | "passive";

export interface OpenOptions {
  executor: SqlExecutor;
  schema: Schema;
  backend?: SyncBackend;
  accounts?: AccountSource;
  options?: SyncOptions;
  role?: SyncRole;
  /** Encrypts everything sent to the backend (spec/cipher.md). */
  cipher?: Cipher;
}

/**
 * A local-first database that syncs (spec §21).
 *
 * ```ts
 * const db = await EntanglementDb.open({ executor, schema, backend, accounts });
 * await db.write(async (tx) => tx.put(tasks, task));
 * const stop = db.query(tasks).where("boardId", { isEqualTo: id }).watch(render);
 * await db.sync?.push({ message: "Before the trip" });
 * ```
 */
export class EntanglementDb {
  private constructor(
    readonly store: EntanglementStore,
    /** Sync controls, or null for a local-only or passive instance. */
    readonly sync: SyncEngine | null,
  ) {}

  static async open(options: OpenOptions): Promise<EntanglementDb> {
    const store = await EntanglementStore.open(options.executor, options.schema);
    let engine: SyncEngine | null = null;
    if (options.backend && options.accounts && (options.role ?? "leader") === "leader") {
      engine = new SyncEngine(
        store,
        options.cipher ? new EncryptedBackend(options.backend, options.cipher) : options.backend,
        options.accounts,
        options.options,
      );
      await engine.start();
    }
    return new EntanglementDb(store, engine);
  }

  /** Runs `body` as one atomic, coupled transaction (spec §7.1). */
  write<T>(body: (tx: Tx) => Promise<T>): Promise<T> {
    return this.store.transact((txn) => body(new Tx(txn)));
  }

  get<T>(collection: Collection<T>, id: string): Promise<T | null> {
    return this.store.read(async (reader) => {
      const json = await reader.getJson(keyString(collection.name, id));
      return json === null ? null : collection.decode(json);
    });
  }

  getAll<T>(collection: Collection<T>): Promise<T[]> {
    return this.query(collection).get();
  }

  query<T>(collection: Collection<T>): Query<T> {
    return Query.of(this.store, collection);
  }

  watchAll<T>(collection: Collection<T>, listener: (results: T[]) => void): Unsubscribe {
    return this.query(collection).watch(listener);
  }

  /** Every committed change, with its origin (spec §8.2). */
  onChange(listener: (event: ChangeEvent) => void): Unsubscribe {
    return this.store.onChange(listener);
  }

  /** Picks up writes made by other connections (spec §8.3). */
  checkForExternalChanges(): Promise<boolean> {
    return this.store.checkExternalChanges();
  }

  async close(): Promise<void> {
    await this.sync?.dispose();
    await this.store.close();
  }
}
