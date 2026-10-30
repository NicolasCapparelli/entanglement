import { canonicalJson, decodeDocument, type Json } from "./canonical.js";
import { StateDigest } from "./digest.js";
import { Emitter, type Unsubscribe } from "./emitter.js";
import {
  CollectionDef,
  keyString,
  parseKey,
  type DocKey,
  type KeyString,
  type DocumentMigration,
  type Ref,
  type Schema,
} from "./schema.js";
import type { Row, SqlExecutor } from "./sqlExecutor.js";

/** Where a change came from (spec §8.2). */
export type ChangeOrigin =
  | "local"
  | "remote"
  | "resolution"
  | "restore"
  | "migration"
  | "external";

export interface ChangeEvent {
  readonly collections: ReadonlySet<string>;
  readonly keys: ReadonlySet<KeyString>;
  readonly origin: ChangeOrigin;
}

/** A reference that does not hold. */
const RAW_CHUNK = 400;

export interface Violation {
  readonly from: KeyString;
  readonly to: KeyString;
  readonly reason: string;
}

export function describeViolation(violation: Violation): string {
  return `${violation.from} -> ${violation.to}: ${violation.reason}`;
}

/** A transaction would leave a reference broken (spec §5.4). */
export class IntegrityViolation extends Error {
  override name = "IntegrityViolation";

  constructor(readonly violations: readonly Violation[]) {
    super(`IntegrityViolation(${violations.map(describeViolation).join("; ")})`);
  }
}

/** The local database was written by a newer build (downgrade guard). */
export class LocalSchemaTooNew extends Error {
  override name = "LocalSchemaTooNew";

  constructor(
    readonly stored: number,
    readonly supported: number,
  ) {
    super(`Database is at schema ${stored}; this build supports ${supported}.`);
  }
}

/** One row of the pending overlay (spec §7.3). */
export interface PendingRow {
  readonly key: KeyString;
  /** Canonical value at the base revision; null when absent there. */
  before: string | null;
  grp: number;
  seq: number;
  inflightSeq: number | null;
  heldUnit: string | null;
}

/** The revision this device last agreed with, and that state's digest. */
export interface SyncBase {
  readonly revision: number;
  readonly digest: StateDigest;
}

export const NO_BASE: SyncBase = { revision: 0, digest: StateDigest.empty };

/** A stored conflict entry (spec §13.1). */
export interface ConflictRecord {
  readonly key: KeyString;
  unitId: string;
  readonly ancestor: string | null;
  readonly local: string | null;
  remote: string | null;
  readonly reasons: readonly string[];
  readonly detectedAt: number;
}

export const SYNC_LOG_COLLECTION = "ent_sync_log";

/**
 * The framework-owned local database (spec §6). All access is serialised
 * through one lock; the overlay, groups and counters live in the database and
 * are written in the same transaction as the data.
 */
export class EntanglementStore {
  private readonly defs = new Map<string, CollectionDef>();
  private readonly opaque = new Set<string>();
  private adoptedInTxn: string[] = [];
  private readonly lock = new Lock();
  private readonly changeEmitter = new Emitter<ChangeEvent>();
  private lastDataVersion: number | null = null;
  deviceId = "";

  private constructor(
    private readonly sql: SqlExecutor,
    readonly schema: Schema,
  ) {}

  static async open(sql: SqlExecutor, schema: Schema): Promise<EntanglementStore> {
    const store = new EntanglementStore(sql, schema);
    try {
      await store.initialise();
    } catch (error) {
      await sql.close();
      throw error;
    }
    return store;
  }

  onChange(listener: (event: ChangeEvent) => void): Unsubscribe {
    return this.changeEmitter.on(listener);
  }

  def(name: string): CollectionDef {
    const def = this.defs.get(name);
    if (!def) throw new Error(`Unknown collection "${name}".`);
    return def;
  }

