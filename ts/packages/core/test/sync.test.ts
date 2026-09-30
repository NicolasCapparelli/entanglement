import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  canonicalJson,
  Collection,
  keyString,
  conflictReasons,
  hasLocalChanges,
  InMemoryServer,
  Resolution,
  Schema,
  SyncUnavailableError,
  TransientBackendError,
  type SyncOptions,
} from "../src/index.js";
import { boards, Device, notes, prefs, sorted, tasks, testSchema, tick } from "./support.js";

let server: InMemoryServer;
const devices: Device[] = [];

async function device(
  name: string,
  options: { account?: string | null; sync?: SyncOptions; schema?: Schema } = {},
): Promise<Device> {
  const created = await Device.create(server, { name, ...options });
  devices.push(created);
  return created;
}

/** Two devices sharing a board with one task, fully synced. */
async function syncedPair(): Promise<[Device, Device]> {
  const a = await device("a");
  const b = await device("b");
  await a.addBoard("b1", "Home");
  await a.addTask("t1", "Milk", "b1");
  await a.sync.push();
  await b.sync.pull();
  return [a, b];
}

async function expectConverged(a: Device, b: Device): Promise<void> {
  expect(sorted(await a.state())).toEqual(sorted(await b.state()));
}

beforeEach(() => {
  server = new InMemoryServer();
});
afterEach(async () => {
  for (const d of devices) await d.close();
  devices.length = 0;
});

test("a push publishes; another device sees it is behind and pulls", async () => {
  const a = await device("a");
  const b = await device("b");
  await a.addBoard("b1", "Home");
  await a.addTask("t1", "Milk", "b1");
  await a.sync.checkRemote();
  expect(a.sync.status.relation).toBe("remoteEmpty");

  await a.sync.push();
  expect(a.sync.status.relation).toBe("upToDate");
  expect(a.sync.status.baseRevision).toBe(1);

  await b.sync.checkRemote();
  expect(b.sync.status.relation).toBe("remoteAhead");
  expect(await b.task("t1")).toBeNull();

  await b.sync.pull();
  expect(b.sync.status.relation).toBe("upToDate");
  await expectConverged(a, b);
});

test("changes to different documents merge without asking", async () => {
  const [a, b] = await syncedPair();
  await a.db.write((tx) => tx.patch(tasks, "t1", { title: "Oat milk" }));
  await a.sync.push();
  await b.addTask("t2", "Bread", "b1");
  await b.sync.checkRemote();
  expect(b.sync.status.relation).toBe("diverged");
  await b.sync.push();
  await a.sync.pull();
  expect(b.sync.status.conflictCount).toBe(0);
  await expectConverged(a, b);
  expect((await b.task("t1"))!.title).toBe("Oat milk");
});

test("different fields of one document merge field-wise", async () => {
  const [a, b] = await syncedPair();
  await a.db.write((tx) => tx.patch(tasks, "t1", { title: "Oat milk" }));
  await a.sync.push();
  await b.db.write((tx) => tx.patch(tasks, "t1", { done: true }));
  await b.sync.push();
  await a.sync.pull();
  expect(await a.task("t1")).toEqual({ id: "t1", title: "Oat milk", boardId: "b1", done: true, order: 0 });
  await expectConverged(a, b);
});

