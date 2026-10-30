import { HISTORY_UNAVAILABLE, ServerError, type SubmitStatus } from "./wire.js";
import type { SyncStorage } from "./storage.js";

type Json = Record<string, unknown>;

const RESTORE_KINDS = new Set(["commit", "daily", "manual", "beforeRestore", "beforeOverwrite"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGEST = /^[0-9a-f]{64}$/i;

/** Large payloads are split so no SQLite value nears the 2 MB row limit. */
const CHUNK_CHARS = 400_000;
const MAX_COMMITS_PER_READ = 1000;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  // At most one row, created by the first accepted commit; no row = revision 0.
  `CREATE TABLE IF NOT EXISTS head (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     revision INTEGER NOT NULL,
     schema_version INTEGER NOT NULL,
     min_version INTEGER NOT NULL,
     state_digest TEXT NOT NULL,
     compacted_through INTEGER NOT NULL DEFAULT 0,
     updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS commits (
     revision INTEGER PRIMARY KEY,
     commit_id TEXT NOT NULL UNIQUE,
     parent INTEGER NOT NULL,
     schema_version INTEGER NOT NULL,
     compatible_since INTEGER NOT NULL,
     state_digest TEXT NOT NULL,
     device_id TEXT NOT NULL,
     device_label TEXT,
     client_time INTEGER,
     message TEXT,
     committed_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS checkpoints (
     revision INTEGER PRIMARY KEY,
     schema_version INTEGER NOT NULL,
     state_digest TEXT NOT NULL,
     created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS restore_points (
     revision INTEGER NOT NULL,
     kind TEXT NOT NULL,
     label TEXT,
     pinned INTEGER NOT NULL DEFAULT 0,
     device_label TEXT,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (revision, kind))`,
  // The change list of a commit, or the entity list of a checkpoint, as JSON text.
  `CREATE TABLE IF NOT EXISTS payload (
     kind TEXT NOT NULL,
     revision INTEGER NOT NULL,
     seq INTEGER NOT NULL,
     data TEXT NOT NULL,
     PRIMARY KEY (kind, revision, seq))`,
];

const isInt = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);
const text = (value: unknown): string | null => (value == null ? null : String(value));

/**
 * One account's Entanglement server (spec §18.4) over Durable Object SQLite,
 * the counterpart of the Supabase `ent_*` functions. A Durable Object runs one
 * request at a time and `transactionSync` makes each operation atomic, which
 * is what the Postgres version needs row locks for.
 *
 * Methods take and return the wire JSON; failures throw ServerError.
 */
export class AccountServer {
  constructor(
    private readonly storage: SyncStorage,
    /** Called after a commit lands. Carries the new revision, nothing else. */
    private readonly onHint: (revision: number) => void = () => {},
    private readonly now: () => number = Date.now,
  ) {}

  private rows(query: string, ...bindings: unknown[]): Json[] {
    return this.storage.sql.exec(query, ...bindings).toArray() as Json[];
  }

  migrate(): void {
    this.storage.transactionSync(() => {
      for (const statement of SCHEMA) this.rows(statement);
    });
  }

  /** Binds the store to one account; a different one later is refused. */
  bindAccount(account: string): void {
    this.storage.transactionSync(() => {
      const row = this.rows(`SELECT value FROM meta WHERE key = 'account'`)[0];
      if (!row) this.rows(`INSERT INTO meta (key, value) VALUES ('account', ?)`, account);
      else if (row.value !== account) throw new ServerError(403, "wrong_account", "This store belongs to another account.");
    });
  }

  private readHead(): Json | undefined {
    return this.rows(`SELECT * FROM head WHERE id = 1`)[0];
  }

  private currentRevision(): number {
    return Number(this.readHead()?.revision ?? 0);
  }

  private writePayload(kind: string, revision: number, json: string): void {
    this.rows(`DELETE FROM payload WHERE kind = ? AND revision = ?`, kind, revision);
    for (let seq = 0, offset = 0; offset < json.length || seq === 0; seq++, offset += CHUNK_CHARS) {
      this.rows(
        `INSERT INTO payload (kind, revision, seq, data) VALUES (?, ?, ?, ?)`,
        kind,
        revision,
        seq,
        json.slice(offset, offset + CHUNK_CHARS),
      );
    }
  }

  private readPayload(kind: string, revision: number): unknown {
    const parts = this.rows(`SELECT data FROM payload WHERE kind = ? AND revision = ? ORDER BY seq`, kind, revision);
    return JSON.parse(parts.map((part) => String(part.data)).join("") || "[]");
  }

  // -- reads ----------------------------------------------------------------

  head(): Json | null {
    const row = this.readHead();
    if (!row || Number(row.revision) === 0) return null;
    return {
      revision: Number(row.revision),
      schemaVersion: Number(row.schema_version),
      minVersion: Number(row.min_version),
      stateDigest: String(row.state_digest),
      updatedAt: Number(row.updated_at),
    };
  }