  defOrNull(name: string): CollectionDef | null {
    return this.defs.get(name) ?? null;
  }

  get syncedCollections(): CollectionDef[] {
    return [...this.defs.values()].filter((def) => def.sync);
  }

  // ---------------------------------------------------------------------------
  // Setup
  // ---------------------------------------------------------------------------

  private async initialise(): Promise<void> {
    for (const def of this.schema.collections) this.defs.set(def.name, def);
    this.defs.set(SYNC_LOG_COLLECTION, new CollectionDef(SYNC_LOG_COLLECTION, { indexes: ["at"] }));

    await this.lock.run(() =>
      this.sql.transaction(async () => {
        for (const statement of FRAMEWORK_TABLES) await this.sql.execute(statement);
        for (const def of this.defs.values()) await this.ensureTable(def);
        if ((await this.meta("device_id")) === null) await this.setMeta("device_id", newId());
        this.deviceId = (await this.meta("device_id")) ?? "";

        // Synced collections this database has ever held. One in this set but
        // not in the schema is opaque; one outside it was local-only and is
        // ignored, so it can never leak into the synced state.
        const known = decodeStringList(await this.meta("synced_collections"));
        for (const name of known) {
          if (!this.defs.has(name)) {
            this.opaque.add(name);
            this.defs.set(name, CollectionDef.opaque(name));
          }
        }
        const synced = new Set([...known, ...this.syncedCollections.map((def) => def.name)]);
        await this.setMeta("synced_collections", canonicalJson([...synced].sort()));
        await this.migrateLocalSchema();
      }),
    );
    this.lastDataVersion = await this.sql.dataVersion();
  }

  private async ensureTable(def: CollectionDef): Promise<void> {
    await this.sql.execute(
      `CREATE TABLE IF NOT EXISTS "${def.table}" (id TEXT PRIMARY KEY, doc TEXT NOT NULL)`,
    );
    const columns = await this.sql.select(`PRAGMA table_xinfo("${def.table}")`);
    const existing = new Set(
      columns
        .map((column) => String(column.name))
        .filter((name) => name.startsWith("ix_"))
        .map((name) => name.slice(3)),
    );
    for (const field of def.indexes) {
      if (existing.has(field)) continue;
      await this.sql.execute(
        `ALTER TABLE "${def.table}" ADD COLUMN "ix_${field}" ` +
          `GENERATED ALWAYS AS (json_extract(doc, '$.${field}')) VIRTUAL`,
      );
      await this.sql.execute(
        `CREATE INDEX IF NOT EXISTS "${def.table}__${field}" ON "${def.table}" ("ix_${field}")`,
      );
    }
    for (const field of existing) {
      if (def.indexes.has(field)) continue;
      await this.sql.execute(`DROP INDEX IF EXISTS "${def.table}__${field}"`);
      await this.sql.execute(`ALTER TABLE "${def.table}" DROP COLUMN "ix_${field}"`);
    }
  }

  /** Registers a synced collection first seen in remote data. */
  async adoptOpaque(name: string): Promise<CollectionDef> {
    const existing = this.defs.get(name);
    if (existing) return existing;
    const def = CollectionDef.opaque(name);
    await this.ensureTable(def);
    this.defs.set(name, def);
    this.opaque.add(name);
    this.adoptedInTxn.push(name);
    const known = decodeStringList(await this.meta("synced_collections"));
    known.add(name);
    await this.setMeta("synced_collections", canonicalJson([...known].sort()));
    return def;
  }

