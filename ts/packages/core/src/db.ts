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
/** What `attachSync` does when the remote already has history and this device has unsynced local data. */
export type RemoteHistoryChoice = "refuse" | "merge" | "useRemote" | "useLocal";

export interface AttachSyncOptions {
  backend: SyncBackend;
  accounts: AccountSource;
  options?: SyncOptions;
  /** Encrypts everything sent to the backend (spec/cipher.md). */
  cipher?: Cipher;
  /**
   * Only consulted when the remote already has commits AND this device has
   * local data it has never synced. A remote that is empty, or a device with
   * nothing unsynced, never needs a choice.
   * - `refuse` (default): throw `SyncRemoteHasHistoryError`; nothing changes.
   * - `merge`: ordinary three-way merge against an empty ancestor.
   * - `useRemote`: `discardLocalAndPull` (local changes are backed up first).
   * - `useLocal`: `overwriteRemoteWithLocal` (the remote is restore-pointed first).
   */
  ifRemoteHasHistory?: RemoteHistoryChoice;
}

/** Thrown by `attachSync` when the remote has history that this device's local data was never part of. */
export class SyncRemoteHasHistoryError extends Error {
  constructor(
    readonly remoteRevision: number,
    readonly localChanges: number,
  ) {
    super(
      `The remote already has history (revision ${remoteRevision}) and this device holds ${localChanges} ` +
        "unsynced document(s). Pass ifRemoteHasHistory: 'merge' | 'useRemote' | 'useLocal'.",
    );
    this.name = "SyncRemoteHasHistoryError";
  }
}

export class EntanglementDb {
  private engine: SyncEngine | null;

  private constructor(
    readonly store: EntanglementStore,
    engine: SyncEngine | null,
    private readonly role: SyncRole,
  ) {
    this.engine = engine;
  }

  /** Sync controls, or null for a local-only or passive instance (changes with `attachSync` / `detachSync`). */
  get sync(): SyncEngine | null {
    return this.engine;
  }

  /**
   * Turns sync on for an open, local-only database. Local history is kept:
   * unsynced documents are published by the first cycle (an empty remote
   * receives them as revision 1). If the remote already has commits and this
   * device has never-synced data, `ifRemoteHasHistory` decides (default:
   * throw, leaving the database untouched). Returns the new engine.
   */
  async attachSync(options: AttachSyncOptions): Promise<SyncEngine> {
    if (this.engine) throw new Error("Sync is already attached; call detachSync() first.");
    if (this.role !== "leader") throw new Error("Only the leader instance can sync.");
    const backend = options.cipher ? new EncryptedBackend(options.backend, options.cipher) : options.backend;
    const choice = options.ifRemoteHasHistory ?? "refuse";
    const { base, pending } = await this.store.read(async (reader) => ({
      base: await reader.base(),
      pending: await reader.allPending(),
    }));
    const unsynced = base.revision === 0 ? pending.length : 0;
    let needsChoice = false;
    if (unsynced > 0 && choice !== "merge") {
      const head = await backend.head();
      if (head !== null) {
        if (choice === "refuse") throw new SyncRemoteHasHistoryError(head.revision, unsynced);
        needsChoice = true;
      }
    }
    const engine = new SyncEngine(this.store, backend, options.accounts, options.options);
    await engine.start({ hold: needsChoice });
    if (needsChoice) {
      try {
        if (choice === "useRemote") await engine.discardLocalAndPull();
        else if (choice === "useLocal") await engine.overwriteRemoteWithLocal();
      } catch (error) {
        await engine.dispose();
        throw error;
      }
      engine.release();
    }
    this.engine = engine;
    return engine;
  }

  /** Turns sync off. Local data, pending changes and the sync base stay, so `attachSync` later continues where it left off. */
  async detachSync(): Promise<void> {
    const engine = this.engine;
    if (!engine) return;
    this.engine = null;
    await engine.dispose();
  }

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
    return new EntanglementDb(store, engine, options.role ?? "leader");
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
    await this.engine?.dispose();
    await this.store.close();
  }
}
