import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  canonicalJson,
  EntanglementDb,
  IntegrityViolation,
  keyString,
  LocalSchemaTooNew,
  type ChangeEvent,
  type SqlExecutor,
} from "../src/index.js";
import { SqlJsExecutor } from "../src/sqljs.js";
import { boards, memoryExecutor, prefs, tasks, testSchema, tick } from "./support.js";

async function openLocal(executor?: SqlExecutor, schema = testSchema()): Promise<EntanglementDb> {
  return EntanglementDb.open({ executor: executor ?? (await memoryExecutor()), schema });
}

async function pendingRows(db: EntanglementDb) {
  return db.store.read(async (reader) => (await reader.allPending()).map(({ key, before, grp }) => ({ key, before, grp })));
}

let db: EntanglementDb;
beforeEach(async () => {
  db = await openLocal();
});
afterEach(() => db.close());

test("writes, reads and deletes documents", async () => {
  await db.write((tx) => tx.put(boards, { id: "b1", name: "Home" }));
  expect(await db.get(boards, "b1")).toEqual({ id: "b1", name: "Home" });
  await db.write((tx) => tx.delete(boards, "b1"));
  expect(await db.get(boards, "b1")).toBeNull();
});

describe("pending overlay", () => {
  test("repeated edits coalesce, keeping the original before", async () => {
    for (const name of ["A", "B", "C"]) await db.write((tx) => tx.put(boards, { id: "b1", name }));
    const rows = await pendingRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.before).toBeNull();
  });

  test("an exact undo leaves nothing pending", async () => {
    await db.write((tx) => tx.put(boards, { id: "b1", name: "A" }));
    await db.write((tx) => tx.delete(boards, "b1"));
    expect(await pendingRows(db)).toEqual([]);
  });

  test("documents written together share a group, transitively", async () => {
    await db.write(async (tx) => {
      await tx.put(boards, { id: "b1", name: "A" });
      await tx.put(boards, { id: "b2", name: "B" });
    });
    await db.write((tx) => tx.put(boards, { id: "b3", name: "C" }));
    let groups = new Map((await pendingRows(db)).map((row) => [row.key, row.grp]));
    expect(groups.get(keyString("boards", "b1"))).toBe(groups.get(keyString("boards", "b2")));
    expect(groups.get(keyString("boards", "b3"))).not.toBe(groups.get(keyString("boards", "b1")));

    await db.write(async (tx) => {
      await tx.put(boards, { id: "b2", name: "B2" });
      await tx.put(boards, { id: "b3", name: "C2" });
    });
    groups = new Map((await pendingRows(db)).map((row) => [row.key, row.grp]));
    expect(new Set(groups.values()).size).toBe(1);
  });

  test("local-only collections are never journaled", async () => {
    await db.write((tx) => tx.put(prefs, { id: "layout", gap: 8 }));
    expect(await pendingRows(db)).toEqual([]);
    expect(await db.get(prefs, "layout")).toEqual({ id: "layout", gap: 8 });
  });
});

test("unknown top-level fields survive a write by this build", async () => {
  await db.store.transact((txn) =>
    txn.put(keyString("boards", "b1"), canonicalJson({ id: "b1", name: "A", icon: "star" })),
  );
  await db.write((tx) => tx.put(boards, { id: "b1", name: "Renamed" }));
  expect(await db.get(boards, "b1")).toEqual({ id: "b1", name: "Renamed", icon: "star" });
});

describe("integrity", () => {
  test("a dangling reference rolls the transaction back", async () => {
    await expect(
      db.write((tx) => tx.put(tasks, { id: "t1", title: "x", boardId: "missing", done: false, order: 0 })),
    ).rejects.toBeInstanceOf(IntegrityViolation);
    expect(await db.get(tasks, "t1")).toBeNull();
    expect(await pendingRows(db)).toEqual([]);
  });

  test("deleting a referenced document needs the cascade in the same transaction", async () => {
    await db.write(async (tx) => {
      await tx.put(boards, { id: "b1", name: "A" });
      await tx.put(tasks, { id: "t1", title: "x", boardId: "b1", done: false, order: 0 });
    });
    await expect(db.write((tx) => tx.delete(boards, "b1"))).rejects.toBeInstanceOf(IntegrityViolation);
    await db.write(async (tx) => {
      await tx.delete(tasks, "t1");
      await tx.delete(boards, "b1");
    });
    expect(await db.get(boards, "b1")).toBeNull();
  });

  test("references are checked at the end of the transaction", async () => {
    await db.write(async (tx) => {
      await tx.put(tasks, { id: "t1", title: "x", boardId: "b1", done: false, order: 0 });
      await tx.put(boards, { id: "b1", name: "created second" });
    });
    expect(await db.get(tasks, "t1")).not.toBeNull();
  });
});

