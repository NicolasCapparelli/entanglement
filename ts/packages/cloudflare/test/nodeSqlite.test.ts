// The server logic and the client adapter, end to end through the Worker
// helper and the Durable Object class, over node:sqlite. Fast; the Miniflare
// suite runs the same checks on the real runtime.
import { describe, expect, test } from "vitest";

import { runBackendContract } from "../../core/test/backendContract.js";
import { simulate, type SimTarget } from "../../core/test/simulation.js";
import { AuthRequiredError, FatalBackendError, TransientBackendError } from "@entanglement/core";
import { NodeHost } from "./hosts.js";
import { remoteTarget } from "./targets.js";

let accountCounter = 0;

describe("Durable Object over node:sqlite", () => {
  runBackendContract(async () => {
    const host = new NodeHost();
    const n = accountCounter++;
    host.grant(`a${n}`, `alice-${n}`);
    host.grant(`b${n}`, `bob-${n}`);
    return { backend: host.backend(`a${n}`, { reconnectMinMs: 5 }), otherAccount: host.backend(`b${n}`) };
  });

  test("errors map like the Supabase adapter's", async () => {
    const host = new NodeHost();
    host.grant("good", "alice");
    await expect(host.backend(null).head()).rejects.toBeInstanceOf(AuthRequiredError);
    await expect(host.backend("revoked").head()).rejects.toBeInstanceOf(AuthRequiredError);
    const offline = host.backend("good", {
      fetch: (async () => {
        throw new TypeError("Network request failed");
      }) as typeof fetch,
    });
    await expect(offline.head()).rejects.toBeInstanceOf(TransientBackendError);
    const flaky = host.backend("good", { fetch: (async () => new Response("<html>bad gateway</html>", { status: 502 })) as typeof fetch });
    await expect(flaky.head()).rejects.toBeInstanceOf(TransientBackendError);
    const forbidden = host.backend("good", { fetch: (async () => new Response("{}", { status: 403 })) as typeof fetch });
    await expect(forbidden.head()).rejects.toBeInstanceOf(FatalBackendError);
  });

  test("a store refuses to serve a second account", async () => {
    const host = new NodeHost();
    const first = new Request("https://x/v1/head", { headers: { "x-entanglement-account": "alice" } });
    const object = host.env.ENTANGLEMENT_ACCOUNT.get("shared");
    expect((await object.fetch(first)).status).toBe(200);
    const intruder = new Request("https://x/v1/head", { headers: { "x-entanglement-account": "mallory" } });
    expect((await object.fetch(intruder)).status).toBe(403);
    expect((await object.fetch(new Request("https://x/v1/head"))).status).toBe(401);
  });

  test("a client-supplied account header cannot redirect a request", async () => {
    const host = new NodeHost();
    host.grant("alice-token", "alice");
    host.grant("bob-token", "bob");
    const bob = host.backend("bob-token");
    const sneaky = host.backend("alice-token", {
      fetch: ((input: string, init: RequestInit) =>
        host.fetch(input, { ...init, headers: { ...(init.headers as object), "x-entanglement-account": "bob" } })) as typeof fetch,
    });
    await sneaky.putRestorePoint({ revision: 0, kind: "manual", label: "alice's", pinned: false, deviceLabel: null, createdAt: new Date() });
    expect(await bob.restorePoints()).toEqual([]);
  });

  test("large commits and checkpoints are chunked and read back whole", async () => {
    const host = new NodeHost();
    host.grant("t", "alice");
    const backend = host.backend("t");
    const { StateDigest, newId } = await import("@entanglement/core");
    const big = JSON.stringify({ text: "é".repeat(1_500_000) });
    const digest = StateDigest.of([["notes", "n", big]]);
    const changes = [{ collection: "notes", id: "n", value: big, group: 0 }];
    const result = await backend.submit({
      commitId: newId(), parent: 0, schemaVersion: 1, compatibleSince: 1, deviceId: "d", deviceLabel: null,
      clientTime: null, message: null, stateDigest: digest, changes,
    });
    expect(result.kind).toBe("accepted");
    await backend.putCheckpoint({ revision: 1, schemaVersion: 1, stateDigest: digest, entities: changes, createdAt: new Date() });
    expect((await backend.commits({ after: 0, upTo: 1 }))[0]!.request.changes).toEqual(changes);
    expect((await backend.checkpoint({ atOrBefore: 1 }))!.entities).toEqual(changes);
  });
});

function nodeTarget(): SimTarget {
  const host = new NodeHost();
  host.grant("token", "alice");
  return remoteTarget((token) => host.backend(token), "token");
}

describe("simulation over the Durable Object (node:sqlite)", () => {
  for (let seed = 1; seed <= 150; seed++) test(`seed ${seed} converges`, () => simulate(seed, false, nodeTarget()));
});

describe("simulation with asking, restores and overwrites (node:sqlite)", () => {
  for (let seed = 1001; seed <= 1150; seed++) test(`seed ${seed} converges`, () => simulate(seed, true, nodeTarget()));
});