  /** Brings stored documents up to the schema version (spec §17.3). */
  private async migrateLocalSchema(): Promise<void> {
    const storedText = await this.meta("local_schema_version");
    if (storedText === null) {
      await this.setMeta("local_schema_version", String(this.schema.version));
      return;
    }
    const stored = Number(storedText);
    if (stored > this.schema.version) throw new LocalSchemaTooNew(stored, this.schema.version);
    if (stored === this.schema.version) return;

    const steps: DocumentMigration[] = [];
    for (let version = stored + 1; version <= this.schema.version; version++) {
      const step = this.schema.migrations.get(version);
      if (step) steps.push(step);
    }
    if (steps.length > 0) {
      const migrate = (collection: string, value: string | null): string | null => {
        if (value === null) return null;
        let doc: Json | null = decodeDocument(value);
        for (const step of steps) {
          if (doc === null) break;
          doc = step(collection, doc);
        }
        return doc === null ? null : canonicalJson(doc);
      };
      for (const def of this.defs.values()) {
        if (this.opaque.has(def.name) || def.name === SYNC_LOG_COLLECTION) continue;
        const rows = await this.sql.select(`SELECT id, doc FROM "${def.table}"`);
        for (const row of rows) {
          await this.writeRow(keyString(def.name, String(row.id)), migrate(def.name, String(row.doc)));
        }
      }
      const pending = await this.sql.select("SELECT collection, id, before FROM ent_pending");
      for (const row of pending) {
        await this.sql.execute(
          "UPDATE ent_pending SET before = ? WHERE collection = ? AND id = ?",
          [migrate(String(row.collection), nullableString(row.before)), row.collection ?? null, row.id ?? null],
        );
      }
      const base = await this.readBase();
      const baseState = await this.baseStateRaw();
      await this.writeBase({
        revision: base.revision,
        digest: StateDigest.of(
          [...baseState].map(([key, value]) => {
            const { collection, id } = parseKey(key);
            return [collection, id, value] as const;
          }),
        ),
      });
    }
    await this.setMeta("local_schema_version", String(this.schema.version));
  }

  // ---------------------------------------------------------------------------
  // Access
  // ---------------------------------------------------------------------------

  /**
   * Runs `body` in one write transaction; integrity is validated before commit
   * and a change event with `origin` is emitted after.
   */
  transact<T>(body: (txn: StoreTxn) => Promise<T>, origin: ChangeOrigin = "local"): Promise<T> {
    return this.lock.run(async () => {
      const txn = new StoreTxn(this);
      this.adoptedInTxn = [];
      let result: T;
      try {
        result = await this.sql.transaction(async () => {
          const value = await body(txn);
          await txn.validate();
          return value;
        });
      } catch (error) {
        for (const name of this.adoptedInTxn) {
          this.defs.delete(name);
          this.opaque.delete(name);
        }
        throw error;
      }
      if (txn.touched.size > 0) {
        const event: ChangeEvent = {
          collections: new Set([...txn.touched].map((key) => parseKey(key).collection)),
          keys: new Set(txn.touched),
          origin: txn.originOverride ?? origin,
        };
        // Delivered after the lock is released, like a Dart broadcast stream.
        queueMicrotask(() => this.changeEmitter.emit(event));
      }
      return result;
    });
  }

  /** Read-only access to committed data. */
  read<T>(body: (reader: StoreReader) => Promise<T>): Promise<T> {
    return this.lock.run(() => body(new StoreReader(this)));
  }

  /** Detects commits by other connections and notifies watchers. */
  checkExternalChanges(): Promise<boolean> {
    return this.lock.run(async () => {
      const version = await this.sql.dataVersion();
      if (version === this.lastDataVersion) return false;
      this.lastDataVersion = version;
      const event: ChangeEvent = {
        collections: new Set(this.defs.keys()),
        keys: new Set(),
        origin: "external",
      };
      queueMicrotask(() => this.changeEmitter.emit(event));
      return true;
    });
  }

  close(): Promise<void> {
    return this.lock.run(() => this.sql.close());
  }

  // ---------------------------------------------------------------------------
  // Primitives (callers hold the lock)
  // ---------------------------------------------------------------------------

  /** @internal */ get executor(): SqlExecutor {
    return this.sql;
  }

