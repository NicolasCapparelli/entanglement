import initSqlJs, { type SqlJsStatic } from "sql.js";

import {
  Collection,
  EntanglementDb,
  InMemoryBackend,
  ManualAccountSource,
  MergePolicy,
  Ref,
  Schema,
  type Cipher,
  type DocumentMigration,
  type InMemoryServer,
  type Json,
  type RemoteHistoryChoice,
  type KeyString,
  type SqlExecutor,
  type SyncBackend,
  type SyncOptions,
} from "../src/index.js";
import { SqlJsExecutor } from "../src/sqljs.js";

let sqlJs: Promise<SqlJsStatic> | null = null;

export async function memoryExecutor(): Promise<SqlJsExecutor> {
  sqlJs ??= initSqlJs();
  return new SqlJsExecutor(new (await sqlJs).Database());
}

export const boards = Collection.json("boards", {
  fields: ["id", "name", "color"],
  merge: MergePolicy.fieldwise(),
});

export const tasks = Collection.json("tasks", {
  fields: ["id", "title", "boardId", "done", "order"],
  indexes: ["boardId"],
  refs: (doc) => [new Ref("boards", doc.boardId as string)],
  merge: MergePolicy.fieldwise(),
});

export const notes = Collection.json("notes", { fields: ["id", "text"] });

export const prefs = Collection.json("prefs", { sync: false });

export function testSchema(
  options: { version?: number; compatibleSince?: number; migrations?: Record<number, DocumentMigration> } = {},
): Schema {
  return new Schema({
    version: options.version ?? 1,
    compatibleSince: options.compatibleSince,
    collections: [boards, tasks, notes, prefs],
    migrations: options.migrations,
  });
}

export const quietOptions: SyncOptions = {
  deviceLabel: "test",
  vcs: { remoteCheckEveryMs: null },
  history: { dailyRestorePoints: false },
};

/** One simulated device: its own database, signed in to a shared server. */
export class Device {
  private constructor(
    readonly name: string,
    readonly db: EntanglementDb,
    readonly accounts: ManualAccountSource,
  ) {}

  static async create(
    server: InMemoryServer | null,
    options: {
      name?: string;
      account?: string | null;
      sync?: SyncOptions;
      schema?: Schema;
      executor?: SqlExecutor;
      cipher?: Cipher;
      /** Replaces the in-memory backend (then `server` may be null). */
      backend?: (accounts: ManualAccountSource) => SyncBackend;
      /** Opens without a backend; call `attach()` later. */
      localOnly?: boolean;
    } = {},
  ): Promise<Device> {
    const name = options.name ?? "device";
    const accounts = new ManualAccountSource(options.account === undefined ? "alice" : options.account);
    const db = await EntanglementDb.open({
      executor: options.executor ?? (await memoryExecutor()),
      schema: options.schema ?? testSchema(),
      ...(options.localOnly
        ? {}
        : {
            backend: options.backend ? options.backend(accounts) : new InMemoryBackend(server!, accounts),
            accounts,
            cipher: options.cipher,
          }),
      options: { ...quietOptions, ...options.sync, deviceLabel: name },
    });
    return new Device(name, db, accounts);
  }

  /** Attaches any backend to a device created with `localOnly`. */
  attachBackend(backend: SyncBackend, ifRemoteHasHistory?: RemoteHistoryChoice, sync?: SyncOptions) {
    return this.db.attachSync({
      backend,
      accounts: this.accounts,
      options: { ...quietOptions, ...sync, deviceLabel: this.name },
      ifRemoteHasHistory,
    });
  }

  /** Attaches sync to a device created with `localOnly`. */
  attach(
    server: InMemoryServer,
    options: { ifRemoteHasHistory?: RemoteHistoryChoice; cipher?: Cipher; sync?: SyncOptions } = {},
  ) {
    return this.db.attachSync({
      backend: new InMemoryBackend(server, this.accounts),
      accounts: this.accounts,
      cipher: options.cipher,
      options: { ...quietOptions, ...options.sync, deviceLabel: this.name },
      ifRemoteHasHistory: options.ifRemoteHasHistory,
    });
  }

  get sync() {
    return this.db.sync!;
  }

  addBoard(id: string, name: string): Promise<void> {
    return this.db.write((tx) => tx.put(boards, { id, name }));
  }

  addTask(id: string, title: string, boardId: string, order = 0): Promise<void> {
    return this.db.write((tx) => tx.put(tasks, { id, title, boardId, done: false, order }));
  }

  task(id: string): Promise<Json | null> {
    return this.db.get(tasks, id);
  }

  board(id: string): Promise<Json | null> {
    return this.db.get(boards, id);
  }

  /** Every synced document, for convergence checks. */
  async state(): Promise<Map<KeyString, string>> {
    return this.db.store.read((reader) => reader.currentState());
  }

  close(): Promise<void> {
    return this.db.close();
  }
}

export function sorted(state: Map<KeyString, string>): [string, string][] {
  return [...state].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

export const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