describe("conflicts in VCS mode", () => {
  let a: Device;
  let b: Device;

  beforeEach(async () => {
    [a, b] = await syncedPair();
    await a.db.write((tx) => tx.patch(tasks, "t1", { title: "A says" }));
    await a.sync.push();
    await b.db.write((tx) => tx.patch(tasks, "t1", { title: "B says" }));
    await b.db.write((tx) => tx.put(notes, { id: "n1", text: "unrelated" }));
    await b.sync.push();
  });

  test("are held while everything else still publishes", async () => {
    expect(b.sync.status.relation).toBe("conflicted");
    expect(b.sync.status.heldCount).toBe(1);
    expect(b.sync.status.pendingCount).toBe(0);
    const [unit] = await b.sync.conflicts();
    const entry = unit!.entries[0]!;
    expect(entry.key).toEqual({ collection: "tasks", id: "t1" });
    expect(entry.ancestor!.title).toBe("Milk");
    expect(entry.local!.title).toBe("B says");
    expect(entry.remote!.title).toBe("A says");
    expect(conflictReasons(unit!)).toEqual(new Set(["fieldConflict"]));
    await a.sync.pull();
    expect(await a.db.get(notes, "n1")).not.toBeNull();
    expect((await a.task("t1"))!.title).toBe("A says");
  });

  test("keepRemote adopts theirs and logs mine", async () => {
    const [unit] = await b.sync.conflicts();
    await b.sync.resolve(unit!.id, Resolution.keepRemote);
    expect((await b.task("t1"))!.title).toBe("A says");
    const [entry] = await b.sync.log();
    expect(entry!.choice).toBe("keepRemote");
    expect(entry!.automatic).toBe(false);
    expect(entry!.discarded[0]!.value!.title).toBe("B says");
    await b.sync.push();
    await a.sync.pull();
    await expectConverged(a, b);
  });

  test("keepLocal publishes mine", async () => {
    const [unit] = await b.sync.conflicts();
    await b.sync.resolve(unit!.id, Resolution.keepLocal);
    await b.sync.push();
    await a.sync.pull();
    expect((await a.task("t1"))!.title).toBe("B says");
    await expectConverged(a, b);
  });

  test("a logged decision can be reinstated", async () => {
    const [unit] = await b.sync.conflicts();
    await b.sync.resolve(unit!.id, Resolution.keepRemote);
    await b.sync.reinstate((await b.sync.log())[0]!.id);
    expect((await b.task("t1"))!.title).toBe("B says");
    await b.sync.push();
    await a.sync.pull();
    expect((await a.task("t1"))!.title).toBe("B says");
  });
});

test("preferRemote resolves automatically, logs, and syncs the log", async () => {
  const [a, b] = await syncedPair();
  await b.sync.setConflictPolicy("preferRemote");
  await a.db.write((tx) => tx.patch(tasks, "t1", { title: "A says" }));
  await a.sync.push();
  await b.db.write((tx) => tx.patch(tasks, "t1", { title: "B says" }));
  await b.sync.push();
  expect(b.sync.status.conflictCount).toBe(0);
  expect((await b.task("t1"))!.title).toBe("A says");
  const [entry] = await b.sync.log();
  expect(entry!.automatic).toBe(true);
  expect(entry!.discarded[0]!.value!.title).toBe("B says");
  await a.sync.pull();
  expect((await a.sync.log())[0]!.id).toBe(entry!.id);
  await expectConverged(a, b);
});

test("the sync log keeps its retention, and the pruning syncs", async () => {
  const a = await device("a");
  const b = await device("b", {
    sync: { history: { dailyRestorePoints: false, syncLogRetention: 2, syncLogMaxAgeMs: 0 } },
  });
  await a.addBoard("b1", "Home");
  await a.addTask("t1", "Milk", "b1");
  await a.sync.push();
  await b.sync.pull();
  await b.sync.setConflictPolicy("preferRemote");

  const kept: string[] = [];
  for (let round = 0; round < 4; round++) {
    await a.db.write((tx) => tx.patch(tasks, "t1", { title: `A ${round}` }));
    await a.sync.push();
    await b.db.write((tx) => tx.patch(tasks, "t1", { title: `B ${round}` }));
    await b.sync.push();
    kept.unshift((await b.sync.log())[0]!.id);
    await a.sync.pull();
  }

  const log = await b.sync.log();
  expect(log.map((entry) => entry.id)).toEqual(kept.slice(0, 2));
  expect(log[0]!.discarded[0]!.value!.title).toBe("B 3");
  // Pruned entries are ordinary deletes: every device ends up with the same log.
  expect((await a.sync.log()).map((entry) => entry.id)).toEqual(kept.slice(0, 2));
  await expectConverged(a, b);
  expect(a.sync.status.pendingCount).toBe(0);
  expect(b.sync.status.pendingCount).toBe(0);
});

