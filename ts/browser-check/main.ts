// Runs in a real browser (Chromium and WebKit via Playwright; WebKit is what Tauri's WKWebView is).
// Exercises the TS core end to end: sql.js (WASM) executor, two devices syncing through the
// in-memory backend, and the XChaCha20-Poly1305 cipher with a server that must only see ciphertext.
import initSqlJs from "sql.js";

import {
  Collection,
  EntanglementDb,
  InMemoryBackend,
  InMemoryServer,
  KeyCipher,
  ManualAccountSource,
  MergePolicy,
  Schema,
} from "../packages/core/src/index.js";
import { SqlJsExecutor } from "../packages/core/src/sqljs.js";

const boards = Collection.json("boards", { fields: ["id", "name"], merge: MergePolicy.fieldwise() });
const schema = new Schema({ version: 1, collections: [boards] });

function check(condition: unknown, message: string): void {
  if (!condition) throw new Error(`check failed: ${message}`);
}

async function run(): Promise<Record<string, unknown>> {
  const SQL = await initSqlJs({ locateFile: () => "sql-wasm.wasm" });
  const server = new InMemoryServer();
  const key = new Uint8Array(32).fill(7);
  const cipher = new KeyCipher({ keys: { a: key }, activeKeyId: "a" });
  const open = async (label: string) => {
    const accounts = new ManualAccountSource("alice");
    return EntanglementDb.open({
      executor: new SqlJsExecutor(new SQL.Database()),
      schema,
      backend: new InMemoryBackend(server, accounts),
      accounts,
      cipher,
      options: { deviceLabel: label, vcs: { remoteCheckEveryMs: null }, history: { dailyRestorePoints: false } },
    });
  };
  const one = await open("one");
  const two = await open("two");

  await one.write((tx) => tx.put(boards, { id: "b1", name: "Secret board" }));
  await one.sync!.push({ message: "Private message" });
  await two.sync!.pull();
  const seen = await two.get(boards, "b1");
  check((seen as { name?: string } | null)?.name === "Secret board", "device two reads the synced document");

  await two.write((tx) => tx.put(boards, { id: "b2", name: "From two" }));
  await two.sync!.push();
  await one.sync!.pull();
  check((await one.get(boards, "b2")) !== null, "device one receives device two's write");

  const stored = JSON.stringify(server.commitsOf("alice"), (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  check(!stored.includes("Secret board") && !stored.includes("Private message"), "server holds only ciphertext");
  check(stored.includes("$enc"), "documents are sealed");

  await one.close();
  await two.close();
  return { userAgent: navigator.userAgent, secureContext: isSecureContext, commitBytes: stored.length };
}

run().then(
  (details) => ((window as unknown as { __result: unknown }).__result = { ok: true, details }),
  (error: unknown) => ((window as unknown as { __result: unknown }).__result = { ok: false, error: String(error instanceof Error ? error.stack : error) }),
);