  commits(after: number, upTo: number, limit: number): Json[] {
    if (!isInt(after) || !isInt(upTo) || !isInt(limit) || limit < 1) {
      throw new ServerError(400, "invalid_request", "Bad commits range.");
    }
    const compacted = Number(this.readHead()?.compacted_through ?? 0);
    if (after < compacted) {
      throw new ServerError(410, HISTORY_UNAVAILABLE, `Commits up to ${compacted} were compacted.`);
    }
    const rows = this.rows(
      `SELECT * FROM commits WHERE revision > ? AND revision <= ? ORDER BY revision LIMIT ?`,
      after,
      upTo,
      Math.min(limit, MAX_COMMITS_PER_READ),
    );
    return rows.map((row) => ({
      revision: Number(row.revision),
      committedAt: Number(row.committed_at),
      request: {
        commitId: String(row.commit_id),
        parent: Number(row.parent),
        schemaVersion: Number(row.schema_version),
        compatibleSince: Number(row.compatible_since),
        deviceId: String(row.device_id),
        deviceLabel: text(row.device_label),
        clientTime: row.client_time == null ? null : Number(row.client_time),
        message: text(row.message),
        stateDigest: String(row.state_digest),
        changes: this.readPayload("commit", Number(row.revision)),
      },
    }));
  }

  checkpoint(atOrBefore: number): Json | null {
    if (!isInt(atOrBefore)) throw new ServerError(400, "invalid_request", "Bad revision.");
    const row = this.rows(`SELECT * FROM checkpoints WHERE revision <= ? ORDER BY revision DESC LIMIT 1`, atOrBefore)[0];
    if (!row) return null;
    return {
      revision: Number(row.revision),
      schemaVersion: Number(row.schema_version),
      stateDigest: String(row.state_digest),
      entities: this.readPayload("checkpoint", Number(row.revision)),
      createdAt: Number(row.created_at),
    };
  }

  restorePoints(): Json[] {
    return this.rows(`SELECT * FROM restore_points ORDER BY revision DESC, kind`).map((row) => ({
      revision: Number(row.revision),
      kind: String(row.kind),
      label: text(row.label),
      pinned: Number(row.pinned) === 1,
      deviceLabel: text(row.device_label),
      createdAt: Number(row.created_at),
    }));
  }

  // -- writes ---------------------------------------------------------------