describe("queries", () => {
  beforeEach(async () => {
    await db.write(async (tx) => {
      await tx.put(boards, { id: "b1", name: "A" });
      await tx.put(boards, { id: "b2", name: "B" });
      await tx.put(tasks, { id: "t1", title: "one", boardId: "b1", done: false, order: 2 });
      await tx.put(tasks, { id: "t2", title: "two", boardId: "b1", done: true, order: 1 });
      await tx.put(tasks, { id: "t3", title: "three", boardId: "b2", done: false, order: 0 });
    });
  });

  test("filter and sort on indexed and unindexed fields", async () => {
    const inB1 = await db.query(tasks).where("boardId", { isEqualTo: "b1" }).orderBy("order").get();
    expect(inB1.map((t) => t.id)).toEqual(["t2", "t1"]);
    const open = await db.query(tasks).where("done", { isEqualTo: false }).orderBy("order", { descending: true }).get();
    expect(open.map((t) => t.id)).toEqual(["t1", "t3"]);
    expect(await db.query(tasks).where("id", { whereIn: ["t1", "t3"] }).limit(1).get()).toHaveLength(1);
  });

  test("watch delivers the current result and every change, with origin", async () => {
    const seen: string[][] = [];
    const origins: string[] = [];
    const stop = db.query(tasks).where("boardId", { isEqualTo: "b2" }).watch((result) => {
      seen.push(result.map((t) => t.id as string));
    });
    const stopChanges = db.onChange((event: ChangeEvent) => origins.push(event.origin));
    await tick(20);
    await db.write((tx) => tx.put(tasks, { id: "t4", title: "four", boardId: "b2", done: false, order: 5 }));
    await tick(20);
    stop();
    stopChanges();
    expect(seen[0]).toEqual(["t3"]);
    expect(seen.at(-1)).toEqual(["t3", "t4"]);
    expect(origins).toEqual(["local"]);
  });

  test("tx.query sees the transaction's own writes", async () => {
    const inside = await db.write(async (tx) => {
      await tx.put(boards, { id: "b3", name: "C" });
      return tx.query(boards).get();
    });
    expect(inside).toHaveLength(3);
  });
});

test("persistence exports the database and reopening restores it", async () => {
  let saved: Uint8Array | null = null;
  const initSqlJs = (await import("sql.js")).default;
  const SQL = await initSqlJs();
  const first = await openLocal(
    new SqlJsExecutor(new SQL.Database(), { persist: (bytes) => void (saved = bytes), persistDelayMs: 1 }),
  );
  await first.write((tx) => tx.put(boards, { id: "b1", name: "kept" }));
  await first.close();
  expect(saved).not.toBeNull();

  const second = await openLocal(new SqlJsExecutor(new SQL.Database(saved!)));
  expect(await second.get(boards, "b1")).toEqual({ id: "b1", name: "kept" });
  const rows = await pendingRows(second);
  expect(rows).toHaveLength(1);
  await second.close();
});

test("local migrations transform documents; newer databases refuse to open", async () => {
  let saved: Uint8Array | null = null;
  const SQL = await (await import("sql.js")).default();
  const persist = { persist: (bytes: Uint8Array) => void (saved = bytes), persistDelayMs: 1 };

  const v1 = await openLocal(new SqlJsExecutor(new SQL.Database(), persist));
  await v1.write((tx) => tx.put(boards, { id: "b1", name: "old" }));
  await v1.close();

  const v2 = await openLocal(
    new SqlJsExecutor(new SQL.Database(saved!), persist),
    testSchema({
      version: 2,
      migrations: { 2: (collection, doc) => (collection === "boards" ? { ...doc, name: String(doc.name).toUpperCase() } : doc) },
    }),
  );
  expect(await v2.get(boards, "b1")).toEqual({ id: "b1", name: "OLD" });
  await v2.write((tx) => tx.put(boards, { id: "b2", name: "x" }));
  await v2.close();

  await expect(openLocal(new SqlJsExecutor(new SQL.Database(saved!)))).rejects.toBeInstanceOf(LocalSchemaTooNew);
});

describe("reference checks", () => {
  /** Counts statements while `body` runs. */
  async function countingDb(): Promise<{ db: EntanglementDb; during: (body: () => Promise<unknown>) => Promise<number> }> {
    const executor = await memoryExecutor();
    let calls = 0;
    const select = executor.select.bind(executor);
    executor.select = (sql, args) => {
      calls++;
      return select(sql, args);
    };
    const counted = await openLocal(executor);
    return {
      db: counted,
      during: async (body) => {
        calls = 0;
        await body();
        return calls;
      },
    };
  }

  test("editing a target does not read its referrers one at a time", async () => {
    const { db: local, during } = await countingDb();
    await local.write((tx) => tx.put(boards, { id: "b1", name: "Home" }));
    const seed = async (n: number, from: number): Promise<void> => {
      await local.write(async (tx) => {
        for (let i = from; i < from + n; i++) await tx.put(tasks, { id: `t${i}`, boardId: "b1", title: "x", done: false, position: i, notes: "" });
      });
    };
    await seed(20, 0);
    const few = await during(() => local.write((tx) => tx.put(boards, { id: "b1", name: "Few" })));
    await seed(980, 20);
    const many = await during(() => local.write((tx) => tx.put(boards, { id: "b1", name: "Many" })));
    expect(many - few).toBeLessThan(5);
    await local.close();
  });

  test("still refuses deleting a target with many referrers", async () => {
    await db.write((tx) => tx.put(boards, { id: "b1", name: "Home" }));
    await db.write(async (tx) => {
      for (let i = 0; i < 450; i++) await tx.put(tasks, { id: `t${i}`, boardId: "b1", title: "x", done: false, position: i, notes: "" });
    });
    await expect(db.write((tx) => tx.delete(boards, "b1"))).rejects.toBeInstanceOf(IntegrityViolation);
  });
});
