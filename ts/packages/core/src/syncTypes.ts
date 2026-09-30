import type { Json } from "./canonical.js";
import type { DocKey } from "./schema.js";

/** How a device syncs (spec §14). Device-local; never migrates data. */
export type SyncMode = "vcs" | "realtime";

/** What to do with a unit both sides changed incompatibly (spec §13.3). */
export type ConflictPolicy = "ask" | "preferRemote" | "preferLocal";

export interface VcsOptions {
  conflictPolicy?: ConflictPolicy;
  /** Autosave: push on this interval whenever there are local changes. */
  autoPushEveryMs?: number | null;
  /** How often to check (metadata only) whether the remote moved. */
  remoteCheckEveryMs?: number | null;
}

export interface RealtimeOptions {
  conflictPolicy?: ConflictPolicy;
  debounceMs?: number;
  maxDelayMs?: number;
  hintDelayMs?: number;
  pollMs?: number | null;
}

export interface HistoryOptions {
  keepRestorePoints?: number;
  dailyRestorePoints?: boolean;
  localBackups?: number;
  checkpointEvery?: number;
  checkpointMaxAgeMs?: number;
  /**
   * Sync-log entries kept: the newest `syncLogRetention`, plus any younger
   * than `syncLogMaxAgeMs`, whichever keeps more (spec §13.4). Older entries
   * are pruned as ordinary deletes, so every device converges on the same log.
   */
  syncLogRetention?: number;
  syncLogMaxAgeMs?: number;
}

export interface SyncOptions {
  defaultMode?: SyncMode;
  vcs?: VcsOptions;
  realtime?: RealtimeOptions;
  history?: HistoryOptions;
  deviceLabel?: string | null;
}

/** SyncOptions with every default filled in. */
export interface ResolvedSyncOptions {
  defaultMode: SyncMode;
  vcs: Required<VcsOptions>;
  realtime: Required<RealtimeOptions>;
  history: Required<HistoryOptions>;
  deviceLabel: string | null;
}

export function resolveOptions(options: SyncOptions = {}): ResolvedSyncOptions {
  return {
    defaultMode: options.defaultMode ?? "vcs",
    vcs: {
      conflictPolicy: "ask",
      autoPushEveryMs: null,
      remoteCheckEveryMs: 5 * 60_000,
      ...options.vcs,
    },
    realtime: {
      conflictPolicy: "preferRemote",
      debounceMs: 2_000,
      maxDelayMs: 10_000,
      hintDelayMs: 500,
      pollMs: 60_000,
      ...options.realtime,
    },
    history: {
      keepRestorePoints: 10,
      dailyRestorePoints: true,
      localBackups: 3,
      checkpointEvery: 200,
      checkpointMaxAgeMs: 30 * 24 * 3_600_000,
      syncLogRetention: 200,
      syncLogMaxAgeMs: 90 * 24 * 3_600_000,
      ...options.history,
    },
    deviceLabel: options.deviceLabel ?? null,
  };
}

/** Where local and remote stand (spec §10). */
export type SyncRelation =
  | "signedOut"
  | "accountMismatch"
  | "remoteSchemaTooNew"
  | "conflicted"
  | "remoteEmpty"
  | "diverged"
  | "localAhead"
  | "remoteAhead"
  | "upToDate";

export type SyncActivity = "idle" | "checking" | "pulling" | "pushing" | "restoring";

export interface SyncProblem {
  readonly kind: "offline" | "authRequired" | "integrity" | "error";
  readonly message: string;
}

export interface SyncStatus {
  readonly relation: SyncRelation;
  readonly activity: SyncActivity;
  readonly problem: SyncProblem | null;
  readonly mode: SyncMode;
  readonly account: string | null;
  /** Documents with publishable local changes. */
  readonly pendingCount: number;
  /** Documents with local changes held back by conflicts. */
  readonly heldCount: number;
  /** Conflict units awaiting a decision. */
  readonly conflictCount: number;
  readonly baseRevision: number;
  readonly knownHeadRevision: number | null;
  readonly lastCheckedAt: Date | null;
  readonly lastSyncedAt: Date | null;
}

export function hasLocalChanges(status: SyncStatus): boolean {
  return status.pendingCount + status.heldCount > 0;
}

/** One document of a conflict unit (spec §13.1). */
export interface ConflictEntry {
  readonly key: DocKey;
  readonly ancestor: Json | null;
  /** The current local value (the user may have edited since detection). */
  readonly local: Json | null;
  readonly remote: Json | null;
  readonly reasons: readonly string[];
}

export interface ConflictUnit {
  readonly id: string;
  readonly detectedAt: Date;
  readonly entries: readonly ConflictEntry[];
}

export function conflictReasons(unit: ConflictUnit): Set<string> {
  return new Set(unit.entries.flatMap((entry) => entry.reasons));
}

export type Resolution =
  | { readonly kind: "keepLocal" }
  | { readonly kind: "keepRemote" }
  /** Explicit values for every entry, keyed `collection/id`; null deletes. */
  | { readonly kind: "custom"; readonly values: ReadonlyMap<string, Json | null> };

export const Resolution = {
  keepLocal: { kind: "keepLocal" } as Resolution,
  keepRemote: { kind: "keepRemote" } as Resolution,
  custom(values: ReadonlyMap<string, Json | null>): Resolution {
    return { kind: "custom", values };
  },
};

/** A recorded conflict decision (spec §13.4), synced to every device. */
export interface SyncLogEntry {
  readonly id: string;
  readonly at: Date;
  readonly deviceLabel: string | null;
  readonly automatic: boolean;
  readonly choice: "keepLocal" | "keepRemote" | "custom";
  /** Values this decision replaced; reinstating writes them back. */
  readonly discarded: readonly { readonly key: DocKey; readonly value: Json | null }[];
}

export function syncLogEntryFromJson(json: Json): SyncLogEntry {
  return {
    id: json.id as string,
    at: new Date(json.at as number),
    deviceLabel: (json.deviceLabel as string | null | undefined) ?? null,
    automatic: json.automatic === true,
    choice: json.choice as SyncLogEntry["choice"],
    discarded: (json.discarded as Json[]).map((item) => ({
      key: { collection: item.collection as string, id: item.id as string },
      value: (item.value as Json | null | undefined) ?? null,
    })),
  };
}
