import { expect } from "vitest";

import {
  BackendError,
  InMemoryBackend,
  IntegrityViolation,
  InMemoryServer,
  parseKey,
  Resolution,
  StateDigest,
  TransientBackendError,
  type AccountSource,
  type Commit,
  type ConflictPolicy,
  type Head,
  type SyncBackend,
} from "../src/index.js";
import { boards, Device, notes, sorted, tasks } from "./support.js";

/** mulberry32: a tiny seeded PRNG, so every failure is reproducible. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The server under simulation, plus a way to look at its books afterwards. */
export interface SimTarget {
  /** Called once per run; true makes the next call or its response fail. */
  setFaults(rule: () => boolean): void;
  backend(accounts: AccountSource): SyncBackend;
  /** Alice's head and full commit list, read without faults. */
  head(): Promise<Head | null>;
  commits(): Promise<Commit[]>;
  dispose?(): Promise<void>;
}

export function memoryTarget(): SimTarget {
  const server = new InMemoryServer();
  return {
    setFaults: (rule) => {
      server.faults = rule;
    },
    backend: (accounts) => new InMemoryBackend(server, accounts),
    head: async () => server.headOf("alice"),
    commits: async () => server.commitsOf("alice"),
  };
}

/**
 * Wraps any backend with the simulation's fault injection: a call may fail
 * before reaching the server, or after it (a lost response).
 */
export class FaultyBackend implements SyncBackend {
  constructor(
    private readonly inner: SyncBackend,
    private readonly faults: () => (op: string, after: boolean) => boolean,
  ) {}

  private async run<T>(op: string, body: () => Promise<T>): Promise<T> {
    if (this.faults()(op, false)) throw new TransientBackendError(`Injected failure before ${op}.`);
    const result = await body();
    if (this.faults()(op, true)) throw new TransientBackendError(`Injected lost response after ${op}.`);
    return result;
  }

  head: SyncBackend["head"] = () => this.run("head", () => this.inner.head());
  commits: SyncBackend["commits"] = (o) => this.run("commits", () => this.inner.commits(o));
  submit: SyncBackend["submit"] = (r) => this.run("submit", () => this.inner.submit(r));
  checkpoint: SyncBackend["checkpoint"] = (o) => this.run("checkpoint", () => this.inner.checkpoint(o));
  putCheckpoint: SyncBackend["putCheckpoint"] = (c) => this.run("putCheckpoint", () => this.inner.putCheckpoint(c));
  restorePoints: SyncBackend["restorePoints"] = () => this.run("restorePoints", () => this.inner.restorePoints());
  putRestorePoint: SyncBackend["putRestorePoint"] = (p) => this.run("putRestorePoint", () => this.inner.putRestorePoint(p));
  deleteRestorePoints: SyncBackend["deleteRestorePoints"] = (k) =>
    this.run("deleteRestorePoints", () => this.inner.deleteRestorePoints(k));
  compact: SyncBackend["compact"] = (o) => this.run("compact", () => this.inner.compact(o));
  onHint: SyncBackend["onHint"] = (l) => this.inner.onHint(l);
}

/**
 * Seeded multi-device simulation (spec §23.3), mirroring the Dart harness.
 * Devices edit and sync at random while the server drops requests and
 * responses; once faults stop and everyone syncs, all devices must hold the
 * identical state with nothing pending, no conflicts, valid references, and a
 * clean commit history.
 */
