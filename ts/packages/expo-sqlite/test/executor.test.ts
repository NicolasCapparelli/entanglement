import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Collection, EntanglementDb, MergePolicy, Schema, type SqlExecutor } from "@entanglement/core";
import { afterEach, describe, expect, test } from "vitest";

import { ExpoSqliteExecutor } from "../src/index.js";
import { NodeExpoShim } from "./expoShim.js";

const open: SqlExecutor[] = [];
let dir: string | null = null;

async function executor(path?: string): Promise<ExpoSqliteExecutor> {
  const created = await ExpoSqliteExecutor.create(new NodeExpoShim(path));
  open.push(created);
  return created;
}

afterEach(async () => {
  for (const e of open.splice(0)) await e.close().catch(() => undefined);
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe("SqlExecutor contract", () => {
  test("select and execute round-trip every value type", async () => {
    const sql = await executor();
    await sql.execute("CREATE TABLE t (a INTEGER, b REAL, c TEXT, d BLOB, e TEXT)");
    await sql.execute("INSERT INTO t VALUES (?, ?, ?, ?, ?)", [42, 1.5, "ü", new Uint8Array([1, 2, 3]), null]);
    const [row] = await sql.select("SELECT * FROM t");
    expect(row).toMatchObject({ a: 42, b: 1.5, c: "ü", e: null });
    expect(Array.from(row!.d as Uint8Array)).toEqual([1, 2, 3]);
  });

  test("bigint arguments are bound as numbers", async () => {
    const sql = await executor();
    await sql.execute("CREATE TABLE t (a INTEGER)");
    await sql.execute("INSERT INTO t VALUES (?)", [123n]);
    expect(await sql.select("SELECT a FROM t")).toEqual([{ a: 123 }]);
  });

  test("a transaction commits and returns the body's result", async () => {
    const sql = await executor();
    await sql.execute("CREATE TABLE t (a INTEGER)");
    const result = await sql.transaction(async () => {
      await sql.execute("INSERT INTO t VALUES (1)");
      expect(await sql.select("SELECT a FROM t")).toHaveLength(1);
      return "done";
    });
    expect(result).toBe("done");
    expect(await sql.select("SELECT a FROM t")).toHaveLength(1);
  });

  test("a throwing transaction rolls back and rethrows", async () => {
    const sql = await executor();
    await sql.execute("CREATE TABLE t (a INTEGER)");
    await expect(
      sql.transaction(async () => {
        await sql.execute("INSERT INTO t VALUES (1)");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await sql.select("SELECT a FROM t")).toEqual([]);
    // The connection is usable afterwards.
    await sql.transaction(() => sql.execute("INSERT INTO t VALUES (2)"));
    expect(await sql.select("SELECT a FROM t")).toEqual([{ a: 2 }]);
  });

  test("a failing statement inside a transaction rolls back", async () => {
    const sql = await executor();
    await sql.execute("CREATE TABLE t (a INTEGER PRIMARY KEY)");
    await expect(
      sql.transaction(async () => {
        await sql.execute("INSERT INTO t VALUES (1)");
        await sql.execute("INSERT INTO t VALUES (1)");
      }),
    ).rejects.toThrow();
    expect(await sql.select("SELECT a FROM t")).toEqual([]);
  });

  test("BEGIN IMMEDIATE takes the write lock up front", async () => {
    dir = mkdtempSync(join(tmpdir(), "ent-expo-"));
    const path = join(dir, "db.sqlite");
    const first = await ExpoSqliteExecutor.create(new NodeExpoShim(path));
    open.push(first);
    await first.execute("CREATE TABLE t (a INTEGER)");
    // A second connection with no busy timeout, like another process.
    const second = await ExpoSqliteExecutor.create(new NodeExpoShim(path), { skipPragmas: true });
    open.push(second);
    await first.transaction(async () => {
      await expect(second.transaction(async () => undefined)).rejects.toThrow(/locked|busy/i);
    });
  });

  test("data_version changes when another connection commits", async () => {
    dir = mkdtempSync(join(tmpdir(), "ent-expo-"));
    const path = join(dir, "db.sqlite");
    const mine = await ExpoSqliteExecutor.create(new NodeExpoShim(path));
    const other = await ExpoSqliteExecutor.create(new NodeExpoShim(path));
    open.push(mine, other);
    await mine.execute("CREATE TABLE t (a INTEGER)");
    const before = await mine.dataVersion();
    expect(await mine.dataVersion()).toBe(before);
    await other.execute("INSERT INTO t VALUES (1)");
    expect(await mine.dataVersion()).toBeGreaterThan(before);
  });
});

describe("under EntanglementDb", () => {
  const notes = Collection.json("notes", { fields: ["id", "text"], merge: MergePolicy.fieldwise() });
  const schema = () => new Schema({ version: 1, collections: [notes] });

  test("writes, queries and persists across reopen", async () => {
    dir = mkdtempSync(join(tmpdir(), "ent-expo-"));
    const path = join(dir, "db.sqlite");
    let db = await EntanglementDb.open({ executor: await executor(path), schema: schema() });
    await db.write((tx) => tx.put(notes, { id: "n1", text: "hello" }));
    await db.write((tx) => tx.put(notes, { id: "n2", text: "world" }));
    expect((await db.getAll(notes)).map((n) => n.text).sort()).toEqual(["hello", "world"]);
    await db.close();

    db = await EntanglementDb.open({ executor: await executor(path), schema: schema() });
    expect(await db.get(notes, "n1")).toMatchObject({ text: "hello" });
    await db.close();
  });

  test("a failed write leaves nothing behind", async () => {
    const db = await EntanglementDb.open({ executor: await executor(), schema: schema() });
    await expect(
      db.write(async (tx) => {
        await tx.put(notes, { id: "n1", text: "x" });
        throw new Error("nope");
      }),
    ).rejects.toThrow("nope");
    expect(await db.getAll(notes)).toEqual([]);
    await db.close();
  });
});
