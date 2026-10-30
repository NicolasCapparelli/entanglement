// The example Worker and the real Durable Object class running in workerd
// (via Miniflare) on a local port, driven by the real client adapter over real
// fetch and WebSockets.
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  AuthRequiredError,
  EncryptedBackend,
  KeyCipher,
  newId,
  StateDigest,
  TransientBackendError,
  type CommitRequest,
} from "@entanglement/core";
import { runBackendContract } from "../../core/test/backendContract.js";
import { simulate } from "../../core/test/simulation.js";
import { Device } from "../../core/test/support.js";
import { directoryContains, MiniflareHost } from "./hosts.js";
import { remoteTarget } from "./targets.js";

let host: MiniflareHost;
beforeAll(async () => {
  host = await MiniflareHost.start();
}, 60_000);
afterAll(async () => {
  await host.stop();
});

let counter = 0;
const freshAccount = async (): Promise<{ token: string; account: string }> => {
  const n = counter++;
  const token = `token-${n}-${newId()}`;
  const account = `account-${n}`;
  await host.grant(token, account);
  return { token, account };
};

describe("Durable Object in workerd", () => {
  runBackendContract(async () => {
    const alice = await freshAccount();
    const bob = await freshAccount();
    return { backend: host.backend(alice.token), otherAccount: host.backend(bob.token) };
  });

  test("submit, pull and a WebSocket hint, with auth enforced", async () => {
    const { token } = await freshAccount();
    const backend = host.backend(token);
    const hints: number[] = [];
    let opened!: () => void;
    const open = new Promise<void>((resolve) => (opened = resolve));
    const stop = backend.onHint(() => {
      hints.push(Date.now());
      opened();
    })!;
    await open; // the initial catch-up hint on connect
    const before = hints.length;

    const request: CommitRequest = {
      commitId: newId(), parent: 0, schemaVersion: 1, compatibleSince: 1, deviceId: "d", deviceLabel: "Phone",
      clientTime: 1, message: "hello", stateDigest: StateDigest.of([["notes", "n", '{"a":1}']]),
      changes: [{ collection: "notes", id: "n", value: '{"a":1}', group: 0 }],
    };
    expect(await backend.submit(request)).toEqual({ kind: "accepted", revision: 1 });
    await expect.poll(() => hints.length, { timeout: 5_000 }).toBeGreaterThan(before);
    const [commit] = await backend.commits({ after: 0, upTo: 1 });
    expect(commit!.request.changes).toEqual(request.changes);
    stop();

    // The hint payload is a revision and nothing else.
    const raw = new WebSocket(`${host.baseUrl.replace("http", "ws")}/subscribe`, [
      "entanglement.v1",
      `bearer.${Buffer.from(token).toString("base64url")}`,
    ]);
    const message = new Promise<string>((resolve) => (raw.onmessage = (event) => resolve(String(event.data))));
    await new Promise((resolve) => (raw.onopen = resolve));
    await backend.submit({ ...request, commitId: newId(), parent: 1, message: null });
    expect(JSON.parse(await message)).toEqual({ type: "hint", revision: 2 });
    raw.close();

    await expect(host.backend("not-a-token").head()).rejects.toBeInstanceOf(AuthRequiredError);
    await expect(host.backend(null).head()).rejects.toBeInstanceOf(AuthRequiredError);
    const unauthenticatedSocket = new WebSocket(`${host.baseUrl.replace("http", "ws")}/subscribe`);
    await new Promise((resolve) => (unauthenticatedSocket.onerror = unauthenticatedSocket.onclose = resolve));
  });

  test("an unreachable server is a transient error", async () => {
    const offline = host.backend("x", { baseUrl: "http://127.0.0.1:1/v1" });
    await expect(offline.head()).rejects.toBeInstanceOf(TransientBackendError);
  });

  describe("simulation", () => {
    const run = (seed: number, interactive: boolean) => async () => {
      const { token } = await freshAccount();
      await simulate(seed, interactive, remoteTarget((t) => host.backend(t), token));
    };
    for (let seed = 1; seed <= 150; seed++) test(`seed ${seed} converges`, run(seed, false), 120_000);
    for (let seed = 1001; seed <= 1150; seed++) test(`seed ${seed} converges`, run(seed, true), 120_000);
  });
});

describe("encryption at rest", () => {
  const SENTINEL = "SENTINEL-plaintext-4f8a1c";
  const key = (byte: number): Uint8Array => new Uint8Array(32).fill(byte);

  const writeAndSync = async (encrypted: boolean) => {
    const own = await MiniflareHost.start();
    try {
      await own.grant("t", "alice");
      const accounts = new Set<Device>();
      const make = async (name: string) => {
        const raw = own.backend("t");
        const device = await Device.create(null, {
          name,
          backend: () => (encrypted ? new EncryptedBackend(raw, new KeyCipher({ keys: { a: key(7) }, activeKeyId: "a" })) : raw),
          sync: { history: { dailyRestorePoints: false, checkpointEvery: 2 } },
        });
        accounts.add(device);
        return device;
      };
      const one = await make("one");
      const two = await make("two");
      for (let index = 0; index < 5; index++) {
        await one.addBoard(`b${index}`, `${SENTINEL}-board-${index}`);
        await one.addTask(`t${index}`, `${SENTINEL}-task-${index}`, `b${index}`);
        await one.sync.sync();
      }
      await two.sync.sync();
      const synced = (await two.board("b4")) as { name: string } | null;
      expect(synced?.name).toBe(`${SENTINEL}-board-4`); // readable to a device holding the key
      for (const device of accounts) await device.close();
    } catch (error) {
      await own.stop();
      throw error;
    }
    await own.stop({ keepFiles: true });
    return own.persistDir;
  };

  test("with a KeyCipher the Durable Object's storage holds no plaintext values", async () => {
    const dir = await writeAndSync(true);
    expect(directoryContains(dir, SENTINEL)).toBe(false);
    expect(directoryContains(dir, "board-")).toBe(false);
    expect(directoryContains(dir, "commits")).toBe(true); // we really did read the database
  }, 60_000);

  test("control: without a cipher the same scan finds the values", async () => {
    const dir = await writeAndSync(false);
    expect(directoryContains(dir, SENTINEL)).toBe(true);
  }, 60_000);
});