test("preferLocal keeps this device and publishes over the other", async () => {
  const [a, b] = await syncedPair();
  await b.sync.setConflictPolicy("preferLocal");
  await a.db.write((tx) => tx.patch(tasks, "t1", { title: "A says" }));
  await a.sync.push();
  await b.db.write((tx) => tx.patch(tasks, "t1", { title: "B says" }));
  await b.sync.push();
  await a.sync.pull();
  expect((await a.task("t1"))!.title).toBe("B says");
  expect((await a.sync.log())[0]!.discarded[0]!.value!.title).toBe("A says");
});

describe("integrity across a merge", () => {
  let a: Device;
  let b: Device;

  beforeEach(async () => {
    [a, b] = await syncedPair();
    await a.addBoard("b2", "Work");
    await a.sync.push();
    await b.sync.pull();
    await a.db.write((tx) => tx.delete(boards, "b2"));
    await a.sync.push();
    await b.db.write((tx) => tx.patch(tasks, "t1", { boardId: "b2" }));
    await b.sync.pull();
  });

  test("joins both changes into one conflict unit", async () => {
    const [unit] = await b.sync.conflicts();
    expect(new Set(unit!.entries.map((e) => `${e.key.collection}/${e.key.id}`))).toEqual(
      new Set(["tasks/t1", "boards/b2"]),
    );
    expect(conflictReasons(unit!).has("integrity")).toBe(true);
    expect(await b.board("b2")).not.toBeNull();
  });

  test("keepLocal restores the board everywhere", async () => {
    await b.sync.resolve((await b.sync.conflicts())[0]!.id, Resolution.keepLocal);
    await b.sync.push();
    await a.sync.pull();
    expect(await a.board("b2")).not.toBeNull();
    expect((await a.task("t1"))!.boardId).toBe("b2");
    await expectConverged(a, b);
  });

  test("keepRemote keeps the deletion and puts the task back", async () => {
    await b.sync.resolve((await b.sync.conflicts())[0]!.id, Resolution.keepRemote);
    expect(await b.board("b2")).toBeNull();
    expect((await b.task("t1"))!.boardId).toBe("b1");
    await b.sync.push();
    await a.sync.pull();
    await expectConverged(a, b);
  });
});

test("edits that depend on held data wait for the conflict", async () => {
  const [a, b] = await syncedPair();
  await a.addBoard("b2", "Work");
  await a.sync.push();
  await b.sync.pull();
  await a.db.write((tx) => tx.delete(boards, "b2"));
  await a.sync.push();
  await b.db.write((tx) => tx.patch(boards, "b2", { name: "Work!" }));
  await b.sync.pull();
  expect(conflictReasons((await b.sync.conflicts())[0]!)).toEqual(new Set(["deleteVsEdit"]));

  await b.addTask("t9", "on the held board", "b2");
  await b.sync.push();
  await a.sync.pull();
  expect(await a.task("t9")).toBeNull();

  await b.sync.resolve((await b.sync.conflicts())[0]!.id, Resolution.keepLocal);
  await b.sync.push();
  await a.sync.pull();
  expect(await a.board("b2")).not.toBeNull();
  expect(await a.task("t9")).not.toBeNull();
  await expectConverged(a, b);
});