export async function simulate(
  seed: number,
  interactive: boolean,
  target: SimTarget = memoryTarget(),
): Promise<void> {
  const random = rng(seed);
  const int = (n: number): number => Math.floor(random() * n);
  const pick = <T>(items: T[]): T => items[int(items.length)]!;
  let faultRate = 0.15;
  target.setFaults(() => random() < faultRate);

  const policies: ConflictPolicy[] = ["preferRemote", "preferLocal", ...(interactive ? (["ask", "ask"] as const) : [])];
  const devices: Device[] = [];
  for (let index = 0; index < 4; index++) {
    const device = await Device.create(null, {
      backend: (accounts) => target.backend(accounts),
      name: `d${index}`,
      sync: {
        vcs: { remoteCheckEveryMs: null },
        history: { dailyRestorePoints: false, checkpointEvery: 3 + int(6), keepRestorePoints: 1 + int(3) },
      },
    });
    await device.sync.setConflictPolicy(pick(policies));
    devices.push(device);
  }

  let counter = 0;
  const fresh = (prefix: string): string => `${prefix}${seed}_${counter++}`;

  const randomEdit = async (device: Device): Promise<void> => {
    const keys = [...(await device.state()).keys()].map(parseKey);
    const ids = (collection: string): string[] => keys.filter((k) => k.collection === collection).map((k) => k.id);
    const boardIds = ids("boards");
    const taskIds = ids("tasks");
    const noteIds = ids("notes");
    const roll = int(9);
    if (roll === 0 || boardIds.length === 0) {
      await device.addBoard(fresh("b"), `board ${counter}`);
    } else if (roll === 1) {
      await device.db.write((tx) => tx.patch(boards, pick(boardIds), { name: `renamed ${counter++}` }));
    } else if (roll === 2) {
      const board = pick(boardIds);
      await device.db.write(async (tx) => {
        for (const task of await tx.query(tasks).where("boardId", { isEqualTo: board }).get()) {
          await tx.delete(tasks, task.id as string);
        }
        await tx.delete(boards, board);
      });
    } else if (roll === 3 || roll === 4) {
      await device.addTask(fresh("t"), "task", pick(boardIds), int(5));
    } else if (roll === 5 && taskIds.length > 0) {
      await device.db.write((tx) => tx.patch(tasks, pick(taskIds), { title: `edit ${counter++}` }));
    } else if (roll === 6 && taskIds.length > 0) {
      await device.db.write((tx) => tx.patch(tasks, pick(taskIds), { done: random() < 0.5 }));
    } else if (roll === 7 && taskIds.length > 0 && boardIds.length > 1) {
      await device.db.write((tx) => tx.patch(tasks, pick(taskIds), { boardId: pick(boardIds) }));
    } else if (roll === 8 && noteIds.length > 0 && random() < 0.5) {
      await device.db.write((tx) => tx.delete(notes, pick(noteIds)));
    } else {
      await device.db.write((tx) => tx.put(notes, { id: fresh("n"), text: "note" }));
    }
  };

  const resolveAll = async (device: Device): Promise<void> => {
    for (const unit of await device.sync.conflicts()) {
      await device.sync.resolve(unit.id, random() < 0.5 ? Resolution.keepLocal : Resolution.keepRemote);
    }
  };

  const randomSync = async (device: Device): Promise<void> => {
    try {
      const roll = int(interactive ? 20 : 3);
      if (roll === 0) await device.sync.push();
      else if (roll === 1) await device.sync.pull();
      else if (roll >= 3 && roll <= 5) await resolveAll(device);
      else if (roll === 6) {
        const points = await device.sync.restorePoints();
        if (points.length > 0) await device.sync.restore(pick(points));
      } else if (roll === 7) await device.sync.overwriteRemoteWithLocal();
      else if (roll === 8) await device.sync.discardLocalAndPull();
      else await device.sync.sync();
    } catch (error) {
      // Injected faults recover on the next attempt; a resolution that would
      // break a reference is refused and chosen differently later.
      if (!(error instanceof BackendError) && !(error instanceof IntegrityViolation)) throw error;
    }
  };

  for (let step = 0; step < 250; step++) {
    const device = pick(devices);
    const edit = random() < 0.55;
    try {
      if (edit) await randomEdit(device);
      else await randomSync(device);
    } catch (error) {
      throw new Error(`seed ${seed} step ${step}, ${device.name} ${edit ? "edit" : "sync"}: ${String(error)}`);
    }
  }

  faultRate = 0;
  for (let round = 0; round < 8; round++) {
    for (const device of devices) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await resolveAll(device);
          break;
        } catch (error) {
          if (!(error instanceof IntegrityViolation)) throw error;
        }
      }
      try {
        await device.sync.sync();
      } catch (error) {
        throw new Error(`seed ${seed} quiesce round ${round}, ${device.name}: ${String(error)}`);
      }
    }
  }

  const reference = sorted(await devices[0]!.state());
  for (const device of devices) {
    expect(sorted(await device.state()), `${device.name} diverged (seed ${seed})`).toEqual(reference);
    expect(device.sync.status.pendingCount + device.sync.status.heldCount).toBe(0);
    expect(device.sync.status.conflictCount).toBe(0);
    expect(device.sync.status.relation).toBe("upToDate");
  }
  const head = (await target.head())!;
  const digest = StateDigest.of(
    reference.map(([key, value]) => [parseKey(key as never).collection, parseKey(key as never).id, value] as const),
  );
  expect(digest.hex).toBe(head.stateDigest.hex);
  const boardIds = new Set(reference.filter(([key]) => key.startsWith("boards/")).map(([key]) => key.slice(7)));
  for (const [key, value] of reference) {
    if (key.startsWith("tasks/")) expect(boardIds.has(JSON.parse(value).boardId)).toBe(true);
  }
  const commits = await target.commits();
  expect(new Set(commits.map((c) => c.request.commitId)).size).toBe(commits.length);
  commits.forEach((commit, index) => {
    if (index > 0) expect(commit.revision).toBe(commits[index - 1]!.revision + 1);
  });

  for (const device of devices) await device.close();
  await target.dispose?.();
}