  /** Compare-and-swap publish (the `ent_submit` function). */
  submit(request: Json): { status: SubmitStatus; revision: number | null } {
    const invalid = { status: "rejected_invalid" as const, revision: null };
    const { commitId, parent, schemaVersion, compatibleSince, stateDigest, changes } = request;
    if (
      typeof commitId !== "string" ||
      !UUID.test(commitId) ||
      !isInt(parent) ||
      parent < 0 ||
      !isInt(schemaVersion) ||
      !isInt(compatibleSince) ||
      typeof stateDigest !== "string" ||
      !DIGEST.test(stateDigest) ||
      !Array.isArray(changes) ||
      !changes.every(validChange) ||
      (request.clientTime != null && !isInt(request.clientTime)) ||
      (request.deviceLabel != null && typeof request.deviceLabel !== "string") ||
      (request.message != null && typeof request.message !== "string")
    ) {
      return invalid;
    }
    const result = this.storage.transactionSync(() => {
      const head = this.readHead();
      const current = Number(head?.revision ?? 0);

      // 1. Idempotency: a retry whose answer was lost must hear "accepted".
      const existing = this.rows(`SELECT revision FROM commits WHERE commit_id = ?`, commitId)[0];
      if (existing) return { status: "accepted" as const, revision: Number(existing.revision) };

      // 2. Schema gate (spec §17.2). An empty account has no data to protect.
      if (head && current > 0 && schemaVersion < Number(head.min_version)) {
        return { status: "rejected_schema_too_old" as const, revision: current };
      }

      // 3. Compare-and-swap.
      if (parent !== current) return { status: "conflict" as const, revision: current };

      // 4. Advance.
      const revision = current + 1;
      const now = this.now();
      const message = text(request.message);
      const deviceLabel = text(request.deviceLabel);
      this.rows(
        `INSERT INTO commits (revision, commit_id, parent, schema_version, compatible_since, state_digest,
           device_id, device_label, client_time, message, committed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        revision,
        commitId,
        parent,
        schemaVersion,
        compatibleSince,
        stateDigest,
        text(request.deviceId) ?? "",
        deviceLabel,
        request.clientTime ?? null,
        message,
        now,
      );
      this.writePayload("commit", revision, JSON.stringify(changes));
      if (head) {
        this.rows(
          `UPDATE head SET revision = ?, schema_version = ?, min_version = MAX(min_version, ?),
             state_digest = ?, updated_at = ? WHERE id = 1`,
          revision,
          schemaVersion,
          compatibleSince,
          stateDigest,
          now,
        );
      } else {
        this.rows(
          `INSERT INTO head (id, revision, schema_version, min_version, state_digest, compacted_through, updated_at)
           VALUES (1, ?, ?, ?, ?, 0, ?)`,
          revision,
          schemaVersion,
          compatibleSince,
          stateDigest,
          now,
        );
      }
      if (message !== null) {
        this.rows(
          `INSERT OR IGNORE INTO restore_points (revision, kind, label, pinned, device_label, created_at)
           VALUES (?, 'commit', ?, 0, ?, ?)`,
          revision,
          message,
          deviceLabel,
          now,
        );
      }
      return { status: "accepted" as const, revision };
    });
    if (result.status === "accepted" && result.revision !== null) this.onHint(result.revision);
    return result;
  }

  /** Accepted only if it matches its commit's digest (`ent_put_checkpoint`). */
  putCheckpoint(checkpoint: Json): void {
    const { revision, schemaVersion, stateDigest, entities } = checkpoint;
    if (!isInt(revision) || !isInt(schemaVersion) || typeof stateDigest !== "string" || !Array.isArray(entities) || !entities.every(validChange)) {
      throw new ServerError(400, "invalid_request", "Bad checkpoint.");
    }
    this.storage.transactionSync(() => {
      const commit = this.rows(`SELECT state_digest FROM commits WHERE revision = ?`, revision)[0];
      if (!commit) throw new ServerError(404, "not_found", `No commit at revision ${revision}.`);
      if (String(commit.state_digest) !== stateDigest) {
        throw new ServerError(422, "digest_mismatch", "Checkpoint digest does not match its commit.");
      }
      if (this.rows(`SELECT 1 FROM checkpoints WHERE revision = ?`, revision).length > 0) return;
      this.rows(
        `INSERT INTO checkpoints (revision, schema_version, state_digest, created_at) VALUES (?, ?, ?, ?)`,
        revision,
        schemaVersion,
        stateDigest,
        this.now(),
      );
      this.writePayload("checkpoint", revision, JSON.stringify(entities));
    });
  }

  putRestorePoint(point: Json): void {
    const { revision, kind } = point;
    if (!isInt(revision) || typeof kind !== "string" || !RESTORE_KINDS.has(kind)) {
      throw new ServerError(400, "invalid_request", "Bad restore point.");
    }
    this.storage.transactionSync(() => {
      if (revision < 0 || revision > this.currentRevision()) {
        throw new ServerError(404, "not_found", `Revision ${revision} not found.`);
      }
      this.rows(
        `INSERT INTO restore_points (revision, kind, label, pinned, device_label, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (revision, kind) DO UPDATE SET
           label = excluded.label, pinned = excluded.pinned, device_label = excluded.device_label`,
        revision,
        kind,
        text(point.label),
        point.pinned === true ? 1 : 0,
        text(point.deviceLabel),
        this.now(),
      );
    });
  }

  deleteRestorePoints(keys: unknown): void {
    if (!Array.isArray(keys) || !keys.every((key) => key && isInt(key.revision) && typeof key.kind === "string")) {
      throw new ServerError(400, "invalid_request", "Bad restore point keys.");
    }
    this.storage.transactionSync(() => {
      for (const key of keys as { revision: number; kind: string }[]) {
        this.rows(`DELETE FROM restore_points WHERE revision = ? AND kind = ?`, key.revision, key.kind);
      }
    });
  }

  /** Drops history older than a checkpoint anchor (`ent_compact`, spec §15.3). */
  compact(anchor: number): void {
    if (!isInt(anchor)) throw new ServerError(400, "invalid_request", "Bad anchor.");
    this.storage.transactionSync(() => {
      if (this.rows(`SELECT 1 FROM checkpoints WHERE revision = ?`, anchor).length === 0) {
        throw new ServerError(404, "not_found", `No checkpoint at ${anchor}.`);
      }
      if (this.rows(`SELECT 1 FROM restore_points WHERE pinned = 1 AND revision < ? LIMIT 1`, anchor).length > 0) {
        throw new ServerError(422, "pinned_precedes_anchor", "A pinned restore point precedes the anchor.");
      }
      this.rows(`DELETE FROM payload WHERE kind = 'commit' AND revision <= ?`, anchor);
      this.rows(`DELETE FROM payload WHERE kind = 'checkpoint' AND revision < ?`, anchor);
      this.rows(`DELETE FROM commits WHERE revision <= ?`, anchor);
      this.rows(`DELETE FROM checkpoints WHERE revision < ?`, anchor);
      this.rows(`UPDATE head SET compacted_through = MAX(compacted_through, ?) WHERE id = 1`, anchor);
    });
  }
}

function validChange(change: unknown): boolean {
  if (typeof change !== "object" || change === null) return false;
  const { collection, id, op } = change as Json;
  return typeof collection === "string" && typeof id === "string" && (op === "put" || op === "delete");
}
