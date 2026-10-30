// Mille spec §5.2 "Size check": 60k Mille-shaped documents. Not a test; run with `npm run bench:size`.
// Reports local write time, commit (digest + submit) time, checkpoint size plain and encrypted, and
// first-sync (a new device pulling from the checkpoint) time. Node only: phones must be estimated.
import { gzipSync } from "node:zlib";

import { sha256 } from "@noble/hashes/sha2";
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
  StateDigest,
  canonicalJson,
  type Cipher,
} from "../packages/core/src/index.js";
import { SqlJsExecutor } from "../packages/core/src/sqljs.js";

const TOTAL = Number(process.env.DOCS ?? 60_000);
const BATCH = Number(process.env.BATCH ?? 1_000);
const fieldwise = MergePolicy.fieldwise();
const col = (name: string, fields: string[], indexes: string[] = []) =>
  Collection.json(name, { fields, indexes, merge: fieldwise });
const accounts = col("accounts", ["id", "name"]);
const txns = col("txns", ["id", "accountId", "date"], ["accountId"]);
const txnNotes = col("txn_notes", ["id", "categoryId"]);
const balances = col("balances", ["id", "accountId", "asOf"], ["accountId"]);
const categories = col("categories", ["id", "name"]);
const rules = col("rules", ["id", "name"]);
const securities = col("securities", ["id", "ticker"]);
const invTxns = col("inv_txns", ["id", "accountId"], ["accountId"]);
const schema = new Schema({
  version: 1,
  collections: [accounts, txns, txnNotes, balances, categories, rules, securities, invTxns],
});

const hex = (text: string) => Buffer.from(sha256(new TextEncoder().encode(text))).toString("hex").slice(0, 32);
const ms = (t: number) => Math.round(t);
const mib = (bytes: number) => `${(bytes / 1048576).toFixed(2)} MiB`;
const merchants = ["Trader Joe's", "Acme Payroll", "Shell Oil", "Netflix", "Whole Foods", "Amazon", "Con Edison", "Starbucks"];

type Doc = [Collection, Record<string, unknown>];

function* documents(): Generator<Doc> {
  const nAcc = 40;
  const nTxn = 5_000;
  const nBal = 24_000;
  const nSec = 2_000;
  const nCat = 60;
  const nRule = 100;
  for (let i = 0; i < nAcc; i++) {
    yield [accounts, { id: `acc-${i}`, name: `Account ${i}`, kind: "depository", subtype: "checking", isLiability: false, institution: "Example Bank", mask: String(1000 + i), currency: "USD", hidden: false, closedOn: null, colorKey: `c${i % 8}`, links: [{ source: "plaid", connectionId: "conn-1", externalId: hex(`ext${i}`), from: "2020-01-01", to: null }] }];
  }
  for (let i = 0; i < nCat; i++) yield [categories, { id: `cat-${i}`, name: `Category ${i}`, kind: "expense", group: `Group ${i % 9}`, colorKey: `c${i % 8}`, archived: false }];
  for (let i = 0; i < nRule; i++) yield [rules, { id: `rule-${i}`, name: `Rule ${i}`, order: i, enabled: true, match: { all: [{ field: "merchant", op: "contains", value: merchants[i % 8] }] }, actions: [{ type: "setCategory", categoryId: `cat-${i % nCat}` }] }];
  for (let i = 0; i < nSec; i++) yield [securities, { id: hex(`sec${i}`), name: `Security ${i}`, ticker: `T${i}`, cusip: hex(`cusip${i}`).slice(0, 9), isin: null, type: "equity" }];
  for (let i = 0; i < nTxn; i++) {
    const id = hex(`txn${i}`);
    yield [txns, { id, accountId: `acc-${i % nAcc}`, sourceKey: { source: "plaid", connectionId: "conn-1", id: hex(`src${i}`) }, amountMinor: -((i * 7919) % 50_000), currency: "USD", date: `2025-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`, authorizedDate: null, pending: false, description: `${merchants[i % 8]} #${i}`, merchant: merchants[i % 8], sourceCategory: "GENERAL", replacesPending: null, removed: false }];
    yield [txnNotes, { id, categoryId: `cat-${i % nCat}`, tags: i % 5 === 0 ? ["tax"] : [], note: i % 9 === 0 ? "check this one later" : "", reviewed: i % 3 === 0, reviewedAt: i % 3 === 0 ? 1_760_000_000_000 + i : null, transferPairId: null, appliedRuleId: `rule-${i % nRule}`, setBy: "rule" }];
  }
  for (let i = 0; i < nBal; i++) {
    const acc = i % nAcc;
    const day = Math.floor(i / nAcc);
    yield [balances, { id: hex(`bal${acc}-${day}`), accountId: `acc-${acc}`, asOf: new Date(Date.UTC(2023, 0, 1 + day)).toISOString().slice(0, 10), currentMinor: 1_000_000 + ((i * 104729) % 900_000), availableMinor: null, limitMinor: null, source: "import" }];
  }
  // The remainder: investment transactions.
  const used = nAcc + nCat + nRule + nSec + nTxn * 2 + nBal;
  for (let i = 0; i < TOTAL - used; i++) yield [invTxns, { id: hex(`inv${i}`), accountId: `acc-${i % nAcc}`, securityId: hex(`sec${i % nSec}`), type: "buy", date: "2025-03-14", quantity: 3.5, priceMinor: 12_345, amountMinor: -43_207, currency: "USD" }];
}

