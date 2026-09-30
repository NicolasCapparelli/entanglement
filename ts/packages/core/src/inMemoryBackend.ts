import { Emitter } from "./emitter.js";
import {
  AuthRequiredError,
  FatalBackendError,
  HistoryUnavailableError,
  TransientBackendError,
  type AccountSource,
  type Checkpoint,
  type Commit,
  type CommitRequest,
  type Head,
  type RestorePoint,
  type RestorePointKey,
  type SubmitResult,
  type SyncBackend,
  type Unsubscribe,
} from "./protocol.js";

/** An AccountSource driven by hand, for tests and local-only apps. */
export class ManualAccountSource implements AccountSource {
  private readonly changes = new Emitter<string | null>();

  constructor(private current: string | null = null) {}

  currentAccount(): string | null {
    return this.current;
  }

  onAccountChange(listener: (account: string | null) => void): Unsubscribe {
    return this.changes.on(listener);
  }

  signIn(account: string): void {
    this.current = account;
    this.changes.emit(account);
  }

  signOut(): void {
    this.current = null;
    this.changes.emit(null);
  }
}

/**
 * Decides whether a call fails, for fault injection. `after` is true once the
 * server has already done the work (a lost response).
 */
export type FaultRule = (op: string, after: boolean) => boolean;

class AccountState {
  head: Head | null = null;
  readonly commits = new Map<number, Commit>();
  readonly commitIds = new Map<string, number>();
  readonly checkpoints = new Map<number, Checkpoint>();
  readonly restorePoints = new Map<string, RestorePoint>();
  readonly hints = new Emitter<void>();
  compactedThrough = 0;
}

const pointKey = (key: RestorePointKey): string => `${key.revision}:${key.kind}`;

/**
 * The reference server (spec §18.4), holding any number of accounts in memory.
 * Both the test double and the executable definition of what every adapter
 * must do; the contract suite runs against it.
 */
export class InMemoryServer {
  private readonly accounts = new Map<string, AccountState>();

  /** Consulted before and after every call; true throws a transient error. */
  faults: FaultRule | null = null;

  submitCount = 0;

  /** @internal */
  state(account: string): AccountState {
    let state = this.accounts.get(account);
    if (!state) {
      state = new AccountState();
      this.accounts.set(account, state);
    }
    return state;
  }

  commitsOf(account: string): Commit[] {
    return [...this.state(account).commits.values()].sort((a, b) => a.revision - b.revision);
  }

  headOf(account: string): Head | null {
    return this.state(account).head;
  }
}

export class InMemoryBackend implements SyncBackend {
  constructor(
    readonly server: InMemoryServer,
    readonly accounts: AccountSource,
  ) {}

  private async call<T>(op: string, body: (account: AccountState) => T): Promise<T> {
    await Promise.resolve();
    const faults = this.server.faults;
    if (faults?.(op, false)) {
      throw new TransientBackendError(`Injected failure before ${op}.`);
    }
    const id = this.accounts.currentAccount();
    if (id === null) throw new AuthRequiredError("Not signed in.");
    const result = body(this.server.state(id));
    if (faults?.(op, true)) {
      throw new TransientBackendError(`Injected lost response after ${op}.`);
    }
    return result;
  }

  head(): Promise<Head | null> {
    return this.call("head", (account) => account.head);
  }

  commits({ after, upTo, limit = 200 }: { after: number; upTo: number; limit?: number }): Promise<Commit[]> {
    return this.call("commits", (account) => {
      if (after < account.compactedThrough) {
        throw new HistoryUnavailableError(
          `Commits up to ${account.compactedThrough} were compacted.`,
        );
      }
      const result: Commit[] = [];
      for (let revision = after + 1; revision <= upTo; revision++) {
        const commit = account.commits.get(revision);
        if (!commit) break;
        result.push(commit);
        if (result.length >= limit) break;
      }
      return result;
    });
  }

