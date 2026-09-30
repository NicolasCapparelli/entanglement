import { canonicalJson, decodeDocument, type Json } from "./canonical.js";
import { StateDigest } from "./digest.js";
import { Emitter, type Unsubscribe } from "./emitter.js";
import { decide, UnionFind, type Decision } from "./merge.js";
import {
  AuthRequiredError,
  BackendError,
  changeKey,
  commitRequestFromJson,
  commitRequestToJson,
  FatalBackendError,
  HistoryUnavailableError,
  TransientBackendError,
  type AccountSource,
  type Change,
  type Commit,
  type CommitRequest,
  type Head,
  type RestorePoint,
  type RestorePointKind,
  type SubmitResult,
  type SyncBackend,
} from "./protocol.js";
import {
  compareKeys,
  keyOf,
  keyString,
  MergePolicy,
  parseKey,
  type KeyString,
  type Schema,
} from "./schema.js";
import {
  describeViolation,
  newId,
  SYNC_LOG_COLLECTION,
  type ChangeEvent,
  type ConflictRecord,
  type EntanglementStore,
  type PendingRow,
  type StoreTxn,
  type SyncBase,
  type Violation,
} from "./store.js";
import {
  resolveOptions,
  syncLogEntryFromJson,
  type ConflictPolicy,
  type ConflictUnit,
  type ResolvedSyncOptions,
  type Resolution,
  type SyncActivity,
  type SyncLogEntry,
  type SyncMode,
  type SyncOptions,
  type SyncProblem,
  type SyncRelation,
  type SyncStatus,
} from "./syncTypes.js";

/** The server's state does not match its own recorded digest. */
export class SyncIntegrityError extends Error {
  override name = "SyncIntegrityError";
}

/** An operation needing a usable account was called without one. */
export class SyncUnavailableError extends Error {
  override name = "SyncUnavailableError";

  constructor(readonly relation: SyncRelation) {
    super(`Sync is ${relation}.`);
  }
}

class DigestMismatch extends Error {}

/** The remote side of a pull: commits since base, or a whole state (§12.1). */
interface RemoteSide {
  readonly commits: readonly Commit[];
  readonly state: Map<KeyString, string> | null;
  migrated: boolean;
}

type Choice = "clean" | "hold" | "local" | "remote";

/**
 * Drives synchronisation for one store (spec §11–§16, §20). Every operation
 * runs through one queue, so cycles, restores and account switches never
 * overlap. Local writes never wait for it.
 */
export class SyncEngine {
  readonly options: ResolvedSyncOptions;
  private readonly queue = new Queue();
  private readonly statusEmitter = new Emitter<SyncStatus>();
  private readonly subscriptions: Unsubscribe[] = [];
  private hintSubscription: Unsubscribe | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private autoPushTimer: ReturnType<typeof setInterval> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private maxDelayTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  private currentMode: SyncMode;
  private account: string | null = null;
  private accountMismatch = false;
  private remoteTooNew = false;
  private headChecked = false;
  private knownHead: number | null = null;
  private lastCheckedAt: Date | null = null;
  private lastSyncedAt: Date | null = null;
  private activity: SyncActivity = "idle";
  private problem: SyncProblem | null = null;
  private failures = 0;
  private cycleQueued = false;
  private started = false;
  private disposed = false;
  private lastStateAtMigrated = false;
  private readonly policyOverrides = new Map<SyncMode, ConflictPolicy>();

  private statusValue: SyncStatus;

  constructor(
    readonly store: EntanglementStore,
    readonly backend: SyncBackend,
    readonly accounts: AccountSource,
    options: SyncOptions = {},
  ) {
    this.options = resolveOptions(options);
    this.currentMode = this.options.defaultMode;
    this.statusValue = {
      relation: "signedOut",
      activity: "idle",
      problem: null,
      mode: this.currentMode,
      account: null,
      pendingCount: 0,
      heldCount: 0,
      conflictCount: 0,
      baseRevision: 0,
      knownHeadRevision: null,
      lastCheckedAt: null,
      lastSyncedAt: null,
    };
  }

  get schema(): Schema {
    return this.store.schema;
  }

  get status(): SyncStatus {
    return this.statusValue;
  }

  /** Called with every status change. */
  onStatus(listener: (status: SyncStatus) => void): Unsubscribe {
    return this.statusEmitter.on(listener);
  }

  get mode(): SyncMode {
    return this.currentMode;
  }

  private get ready(): boolean {
    return this.account !== null && !this.accountMismatch;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const stored = await this.store.read((reader) => reader.meta("mode"));
    if (stored === "vcs" || stored === "realtime") this.currentMode = stored;
    this.subscriptions.push(this.store.onChange((event) => this.onLocalChange(event)));
    this.subscriptions.push(this.accounts.onAccountChange((account) => void this.onAccount(account)));
    await this.onAccount(this.accounts.currentAccount());
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.cancelTimers();
    this.hintSubscription?.();
    for (const unsubscribe of this.subscriptions) unsubscribe();
    await this.queue.run(async () => {});
  }

  /** Call when the app returns to the foreground. */
  async resume(): Promise<void> {
    await this.store.checkExternalChanges();
    if (!this.ready) return;
    if (this.currentMode === "realtime") this.requestCycle();
    else void this.guard(() => this.checkRemote());
  }

  /** Call when the app goes to the background. */
  async pause(): Promise<void> {
    this.cancelTimers();
    if (this.ready && this.currentMode === "realtime") {
      await this.guard(() => withTimeout(this.push({ userInitiated: false }), 10_000));
    }
  }

  async setMode(mode: SyncMode): Promise<void> {
    if (mode === this.currentMode) return;
    await this.store.transact((txn) => txn.setMeta("mode", mode));
    this.currentMode = mode;
    this.schedule();
    await this.publishStatus();
    if (this.ready && mode === "realtime") this.requestCycle();
  }

  get conflictPolicy(): ConflictPolicy {
    return this.policyFor(this.currentMode);
  }

  private policyFor(mode: SyncMode): ConflictPolicy {
    return (
      this.policyOverrides.get(mode) ??
      (mode === "vcs" ? this.options.vcs.conflictPolicy : this.options.realtime.conflictPolicy)
    );
  }

  async setConflictPolicy(policy: ConflictPolicy, mode: SyncMode = this.currentMode): Promise<void> {
    this.policyOverrides.set(mode, policy);
    await this.store.transact((txn) => txn.setMeta(`conflict_policy_${mode}`, policy));
  }

