import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { InMemoryServer, SyncRemoteHasHistoryError } from "../src/index.js";
import { Device, sorted, tick } from "./support.js";

let server: InMemoryServer;
const devices: Device[] = [];

async function local(name: string, sync = {}): Promise<Device> {
  const d = await Device.create(null, { name, localOnly: true, sync });
  devices.push(d);
  return d;
}
async function synced(name: string): Promise<Device> {
  const d = await Device.create(server, { name });
  devices.push(d);
  return d;
}

beforeEach(() => {
  server = new InMemoryServer();
});
afterEach(async () => {
  for (const d of devices.splice(0)) await d.close();
});

describe("attachSync", () => {
  test("a local-only db has no engine and keeps its history until attached", async () => {
    const a = await local("a");
    expect(a.db.sync).toBeNull();
    await a.addBoard("b1", "Home");
    await a.addTask("t1", "Milk", "b1");
    const engine = await a.attach(server);
    expect(a.db.sync).toBe(engine);
    await engine.push();
    expect((await server.headOf("alice"))?.revision).toBe(1);
    const b = await synced("b");
    await b.sync.pull();
    expect(await b.task("t1")).toMatchObject({ title: "Milk" });
    expect(sorted(await b.state())).toEqual(sorted(await a.state()));
  });

  test("realtime mode publishes local history on its own after attaching", async () => {
    const a = await local("a", { defaultMode: "realtime", realtime: { debounceMs: 5, pollMs: null } });
    await a.addBoard("b1", "Home");
    await a.attach(server, { sync: { defaultMode: "realtime", realtime: { debounceMs: 5, pollMs: null } } });
    for (let i = 0; i < 50 && (await server.headOf("alice")) === null; i++) await tick(10);
    expect((await server.headOf("alice"))?.revision).toBe(1);
  });

  test("a second device converges after the first enables sync live", async () => {
    const a = await local("a");
    for (let i = 0; i < 20; i++) await a.addBoard(`b${i}`, `Board ${i}`);
    await a.attach(server);
    await a.sync.sync();
    const b = await synced("b");
    await b.sync.sync();
    expect(sorted(await b.state())).toEqual(sorted(await a.state()));
    await b.addBoard("extra", "Extra");
    await b.sync.sync();
    await a.sync.sync();
    expect(await a.board("extra")).not.toBeNull();
  });

  test("refuses by default when the remote has other history; nothing changes", async () => {
    const other = await synced("other");
    await other.addBoard("r1", "Remote");
    await other.sync.push();
    const a = await local("a");
    await a.addBoard("l1", "Local");
    await expect(a.attach(server)).rejects.toBeInstanceOf(SyncRemoteHasHistoryError);
    expect(a.db.sync).toBeNull();
    expect(await a.board("l1")).not.toBeNull();
    expect(await a.board("r1")).toBeNull();
  });

  test("a device with nothing unsynced just pulls, without a choice", async () => {
    const other = await synced("other");
    await other.addBoard("r1", "Remote");
    await other.sync.push();
    const a = await local("a");
    await a.attach(server);
    await a.sync.sync();
    expect(await a.board("r1")).not.toBeNull();
  });

  test("merge combines both sides", async () => {
    const other = await synced("other");
    await other.addBoard("r1", "Remote");
    await other.sync.push();
    const a = await local("a");
    await a.addBoard("l1", "Local");
    await a.attach(server, { ifRemoteHasHistory: "merge" });
    await a.sync.sync();
    expect(await a.board("r1")).not.toBeNull();
    expect(await a.board("l1")).not.toBeNull();
    await other.sync.pull();
    expect(await other.board("l1")).not.toBeNull();
  });

  test("useRemote discards local data (backed up) and takes the remote", async () => {
    const other = await synced("other");
    await other.addBoard("r1", "Remote");
    await other.sync.push();
    const a = await local("a");
    await a.addBoard("l1", "Local");
    await a.attach(server, { ifRemoteHasHistory: "useRemote" });
    expect(await a.board("l1")).toBeNull();
    expect(await a.board("r1")).not.toBeNull();
    expect((await a.sync.localBackups()).length).toBe(1);
    expect(a.sync.status.pendingCount).toBe(0);
  });

  test("useLocal overwrites the remote with this device", async () => {
    const other = await synced("other");
    await other.addBoard("r1", "Remote");
    await other.sync.push();
    const a = await local("a");
    await a.addBoard("l1", "Local");
    await a.attach(server, { ifRemoteHasHistory: "useLocal" });
    await other.sync.pull();
    expect(await other.board("l1")).not.toBeNull();
    expect(await other.board("r1")).toBeNull();
    expect((await other.sync.restorePoints()).some((p) => p.kind === "beforeOverwrite")).toBe(true);
  });

  test("detach stops syncing but keeps local data; reattach continues", async () => {
    const a = await local("a");
    await a.addBoard("b1", "One");
    await a.attach(server);
    await a.sync.push();
    await a.db.detachSync();
    expect(a.db.sync).toBeNull();
    await a.addBoard("b2", "Two");
    await a.attach(server); // base revision > 0, so no choice is needed
    await a.sync.push();
    expect((await server.headOf("alice"))?.revision).toBe(2);
    await expect(a.attach(server)).rejects.toThrow(/already attached/);
  });
});