  /** @internal */ async meta(key: string): Promise<string | null> {
    const rows = await this.sql.select("SELECT value FROM ent_meta WHERE key = ?", [key]);
    return nullableString(rows[0]?.value);
  }

  /** @internal */ async setMeta(key: string, value: string | null): Promise<void> {
    if (value === null) {
      await this.sql.execute("DELETE FROM ent_meta WHERE key = ?", [key]);
    } else {
      await this.sql.execute(
        "INSERT INTO ent_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        [key, value],
      );
    }
  }

  /** @internal */ async nextCounter(key: string): Promise<number> {
    const value = Number((await this.meta(key)) ?? "0") + 1;
    await this.setMeta(key, String(value));
    return value;
  }

  /** @internal */ async getRaw(key: KeyString): Promise<string | null> {
    const { collection, id } = parseKey(key);
    const def = this.defs.get(collection);
    if (!def) return null;
    const rows = await this.sql.select(`SELECT doc FROM "${def.table}" WHERE id = ?`, [id]);
    return nullableString(rows[0]?.doc);
  }

  /** Writes the row and keeps the reference index in step. No journaling. */
  /** @internal */ async writeRow(key: KeyString, value: string | null): Promise<void> {
    const { collection, id } = parseKey(key);
    const def = this.defs.get(collection) ?? (await this.adoptOpaque(collection));
    if (value === null) {
      await this.sql.execute(`DELETE FROM "${def.table}" WHERE id = ?`, [id]);
    } else {
      await this.sql.execute(
        `INSERT INTO "${def.table}" (id, doc) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET doc = excluded.doc`,
        [id, value],
      );
    }
    await this.sql.execute("DELETE FROM ent_refs WHERE from_collection = ? AND from_id = ?", [
      collection,
      id,
    ]);
    if (value !== null && def.refs) {
      for (const ref of def.refsOf(decodeDocument(value))) {
        await this.sql.execute(
          "INSERT OR IGNORE INTO ent_refs (from_collection, from_id, to_collection, to_id) VALUES (?, ?, ?, ?)",
          [collection, id, ref.collection, ref.id],
        );
      }
    }
  }

  /** @internal */ async pending(key: KeyString): Promise<PendingRow | null> {
    const { collection, id } = parseKey(key);
    const rows = await this.sql.select(
      "SELECT * FROM ent_pending WHERE collection = ? AND id = ?",
      [collection, id],
    );
    return rows[0] ? pendingFrom(rows[0]) : null;
  }

  /** @internal */ async allPending(): Promise<PendingRow[]> {
    const rows = await this.sql.select("SELECT * FROM ent_pending ORDER BY collection, id");
    return rows.map(pendingFrom);
  }

  /** @internal */ async savePending(row: PendingRow): Promise<void> {
    const { collection, id } = parseKey(row.key);
    await this.sql.execute(
      "INSERT INTO ent_pending (collection, id, before, grp, seq, inflight_seq, held_unit) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (collection, id) DO UPDATE SET " +
        "before = excluded.before, grp = excluded.grp, seq = excluded.seq, " +
        "inflight_seq = excluded.inflight_seq, held_unit = excluded.held_unit",
      [collection, id, row.before, row.grp, row.seq, row.inflightSeq, row.heldUnit],
    );
  }

  /** @internal */ async deletePending(key: KeyString): Promise<void> {
    const { collection, id } = parseKey(key);
    await this.sql.execute("DELETE FROM ent_pending WHERE collection = ? AND id = ?", [
      collection,
      id,
    ]);
  }

  /** @internal */ async readBase(): Promise<SyncBase> {
    const revision = await this.meta("base_revision");
    const digest = await this.meta("base_digest");
    if (revision === null || digest === null) return NO_BASE;
    return { revision: Number(revision), digest: StateDigest.parse(digest) };
  }

  /** @internal */ async writeBase(base: SyncBase): Promise<void> {
    await this.setMeta("base_revision", String(base.revision));
    await this.setMeta("base_digest", base.digest.hex);
  }