  submit(request: CommitRequest): Promise<SubmitResult> {
    return this.call("submit", (account): SubmitResult => {
      this.server.submitCount++;
      // Idempotency first: a retry of an accepted commit whose answer was lost
      // must hear "accepted", not "conflict".
      const existing = account.commitIds.get(request.commitId);
      if (existing !== undefined) return { kind: "accepted", revision: existing };

      const head = account.head;
      if (head && request.schemaVersion < head.minVersion) {
        return { kind: "rejected", reason: "schemaTooOld" };
      }
      const current = head?.revision ?? 0;
      if (request.parent !== current) return { kind: "conflict", headRevision: current };

      const revision = current + 1;
      const now = new Date();
      account.commits.set(revision, { revision, request, committedAt: now });
      account.commitIds.set(request.commitId, revision);
      account.head = {
        revision,
        schemaVersion: request.schemaVersion,
        minVersion: head ? Math.max(head.minVersion, request.compatibleSince) : request.compatibleSince,
        stateDigest: request.stateDigest,
        updatedAt: now,
      };
      if (request.message !== null) {
        const point: RestorePoint = {
          revision,
          kind: "commit",
          label: request.message,
          pinned: false,
          deviceLabel: request.deviceLabel,
          createdAt: now,
        };
        account.restorePoints.set(pointKey(point), point);
      }
      account.hints.emit();
      return { kind: "accepted", revision };
    });
  }

  checkpoint({ atOrBefore }: { atOrBefore: number }): Promise<Checkpoint | null> {
    return this.call("checkpoint", (account) => {
      let best: Checkpoint | null = null;
      for (const checkpoint of account.checkpoints.values()) {
        if (checkpoint.revision <= atOrBefore && (!best || checkpoint.revision > best.revision)) {
          best = checkpoint;
        }
      }
      return best;
    });
  }

  putCheckpoint(checkpoint: Checkpoint): Promise<void> {
    return this.call("putCheckpoint", (account) => {
      const commit = account.commits.get(checkpoint.revision);
      if (!commit) throw new FatalBackendError(`No commit at revision ${checkpoint.revision}.`);
      if (!commit.request.stateDigest.equals(checkpoint.stateDigest)) {
        throw new FatalBackendError("Checkpoint digest does not match its commit.", "digest_mismatch");
      }
      if (!account.checkpoints.has(checkpoint.revision)) {
        account.checkpoints.set(checkpoint.revision, checkpoint);
      }
    });
  }

  restorePoints(): Promise<RestorePoint[]> {
    return this.call("restorePoints", (account) =>
      [...account.restorePoints.values()].sort((a, b) => b.revision - a.revision),
    );
  }

  putRestorePoint(point: RestorePoint): Promise<void> {
    return this.call("putRestorePoint", (account) => {
      const head = account.head?.revision ?? 0;
      if (point.revision < 0 || point.revision > head) {
        throw new FatalBackendError(`Revision ${point.revision} not found.`);
      }
      account.restorePoints.set(pointKey(point), point);
    });
  }

  deleteRestorePoints(keys: readonly RestorePointKey[]): Promise<void> {
    return this.call("deleteRestorePoints", (account) => {
      for (const key of keys) account.restorePoints.delete(pointKey(key));
    });
  }

  compact({ anchor }: { anchor: number }): Promise<void> {
    return this.call("compact", (account) => {
      if (!account.checkpoints.has(anchor)) {
        throw new FatalBackendError(`No checkpoint at ${anchor}.`);
      }
      for (const point of account.restorePoints.values()) {
        if (point.pinned && point.revision < anchor) {
          throw new FatalBackendError("A pinned restore point precedes the anchor.");
        }
      }
      for (const revision of [...account.commits.keys()]) {
        if (revision <= anchor) account.commits.delete(revision);
      }
      for (const [id, revision] of [...account.commitIds]) {
        if (revision <= anchor) account.commitIds.delete(id);
      }
      for (const revision of [...account.checkpoints.keys()]) {
        if (revision < anchor) account.checkpoints.delete(revision);
      }
      account.compactedThrough = Math.max(account.compactedThrough, anchor);
    });
  }

  onHint(listener: () => void): Unsubscribe | null {
    const id = this.accounts.currentAccount();
    if (id === null) return null;
    return this.server.state(id).hints.on(listener);
  }
}