test("realtime mode pushes after edits settle and pulls on hints", async () => {
  const sync: SyncOptions = {
    defaultMode: "realtime",
    realtime: { debounceMs: 20, maxDelayMs: 200, hintDelayMs: 10, pollMs: null },
    history: { dailyRestorePoints: false },
  };
  const a = await device("a", { sync });
  const b = await device("b", { sync });
  const eventually = async (condition: () => Promise<boolean>): Promise<void> => {
    const deadline = Date.now() + 3000;
    while (!(await condition())) {
      if (Date.now() > deadline) throw new Error("timed out");
      await tick(10);
    }
  };

  await a.addBoard("b1", "Home");
  await a.addTask("t1", "Milk", "b1");
  await eventually(async () => (await b.task("t1")) !== null);

  await b.db.write((tx) => tx.patch(tasks, "t1", { done: true }));
  await eventually(async () => (await a.task("t1"))!.done === true);
  expect(server.commitsOf("alice")).toHaveLength(2);

  await a.sync.setMode("vcs");
  await a.db.write((tx) => tx.patch(tasks, "t1", { title: "Oat milk" }));
  await tick(300);
  expect(server.commitsOf("alice")).toHaveLength(2);
  expect(a.sync.status.relation).toBe("localAhead");
});

describe("importing existing data", () => {
  const doc = (json: Record<string, unknown>): string => canonicalJson(json);
  const t = (id: string) => keyString("tasks", id);
  const board = doc({ id: "b1", name: "Home" });
  const task = (id: string, title: string) => ({ id, title, boardId: "b1", done: false, order: 0 });

  test("the first importer publishes and pins its data", async () => {
    const a = await device("a");
    await a.sync.importState({
      puts: new Map([[keyString("boards", "b1"), board], [t("t1"), doc(task("t1", "Milk"))]]),
      label: "legacy",
    });
    expect(a.sync.status.relation).toBe("upToDate");
    const pinned = (await a.sync.restorePoints()).filter((p) => p.pinned);
    expect(pinned.map((p) => p.label)).toEqual(["legacy"]);
  });

  test("an importer keeps fields it does not know from the first import", async () => {
    const a = await device("a");
    await a.sync.importState({
      puts: new Map([
        [keyString("boards", "b1"), board],
        [t("t1"), doc({ ...task("t1", "Milk"), reminderTime: "08:00" })],
      ]),
      label: "legacy",
    });
    const b = await device("b");
    await b.sync.importState({
      puts: new Map([[keyString("boards", "b1"), board], [t("t1"), doc(task("t1", "Oat milk"))]]),
      label: "legacy",
    });
    await a.sync.pull();
    expect(await a.task("t1")).toEqual({ ...task("t1", "Oat milk"), reminderTime: "08:00" });
  });

  test("later importers merge three-way against the first import", async () => {
    const a = await device("a");
    await a.sync.importState({
      puts: new Map([
        [keyString("boards", "b1"), board],
        [t("t1"), doc(task("t1", "Milk"))],
        [t("t2"), doc(task("t2", "Bread"))],
        [t("t4"), doc(task("t4", "Only on A"))],
      ]),
      label: "legacy",
    });
    await a.db.write((tx) => tx.patch(tasks, "t2", { done: true }));
    await a.sync.push();
    const b = await device("b");
    await b.sync.importState({
      puts: new Map([
        [keyString("boards", "b1"), board],
        [t("t1"), doc(task("t1", "Oat milk"))],
        [t("t2"), doc(task("t2", "Bread"))],
        [t("t3"), doc(task("t3", "New on B"))],
      ]),
      deletes: new Set([t("t5")]),
      label: "legacy",
    });
    expect(b.sync.status.conflictCount).toBe(0);
    await a.sync.pull();
    expect((await a.task("t1"))!.title).toBe("Oat milk");
    expect((await a.task("t2"))!.done).toBe(true);
    expect(await a.task("t3")).not.toBeNull();
    expect(await a.task("t4")).not.toBeNull();
    await expectConverged(a, b);
  });
});