  /** Every synced document, as canonical strings. */
  /** @internal */ async currentStateRaw(): Promise<Map<KeyString, string>> {
    const state = new Map<KeyString, string>();
    for (const def of this.syncedCollections) {
      const rows = await this.sql.select(`SELECT id, doc FROM "${def.table}"`);
      for (const row of rows) state.set(keyString(def.name, String(row.id)), String(row.doc));
    }
    return state;
  }

  /** The exact state at the base revision (spec §7.4). */
  /** @internal */ async baseStateRaw(): Promise<Map<KeyString, string>> {
    const state = await this.currentStateRaw();
    for (const row of await this.allPending()) {
      if (row.before === null) state.delete(row.key);
      else state.set(row.key, row.before);
    }
    return state;
  }

  private async referrers(key: KeyString): Promise<KeyString[]> {
    const { collection, id } = parseKey(key);
    const rows = await this.sql.select(
      "SELECT from_collection, from_id FROM ent_refs WHERE to_collection = ? AND to_id = ?",
      [collection, id],
    );
    return rows.map((row) => keyString(String(row.from_collection), String(row.from_id)));
  }

  /**
   * Finds broken references among `keys`, viewing documents through
   * `valueOf` (spec §5.4, §12.4): outgoing references of every key with a
   * value, and references into every key from documents outside `keys`.
   * Documents outside `keys` are read as stored, in bulk: a target with
   * thousands of referrers is written on the UI's path, and every statement
   * here runs under the store lock. Each target is looked up once.
   */
  async findViolations(
    keys: ReadonlySet<KeyString>,
    valueOf: (key: KeyString) => Promise<string | null>,
  ): Promise<Violation[]> {
    const violations: Violation[] = [];
    const targets = new Map<KeyString, string | null>();
    const targetOf = async (key: KeyString): Promise<string | null> => {
      if (targets.has(key)) return targets.get(key) ?? null;
      const value = await valueOf(key);
      targets.set(key, value);
      return value;
    };
    const checkRef = async (from: KeyString, ref: Ref): Promise<void> => {
      const fromDef = this.defs.get(parseKey(from).collection);
      const targetDef = this.defs.get(ref.collection);
      if (!targetDef) {
        violations.push({ from, to: ref.key, reason: "unknown collection" });
        return;
      }
      if ((fromDef?.sync ?? true) && !targetDef.sync) {
        violations.push({ from, to: ref.key, reason: "synced document references local-only data" });
        return;
      }
      const target = await targetOf(ref.key);
      if (target === null) {
        violations.push({ from, to: ref.key, reason: "target does not exist" });
        return;
      }
      if (ref.check && !ref.check(decodeDocument(target))) {
        violations.push({ from, to: ref.key, reason: "target check failed" });
      }
    };

    for (const key of keys) {
      const def = this.defs.get(parseKey(key).collection);
      if (!def?.refs) continue;
      const value = await valueOf(key);
      if (value === null) continue;
      for (const ref of def.refsOf(decodeDocument(value))) await checkRef(key, ref);
    }
    for (const key of keys) {
      const outside = (await this.referrers(key)).filter((referrer) => !keys.has(referrer));
      for (const [referrer, value] of await this.rawMany(outside)) {
        const def = this.defs.get(parseKey(referrer).collection);
        if (!def) continue;
        for (const ref of def.refsOf(decodeDocument(value))) {
          if (ref.key === key) await checkRef(referrer, ref);
        }
      }
    }
    return violations;
  }