  private async loadPolicies(): Promise<void> {
    for (const mode of ["vcs", "realtime"] as const) {
      const stored = await this.store.read((reader) => reader.meta(`conflict_policy_${mode}`));
      if (stored === "ask" || stored === "preferRemote" || stored === "preferLocal") {
        this.policyOverrides.set(mode, stored);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Accounts (spec §16)
  // ---------------------------------------------------------------------------

  private async onAccount(account: string | null): Promise<void> {
    if (this.disposed) return;
    this.cancelTimers();
    this.hintSubscription?.();
    this.hintSubscription = null;
    this.account = null;
    this.accountMismatch = false;
    this.headChecked = false;
    this.knownHead = null;
    this.problem = null;
    if (account === null) {
      await this.publishStatus();
      return;
    }
    await this.loadPolicies();
    const owner = await this.store.read((reader) => reader.meta("owner_account"));
    if (owner === null) {
      await this.store.transact((txn) => txn.setMeta("owner_account", account));
    } else if (owner !== account) {
      this.accountMismatch = true;
      this.account = account;
      await this.publishStatus();
      return;
    }
    this.account = account;
    this.schedule();
    await this.publishStatus();
    if (this.currentMode === "realtime") this.requestCycle();
    else void this.guard(() => this.checkRemote());
  }

  /** Moves this device to the signed-in account (spec §16.2). */
  async switchAccount(options: { discardUnpublished?: boolean } = {}): Promise<void> {
    const account = this.accounts.currentAccount();
    if (account === null) throw new SyncUnavailableError("signedOut");
    await this.queue.run(() =>
      this.store.transact(async (txn) => {
        const pending = await txn.allPending();
        if (pending.length > 0 && !options.discardUnpublished) {
          throw new Error(
            `${pending.length} unpublished change(s) belong to the previous account. ` +
              "Pass discardUnpublished: true to switch anyway (a local backup is kept).",
          );
        }
        await txn.writeBackup("Before switching account", this.options.history.localBackups);
        for (const key of (await txn.currentState()).keys()) await txn.writeUnjournaled(key, null);
        for (const row of await txn.allPending()) await txn.deletePending(row.key);
        await txn.clearConflicts();
        await txn.setInflight(null);
        await txn.setBase({ revision: 0, digest: StateDigest.empty });
        await txn.setMeta("owner_account", account);
        txn.origin = "remote";
      }),
    );
    await this.onAccount(account);
  }

  // ---------------------------------------------------------------------------
  // Public operations
  // ---------------------------------------------------------------------------

  /** Checks (metadata only) whether the remote moved. Never applies. */
  checkRemote(): Promise<void> {
    return this.operation("checking", async () => {
      this.noteHead(await this.backend.head());
    });
  }

  /**
   * Publishes local changes (spec §11). A user-initiated VCS push is a
   * restore point, labelled with `message`.
   */
  push(options: { message?: string | null; userInitiated?: boolean } = {}): Promise<void> {
    const userInitiated = options.userInitiated ?? true;
    return this.operation("pushing", async () => {
      await this.pushLocked(options.message ?? null, userInitiated && this.currentMode === "vcs");
      await this.afterSuccessfulCycle();
    });
  }

  /** Fetches and merges remote changes (spec §12). */
  pull(): Promise<void> {
    return this.operation("pulling", async () => {
      await this.pullLocked();
      await this.afterSuccessfulCycle();
    });
  }

  /** Pull, then push. */
  sync(): Promise<void> {
    return this.operation("pulling", async () => {
      await this.pullLocked();
      await this.pushLocked(null, false);
      await this.afterSuccessfulCycle();
    });
  }

  /** Throws away unpublished changes (backed up first) and pulls (§13.5). */
  discardLocalAndPull(): Promise<void> {
    return this.operation("pulling", async () => {
      await this.resolveInflight();
      await this.store.transact(async (txn) => {
        await txn.writeBackup("Before discarding local changes", this.options.history.localBackups);
        for (const row of await txn.allPending()) {
          await txn.writeUnjournaled(row.key, row.before);
          await txn.deletePending(row.key);
        }
        await txn.clearConflicts();
        txn.origin = "remote";
      });
      await this.pullLocked();
    });
  }

  /** Makes the remote exactly this device's state, via normal CAS (§13.5). */
  overwriteRemoteWithLocal(): Promise<void> {
    return this.operation("pushing", async () => {
      await this.resolveInflight();
      const target = await this.store.read((reader) => reader.currentState());
      await this.applyTarget(
        target,
        "beforeOverwrite",
        `Before overwrite from ${this.options.deviceLabel ?? "another device"}`,
      );
    });
  }

  // ---------------------------------------------------------------------------
  // Importing existing data
  // ---------------------------------------------------------------------------

  /**
   * Brings data from another system into the account, merging correctly
   * however many devices import (mirrors the Dart `importState`).
   *
   * `puts` are documents this device holds; `deletes` are documents it has a
   * record of deleting; anything else is left alone. The first importer
   * publishes and pins its revision under `label`; later importers use that
   * pinned revision as the common ancestor of an ordinary three-way merge.
   * Local synced data is replaced, so call this on a fresh store.
   */
  importState(options: {
    puts: Map<KeyString, string>;
    deletes?: Set<KeyString>;
    label?: string;
  }): Promise<void> {
    const label = options.label ?? "Imported data";
    const deletes = options.deletes ?? new Set<KeyString>();
    return this.operation("pushing", async () => {
      await this.resolveInflight();
      const head = await this.backend.head();
      this.noteHead(head);
      if (this.remoteTooNew) throw new SyncUnavailableError("remoteSchemaTooNew");

      let anchor = 0;
      let anchorState = new Map<KeyString, string>();
      if (head) {
        const markers = (await this.backend.restorePoints())
          .filter((point) => point.pinned && point.label === label)
          .map((point) => point.revision);
        if (markers.length > 0) {
          anchor = Math.min(...markers);
          anchorState = await this.stateAt(anchor);
        }
      }

      await this.store.transact(async (txn) => {
        txn.origin = "migration";
        for (const key of (await txn.currentState()).keys()) await txn.writeUnjournaled(key, null);
        for (const row of await txn.allPending()) await txn.deletePending(row.key);
        await txn.clearConflicts();
        for (const [key, value] of anchorState) await txn.writeUnjournaled(key, value);
        await txn.setBase({ revision: anchor, digest: digestOf(anchorState) });
        for (const [key, raw] of options.puts) {
          const value = this.carryUnknownFields(key, raw, anchorState.get(key) ?? null);
          if (anchorState.get(key) !== value) await txn.put(key, value, { isolated: true });
        }
        for (const key of deletes) {
          if (!options.puts.has(key) && anchorState.has(key)) await txn.put(key, null, { isolated: true });
        }
        // Imported data predates reference checking; merges still check it.
        txn.validateIntegrity = false;
      });

      if (head === null) {
        await this.pushLocked(label, false);
        const base = await this.store.read((reader) => reader.base());
        if (base.revision > 0) {
          await this.backend.putRestorePoint({
            revision: base.revision,
            kind: "manual",
            label,
            pinned: true,
            deviceLabel: this.options.deviceLabel,
            createdAt: new Date(),
          });
        }
      } else {
        await this.pullLocked();
        await this.pushLocked(null, false);
      }
      await this.afterSuccessfulCycle();
    });
  }

  /**
   * Keeps the anchor's top-level keys this build does not declare, as every
   * ordinary write does (spec §5.5), so an importing client never strips
   * another client's fields.
   */
  private carryUnknownFields(key: KeyString, value: string, anchor: string | null): string {
    const known = this.store.defOrNull(parseKey(key).collection)?.fields;
    if (!known || anchor === null) return value;
    const carried: Json = {};
    for (const [field, inner] of Object.entries(decodeDocument(anchor))) {
      if (!known.has(field)) carried[field] = inner;
    }
    return canonicalJson({ ...carried, ...decodeDocument(value) });
  }

  /** Pins or unpins a restore point; pinned points block compaction. */
  setPinned(point: RestorePoint, pinned: boolean): Promise<void> {
    return this.backend.putRestorePoint({ ...point, pinned });
  }

  // ---------------------------------------------------------------------------
  // Conflicts (spec §13)
  // ---------------------------------------------------------------------------

  conflicts(): Promise<ConflictUnit[]> {
    return this.store.read(async (reader) => {
      const units = new Map<string, ConflictRecord[]>();
      for (const record of await reader.conflicts()) {
        const list = units.get(record.unitId);
        if (list) list.push(record);
        else units.set(record.unitId, [record]);
      }
      const result: ConflictUnit[] = [];
      for (const [id, records] of units) {
        const entries = [];
        for (const record of records) {
          entries.push({
            key: parseKey(record.key),
            ancestor: decodeOrNull(record.ancestor),
            local: await reader.getJson(record.key),
            remote: decodeOrNull(record.remote),
            reasons: record.reasons,
          });
        }
        result.push({ id, detectedAt: new Date(records[0]?.detectedAt ?? 0), entries });
      }
      return result;
    });
  }

  /** Decides a held conflict unit (spec §13.2). */
  async resolve(unitId: string, resolution: Resolution): Promise<void> {
    await this.store.transact(async (txn) => {
      const records = (await txn.conflicts()).filter((record) => record.unitId === unitId);
      if (records.length === 0) throw new Error(`No conflict unit ${unitId}.`);
      for (const record of records) {
        const row = await txn.pending(record.key);
        if (row) {
          row.heldUnit = null;
          await txn.savePending(row);
        }
      }
      const discarded = new Map<KeyString, string | null>();
      for (const record of records) {
        const current = await txn.getRaw(record.key);
        let chosen: string | null;
        switch (resolution.kind) {
          case "keepLocal":
            chosen = current;
            break;
          case "keepRemote":
            chosen = record.remote;
            break;
          case "custom": {
            if (!resolution.values.has(record.key)) {
              throw new Error(`A custom resolution must give a value for ${record.key}.`);
            }
            const value = resolution.values.get(record.key) ?? null;
            chosen = value === null ? null : canonicalJson(value);
          }
        }
        if (current !== chosen) discarded.set(record.key, current);
        if (record.remote !== chosen && !discarded.has(record.key)) {
          discarded.set(record.key, record.remote);
        }
        if (chosen !== current) await txn.put(record.key, chosen);
      }
      await txn.deleteConflictUnit(unitId);
      if (await this.writeLog(txn, false, resolution.kind, discarded)) await this.pruneLog(txn);
      txn.origin = "resolution";
    });
    await this.publishStatus();
    if (this.ready && this.currentMode === "realtime") this.requestCycle();
  }

  log(): Promise<SyncLogEntry[]> {
    return this.store.read(async (reader) => {
      const rows = await reader.sql.select(
        `SELECT doc FROM "c_${SYNC_LOG_COLLECTION}" ORDER BY "ix_at" DESC, id DESC`,
      );
      return rows.map((row) => syncLogEntryFromJson(decodeDocument(String(row.doc))));
    });
  }

  /** Writes back what a logged decision discarded, as an ordinary edit. */
  async reinstate(logEntryId: string): Promise<void> {
    await this.store.transact(async (txn) => {
      const raw = await txn.getRaw(keyString(SYNC_LOG_COLLECTION, logEntryId));
      if (raw === null) throw new Error(`No sync log entry ${logEntryId}.`);
      for (const { key, value } of syncLogEntryFromJson(decodeDocument(raw)).discarded) {
        await txn.put(keyOf(key), value === null ? null : canonicalJson(value));
      }
    });
  }

  // ---------------------------------------------------------------------------
  // History (spec §15)
  // ---------------------------------------------------------------------------

  restorePoints(): Promise<RestorePoint[]> {
    return this.backend.restorePoints();
  }

  /** Labels the current state as a restore point, pushing first. */
  mark(label: string, options: { pinned?: boolean } = {}): Promise<void> {
    return this.operation("pushing", async () => {
      await this.pushLocked(null, false);
      const base = await this.store.read((reader) => reader.base());
      if (base.revision === 0) throw new Error("Nothing has been committed yet.");
      await this.backend.putRestorePoint({
        revision: base.revision,
        kind: "manual",
        label,
        pinned: options.pinned ?? false,
        deviceLabel: this.options.deviceLabel,
        createdAt: new Date(),
      });
    });
  }

  /** Restores a point's state as a new, forward commit (spec §15.5). */
  restore(point: RestorePoint): Promise<void> {
    return this.operation("restoring", async () => {
      await this.resolveInflight();
      const target = await this.stateAt(point.revision);
      await this.applyTarget(
        target,
        "beforeRestore",
        `Before restoring ${point.label ?? `revision ${point.revision}`}`,
      );
    });
  }

  localBackups(): Promise<{ id: string; createdAt: Date; reason: string }[]> {
    return this.store.read(async (reader) =>
      (await reader.backups()).map((row) => ({
        id: String(row.id),
        createdAt: new Date(Number(row.created_at)),
        reason: String(row.reason),
      })),
    );
  }

  /** Applies a local backup as the target state and publishes it. */
  restoreLocalBackup(id: string): Promise<void> {
    return this.operation("restoring", async () => {
      const backup = await this.store.read((reader) => reader.backup(id));
      if (!backup) throw new Error(`No local backup ${id}.`);
      const payload = decodeDocument(String(backup.payload));
      const target = new Map<KeyString, string>();
      for (const [collection, docs] of Object.entries(payload)) {
        for (const [docId, doc] of Object.entries(docs as Json)) {
          target.set(keyString(collection, docId), canonicalJson(doc));
        }
      }
      await this.resolveInflight();
      await this.applyTarget(target, "beforeRestore", "Before restoring a local backup");
    });
  }

  /** Gives up on a commit stuck on a permanent transport failure (§11.2). */
  abandonInflight(): Promise<void> {
    return this.queue.run(() =>
      this.store.transact(async (txn) => {
        const request = await txn.inflight();
        if (request === null) return;
        await txn.writeBackup("Before abandoning an upload", this.options.history.localBackups);
        await this.clearInflightMarks(txn, commitRequestFromJson(request));
      }),
    );
  }

  /** Forces the full-state pull path, rebuilding the local base (§12.6). */
  rebuildBase(): Promise<void> {
    return this.operation("pulling", () => this.pullLocked(true));
  }

  // ---------------------------------------------------------------------------
  // Push (spec §11)
  // ---------------------------------------------------------------------------

  private async pushLocked(message: string | null, restorePoint: boolean): Promise<void> {
    await this.resolveInflight();
    for (let attempt = 0; attempt < 5; attempt++) {
      const request = await this.prepareCommit(message);
      if (request === null) {
        if (message !== null) await this.labelBase(message);
        return;
      }
      const result = await this.submitAndSettle(request);
      switch (result.kind) {
        case "accepted":
          this.knownHead = result.revision;
          this.headChecked = true;
          if (restorePoint && message === null) {
            await this.guardBackend(() =>
              this.backend.putRestorePoint({
                revision: result.revision,
                kind: "commit",
                label: null,
                pinned: false,
                deviceLabel: this.options.deviceLabel,
                createdAt: new Date(),
              }),
            );
          }
          return;
        case "conflict":
          await this.pullLocked();
          break;
        case "rejected":
          if (result.reason === "schemaTooOld") this.remoteTooNew = true;
          throw new FatalBackendError(`Commit rejected: ${result.reason}`);
      }
    }
    throw new TransientBackendError("Another device kept committing first; will retry.");
  }

  private async labelBase(message: string): Promise<void> {
    const base = await this.store.read((reader) => reader.base());
    if (base.revision === 0) return;
    await this.backend.putRestorePoint({
      revision: base.revision,
      kind: "commit",
      label: message,
      pinned: false,
      deviceLabel: this.options.deviceLabel,
      createdAt: new Date(),
    });
  }

  /**
   * Builds a commit from every publishable pending row and records it as in
   * flight, durably, before anything is sent.
   */
  private prepareCommit(message: string | null): Promise<CommitRequest | null> {
    return this.store.transact(async (txn) => {
      const rows = await txn.allPending();
      const excluded = new Set(rows.filter((row) => row.heldUnit !== null).map((row) => row.grp));
      let selected: PendingRow[] = [];
      // Later edits can depend on held data; the state this commit would
      // produce must satisfy every reference, so groups that would break one
      // are held back until the conflict is resolved (spec §11.1).
      for (;;) {
        selected = rows.filter((row) => !excluded.has(row.grp));
        if (selected.length === 0) return null;
        const held = new Map<KeyString, string | null>();
        for (const row of rows) if (excluded.has(row.grp)) held.set(row.key, row.before);
        if (held.size === 0) break;
        const selectedByKey = new Map(selected.map((row) => [row.key, row]));
        const violations = await txn.findViolations(
          new Set([...selectedByKey.keys(), ...held.keys()]),
          async (key) => (held.has(key) ? (held.get(key) ?? null) : txn.getRaw(key)),
        );
        const more = new Set<number>();
        for (const violation of violations) {
          for (const key of [violation.from, violation.to]) {
            const row = selectedByKey.get(key);
            if (row) more.add(row.grp);
          }
        }
        if (more.size === 0) break;
        for (const grp of more) excluded.add(grp);
      }

      const base = await txn.base();
      const groupIndex = new Map<number, number>();
      let digest = base.digest;
      const changes: Change[] = [];
      for (const row of selected) {
        const value = await txn.getRaw(row.key);
        const { collection, id } = parseKey(row.key);
        digest = digest.replace(collection, id, row.before, value);
        if (!groupIndex.has(row.grp)) groupIndex.set(row.grp, groupIndex.size);
        changes.push({ collection, id, value, group: groupIndex.get(row.grp) ?? 0 });
        row.inflightSeq = row.seq;
        await txn.savePending(row);
      }
      const request: CommitRequest = {
        commitId: newId(),
        parent: base.revision,
        schemaVersion: this.schema.version,
        compatibleSince: this.schema.compatibleSince,
        deviceId: this.store.deviceId,
        deviceLabel: this.options.deviceLabel,
        clientTime: Date.now(),
        message,
        stateDigest: digest,
        changes,
      };
      await txn.setInflight(commitRequestToJson(request));
      return request;
    });
  }

  /** Resends a commit left in flight. Must run before any pull. */
  private async resolveInflight(): Promise<void> {
    const stored = await this.store.read((reader) => reader.inflight());
    if (stored === null) return;
    const result = await this.submitAndSettle(commitRequestFromJson(stored));
    if (result.kind === "accepted") this.knownHead = result.revision;
  }

  private async submitAndSettle(request: CommitRequest): Promise<SubmitResult> {
    const result = await this.backend.submit(request);
    await this.store.transact(async (txn) => {
      if (result.kind === "accepted") {
        for (const change of request.changes) {
          const key = changeKey(change);
          const row = await txn.pending(key);
          if (!row) continue;
          if (row.inflightSeq !== null && row.seq === row.inflightSeq) {
            await txn.deletePending(key);
            continue;
          }
          // Edited again mid-upload: the committed value is now the base.
          row.before = change.value;
          row.inflightSeq = null;
          const current = await txn.getRaw(key);
          if (current === row.before && row.heldUnit === null) await txn.deletePending(key);
          else await txn.savePending(row);
        }
        await txn.setBase({ revision: result.revision, digest: request.stateDigest });
        await txn.setInflight(null);
      } else {
        await this.clearInflightMarks(txn, request);
      }
    });
    await this.publishStatus();
    return result;
  }

  private async clearInflightMarks(txn: StoreTxn, request: CommitRequest): Promise<void> {
    for (const change of request.changes) {
      const key = changeKey(change);
      const row = await txn.pending(key);
      if (!row || row.inflightSeq === null) continue;
      row.inflightSeq = null;
      // Coalescing was suppressed while in flight; re-evaluate it now.
      const current = await txn.getRaw(key);
      if (current === row.before && row.heldUnit === null) await txn.deletePending(key);
      else await txn.savePending(row);
    }
    await txn.setInflight(null);
  }

  // ---------------------------------------------------------------------------
  // Pull (spec §12)
  // ---------------------------------------------------------------------------

  private async pullLocked(forceFull = false): Promise<void> {
    await this.resolveInflight();
    const head = await this.backend.head();
    this.noteHead(head);
    if (head === null || this.remoteTooNew) return;
    const base = await this.store.read((reader) => reader.base());
    if (head.revision === base.revision && !forceFull) return;

    let remote: RemoteSide;
    if (forceFull || head.revision < base.revision) {
      remote = await this.fetchFull(head);
    } else {
      try {
        remote = await this.fetchIncremental(base.revision, head.revision);
      } catch (error) {
        if (!(error instanceof HistoryUnavailableError)) throw error;
        remote = await this.fetchFull(head);
      }
    }
    try {
      await this.applyRemote(head, remote);
    } catch (error) {
      if (!(error instanceof DigestMismatch)) throw error;
      // The incremental result does not reproduce the head digest: the local
      // base is wrong. The full-state path rebuilds it exactly.
      await this.applyRemote(head, await this.fetchFull(head));
    }
    this.lastSyncedAt = new Date();
  }

  private noteHead(head: Head | null): void {
    this.headChecked = true;
    this.lastCheckedAt = new Date();
    this.knownHead = head?.revision ?? null;
    this.remoteTooNew = head !== null && head.minVersion > this.schema.version;
  }

  private async fetchIncremental(from: number, to: number): Promise<RemoteSide> {
    const commits: Commit[] = [];
    let after = from;
    while (after < to) {
      const page = await this.backend.commits({ after, upTo: to });
      const first = page[0];
      if (!first || first.revision !== after + 1) {
        throw new HistoryUnavailableError("Commit history has a gap.");
      }
      commits.push(...page);
      after = page[page.length - 1]!.revision;
    }
    return {
      commits,
      state: null,
      migrated: commits.some((commit) => this.needsMigration(commit.request.schemaVersion)),
    };
  }

  private async fetchFull(head: Head): Promise<RemoteSide> {
    const state = await this.stateAt(head.revision);
    const digest = digestOf(state);
    if (!digest.equals(head.stateDigest) && !this.lastStateAtMigrated) {
      this.problem = { kind: "integrity", message: "The cloud copy does not match its own fingerprint." };
      throw new SyncIntegrityError(
        `State at revision ${head.revision} does not match the head digest.`,
      );
    }
    return { commits: [], state, migrated: this.lastStateAtMigrated };
  }

  /** The complete state at `revision` (spec §15.4). */
  private async stateAt(revision: number): Promise<Map<KeyString, string>> {
    this.lastStateAtMigrated = false;
    const checkpoint = await this.backend.checkpoint({ atOrBefore: revision });
    const state = new Map<KeyString, string>();
    let from = 0;
    if (checkpoint) {
      from = checkpoint.revision;
      const migrate = this.needsMigration(checkpoint.schemaVersion);
      this.lastStateAtMigrated ||= migrate;
      for (const entity of checkpoint.entities) {
        const value = migrate
          ? this.migrate(entity.collection, entity.value, checkpoint.schemaVersion)
          : entity.value;
        if (value !== null) state.set(changeKey(entity), value);
      }
      if (!migrate && !digestOf(state).equals(checkpoint.stateDigest)) {
        throw new SyncIntegrityError(`Checkpoint ${checkpoint.revision} does not match its digest.`);
      }
    }
    let after = from;
    while (after < revision) {
      const page = await this.backend.commits({ after, upTo: revision });
      const first = page[0];
      if (!first || first.revision !== after + 1) {
        throw new HistoryUnavailableError(`Revision ${revision} cannot be reconstructed.`);
      }
      for (const commit of page) {
        const version = commit.request.schemaVersion;
        const migrate = this.needsMigration(version);
        this.lastStateAtMigrated ||= migrate;
        for (const change of commit.request.changes) {
          const value = migrate ? this.migrate(change.collection, change.value, version) : change.value;
          if (value === null) state.delete(changeKey(change));
          else state.set(changeKey(change), value);
        }
      }
      after = page[page.length - 1]!.revision;
    }
    return state;
  }

  private needsMigration(fromVersion: number): boolean {
    if (fromVersion >= this.schema.version) return false;
    for (let version = fromVersion + 1; version <= this.schema.version; version++) {
      if (this.schema.migrations.has(version)) return true;
    }
    return false;
  }

  /** Ingestion migration (spec §17.4). */
  private migrate(collection: string, value: string | null, fromVersion: number): string | null {
    if (value === null) return null;
    let doc: Json | null = decodeDocument(value);
    for (let version = fromVersion + 1; version <= this.schema.version; version++) {
      const step = this.schema.migrations.get(version);
      if (!step || doc === null) continue;
      doc = step(collection, doc);
    }
    return doc === null ? null : canonicalJson(doc);
  }

  /** Merges the remote side and rebases the overlay onto head (§12.2–§12.5). */
  private applyRemote(head: Head, remote: RemoteSide): Promise<void> {
    const policy = this.conflictPolicy;
    return this.store.transact(async (txn) => {
      txn.origin = "remote";
      const base = await txn.base();
      const pending = new Map((await txn.allPending()).map((row) => [row.key, row]));

      const net = new Map<KeyString, string | null>();
      const remoteGroups: KeyString[][] = [];
      if (remote.state) {
        const baseState = await txn.baseState();
        for (const key of new Set([...baseState.keys(), ...remote.state.keys()])) {
          const before = baseState.get(key) ?? null;
          const after = remote.state.get(key) ?? null;
          if (before !== after) net.set(key, after);
        }
      } else {
        for (const commit of remote.commits) {
          const byGroup = new Map<number, KeyString[]>();
          const version = commit.request.schemaVersion;
          for (const change of commit.request.changes) {
            const key = changeKey(change);
            net.set(
              key,
              this.needsMigration(version)
                ? this.migrate(change.collection, change.value, version)
                : change.value,
            );
            const group = byGroup.get(change.group);
            if (group) group.push(key);
            else byGroup.set(change.group, [key]);
          }
          remoteGroups.push(...byGroup.values());
        }
      }
      for (const key of net.keys()) await txn.ensureCollection(parseKey(key).collection);

      const touched = new Set<KeyString>([...pending.keys(), ...net.keys()]);
      const b = new Map<KeyString, string | null>();
      const l = new Map<KeyString, string | null>();
      const r = new Map<KeyString, string | null>();
      for (const key of touched) {
        const current = await txn.getRaw(key);
        const row = pending.get(key);
        l.set(key, current);
        b.set(key, row ? row.before : current);
        r.set(key, net.has(key) ? (net.get(key) ?? null) : (b.get(key) ?? null));
      }
      const get = (map: Map<KeyString, string | null>, key: KeyString): string | null =>
        map.get(key) ?? null;

      // Verify before changing anything (spec §12.6).
      let digest = base.digest;
      for (const key of net.keys()) {
        const { collection, id } = parseKey(key);
        digest = digest.replace(collection, id, get(b, key), get(r, key));
      }
      let newDigest: StateDigest;
      if (remote.state || remote.migrated) {
        newDigest = remote.migrated ? digest : head.stateDigest;
      } else {
        if (!digest.equals(head.stateDigest)) throw new DigestMismatch();
        newDigest = digest;
      }

      const decisions = new Map<KeyString, Decision>();
      for (const key of touched) {
        decisions.set(
          key,
          decide({
            base: get(b, key),
            local: get(l, key),
            remote: get(r, key),
            policy: this.store.defOrNull(parseKey(key).collection)?.merge ?? MergePolicy.wholeDocument,
          }),
        );
      }

      // Units (spec §12.4).
      const units = new UnionFind<KeyString>();
      for (const key of touched) units.add(key);
      const localGroups = new Map<number, KeyString[]>();
      const heldGroups = new Map<string, KeyString[]>();
      for (const row of pending.values()) {
        pushTo(localGroups, row.grp, row.key);
        if (row.heldUnit !== null) pushTo(heldGroups, row.heldUnit, row.key);
      }
      for (const keys of localGroups.values()) units.unionAll(keys);
      for (const keys of heldGroups.values()) units.unionAll(keys);
      for (const keys of remoteGroups) units.unionAll(keys);

      const integrityFlagged = new Set<KeyString>();
      let remaining: Violation[] = [];
      let components = new Map<KeyString, KeyString[]>();
      let choices = new Map<KeyString, Choice>();
      let merged = new Map<KeyString, string | null>();

      const decidedValue = (key: KeyString): string | null => {
        const decision = decisions.get(key)!;
        switch (decision.take) {
          case "local":
            return get(l, key);
          case "remote":
            return get(r, key);
          case "merged":
            return decision.value;
          case "conflict":
            return get(l, key);
        }
      };

      for (let round = 0; ; round++) {
        if (round > touched.size + 2) throw new Error("Merge integrity pass did not converge.");
        components = units.components();
        choices = new Map();
        for (const [root, keys] of components) {
          const held = keys.some((key) => pending.get(key)?.heldUnit != null);
          const conflicted =
            held ||
            keys.some(
              (key) => decisions.get(key)?.take === "conflict" || integrityFlagged.has(key),
            );
          const choice: Choice = !conflicted
            ? "clean"
            : held
              ? "hold"
              : policy === "ask"
                ? "hold"
                : policy === "preferRemote"
                  ? "remote"
                  : "local";
          choices.set(root, choice);
        }
        merged = new Map();
        for (const key of touched) {
          const choice = choices.get(units.find(key))!;
          merged.set(
            key,
            choice === "clean" ? decidedValue(key) : choice === "remote" ? get(r, key) : get(l, key),
          );
        }
        const violations = await txn.findViolations(touched, async (key) =>
          touched.has(key) ? (merged.get(key) ?? null) : txn.getRaw(key),
        );
        let changed = false;
        for (const violation of violations) {
          if (touched.has(violation.from) && touched.has(violation.to)) {
            changed = units.union(violation.from, violation.to) || changed;
          }
          for (const key of [violation.from, violation.to]) {
            if (touched.has(key) && !integrityFlagged.has(key)) {
              integrityFlagged.add(key);
              changed = true;
            }
          }
        }
        if (!changed) {
          remaining = violations;
          break;
        }
      }

      // Anything still broken must already be broken in the head state itself
      // (a buggy or older writer). This device cannot repair that by choosing
      // sides, and refusing would wedge it, so those are tolerated. A
      // violation the merge introduced is a bug.
      if (remaining.length > 0) {
        const inHead = await txn.findViolations(touched, async (key) =>
          touched.has(key) ? get(r, key) : txn.getRaw(key),
        );
        const inherited = new Set(inHead.map(describeViolation));
        const introduced = remaining.filter((violation) => !inherited.has(describeViolation(violation)));
        if (introduced.length > 0) {
          throw new Error(
            `Merge produced broken references: ${introduced.map(describeViolation).join("; ")}`,
          );
        }
        txn.validateIntegrity = false;
      }

      // Apply: rebase the overlay onto head (spec §12.5).
      const existingRecords = new Map((await txn.conflicts()).map((record) => [record.key, record]));
      const now = Date.now();
      let logged = false;
      for (const [root, unsortedKeys] of components) {
        const keys = [...unsortedKeys].sort(compareKeys);
        const choice = choices.get(root)!;
        const group = await txn.newGroup();
        let unitId: string | null = null;
        if (choice === "hold") {
          const existing = keys
            .map((key) => pending.get(key)?.heldUnit)
            .find((unit): unit is string => typeof unit === "string");
          unitId = existing ?? newId();
        }
        for (const key of keys) {
          const value = merged.get(key) ?? null;
          if (value !== get(l, key)) await txn.writeUnjournaled(key, value);
          if (value === get(r, key)) {
            if (pending.has(key)) await txn.deletePending(key);
          } else {
            await txn.savePending({
              key,
              before: get(r, key),
              grp: group,
              seq: pending.get(key)?.seq ?? (await txn.seq()),
              inflightSeq: null,
              heldUnit: unitId,
            });
          }
          if (unitId !== null) {
            const record = existingRecords.get(key);
            if (record) {
              record.unitId = unitId;
              record.remote = get(r, key);
              await txn.saveConflict(record);
            } else {
              const decision = decisions.get(key);
              await txn.saveConflict({
                key,
                unitId,
                ancestor: get(b, key),
                local: get(l, key),
                remote: get(r, key),
                reasons: [
                  ...(decision?.take === "conflict" ? [decision.reason] : []),
                  ...(integrityFlagged.has(key) ? ["integrity"] : []),
                ],
                detectedAt: now,
              });
            }
          }
        }
        if (choice === "remote" || choice === "local") {
          const discarded = new Map<KeyString, string | null>();
          for (const key of keys) {
            if (get(l, key) !== get(r, key)) {
              discarded.set(key, choice === "remote" ? get(l, key) : get(r, key));
            }
          }
          if (await this.writeLog(txn, true, choice === "remote" ? "keepRemote" : "keepLocal", discarded)) {
            logged = true;
          }
        }
      }
      // Pruned only once every unit is applied, so a log entry that arrived in
      // this pull is never rewritten by the loop above after being pruned.
      if (logged) await this.pruneLog(txn);
      await txn.setBase({ revision: head.revision, digest: newDigest });
    });
  }

  /**
   * Records a decision and the values it discarded. Returns whether an entry
   * was written (a decision that discarded nothing is not logged).
   */
  private async writeLog(
    txn: StoreTxn,
    automatic: boolean,
    choice: "keepLocal" | "keepRemote" | "custom",
    discarded: Map<KeyString, string | null>,
  ): Promise<boolean> {
    if (discarded.size === 0) return false;
    const id = newId();
    await txn.put(
      keyString(SYNC_LOG_COLLECTION, id),
      canonicalJson({
        id,
        at: Date.now(),
        deviceLabel: this.options.deviceLabel,
        automatic,
        choice,
        discarded: [...discarded].map(([key, value]) => ({
          ...parseKey(key),
          value: value === null ? null : JSON.parse(value),
        })),
      }),
    );
    return true;
  }

  /**
   * Applies the sync log's retention (spec §13.4): keeps the newest
   * `syncLogRetention` entries plus any younger than `syncLogMaxAgeMs`, and
   * deletes the rest as ordinary, isolated deletes that sync like any edit.
   */
  private async pruneLog(txn: StoreTxn): Promise<void> {
    const history = this.options.history;
    const table = `"c_${SYNC_LOG_COLLECTION}"`;
    const rows = await txn.sql.select(
      `SELECT id FROM ${table} WHERE "ix_at" < ? AND id NOT IN ` +
        `(SELECT id FROM ${table} ORDER BY "ix_at" DESC, id DESC LIMIT ?)`,
      [Date.now() - history.syncLogMaxAgeMs, history.syncLogRetention],
    );
    for (const row of rows) {
      await txn.put(keyString(SYNC_LOG_COLLECTION, String(row.id)), null, { isolated: true });
    }
  }

  // ---------------------------------------------------------------------------
  // Target-state application (spec §13.5, §15.5)
  // ---------------------------------------------------------------------------

  private async applyTarget(
    target: Map<KeyString, string>,
    beforeKind: RestorePointKind,
    beforeLabel: string,
  ): Promise<void> {
    const hasPending = await this.store.read(async (reader) => (await reader.allPending()).length > 0);
    if (hasPending) {
      await this.store.transact((txn) => txn.writeBackup(beforeLabel, this.options.history.localBackups));
    }
    await this.pullLocked();
    const base = await this.store.read((reader) => reader.base());
    if (base.revision > 0) {
      await this.backend.putRestorePoint({
        revision: base.revision,
        kind: beforeKind,
        label: beforeLabel,
        pinned: false,
        deviceLabel: this.options.deviceLabel,
        createdAt: new Date(),
      });
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      await this.store.transact(async (txn) => {
        txn.origin = "restore";
        for (const row of await txn.allPending()) {
          if (row.heldUnit !== null) {
            row.heldUnit = null;
            await txn.savePending(row);
          }
        }
        await txn.clearConflicts();
        const current = await txn.currentState();
        for (const key of new Set([...current.keys(), ...target.keys()])) {
          const wanted = target.get(key) ?? null;
          if ((current.get(key) ?? null) !== wanted) await txn.put(key, wanted);
        }
      });
      const request = await this.prepareCommit(null);
      if (request === null) return;
      const result = await this.submitAndSettle(request);
      if (result.kind === "accepted") {
        this.knownHead = result.revision;
        return;
      }
      if (result.kind === "rejected") throw new FatalBackendError(`Commit rejected: ${result.reason}`);
      // Someone committed meanwhile: take their head, then re-apply the target.
      await this.pullLocked();
    }
    throw new TransientBackendError("Another device kept committing first; will retry.");
  }

  // ---------------------------------------------------------------------------
  // Maintenance after a successful cycle (spec §15.1–§15.3)
  // ---------------------------------------------------------------------------

  private async afterSuccessfulCycle(): Promise<void> {
    const base = await this.store.read((reader) => reader.base());
    if (base.revision === 0 || this.knownHead !== base.revision) return;
    const held = await this.store.read(async (reader) =>
      (await reader.allPending()).some((row) => row.heldUnit !== null),
    );
    if (held) return;
    await this.guardBackend(() => this.maybeDailyRestorePoint(base));
    await this.guardBackend(() => this.maybeCheckpoint(base));
  }

  private async maybeDailyRestorePoint(base: SyncBase): Promise<void> {
    if (!this.options.history.dailyRestorePoints) return;
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
      now.getDate(),
    ).padStart(2, "0")}`;
    const last = await this.store.read((reader) => reader.meta("last_daily_point"));
    if (last === today) return;
    await this.backend.putRestorePoint({
      revision: base.revision,
      kind: "daily",
      label: today,
      pinned: false,
      deviceLabel: this.options.deviceLabel,
      createdAt: now,
    });
    await this.store.transact((txn) => txn.setMeta("last_daily_point", today));
  }

  private async maybeCheckpoint(base: SyncBase): Promise<void> {
    const history = this.options.history;
    const latest = await this.backend.checkpoint({ atOrBefore: base.revision });
    const since = base.revision - (latest?.revision ?? 0);
    const stale =
      latest !== null && since > 0 && Date.now() - latest.createdAt.getTime() > history.checkpointMaxAgeMs;
    if (since < history.checkpointEvery && !stale) return;

    const state = await this.store.read((reader) => reader.baseState());
    const keys = [...state.keys()].sort(compareKeys);
    await this.backend.putCheckpoint({
      revision: base.revision,
      schemaVersion: this.schema.version,
      stateDigest: base.digest,
      entities: keys.map((key) => ({ ...parseKey(key), value: state.get(key) ?? null, group: 0 })),
      createdAt: new Date(),
    });
    await this.compact();
  }

  private async compact(): Promise<void> {
    const points = await this.backend.restorePoints();
    const unpinned = points.filter((point) => !point.pinned).sort((a, b) => b.revision - a.revision);
    const keep = this.options.history.keepRestorePoints;
    const dropped = unpinned.slice(keep);
    if (dropped.length > 0) {
      await this.backend.deleteRestorePoints(dropped.map(({ revision, kind }) => ({ revision, kind })));
    }
    const retained = [...points.filter((point) => point.pinned), ...unpinned.slice(0, keep)];
    const base = await this.store.read((reader) => reader.base());
    const oldest =
      retained.length === 0 ? base.revision : Math.min(...retained.map((point) => point.revision));
    const anchor = await this.backend.checkpoint({ atOrBefore: oldest });
    if (anchor && anchor.revision > 0) await this.backend.compact({ anchor: anchor.revision });
  }

  // ---------------------------------------------------------------------------
  // Scheduling (spec §14, §20)
  // ---------------------------------------------------------------------------

  private schedule(): void {
    this.cancelTimers();
    this.hintSubscription?.();
    this.hintSubscription = null;
    if (!this.ready || this.disposed) return;
    if (this.currentMode === "vcs") {
      const check = this.options.vcs.remoteCheckEveryMs;
      if (check !== null) {
        this.pollTimer = setInterval(() => void this.guard(() => this.checkRemote()), check);
      }
      const autoPush = this.options.vcs.autoPushEveryMs;
      if (autoPush !== null) {
        this.autoPushTimer = setInterval(() => {
          if (this.statusValue.pendingCount > 0) {
            void this.guard(() => this.push({ userInitiated: false }));
          }
        }, autoPush);
      }
    } else {
      const poll = this.options.realtime.pollMs;
      if (poll !== null) this.pollTimer = setInterval(() => this.requestCycle(), poll);
      this.hintSubscription = this.backend.onHint(() => {
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => this.requestCycle(), this.options.realtime.hintDelayMs);
      });
    }
  }

  private onLocalChange(event: ChangeEvent): void {
    void this.publishStatus();
    if (!this.ready || this.currentMode !== "realtime") return;
    if (event.origin === "remote") return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.fireLocalPush(), this.options.realtime.debounceMs);
    this.maxDelayTimer ??= setTimeout(() => this.fireLocalPush(), this.options.realtime.maxDelayMs);
  }

  private fireLocalPush(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.maxDelayTimer) clearTimeout(this.maxDelayTimer);
    this.debounceTimer = null;
    this.maxDelayTimer = null;
    this.requestCycle();
  }

  /** Runs one cycle soon, collapsing requests while one is queued. */
  private requestCycle(): void {
    if (!this.ready || this.disposed || this.cycleQueued) return;
    this.cycleQueued = true;
    queueMicrotask(() => {
      this.cycleQueued = false;
      void this.guard(() => this.sync());
    });
  }

  /** Runs an automatic operation; failures become status and a retry. */
  private async guard(body: () => Promise<void>): Promise<void> {
    try {
      await body();
      this.failures = 0;
      if (this.retryTimer) clearTimeout(this.retryTimer);
    } catch (error) {
      if (error instanceof SyncUnavailableError) return;
      this.failures++;
      const seconds = Math.min(2 ** Math.min(Math.max(this.failures - 1, 0), 8), 300);
      if (this.retryTimer) clearTimeout(this.retryTimer);
      if (!this.disposed && this.ready) {
        this.retryTimer = setTimeout(() => {
          if (this.currentMode === "realtime") this.requestCycle();
          else void this.guard(() => this.checkRemote());
        }, seconds * 1000);
      }
    }
  }

  private async guardBackend(body: () => Promise<void>): Promise<void> {
    try {
      await body();
    } catch (error) {
      // Maintenance is best-effort; the next successful cycle retries it.
      if (!(error instanceof BackendError)) throw error;
    }
  }

  private cancelTimers(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.autoPushTimer) clearInterval(this.autoPushTimer);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.maxDelayTimer) clearTimeout(this.maxDelayTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.pollTimer = this.autoPushTimer = null;
    this.debounceTimer = this.maxDelayTimer = this.retryTimer = null;
  }

  // ---------------------------------------------------------------------------
  // Operations and status
  // ---------------------------------------------------------------------------

  private operation(activity: SyncActivity, body: () => Promise<void>): Promise<void> {
    return this.queue.run(async () => {
      if (!this.ready) {
        throw new SyncUnavailableError(this.account === null ? "signedOut" : "accountMismatch");
      }
      this.activity = activity;
      await this.publishStatus();
      try {
        await body();
        this.problem = null;
      } catch (error) {
        this.problem = problemFor(error);
        throw error;
      } finally {
        this.activity = "idle";
        await this.publishStatus();
      }
    });
  }

  private async publishStatus(): Promise<void> {
    if (this.disposed) return;
    const { base, pending, units } = await this.store.read(async (reader) => ({
      base: await reader.base(),
      pending: await reader.allPending(),
      units: new Set((await reader.conflicts()).map((record) => record.unitId)),
    }));
    const heldGroups = new Set(pending.filter((row) => row.heldUnit !== null).map((row) => row.grp));
    const held = pending.filter((row) => heldGroups.has(row.grp)).length;
    const publishable = pending.length - held;
    const head = this.headChecked ? (this.knownHead ?? 0) : base.revision;

    let relation: SyncRelation;
    if (this.account === null) relation = "signedOut";
    else if (this.accountMismatch) relation = "accountMismatch";
    else if (this.remoteTooNew) relation = "remoteSchemaTooNew";
    else if (units.size > 0) relation = "conflicted";
    else if (this.headChecked && this.knownHead === null) relation = "remoteEmpty";
    else if (publishable > 0 && head > base.revision) relation = "diverged";
    else if (publishable > 0) relation = "localAhead";
    else if (head > base.revision) relation = "remoteAhead";
    else relation = "upToDate";

    this.statusValue = {
      relation,
      activity: this.activity,
      problem: this.problem,
      mode: this.currentMode,
      account: this.account,
      pendingCount: publishable,
      heldCount: held,
      conflictCount: units.size,
      baseRevision: base.revision,
      knownHeadRevision: this.headChecked ? this.knownHead : null,
      lastCheckedAt: this.lastCheckedAt,
      lastSyncedAt: this.lastSyncedAt,
    };
    this.statusEmitter.emit(this.statusValue);
  }
}

function problemFor(error: unknown): SyncProblem {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof TransientBackendError) return { kind: "offline", message };
  if (error instanceof AuthRequiredError) return { kind: "authRequired", message };
  if (error instanceof SyncIntegrityError) return { kind: "integrity", message };
  return { kind: "error", message };
}

function digestOf(state: Map<KeyString, string>): StateDigest {
  return StateDigest.of(
    [...state].map(([key, value]) => {
      const { collection, id } = parseKey(key);
      return [collection, id, value] as const;
    }),
  );
}

function decodeOrNull(value: string | null): Json | null {
  return value === null ? null : decodeDocument(value);
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

class Queue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(body: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    return previous.then(async () => {
      try {
        return await body();
      } finally {
        release();
      }
    });
  }
}