describe("uploads interrupted by lost responses", () => {
  const loseNextSubmitResponse = (): void => {
    let fired = false;
    server.faults = (op, after) => {
      if (op === "submit" && after && !fired) {
        fired = true;
        return true;
      }
      return false;
    };
  };

  test("the retry is recognised and nothing is committed twice", async () => {
    const a = await device("a");
    await a.addBoard("b1", "Home");
    loseNextSubmitResponse();
    await expect(a.sync.push()).rejects.toBeInstanceOf(TransientBackendError);
    expect(a.sync.status.problem?.kind).toBe("offline");
    await a.db.write((tx) => tx.patch(boards, "b1", { name: "Home 2" }));
    await a.sync.push();
    expect(server.commitsOf("alice")).toHaveLength(2);
    expect(a.sync.status.relation).toBe("upToDate");
    const b = await device("b");
    await b.sync.pull();
    expect((await b.board("b1"))!.name).toBe("Home 2");
  });

  test("an undo made during the upload is not lost", async () => {
    const [a, b] = await syncedPair();
    await a.db.write((tx) => tx.patch(boards, "b1", { name: "Renamed" }));
    loseNextSubmitResponse();
    await expect(a.sync.push()).rejects.toBeInstanceOf(TransientBackendError);
    await a.db.write((tx) => tx.patch(boards, "b1", { name: "Home" }));
    await a.sync.push();
    await b.sync.pull();
    expect((await b.board("b1"))!.name).toBe("Home");
    await expectConverged(a, b);
  });
});

describe("history", () => {
  test("a new device bootstraps from a checkpoint after compaction", async () => {
    const sync: SyncOptions = {
      vcs: { remoteCheckEveryMs: null },
      history: { dailyRestorePoints: false, checkpointEvery: 2, keepRestorePoints: 1 },
    };
    const a = await device("a", { sync });
    await a.addBoard("b1", "one");
    await a.sync.push();
    await a.addTask("t1", "x", "b1");
    await a.sync.push();
    await a.db.write((tx) => tx.patch(boards, "b1", { name: "three" }));
    await a.sync.push();
    expect(server.commitsOf("alice")[0]!.revision).toBeGreaterThan(1);
    const c = await device("c");
    await c.sync.pull();
    expect(c.sync.status.relation).toBe("upToDate");
    await expectConverged(a, c);
  });

  test("a long-offline device merges exactly and resurrects nothing", async () => {
    const sync: SyncOptions = {
      vcs: { remoteCheckEveryMs: null },
      history: { dailyRestorePoints: false, checkpointEvery: 1, keepRestorePoints: 1 },
    };
    const a = await device("a", { sync });
    const b = await device("b");
    await a.addBoard("b1", "Home");
    await a.addTask("t1", "keep", "b1");
    await a.addTask("t2", "delete me", "b1");
    await a.sync.push();
    await b.sync.pull();
    await b.db.write((tx) => tx.patch(tasks, "t1", { title: "edited offline" }));
    await a.db.write((tx) => tx.delete(tasks, "t2"));
    await a.sync.push();
    await a.addTask("t3", "new", "b1");
    await a.sync.push();
    expect(server.commitsOf("alice").filter((c) => c.revision <= 2)).toEqual([]);
    await b.sync.sync();
    expect(await b.task("t2")).toBeNull();
    expect((await b.task("t1"))!.title).toBe("edited offline");
    await a.sync.pull();
    await expectConverged(a, b);
  });

  test("restore brings back an earlier state as a new commit", async () => {
    const a = await device("a");
    const b = await device("b");
    await a.addBoard("b1", "first");
    await a.sync.push({ message: "first version" });
    await a.db.write((tx) => tx.patch(boards, "b1", { name: "second" }));
    await a.addBoard("b2", "extra");
    await a.sync.push();
    const first = (await a.sync.restorePoints()).find((point) => point.label === "first version")!;
    await a.sync.restore(first);
    expect((await a.board("b1"))!.name).toBe("first");
    expect(await a.board("b2")).toBeNull();
    expect(a.sync.status.baseRevision).toBe(3);
    expect((await a.sync.restorePoints()).map((p) => p.kind)).toContain("beforeRestore");
    await b.sync.pull();
    await expectConverged(a, b);
  });

  test("overwriteRemoteWithLocal makes the cloud exactly this device", async () => {
    const [a, b] = await syncedPair();
    await a.addTask("t2", "from a", "b1");
    await a.sync.push();
    await b.db.write((tx) => tx.patch(tasks, "t1", { title: "b wins" }));
    await b.sync.overwriteRemoteWithLocal();
    await a.sync.pull();
    expect(await a.task("t2")).toBeNull();
    expect((await a.task("t1"))!.title).toBe("b wins");
    await expectConverged(a, b);
  });

  test("discardLocalAndPull backs up and takes the cloud", async () => {
    const [a, b] = await syncedPair();
    await a.db.write((tx) => tx.patch(tasks, "t1", { title: "cloud" }));
    await a.sync.push();
    await b.db.write((tx) => tx.patch(tasks, "t1", { title: "local" }));
    await b.sync.discardLocalAndPull();
    expect((await b.task("t1"))!.title).toBe("cloud");
    expect(await b.sync.localBackups()).toHaveLength(1);
    expect(hasLocalChanges(b.sync.status)).toBe(false);
  });
});