  /** Stored values of `keys`; absent documents are left out. */
  private async rawMany(keys: readonly KeyString[]): Promise<Map<KeyString, string>> {
    const byCollection = new Map<string, string[]>();
    for (const key of keys) {
      const { collection, id } = parseKey(key);
      const ids = byCollection.get(collection);
      if (ids) ids.push(id);
      else byCollection.set(collection, [id]);
    }
    const found = new Map<KeyString, string>();
    for (const [collection, ids] of byCollection) {
      const def = this.defs.get(collection);
      if (!def) continue;
      for (let i = 0; i < ids.length; i += RAW_CHUNK) {
        const part = ids.slice(i, i + RAW_CHUNK);
        const rows = await this.sql.select(
          `SELECT id, doc FROM "${def.table}" WHERE id IN (${part.map(() => "?").join(",")})`,
          part,
        );
        for (const row of rows) found.set(keyString(collection, String(row.id)), String(row.doc));
      }
    }
    return found;
  }
}

/** Read-only access to committed data. */
export class StoreReader {
  constructor(protected readonly store: EntanglementStore) {}

  get sql(): SqlExecutor {
    return this.store.executor;
  }

  getRaw(key: KeyString): Promise<string | null> {
    return this.store.getRaw(key);
  }

  async getJson(key: KeyString): Promise<Json | null> {
    const raw = await this.store.getRaw(key);
    return raw === null ? null : decodeDocument(raw);
  }

  meta(key: string): Promise<string | null> {
    return this.store.meta(key);
  }

  base(): Promise<SyncBase> {
    return this.store.readBase();
  }

  allPending(): Promise<PendingRow[]> {
    return this.store.allPending();
  }

  pending(key: KeyString): Promise<PendingRow | null> {
    return this.store.pending(key);
  }

  currentState(): Promise<Map<KeyString, string>> {
    return this.store.currentStateRaw();
  }

  baseState(): Promise<Map<KeyString, string>> {
    return this.store.baseStateRaw();
  }

  async inflight(): Promise<Record<string, unknown> | null> {
    const rows = await this.store.executor.select("SELECT request FROM ent_inflight WHERE id = 1");
    const request = rows[0]?.request;
    return request == null ? null : (JSON.parse(String(request)) as Record<string, unknown>);
  }

  async conflicts(): Promise<ConflictRecord[]> {
    const rows = await this.store.executor.select(
      "SELECT * FROM ent_conflicts ORDER BY detected_at, unit_id, collection, id",
    );
    return rows.map((row) => ({
      key: keyString(String(row.collection), String(row.id)),
      unitId: String(row.unit_id),
      ancestor: nullableString(row.ancestor),
      local: nullableString(row.local),
      remote: nullableString(row.remote),
      reasons: [...decodeStringList(nullableString(row.reasons))],
      detectedAt: Number(row.detected_at),
    }));
  }

  backups(): Promise<Row[]> {
    return this.store.executor.select(
      "SELECT id, created_at, reason FROM ent_backups ORDER BY created_at DESC",
    );
  }

  async backup(id: string): Promise<Row | null> {
    const rows = await this.store.executor.select("SELECT * FROM ent_backups WHERE id = ?", [id]);
    return rows[0] ?? null;
  }
}

/** Read-write access inside one transaction. */
export class StoreTxn extends StoreReader {
  /** @internal */ readonly touched = new Set<KeyString>();
  /** @internal */ originOverride: ChangeOrigin | null = null;
  /** Only the engine turns this off, after checking a merge itself. */
  validateIntegrity = true;
  private seqValue: number | null = null;
  private groupValue: number | null = null;

  set origin(origin: ChangeOrigin) {
    this.originOverride = origin;
  }

  async seq(): Promise<number> {
    this.seqValue ??= await this.store.nextCounter("txn_seq");
    return this.seqValue;
  }

  async group(): Promise<number> {
    this.groupValue ??= await this.newGroup();
    return this.groupValue;
  }

  newGroup(): Promise<number> {
    return this.store.nextCounter("next_group");
  }

  setMeta(key: string, value: string | null): Promise<void> {
    return this.store.setMeta(key, value);
  }

