import { afterEach, beforeEach, expect, test } from "vitest";

import {
  BackendError,
  HistoryUnavailableError,
  newId,
  StateDigest,
  type Change,
  type Checkpoint,
  type CommitRequest,
  type RestorePoint,
  type SyncBackend,
} from "../src/index.js";

/** A fresh, empty account on some backend, plus optionally a second one. */
export interface ContractHarness {
  backend: SyncBackend;
  otherAccount?: SyncBackend;
  dispose?: () => Promise<void>;
}

/**
 * The backend conformance suite (design spec §23.4), mirroring the Dart one
 * test for test. Every adapter must pass it; the in-memory reference backend
 * runs it too.
 */
export function runBackendContract(create: () => Promise<ContractHarness>): void {
  let harness: ContractHarness;
  const backend = (): SyncBackend => harness.backend;

  beforeEach(async () => {
    harness = await create();
  });
  afterEach(async () => {
    await harness.dispose?.();
  });

  let digestSeed = 0;
  const request = (options: {
    parent: number;
    commitId?: string;
    schemaVersion?: number;
    compatibleSince?: number;
    message?: string | null;
    changes?: Change[];
    digest?: StateDigest;
  }): CommitRequest => ({
    commitId: options.commitId ?? newId(),
    parent: options.parent,
    schemaVersion: options.schemaVersion ?? 1,
    compatibleSince: options.compatibleSince ?? 1,
    deviceId: "contract-device",
    deviceLabel: "Contract",
    clientTime: Date.now(),
    message: options.message ?? null,
    stateDigest: options.digest ?? StateDigest.of([["seed", String(digestSeed++), "{}"]]),
    changes: options.changes ?? [
      { collection: "notes", id: `n${options.parent}`, value: '{"text":"hi"}', group: 0 },
    ],
  });

  const commit = async (parent: number, options: { message?: string; digest?: StateDigest } = {}): Promise<number> => {
    const result = await backend().submit(request({ parent, ...options }));
    expect(result.kind).toBe("accepted");
    return result.kind === "accepted" ? result.revision : -1;
  };

  const point = (revision: number, kind: RestorePoint["kind"], label: string | null, pinned: boolean): RestorePoint => ({
    revision,
    kind,
    label,
    pinned,
    deviceLabel: "Contract",
    createdAt: new Date(),
  });

  test("an empty account has no head", async () => {
    expect(await backend().head()).toBeNull();
    expect(await backend().commits({ after: 0, upTo: 10 })).toEqual([]);
    expect(await backend().checkpoint({ atOrBefore: 10 })).toBeNull();
    expect(await backend().restorePoints()).toEqual([]);
  });

  test("the first commit creates revision 1 and the head describes it", async () => {
    const digest = StateDigest.of([["notes", "n0", '{"text":"hi"}']]);
    const result = await backend().submit(request({ parent: 0, schemaVersion: 3, compatibleSince: 2, digest }));
    expect(result).toEqual({ kind: "accepted", revision: 1 });
    const head = (await backend().head())!;
    expect(head.revision).toBe(1);
    expect(head.schemaVersion).toBe(3);
    expect(head.minVersion).toBe(2);
    expect(head.stateDigest.hex).toBe(digest.hex);
  });

  test("a stale parent is a conflict naming the current head", async () => {
    await commit(0);
    await commit(1);
    expect(await backend().submit(request({ parent: 1 }))).toEqual({ kind: "conflict", headRevision: 2 });
    expect((await backend().head())!.revision).toBe(2);
  });

  test("resubmitting a commit id is recognised, whatever its parent", async () => {
    const original = request({ parent: 0 });
    expect((await backend().submit(original)).kind).toBe("accepted");
    await commit(1);
    expect(await backend().submit(original)).toEqual({ kind: "accepted", revision: 1 });
    expect((await backend().head())!.revision).toBe(2);
  });

  test("a first commit against a non-zero parent conflicts", async () => {
    expect(await backend().submit(request({ parent: 5 }))).toEqual({ kind: "conflict", headRevision: 0 });
    expect(await backend().head()).toBeNull();
  });

  test("the schema gate fences off writers older than minVersion", async () => {
    await backend().submit(request({ parent: 0, schemaVersion: 2, compatibleSince: 2 }));
    expect(await backend().submit(request({ parent: 1, schemaVersion: 1, compatibleSince: 1 }))).toEqual({
      kind: "rejected",
      reason: "schemaTooOld",
    });
    await backend().submit(request({ parent: 1, schemaVersion: 3, compatibleSince: 1 }));
    expect((await backend().head())!.minVersion).toBe(2);
  });

  test("commits come back in order, contiguous, with changes intact", async () => {
    const changes: Change[] = [
      { collection: "tasks", id: "t1", value: '{"done":false,"title":"x"}', group: 0 },
      { collection: "boards", id: "b1", value: '{"name":"é 😀"}', group: 0 },
      { collection: "tasks", id: "t0", value: null, group: 1 },
    ];
    await backend().submit(request({ parent: 0, changes, message: "first" }));
    await commit(1);
    await commit(2);
    const all = await backend().commits({ after: 0, upTo: 3 });
    expect(all.map((c) => c.revision)).toEqual([1, 2, 3]);
    const first = all[0]!.request;
    expect(first.message).toBe("first");
    expect(first.deviceLabel).toBe("Contract");
    expect(first.changes).toEqual(changes);
    expect((await backend().commits({ after: 1, upTo: 2 })).map((c) => c.revision)).toEqual([2]);
    expect((await backend().commits({ after: 0, upTo: 3, limit: 2 })).map((c) => c.revision)).toEqual([1, 2]);
  });

  test("a message makes a commit restore point; points can be added and removed", async () => {
    await commit(0, { message: "labelled" });
    await commit(1);
    await backend().putRestorePoint(point(2, "manual", "mine", true));
    const summary = (await backend().restorePoints()).map((p) => [p.revision, p.kind, p.label, p.pinned]);
    expect(summary).toEqual(
      expect.arrayContaining([
        [1, "commit", "labelled", false],
        [2, "manual", "mine", true],
      ]),
    );
    expect(summary).toHaveLength(2);
    await backend().deleteRestorePoints([{ revision: 1, kind: "commit" }]);
    expect((await backend().restorePoints()).map((p) => p.revision)).toEqual([2]);
    await expect(backend().putRestorePoint(point(99, "manual", null, false))).rejects.toBeInstanceOf(BackendError);
  });

  test("checkpoints must match their commit digest", async () => {
    const digest = StateDigest.of([["notes", "n0", '{"text":"hi"}']]);
    await commit(0, { digest });
    await commit(1);
    const checkpoint = (stateDigest: StateDigest): Checkpoint => ({
      revision: 1,
      schemaVersion: 1,
      stateDigest,
      entities: [{ collection: "notes", id: "n0", value: '{"text":"hi"}', group: 0 }],
      createdAt: new Date(),
    });
    await expect(backend().putCheckpoint(checkpoint(StateDigest.empty))).rejects.toBeInstanceOf(BackendError);
    await backend().putCheckpoint(checkpoint(digest));
    await backend().putCheckpoint(checkpoint(digest));
    const stored = (await backend().checkpoint({ atOrBefore: 2 }))!;
    expect(stored.revision).toBe(1);
    expect(stored.stateDigest.hex).toBe(digest.hex);
    expect(stored.entities[0]!.value).toBe('{"text":"hi"}');
    expect(await backend().checkpoint({ atOrBefore: 0 })).toBeNull();
  });

  test("compaction keeps everything after its anchor and guards pinned points", async () => {
    const digests: StateDigest[] = [];
    for (let parent = 0; parent < 4; parent++) {
      const digest = StateDigest.of([["notes", `rev${parent}`, "{}"]]);
      digests.push(digest);
      await commit(parent, { digest });
    }
    const at = (revision: number): Checkpoint => ({
      revision,
      schemaVersion: 1,
      stateDigest: digests[revision - 1]!,
      entities: [],
      createdAt: new Date(),
    });
    await expect(backend().compact({ anchor: 2 })).rejects.toBeInstanceOf(BackendError);
    await backend().putCheckpoint(at(1));
    await backend().putCheckpoint(at(3));
    await backend().putRestorePoint(point(2, "manual", "pinned", true));
    await expect(backend().compact({ anchor: 3 })).rejects.toBeInstanceOf(BackendError);
    await backend().deleteRestorePoints([{ revision: 2, kind: "manual" }]);
    await backend().compact({ anchor: 3 });
    await expect(backend().commits({ after: 0, upTo: 4 })).rejects.toBeInstanceOf(HistoryUnavailableError);
    expect((await backend().commits({ after: 3, upTo: 4 })).map((c) => c.revision)).toEqual([4]);
    expect((await backend().checkpoint({ atOrBefore: 4 }))!.revision).toBe(3);
    expect(await backend().checkpoint({ atOrBefore: 2 })).toBeNull();
    await commit(4);
    expect((await backend().head())!.revision).toBe(5);
  });

  test("accounts are isolated", async (context) => {
    const other = harness.otherAccount;
    if (!other) return context.skip();
    await commit(0);
    expect(await other.head()).toBeNull();
    expect(await other.commits({ after: 0, upTo: 10 })).toEqual([]);
    expect((await other.submit(request({ parent: 0 }))).kind).toBe("accepted");
    expect((await backend().head())!.revision).toBe(1);
  });

  test("hints fire when the head moves", async () => {
    let resolveFired!: () => void;
    const fired = new Promise<void>((resolve) => {
      resolveFired = resolve;
    });
    const unsubscribe = backend().onHint(() => resolveFired());
    if (!unsubscribe) return;
    // A realtime channel takes a moment to join, and a change made before it
    // joins is not seen (production falls back to polling). Keep moving the
    // head until a hint arrives rather than guessing a delay.
    let received = false;
    void fired.then(() => {
      received = true;
    });
    for (let parent = 0; parent < 6 && !received; parent++) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await commit(parent);
    }
    await Promise.race([
      fired,
      new Promise((_, reject) => setTimeout(() => reject(new Error("no hint")), 5_000)),
    ]);
    unsubscribe();
  }, 30_000);
}
