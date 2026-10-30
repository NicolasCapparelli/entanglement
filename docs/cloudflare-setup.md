# Cloudflare server setup

`@entanglement/cloudflare` is a second server for the same protocol as the Supabase SQL: one **Durable Object per account** with SQLite storage. The object runs one request at a time, so it needs no row locks, and each operation is a `transactionSync`, so it is atomic. It implements the same rules as `0001_entanglement.sql`: head check and conflicts, idempotency on `commitId`, the schema gate, checkpoint digest verification, compaction safety and commit restore points. Hints go to subscribed clients over WebSockets, using the Hibernation API, and carry only the new revision.

You host three things: the Durable Object class, a Worker that authenticates devices, and (in the app) the client backend.

## 1. The Worker

The Worker owns authentication. It checks the device's bearer token, decides the account ID, and forwards the request:

```ts
import { bearerTokenFromRequest, handleEntanglementRequest } from "@entanglement/cloudflare";
export { EntanglementAccount } from "@entanglement/cloudflare";

export default {
  async fetch(request, env) {
    const accountId = await lookUpAccount(bearerTokenFromRequest(request), env); // yours
    if (!accountId) return new Response("unauthorized", { status: 401 });
    return handleEntanglementRequest(request, env, accountId);
  },
};
```

`handleEntanglementRequest` drops any account header or `Authorization` the client sent, sets the trusted `x-entanglement-account` header, and calls the account's object. The object refuses a request without that header, and refuses a second account on the same storage. Durable Objects are not reachable from the internet except through your Worker's binding, so never route a request to one without authenticating it first.

`bearerTokenFromRequest` reads `Authorization: Bearer …`, and for WebSockets (which cannot set headers in browsers or React Native) the `bearer.<base64url token>` subprotocol the client adds. A complete reference Worker, which keeps SHA-256 hashes of device tokens in KV, is [`ts/packages/cloudflare/example/worker.ts`](../ts/packages/cloudflare/example/worker.ts) with [`wrangler.jsonc`](../ts/packages/cloudflare/example/wrangler.jsonc). It is what the tests run; it is not deployed from here.

## 2. Bindings

```jsonc
"durable_objects": { "bindings": [{ "name": "ENTANGLEMENT_ACCOUNT", "class_name": "EntanglementAccount" }] },
"migrations": [{ "tag": "v1", "new_sqlite_classes": ["EntanglementAccount"] }]
```

The class **must** be declared in `new_sqlite_classes`; a key-value-backed object has no `ctx.storage.sql`. Tables are created on first use and are idempotent. The API is served under `/v1/` (`head`, `commits`, `submit`, `checkpoint`, `restore-points`, `compact`, `subscribe`) wherever your Worker is mounted.

## 3. The client

```ts
import { CloudflareSyncBackend } from "@entanglement/cloudflare";
import { EncryptedBackend, KeyCipher } from "@entanglement/core";

const backend = new CloudflareSyncBackend({
  baseUrl: "https://sync.example.com/v1",
  getToken: () => deviceToken, // null = signed out
});
// Optional: the server then holds only ciphertext.
const sealed = new EncryptedBackend(backend, new KeyCipher({ keys, activeKeyId }));
```

Errors map as with Supabase: network failures, timeouts, 408/429 and 5xx are transient; 401 is auth required; a compacted range (410) is history unavailable; everything else is fatal. `onHint` opens the WebSocket, reconnects with backoff, and fires the listener on every (re)connect so a missed hint is caught up.

Notes:

- With a `KeyCipher` the object's storage contains no document values, labels or messages; revisions, digests, collection names and ids, and timestamps are still visible to the server (see the cipher spec).
- Large commits and checkpoints are split into chunks internally, to stay under SQLite's per-value limit.
- Cost: requests and WebSocket messages bill as Durable Object requests. Keepalive pings are answered by auto-response without waking a hibernated object.
- No CORS headers are set; add them in your Worker if a browser app calls it cross-origin.

## 4. Tests

```bash
cd ts && npx vitest run packages/cloudflare
```

This needs no Cloudflare account. It runs the backend contract suite and the 300 seeded simulations against the Durable Object two ways: over `node:sqlite` (the same server logic and client, no Worker runtime), and in **workerd via Miniflare**, with the real class, the example Worker and real WebSockets. It also scans the persisted storage after an encrypted run to check that no plaintext is stored.