  /**
   * The journaled write path (spec §7.3). `value` is canonical or null.
   * `isolated` gives the write its own coupling group, for bulk writes (an
   * import) whose documents are independent.
   */
  async put(key: KeyString, value: string | null, options: { isolated?: boolean } = {}): Promise<void> {
    const collection = parseKey(key).collection;
    const def = this.store.defOrNull(collection) ?? (await this.store.adoptOpaque(collection));
    const old = await this.store.getRaw(key);
    if (old === value) return;
    await this.store.writeRow(key, value);
    this.touched.add(key);
    if (!def.sync) return;

    const group = options.isolated ? await this.newGroup() : await this.group();
    const seq = await this.seq();
    let row = await this.store.pending(key);
    if (row === null) {
      row = { key, before: old, grp: group, seq, inflightSeq: null, heldUnit: null };
    } else {
      if (row.grp !== group) {
        // Coupling is transitive until published (spec §7.2).
        await this.store.executor.execute("UPDATE ent_pending SET grp = ? WHERE grp = ?", [
          group,
          row.grp,
        ]);
        row.grp = group;
      }
      row.seq = seq;
    }
    if (value === row.before && row.inflightSeq === null && row.heldUnit === null) {
      await this.store.deletePending(key);
    } else {
      await this.store.savePending(row);
    }
  }

  /** Writes without touching the overlay; the engine manages it itself. */
  async writeUnjournaled(key: KeyString, value: string | null): Promise<void> {
    const old = await this.store.getRaw(key);
    if (old === value) return;
    await this.store.writeRow(key, value);
    this.touched.add(key);
  }

  savePending(row: PendingRow): Promise<void> {
    return this.store.savePending(row);
  }

  deletePending(key: KeyString): Promise<void> {
    return this.store.deletePending(key);
  }

  setBase(base: SyncBase): Promise<void> {
    return this.store.writeBase(base);
  }

  async setInflight(request: Record<string, unknown> | null): Promise<void> {
    if (request === null) {
      await this.store.executor.execute("DELETE FROM ent_inflight WHERE id = 1");
    } else {
      await this.store.executor.execute(
        "INSERT OR REPLACE INTO ent_inflight (id, request, created_at) VALUES (1, ?, ?)",
        [canonicalJson(request), Date.now()],
      );
    }
  }

  async saveConflict(record: ConflictRecord): Promise<void> {
    const { collection, id } = parseKey(record.key);
    await this.store.executor.execute(
      "INSERT OR REPLACE INTO ent_conflicts " +
        "(collection, id, unit_id, ancestor, local, remote, reasons, detected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        collection,
        id,
        record.unitId,
        record.ancestor,
        record.local,
        record.remote,
        canonicalJson([...record.reasons]),
        record.detectedAt,
      ],
    );
  }

  async deleteConflictUnit(unitId: string): Promise<void> {
    await this.store.executor.execute("DELETE FROM ent_conflicts WHERE unit_id = ?", [unitId]);
  }

  async clearConflicts(): Promise<void> {
    await this.store.executor.execute("DELETE FROM ent_conflicts");
  }

  async ensureCollection(name: string): Promise<CollectionDef> {
    return this.store.defOrNull(name) ?? (await this.store.adoptOpaque(name));
  }

  findViolations(
    keys: ReadonlySet<KeyString>,
    valueOf: (key: KeyString) => Promise<string | null>,
  ): Promise<Violation[]> {
    return this.store.findViolations(keys, valueOf);
  }

  /** Saves a full copy of the synced collections (spec §15.6). */
  async writeBackup(reason: string, keep = 3): Promise<string> {
    const state = await this.store.currentStateRaw();
    const payload: Record<string, Record<string, unknown>> = {};
    for (const [key, value] of state) {
      const { collection, id } = parseKey(key);
      (payload[collection] ??= {})[id] = decodeDocument(value);
    }
    const id = newId();
    await this.store.executor.execute(
      "INSERT INTO ent_backups (id, created_at, reason, payload) VALUES (?, ?, ?, ?)",
      [id, Date.now(), reason, canonicalJson(payload)],
    );
    await this.store.executor.execute(
      "DELETE FROM ent_backups WHERE id NOT IN (SELECT id FROM ent_backups ORDER BY created_at DESC LIMIT ?)",
      [keep],
    );
    return id;
  }

  /** @internal */ async validate(): Promise<void> {
    if (this.touched.size === 0 || !this.validateIntegrity) return;
    const violations = await this.store.findViolations(this.touched, (key) => this.store.getRaw(key));
    if (violations.length > 0) throw new IntegrityViolation(violations);
  }
}