async function scenario(label: string, SQL: Awaited<ReturnType<typeof initSqlJs>>, cipher?: Cipher) {
  const server = new InMemoryServer();
  const account = new ManualAccountSource("alice");
  const open = (name: string, checkpointEvery = 1_000_000) =>
    EntanglementDb.open({
      executor: new SqlJsExecutor(new SQL.Database()),
      schema,
      backend: new InMemoryBackend(server, account),
      accounts: account,
      cipher,
      options: { deviceLabel: name, vcs: { remoteCheckEveryMs: null }, history: { dailyRestorePoints: false, checkpointEvery } },
    });
  const batches = Math.ceil(TOTAL / BATCH);
  const db = await open("importer", batches);

  let writeMs = 0;
  let pushMs = 0;
  let pushMax = 0;
  let n = 0;
  let batch: Doc[] = [];
  const flush = async () => {
    const rows = batch;
    batch = [];
    let t = performance.now();
    await db.write(async (tx) => {
      for (const [c, doc] of rows) await tx.put(c, doc);
    });
    writeMs += performance.now() - t;
    t = performance.now();
    await db.sync!.push();
    const took = performance.now() - t;
    pushMs += took;
    pushMax = Math.max(pushMax, took);
  };
  for (const doc of documents()) {
    batch.push(doc);
    n++;
    if (batch.length === BATCH) await flush();
  }
  if (batch.length) await flush();

  const stored = server.state("alice");
  const checkpoint = [...stored.checkpoints.values()].sort((a, b) => b.revision - a.revision)[0];
  const json = JSON.stringify(checkpoint?.entities ?? [], (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  const commitsJson = JSON.stringify([...stored.commits.values()], (_k, v) => (typeof v === "bigint" ? v.toString() : v));

  const fresh = await open("phone");
  const t0 = performance.now();
  await fresh.sync!.pull();
  const firstSyncMs = performance.now() - t0;
  const pulled = await fresh.get(balances, hex("bal0-0"));
  if (!pulled) throw new Error("first sync did not deliver documents");

  await db.close();
  await fresh.close();
  return {
    label,
    docs: n,
    commits: stored.commits.size,
    writeMs: ms(writeMs),
    pushMs: ms(pushMs),
    slowestPushMs: ms(pushMax),
    checkpointRevision: checkpoint?.revision ?? null,
    checkpointDocs: checkpoint?.entities.length ?? 0,
    checkpointBytes: json.length,
    checkpointGzipBytes: gzipSync(json).length,
    allCommitsBytes: commitsJson.length,
    firstSyncMs: ms(firstSyncMs),
  };
}

const SQL = await initSqlJs();
const key = new Uint8Array(32).fill(3);
const results = [
  await scenario("plain", SQL),
  await scenario("encrypted (KeyCipher)", SQL, new KeyCipher({ keys: { a: key }, activeKeyId: "a" })),
];

// Digest of the full state computed from scratch (what a verifying device does once).
const all: [string, string, string][] = [];
for (const [c, doc] of documents()) all.push([c.name, String(doc.id), canonicalJson(doc as never)]);
const t = performance.now();
StateDigest.of(all);
const digestScratchMs = ms(performance.now() - t);

console.log(`Node ${process.version}, ${TOTAL} docs, ${BATCH} docs per commit`);
console.log(`Full-state digest from scratch (${all.length} docs): ${digestScratchMs} ms`);
for (const r of results) {
  console.log(`\n${r.label}`);
  console.log(`  commits: ${r.commits}; local writes ${r.writeMs} ms; pushes (digest + seal + submit${r.checkpointRevision ? " + checkpoint" : ""}) ${r.pushMs} ms, slowest ${r.slowestPushMs} ms`);
  console.log(`  checkpoint @${r.checkpointRevision}: ${r.checkpointDocs} docs, ${mib(r.checkpointBytes)} (${mib(r.checkpointGzipBytes)} gzip); all commits ${mib(r.allCommitsBytes)}`);
  console.log(`  first sync of a new device (pull from checkpoint): ${r.firstSyncMs} ms`);
}