describe("accounts", () => {
  test("data created signed out is published on first sign-in", async () => {
    const a = await device("a", { account: null });
    await a.addBoard("b1", "before signing up");
    expect(a.sync.status.relation).toBe("signedOut");
    a.accounts.signIn("alice");
    await tick(10);
    await a.sync.push();
    const b = await device("b");
    await b.sync.pull();
    expect(await b.board("b1")).not.toBeNull();
  });

  test("a different account requires an explicit switch", async () => {
    const a = await device("a");
    await a.addBoard("b1", "alice data");
    await a.sync.push();
    a.accounts.signIn("bob");
    await tick(10);
    expect(a.sync.status.relation).toBe("accountMismatch");
    await expect(a.sync.push()).rejects.toBeInstanceOf(SyncUnavailableError);
    await a.sync.switchAccount();
    expect(await a.board("b1")).toBeNull();
    expect(await a.sync.localBackups()).toHaveLength(1);
    await a.sync.checkRemote();
    expect(a.sync.status.relation).toBe("remoteEmpty");
  });
});

describe("schema evolution", () => {
  test("a breaking change fences off older builds", async () => {
    const newer = await device("newer", { schema: testSchema({ version: 2, compatibleSince: 2 }) });
    await newer.addBoard("b1", "Home");
    await newer.sync.push();
    const older = await device("older");
    await older.sync.checkRemote();
    expect(older.sync.status.relation).toBe("remoteSchemaTooNew");
    await older.sync.pull();
    expect(await older.board("b1")).toBeNull();
  });

  test("an additive change does not, and older builds keep new data", async () => {
    const tags = Collection.json("tags");
    const newerSchema = new Schema({ version: 2, compatibleSince: 1, collections: [boards, tasks, notes, prefs, tags] });
    const newer = await device("newer", { schema: newerSchema });
    await newer.addBoard("b1", "Home");
    await newer.db.write(async (tx) => {
      await tx.put(tags, { id: "g1", label: "urgent" });
      await tx.put(boards, { id: "b1", name: "Home", emoji: "🏠" });
    });
    await newer.sync.push();
    const older = await device("older");
    await older.sync.pull();
    expect(older.sync.status.relation).toBe("upToDate");
    await older.db.write((tx) => tx.put(boards, { id: "b1", name: "Renamed by old" }));
    await older.sync.push();
    await newer.sync.pull();
    expect(await newer.db.get(tags, "g1")).not.toBeNull();
    expect(await newer.board("b1")).toEqual({ id: "b1", name: "Renamed by old", emoji: "🏠" });
    await expectConverged(newer, older);
  });
});
