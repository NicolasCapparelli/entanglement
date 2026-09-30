import { describe, expect, test } from "vitest";

import {
  BackendError,
  IntegrityViolation,
  InMemoryServer,
  parseKey,
  Resolution,
  StateDigest,
  type ConflictPolicy,
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

/**
 * Seeded multi-device simulation (spec §23.3), mirroring the Dart harness.
 * Devices edit and sync at random while the server drops requests and
 * responses; once faults stop and everyone syncs, all devices must hold the
 * identical state with nothing pending, no conflicts, valid references, and a
 * clean commit history.
 */
async function simulate(seed: number, interactive: boolean): Promise<void> {
  const random = rng(seed);
  const int = (n: number): number => Math.floor(random() * n);
  const pick = <T>(items: T[]): T => items[int(items.length)]!;
  const server = new InMemoryServer();
  let faultRate = 0.15;
  server.faults = () => random() < faultRate;

  const policies: ConflictPolicy[] = ["preferRemote", "preferLocal", ...(interactive ? (["ask", "ask"] as const) : [])];
  const devices: Device[] = [];
  for (let index = 0; index < 4; index++) {
    const device = await Device.create(server, {
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
  const head = server.headOf("alice")!;
  const digest = StateDigest.of(
    reference.map(([key, value]) => [parseKey(key as never).collection, parseKey(key as never).id, value] as const),
  );
  expect(digest.hex).toBe(head.stateDigest.hex);
  const boardIds = new Set(reference.filter(([key]) => key.startsWith("boards/")).map(([key]) => key.slice(7)));
  for (const [key, value] of reference) {
    if (key.startsWith("tasks/")) expect(boardIds.has(JSON.parse(value).boardId)).toBe(true);
  }
  const commits = server.commitsOf("alice");
  expect(new Set(commits.map((c) => c.request.commitId)).size).toBe(commits.length);
  commits.forEach((commit, index) => {
    if (index > 0) expect(commit.revision).toBe(commits[index - 1]!.revision + 1);
  });

  for (const device of devices) await device.close();
}

describe("automatic policies", () => {
  for (let seed = 1; seed <= 150; seed++) test(`seed ${seed} converges`, () => simulate(seed, false));
});

describe("asking, with random resolutions, restores and overwrites", () => {
  for (let seed = 1001; seed <= 1150; seed++) test(`seed ${seed} converges`, () => simulate(seed, true));
});
