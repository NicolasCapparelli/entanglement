import { canonicalJson } from "./canonical.js";
import { StateDigest } from "./digest.js";
import type { Unsubscribe } from "./emitter.js";
import { keyString, type KeyString } from "./schema.js";

export type { Unsubscribe };

/**
 * One document change in a commit, or one document in a checkpoint. `value`
 * is canonical JSON (null = deleted); it is decoded only on the wire.
 */
export interface Change {
  readonly collection: string;
  readonly id: string;
  readonly value: string | null;
  readonly group: number;
}

export function changeKey(change: Change): KeyString {
  return keyString(change.collection, change.id);
}

export function changeToJson(change: Change): Record<string, unknown> {
  const json: Record<string, unknown> = {
    collection: change.collection,
    id: change.id,
    op: change.value === null ? "delete" : "put",
    group: change.group,
  };
  if (change.value !== null) json.value = JSON.parse(change.value);
  return json;
}

export function changeFromJson(json: Record<string, unknown>): Change {
  return {
    collection: json.collection as string,
    id: json.id as string,
    value: json.op === "delete" ? null : canonicalJson(json.value),
    group: typeof json.group === "number" ? json.group : 0,
  };
}

/** What a device submits (spec §18.3). */
export interface CommitRequest {
  readonly commitId: string;
  readonly parent: number;
  readonly schemaVersion: number;
  readonly compatibleSince: number;
  readonly deviceId: string;
  readonly deviceLabel: string | null;
  /** Display only; never used for ordering. */
  readonly clientTime: number | null;
  readonly message: string | null;
  /** Digest of the state this commit produces. */
  readonly stateDigest: StateDigest;
  readonly changes: readonly Change[];
}

export function commitRequestToJson(request: CommitRequest): Record<string, unknown> {
  return {
    commitId: request.commitId,
    parent: request.parent,
    schemaVersion: request.schemaVersion,
    compatibleSince: request.compatibleSince,
    deviceId: request.deviceId,
    deviceLabel: request.deviceLabel,
    clientTime: request.clientTime,
    message: request.message,
    stateDigest: request.stateDigest.hex,
    changes: request.changes.map(changeToJson),
  };
}

export function commitRequestFromJson(json: Record<string, unknown>): CommitRequest {
  return {
    commitId: json.commitId as string,
    parent: json.parent as number,
    schemaVersion: json.schemaVersion as number,
    compatibleSince: json.compatibleSince as number,
    deviceId: json.deviceId as string,
    deviceLabel: (json.deviceLabel as string | null | undefined) ?? null,
    clientTime: (json.clientTime as number | null | undefined) ?? null,
    message: (json.message as string | null | undefined) ?? null,
    stateDigest: StateDigest.parse(json.stateDigest as string),
    changes: (json.changes as Record<string, unknown>[]).map(changeFromJson),
  };
}

/** A commit as stored by the backend. */
export interface Commit {
  readonly revision: number;
  readonly request: CommitRequest;
  /** Server time; display only. */
  readonly committedAt: Date;
}

/** The account's current position (spec §9.2). */
export interface Head {
  readonly revision: number;
  /** Schema version of the latest writer. */
  readonly schemaVersion: number;
  /** Oldest schema version still allowed to read and write. */
  readonly minVersion: number;
  readonly stateDigest: StateDigest;
  readonly updatedAt: Date;
}

export type RejectReason = "schemaTooOld" | "invalid" | "quotaExceeded";

export type SubmitResult =
  | { readonly kind: "accepted"; readonly revision: number }
  | { readonly kind: "conflict"; readonly headRevision: number }
  | { readonly kind: "rejected"; readonly reason: RejectReason };

/** A complete state at a revision (spec §15.2). */
export interface Checkpoint {
  readonly revision: number;
  readonly schemaVersion: number;
  readonly stateDigest: StateDigest;
  /** Every live document, encoded as put changes. */
  readonly entities: readonly Change[];
  readonly createdAt: Date;
}

export type RestorePointKind =
  | "commit"
  | "daily"
  | "manual"
  | "beforeRestore"
  | "beforeOverwrite";

/** A user-visible label on a revision (spec §15.1). */
export interface RestorePoint {
  readonly revision: number;
  readonly kind: RestorePointKind;
  readonly label: string | null;
  readonly pinned: boolean;
  readonly deviceLabel: string | null;
  readonly createdAt: Date;
}

export interface RestorePointKey {
  readonly revision: number;
  readonly kind: RestorePointKind;
}

/** Every backend failure is translated into one of these (spec §18.2). */
export abstract class BackendError extends Error {}

/** Retry with backoff: network down, timeout, 5xx. */
export class TransientBackendError extends BackendError {
  override name = "TransientBackendError";
}

export class AuthRequiredError extends BackendError {
  override name = "AuthRequiredError";
}

/** Commits in the requested range were compacted away. */
export class HistoryUnavailableError extends BackendError {
  override name = "HistoryUnavailableError";
}

export class FatalBackendError extends BackendError {
  override name = "FatalBackendError";

  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

/**
 * The remote side of sync (spec §18.1). Authenticated as one account, taken
 * from the adapter's session, never from requests.
 */
export interface SyncBackend {
  /** Current head, or null when the account has never committed. */
  head(): Promise<Head | null>;

  /**
   * Commits with revision in (after, upTo], ascending, at most `limit`.
   * Throws HistoryUnavailableError if any of them was compacted.
   */
  commits(options: { after: number; upTo: number; limit?: number }): Promise<Commit[]>;

  /** Compare-and-swap publish. Idempotent on commitId. */
  submit(request: CommitRequest): Promise<SubmitResult>;

  /** Newest checkpoint with revision ≤ atOrBefore, or null. */
  checkpoint(options: { atOrBefore: number }): Promise<Checkpoint | null>;

  /** Idempotent per revision; refused unless it matches its commit's digest. */
  putCheckpoint(checkpoint: Checkpoint): Promise<void>;

  restorePoints(): Promise<RestorePoint[]>;

  putRestorePoint(point: RestorePoint): Promise<void>;

  deleteRestorePoints(keys: readonly RestorePointKey[]): Promise<void>;

  /**
   * Deletes commits ≤ anchor and checkpoints < anchor. Refused unless a
   * checkpoint exists at exactly `anchor` and no pinned point precedes it.
   */
  compact(options: { anchor: number }): Promise<void>;

  /** Fires when head may have moved; carries no data. Null when unsupported. */
  onHint(listener: () => void): Unsubscribe | null;
}

/** The signed-in account as the adapter sees it; credentials stay there. */
export interface AccountSource {
  currentAccount(): string | null;
  onAccountChange(listener: (account: string | null) => void): Unsubscribe;
}