const FRAMEWORK_TABLES = [
  "CREATE TABLE IF NOT EXISTS ent_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS ent_pending (collection TEXT NOT NULL, id TEXT NOT NULL, before TEXT, " +
    "grp INTEGER NOT NULL, seq INTEGER NOT NULL, inflight_seq INTEGER, held_unit TEXT, " +
    "PRIMARY KEY (collection, id))",
  "CREATE INDEX IF NOT EXISTS ent_pending_grp ON ent_pending (grp)",
  "CREATE TABLE IF NOT EXISTS ent_refs (from_collection TEXT NOT NULL, from_id TEXT NOT NULL, " +
    "to_collection TEXT NOT NULL, to_id TEXT NOT NULL, " +
    "PRIMARY KEY (from_collection, from_id, to_collection, to_id))",
  "CREATE INDEX IF NOT EXISTS ent_refs_to ON ent_refs (to_collection, to_id)",
  "CREATE TABLE IF NOT EXISTS ent_inflight (id INTEGER PRIMARY KEY CHECK (id = 1), " +
    "request TEXT NOT NULL, created_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS ent_conflicts (collection TEXT NOT NULL, id TEXT NOT NULL, " +
    "unit_id TEXT NOT NULL, ancestor TEXT, local TEXT, remote TEXT, reasons TEXT NOT NULL, " +
    "detected_at INTEGER NOT NULL, PRIMARY KEY (collection, id))",
  "CREATE TABLE IF NOT EXISTS ent_backups (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, " +
    "reason TEXT NOT NULL, payload TEXT NOT NULL)",
];

function pendingFrom(row: Row): PendingRow {
  return {
    key: keyString(String(row.collection), String(row.id)),
    before: nullableString(row.before),
    grp: Number(row.grp),
    seq: Number(row.seq),
    inflightSeq: row.inflight_seq == null ? null : Number(row.inflight_seq),
    heldUnit: nullableString(row.held_unit),
  };
}

function nullableString(value: unknown): string | null {
  return value == null ? null : String(value);
}

function decodeStringList(text: string | null): Set<string> {
  if (text === null) return new Set();
  return new Set(JSON.parse(text) as string[]);
}

/** A UUIDv7: time-ordered, so ids created on one device sort by creation. */
export function newId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const millis = Date.now();
  for (let index = 0; index < 6; index++) {
    bytes[index] = Math.floor(millis / 2 ** (8 * (5 - index))) & 0xff;
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Serialises database access. JavaScript has no zones, so re-entrant use
 * (calling db.get inside db.write) cannot be refused outright as in Dart; a
 * wait that outlasts a held transaction by several seconds logs a warning
 * naming the likely cause instead of hanging silently.
 */
class Lock {
  private tail: Promise<void> = Promise.resolve();
  private held = false;

  run<T>(body: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    const warning = this.held
      ? setTimeout(() => {
          console.warn(
            "[entanglement] a database call has waited 5s for a transaction. " +
              "Inside db.write, use the tx methods (tx.get, tx.query), not db.get or db.query.",
          );
        }, 5000)
      : null;
    return previous.then(async () => {
      if (warning) clearTimeout(warning);
      this.held = true;
      try {
        return await body();
      } finally {
        this.held = false;
        release();
      }
    });
  }
}
