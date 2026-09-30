# Entanglement — Design (v3)

> **Implementations.** Dart (`packages/`) and TypeScript (`ts/packages/`), held together by `spec/vectors`. The TypeScript port replaces Dart streams with listener/unsubscribe pairs and cannot refuse re-entrant access outright (no zones); everything else, including the wire format, is identical.
>
> **Implementation notes.** This is the design the code in `packages/` implements; comments cite it as "spec §N". Names differ from early drafts: the framework's local tables use the `ent_` prefix, the facade is `EntanglementDb`, the synced conflict log is the `ent_sync_log` collection, and Supabase objects are `ent_heads`, `ent_commits`, `ent_checkpoints`, `ent_restore_points` and the `ent_*` RPCs. Where implementation surfaced a gap in the design, the design was corrected here (see §11.1 on held data and §12.4 on inherited violations).

> **Status:** supersedes v2. v3 keeps v2's foundations: the local database is the working source of truth, change sets carry before-images, commits are separate from checkpoints, revisions are assigned by the server, and realtime notifications are only hints. It changes five things:
>
> 1. **Dart first, portable by specification.** v1 is a pure-Dart core. Everything that must agree across implementations (wire format, canonical encoding, digests, merge rules, backend contract, server schema) is specified here independently of Dart and backed by shared test vectors, so a TypeScript/React Native port is mechanical. A Rust core remains possible later, behind the same spec.
> 2. **Documents instead of a typed column schema.** Each entity is a JSON document in a framework-owned SQLite table. This removes the schema-materialization, local-DDL-migration and ORM work that v2 left undefined, and makes unknown-field preservation and aggregates straightforward.
> 3. **Merges that keep cross-entity consistency.** Coupling groups (from local transactions and remote commits) and reference validation make the framework merge and conflict *units*, not isolated rows. A merge can no longer produce a state that neither device ever had.
> 4. **Precise conflict defaults, every automatic decision reversible.** VCS mode asks. Realtime defaults to "first committed wins", and every discarded value goes into a synced sync log with one-tap reinstate.
> 5. **History built from revisions, not repeated snapshots.** Restore points are labels on revisions. Checkpoints are compaction anchors. VCS commits stay O(changes) while still offering "restore the last N states".
>
> Section 28 lists every change from v2 with its reason.

---

## 1. Requirements

These are the acceptance criteria. Section 27 traces each one to the part of the design that satisfies it.

| # | Requirement |
|---|---|
| R1 | Two working modes: **VCS** and **Realtime**. |
| R2 | VCS publishes local changes only on an explicit command. That command is either a user action or an app-defined automatic trigger (autosave every N minutes). Pulling is likewise explicit. |
| R3 | VCS pull supports **three-way merge with conflict resolution by the user**. |
| R4 | Optionally retain the last N prior states as backups. |
| R5 | Realtime is a lower-friction VCS and **does not erase what VCS built** (history, restore, conflict handling). |
| R6 | Switching modes is one setting for the user, or one option for the developer. |
| R7 | Independent of the remote database/vendor. |
| R8 | Usable from Flutter now, with a low-friction path to React Native. |
| R9 | Existing apps (Quadra first) adopt it **without losing data**. |

## 2. Scope

**Target:** user-owned data for one user on a few devices. Datasets are small to moderate (up to tens of thousands of documents and a few MB), and simultaneous editing of the same record is uncommon.

**Goals:** offline-first operation, atomic change sets, exact three-way merge, units that stay consistent, restorable history with bounded storage, a pluggable backend, safety across schema versions, and a core engine testable without a network.

**Non-goals for v1:**
- multi-user sharing or collaboration;
- CRDTs or character-level text merging;
- raw SQL replication;
- app-owned databases (Drift, Room, Core Data);
- code generation;
- a web target (possible later through SQLite WASM);
- a Firebase adapter (the contract is designed so one is feasible; section 18.5);
- end-to-end encryption.

---

## 3. Implementation strategy

### 3.1 Dart first

v2 chose Rust because no single app language covers both Flutter and React Native. That is true, but the cost of the Rust route arrives up front: an FFI surface, two binding generators, and native builds for Android and iOS. That cost only pays off once a second language exists, and today only Flutter apps exist. v1 is therefore a pure-Dart implementation.

### 3.2 Portable by specification

What makes a port cheap is not shared binaries. It is that **every decision two implementations must agree on is written down and tested with shared data.** The following are normative and language-neutral:

- canonical JSON encoding (5.7);
- entity hashes and state digests (9.6);
- the pending-overlay and coalescing rules (7);
- per-document three-way decisions, unit formation and integrity passes (12);
- the relation/status derivation (10);
- the wire format and backend contract semantics (18);
- the reference server schema and RPC rules (19);
- the local table layout (6). This is not needed for interoperability, but it makes a port a transcription.

These are exercised by **conformance vectors**: JSON files of inputs and expected outputs under `spec/vectors/` (22). The Dart test suite runs them. A TypeScript port runs the same files. A Dart app and a TypeScript app could share an account, because they speak the same protocol to the same tables.

If maintaining two implementations becomes a burden, a Rust core can replace both behind this same spec. The v2 plan is deferred, not discarded.

### 3.3 Rules that keep the Dart code portable

- `entanglement` is pure Dart with no Flutter import. Flutter-only pieces (lifecycle hooks, bundled SQLite native libraries) live in `entanglement_flutter`.
- The core never calls a SQLite library directly. It talks to a small `SqlExecutor` interface (6.3). On React Native, `op-sqlite` or `expo-sqlite` implement the same interface.
- The public contract uses no code generation, reflection, isolates or mirrors. Sealed classes map to TypeScript discriminated unions, `Stream` maps to subscribe/unsubscribe callbacks, and `Future` maps to `Promise`.
- Everything the core stores or sends is a JSON-compatible value. App model classes are converted at the edge by per-collection codecs.
- Merge, digest, encoding and relation logic are **pure functions with no I/O**. That is where porting risk concentrates, and it is what the vectors cover.

---

## 4. Architecture

```text
                 APPLICATION (Flutter today, React Native later)
                 model classes · codecs · UI · business logic
                                   │
                                   │  EntanglementDb API: write · query/watch · sync · history · conflicts
                                   ▼
 ┌──────────────────────────── entanglement (pure Dart) ────────────────────────────┐
 │                                                                               │
 │  Store        documents · pending overlay · coupling groups · ref index ·     │
 │               integrity checks · watch/change events · local backups          │
 │                                                                               │
 │  Engine       push · pull · merge · resolve · restore · checkpoint/compact    │
 │                                                                               │
 │  Scheduler    VCS / realtime triggers · single-flight queue · retry/backoff   │
 │                                                                               │
 │  Pure         canonical JSON · digests · three-way decide · units · relation  │
 │                                                                               │
 └──────────────┬──────────────────────────────────────────────┬─────────────────┘
                │ SqlExecutor                                   │ SyncBackend
                ▼                                               ▼
     entanglement (lib/sqlite.dart) (package:sqlite3)                 entanglement_supabase · InMemoryBackend (tests)
```

| Layer | Owns | Must not |
|---|---|---|
| **Application** | Collection definitions, codecs, merge policies, references, when to trigger VCS pushes, all UI (status, conflicts, history). | Touch SQLite directly or write outside `db.write`. |
| **Core** | Everything in the box above. | Know the backend vendor or the UI toolkit. |
| **SqlExecutor** | Opening SQLite, executing statements, transactions. | Contain any sync logic. |
| **Backend adapter** | Transport, auth tokens, server-side CAS, storage of commits/checkpoints/restore points, hint subscription, error translation. | Merge, decide conflicts, or interpret document contents. |

---

## 5. Data model

### 5.1 Collections and documents

An app declares **collections**. Each entity is a **document**: a JSON object identified by `(collection, id)`. The document is the unit of change, merge, reference and conflict.

**Aggregates.** Data that must never be split goes in one document: a board with its quadrants and sections, or a task with its subtasks. Documents are rewritten whole on every change, so keep them reasonably small (well under 100 KB). Split anything that grows without bound (a board's tasks, a journal's entries) into its own collection.

**Identity.**
- Normal entities use client-generated **UUIDv7**, so offline creates need no server round-trip.
- Singletons (`settings`) and seed data (`seed-board-default`) use **deterministic ids**. Two devices that independently create "the same" thing then produce the same entity and merge cleanly instead of duplicating (16.3).

### 5.2 Defining a collection

```dart
final tasks = Collection<Task>(
  'tasks',
  decode: Task.fromJson,
  encode: (task) => task.toJson(),
  idOf: (task) => task.id,
  // Top-level keys this build understands. Keys outside this set are preserved (5.5).
  fields: {'title', 'boardId', 'quadrantId', 'categoryId', 'completed',
           'lastCompleted', 'subtasks', 'order', 'updatedAt'},
  // Top-level fields to index for queries (8.1).
  indexes: {'boardId', 'order'},
  // Outgoing references, validated on write and after merge (5.4).
  refs: (doc) => [
    Ref('boards', doc['boardId'] as String,
        check: (board) => boardHasQuadrant(board, doc['quadrantId'])),
    if (doc['categoryId'] != null) Ref('categories', doc['categoryId'] as String),
  ],
  merge: MergePolicy.fieldwise(groups: [
    {'completed', 'lastCompleted', 'subtasks'},   // always merged together
  ]),
);

final deviceSettings = Collection<DeviceSettings>(
  'deviceSettings', /* ... */ sync: false,       // local-only (5.3)
);
```

### 5.3 Local-only collections

A collection with `sync: false` is stored, queried and watched like any other, but it is never journaled and never leaves the device. Use it for device-specific preferences (layout tuned to one screen, notification settings) and for caches.

A synced document **must not** reference a local-only collection, because the reference would dangle on every other device. This is checked when the database opens.

### 5.4 References and integrity

`refs(doc)` returns the documents this document depends on. Each `Ref` names a target `(collection, id)` and can optionally include a `check(targetDoc)` predicate. The predicate covers references into the inside of an aggregate, such as a quadrant id within a board.

The framework guarantees that **the committed local state and every merged state satisfy every reference**:

- **Write time.** At the end of each transaction, the core checks the outgoing references of every touched document. It also checks the incoming references to every touched document, using the reverse index `ent_refs`, which is maintained on every write. A violation rolls back the transaction with `IntegrityViolation(details)`. **The app writes cascades explicitly** in the same transaction: delete a board together with its tasks, or clear `categoryId` when deleting a category.
- **Merge time.** See 12.4.

**Why.** Merging each document independently can produce states that no device ever had: a task moved into a quadrant that another device deleted. Quadra's old action log hit exactly this, and patched it by silently dropping writes. References are the most common cross-document invariant, so the framework enforces them rather than hoping.

Invariants that span documents but are not references (for example, a contiguous `order` across a quadrant's tasks) are protected by **coupling** (7.2) instead.

### 5.5 Unknown-field preservation

When the app writes a document, the core copies over every stored top-level key that is **not** in this build's `fields`. An older build that edits a task therefore keeps a field added by a newer build.

- Omitting a *known* key deletes it.
- Unknown keys count toward equality, digests and sync like any other.
- Preservation is **top-level only**. A newer build that adds structure *inside* a known field (a new key inside each subtask) is not additive, because an older writer replaces that field wholesale. Such a change must raise `compatibleSince` (17).

### 5.6 Merge policies

These apply per collection when both sides changed the same document to different values (12.3).

| Policy | Behavior |
|---|---|
| `wholeDocument` (default) | Any both-sides change is a conflict. |
| `fieldwise(groups)` | A three-way merge per top-level key. Keys listed in the same group merge as one value. It is a conflict only if the same key or group changed differently on both sides. |
| `custom(fn)` | `fn(base?, local?, remote?)` returns a merged document, a deletion, or a conflict. It must be deterministic. |

There is deliberately **no timestamp-based last-writer-wins**. Device clocks cannot order anything. Where an app wants one side to win automatically, that is a *conflict policy* (13.3), and it is recorded and reversible.

### 5.7 Canonical encoding

All equality comparisons use **canonical JSON**: dirty detection, coalescing, three-way decisions, digests, and "did anything change". Canonical JSON is **RFC 8785 (JCS)**.

Constraints on synced documents:
- The top level is a JSON object.
- Numbers are finite. Integers stay within ±(2^53 − 1).
- There are no NaN or Infinity values.
- Strings are valid Unicode.

*Dart note:* `jsonEncode(1.0)` produces `1.0`, but JCS requires `1`. The core must use its own JCS encoder, and the vectors cover the edge cases. As a result, a Dart `double 1.0` and a TypeScript `1` are the same value, and model decoders should read numbers as `num`.

---

## 6. Local storage

The framework owns one SQLite database per `EntanglementDb`. It uses WAL mode and needs SQLite 3.38 or later for the JSON functions (bundled by `sqlite3_flutter_libs`, and on React Native by `op-sqlite`).

### 6.1 Tables

| Table | Purpose |
|---|---|
| `c_<collection>(id TEXT PRIMARY KEY, doc TEXT NOT NULL, <index columns>)` | Current documents, one table per collection. Index columns are `GENERATED ALWAYS AS (json_extract(doc,'$.<field>')) VIRTUAL`, each with an index. |
| `ent_meta(key TEXT PRIMARY KEY, value TEXT)` | `device_id`, `owner_account`, `base_revision`, `base_digest`, `txn_seq`, `local_schema_version`, `mode`, `conflict_policy`, `last_checked_head`, and so on. |
| `ent_pending(collection, id, before TEXT NULL, before_exists INT, grp INT, seq INT, inflight_seq INT NULL, held_unit TEXT NULL, PRIMARY KEY(collection, id))` | The pending overlay (7.3). |
| `ent_refs(from_collection, from_id, to_collection, to_id)` | Reverse reference index, with an index on `(to_collection, to_id)`. |
| `ent_inflight(id INTEGER PRIMARY KEY CHECK(id = 1), request TEXT, created_at)` | At most one commit awaiting a definitive answer (11). |
| `ent_conflicts(unit_id, collection, id, ancestor, local_at_detect, remote, reasons, detected_at)` | Held conflict units (13.1). |
| `ent_backups(id, created_at, reason, payload)` | Local full-state backups (15.6). |

The synced framework collection `ent_sync_log` (13.4) is an ordinary collection table.

### 6.2 Opening the database

At open, the core:
- diffs the declared indexes against the materialized ones and adds or drops generated columns and indexes;
- validates the schema (reference targets exist and are synced where required);
- runs local migrations (17.3);
- refuses to open a database written by a newer local schema (`LocalSchemaTooNew`). This is the downgrade guard.

No per-field DDL ever exists. Adding a field needs nothing.

### 6.3 `SqlExecutor`

```dart
abstract interface class SqlExecutor {
  Future<List<Map<String, Object?>>> select(String sql, [List<Object?> args]);
  Future<void> execute(String sql, [List<Object?> args]);
  Future<T> transaction<T>(Future<T> Function() body, {bool immediate = true});
  Future<int> dataVersion();              // PRAGMA data_version
  Future<void> close();
}
```

v1 implements this over `package:sqlite3` on the calling isolate. The datasets are small and the API is already async, so a background-isolate executor can be swapped in later without changing the core.

---

## 7. Writing

### 7.1 Transactions

Every write goes through `db.write`. The callback may read and write through `tx` but must not await anything else, such as network calls.

```dart
await db.write((tx) async {
  final task = await tx.get(tasks, id);
  await tx.put(tasks, task!.copyWith(quadrantId: q2, order: 0));
  await tx.put(tasks, other.copyWith(order: 1));
});
```

- A transaction is one SQLite transaction (`BEGIN IMMEDIATE`). It increments `txn_seq` and allocates one **group id**.
- `tx.put` inserts or replaces a document (after unknown-field carry-over). `tx.patch` merges top-level keys. `tx.delete` removes a document.
- At the end: integrity checks run (5.4), the pending overlay is updated (7.3), and then the transaction commits and a change event fires (8.2).

### 7.2 Coupling groups

All documents written in one transaction are **coupled**: they are published together and merged or conflicted together. When a transaction touches a document that already has a pending row in group `h`, every row in `h` is relabelled into the transaction's group. Coupling is therefore transitive across transactions until the changes are published.

Transactions are the app's way of saying "these changes only make sense together". Keep them meaningful and small.

### 7.3 The pending overlay and coalescing

A pending row exists for every synced document whose current value differs from its **base** value (the value at the last synced revision). `before` holds the base value (`before_exists = 0` means the document did not exist at base).

On each write of document `e` inside a transaction with sequence `s` and group `g`:

```text
old = current(e)                       # value before this write, or ABSENT
row = pending(e)
if row is null:
    row = { before: old, grp: g, seq: s }
else:
    relabel all rows in row.grp to g   # coupling (7.2)
    row.seq = s
write current(e) = new                 # or delete
if canon(new) == canon(row.before)     # includes ABSENT == ABSENT
   and row.inflight_seq is null        # never eliminate a row the server may be accepting (11.2)
   and row.held_unit is null:          # conflicted rows wait for resolution (13)
    delete row
```

Consequences:
- Five edits to one task leave one pending row.
- An edit followed by an exact undo leaves none.
- Storage is proportional to what changed, not to the database size.

### 7.4 Base reconstruction

```text
base(e) = row.before   if a pending row exists for e
        = current(e)   otherwise
```

This gives the exact state at `base_revision` for every document, without a second copy of the database or a backend round-trip. Three-way merge and the full-state fallback (12.1) rely on it.

---

## 8. Reading and observing

### 8.1 Queries

```dart
db.get(tasks, id);
db.query(tasks).where('boardId', isEqualTo: b).orderBy('order').get();
db.query(tasks).where('boardId', isEqualTo: b).watch();          // Stream<List<Task>>
db.watchAll(tasks);
db.select('SELECT ... FROM c_tasks WHERE ...', args, dependsOn: {tasks}); // read-only escape hatch
```

`where` and `orderBy` accept any top-level field. Declared indexes only make them faster. Reads always come from local data.

### 8.2 Change events and origin

After every committed transaction the core emits `ChangeEvent(collections, keys, origin)`. The origin is one of `local`, `remote` (pull), `resolution`, `restore` or `migration`. Watchers re-run when their collection appears in the event.

**Origin exists so apps can skip side effects for changes they did not make.** For example, an app can decide not to fire "task completed" feedback because a pull brought in a completion from another device. Rescheduling reminders from the full task list stays correct for every origin.

### 8.3 Multiple connections and processes

The overlay, groups and sequence counter all live in the database and are written in the same SQLite transaction as the data. Several connections, isolates or processes (for example, a home-screen widget callback) can therefore write safely. SQLite serializes the writers.

- Exactly one instance per device is the **sync leader** (`SyncRole.leader`, the default). Others open as `SyncRole.passive`: they read and write, but never sync.
- The leader notices writes from other connections through `PRAGMA data_version`. It checks on app resume, before each sync cycle, and every few seconds while watchers are active. When the version has changed it refreshes watchers with origin `local`.

---

## 9. Protocol concepts

### 9.1 Revision

A server-assigned, strictly increasing integer per account. It is the only ordering authority. Revision 0 is the empty state.

### 9.2 Head

The server's current revision for the account, plus:
- `schemaVersion`: of the latest writer;
- `minVersion`: the oldest schema version still allowed to read and write (17);
- `stateDigest`: of the state at head.

### 9.3 Base

`(base_revision, base_digest)` in `ent_meta`: the revision this device last agreed with, together with the digest of that state.

### 9.4 Commit

The atomic unit of publication: every publishable pending change, with coupling groups, advancing head by exactly one revision (18.3).

### 9.5 Checkpoint and restore point

- **Checkpoint:** a complete state at a revision, used as a compaction anchor and for bootstrap (15.2).
- **Restore point:** a user-visible label on a revision (15.1).

A commit is never a checkpoint. A restore point needs no stored snapshot.

### 9.6 State digest

Used to detect divergence, corruption and implementation bugs. It is not a security mechanism.

```text
entityHash(c, id, v) = SHA-256( UTF-8( JCS([c, id, v]) ) )   read as an unsigned 256-bit big-endian integer
stateDigest(S)       = ( Σ over live synced documents of entityHash ) mod 2^256    as 64 lowercase hex chars
empty state          = 64 × "0"
update               : digest' = digest − entityHash(old) + entityHash(new)   (ABSENT contributes 0)
```

Because the digest is additive, it updates in O(changes). Local-only collections are excluded. Every commit and checkpoint carries the digest of the state it produces.

---

## 10. Status model

The status separates **where we are** (relation), **what we are doing** (activity) and **what went wrong** (problem). v2 mixed these into one state list.

```dart
class SyncStatus {
  SyncRelation relation;
  SyncActivity activity;       // idle | checking | pulling | pushing | restoring | bootstrapping
  SyncProblem? problem;        // offline | authRequired | integrity | error(code, message, retryAt)
  SyncMode mode;
  int pendingCount;            // publishable pending documents
  int heldCount;               // pending documents held by conflicts
  int conflictCount;           // held units
  int baseRevision;
  int? knownHeadRevision;      // from the last check
  DateTime? lastCheckedAt, lastSyncedAt;
}
```

`relation` is derived in this priority order:

| Condition | Relation |
|---|---|
| no account | `signedOut` |
| local data owned by another account | `accountMismatch` |
| `head.minVersion > schema.version` | `remoteSchemaTooNew`: update the app. Nothing is pulled or pushed. |
| `conflictCount > 0` | `conflicted` |
| no head exists | `remoteEmpty` |
| pending > 0 and head > base | `diverged` |
| pending > 0 | `localAhead` |
| head > base | `remoteAhead` |
| otherwise | `upToDate` |

`diverged` only means "both sides moved". Most divergence merges automatically. `conflicted` is the only relation that needs a human.

---

## 11. Push

### 11.1 Algorithm

```text
push(message?):
  if ent_inflight exists:
      result = backend.submit(inflight.request)            # identical bytes, same commit id
  else:
      excluded = { grp of every row with held_unit != null }
      repeat:                                              # later edits can depend on held data
          view = held/excluded docs at their `before` (head) value, everything else current
          add to `excluded` the group of any selected doc involved in a broken reference under `view`
      until nothing new is excluded
      rows = pending rows where grp ∉ excluded
      if rows empty: return (a message with no changes labels the head instead, 15.1)
      request = buildCommit(rows, message)                 # 18.3; stateDigest = base_digest + Σ(h(after) − h(before))
      local transaction:
          write ent_inflight(request)
          set rows.inflight_seq = rows.seq
      result = backend.submit(request)

  on Accepted(revision):
      local transaction:
          for each row in request:
              if row.seq == row.inflight_seq:
                  delete row                               # unchanged since capture
              else:
                  row.before = committed value; row.inflight_seq = null
                  if canon(current) == canon(row.before): delete row   # deferred coalescing
          base_revision = revision; base_digest = request.stateDigest
          delete ent_inflight
  on Conflict(head):
      local transaction: clear inflight_seq on rows (re-evaluating coalescing); delete ent_inflight
      pull()                                               # 12, which rebases the overlay onto head
      retry push, at most 5 rounds per cycle, then back off
  on Rejected(reason):
      clear in-flight state as for Conflict; problem = error(reason)
  on transient error:
      keep ent_inflight; retry later with the SAME request
```

### 11.2 Why these rules

- **The in-flight record is durable.** It is written before sending. After a crash or timeout, the identical request is resent, and the server deduplicates by commit id (18.4). A lost acknowledgement can therefore never publish the same change twice.
- **Edits made during the upload are not lost.** A row modified while its commit was in flight has a newer `seq`. On acceptance its `before` becomes the committed value (the new base), so the later edit stays pending.
- **Coalescing is suppressed while a row is in flight.** Suppose `v0` is pending as `v1`, and the user reverts to `v0` while `v1` is uploading. Deleting the row immediately would leave the server at `v1` and the device at `v0` with no record of the difference. The row is kept and re-evaluated after the answer.
- **No pull while a commit is in flight.** Every cycle resolves the in-flight commit first. If an in-flight commit is ever abandoned (15.7), nothing breaks: if it had actually been accepted, it later arrives as a remote commit whose values equal the local pending values, and identical changes merge cleanly (12.3).

---

## 12. Pull and merge

### 12.1 Fetching the remote side

```text
head = backend.head()
if head is null: relation = remoteEmpty; return
if head.minVersion > schema.version: relation = remoteSchemaTooNew; return
if head.revision == base_revision: return
if head.revision <  base_revision: → recovery (12.6)

try:   commits = backend.commits(after: base_revision, upTo: head.revision)   # paged
       remoteNet = last value per document across commits; remoteGroups = each commit's groups
catch HistoryUnavailable:
       S = stateAt(head.revision)                                            # 15.4
       remoteNet = diff(baseState(), S); remoteGroups = ∅
migrate values from commits whose schemaVersion < ours (17.4)
```

**The full-state fallback is a correct three-way merge, not an approximation.** The base is reconstructed exactly (7.4), so a document present in the base but absent from `S` was deleted remotely. A device that has been offline for months never resurrects deletions, and no tombstone retention period is needed. The incremental path is only an optimization.

Everything after the fetch runs inside **one `BEGIN IMMEDIATE` transaction**. No local write can interleave between reading local state and applying the merge.

### 12.2 Inputs

- **Touched documents:** `T = keys(pending) ∪ keys(remoteNet)`.
- For each `k ∈ T`:
  - `B(k)` = base value (7.4);
  - `L(k)` = current value;
  - `R(k)` = `remoteNet(k)` if present, otherwise `B(k)`.
  - Any of these may be `ABSENT`.

### 12.3 Per-document decision

All comparisons use canonical equality.

| Case | Decision |
|---|---|
| `L == R` | take `L` (covers unchanged, both-deleted, identical edits) |
| `L == B`, `R != B` | take `R` |
| `R == B`, `L != B` | take `L` |
| otherwise, one side `ABSENT` | **conflict** `deleteVsEdit` |
| otherwise | apply the collection's merge policy (5.6). For `fieldwise`: treat `B = ABSENT` as `{}`; per key or group, take whichever side changed; **conflict** `fieldConflict(keys)` if both changed differently. |

### 12.4 Units

```text
1. Union-find over T:
     union all keys of each local coupling group (ent_pending.grp)
     union all keys of each remote group (from each fetched commit)
   Connected components are UNITS.
2. Decide every key (12.3). A unit is CONFLICTED if any of its keys conflicts, otherwise CLEAN.
3. Tentative merged state M:
     clean unit      → each key's decided value
     conflicted unit → L for every key (local stays visible until resolved)
     untouched doc   → current (which equals base, which equals head)
4. Integrity pass over M:
     for each k ∈ T with a value in M: every Ref(k → t) must resolve in M and pass its check
     for each k ∈ T deleted or changed in M: every referrer of k (ent_refs, plus refs of remote values) must still hold
     each violation between x and y: union their units (if y ∈ T), mark the unit CONFLICTED(integrity)
5. Repeat 3–4 until no new unions.
6. Apply the conflict policy to newly conflicted units (13.3), fix the chosen sides, and repeat 3–5.
```

**Inherited violations.** If a violation remains after the loop and it also exists in the head state itself (written by a buggy or outdated client), the pull accepts it rather than wedging the device forever; this device cannot repair the head by choosing sides. A violation the merge introduced is a bug and aborts the pull.

**Correctness argument.**
- The all-local state is valid, because write-time checks enforce it.
- The all-remote (head) state is valid, because it was valid on the device that committed it.
- Each iteration either finds no violation or strictly grows a unit.
- In the worst case the whole touched set becomes one unit. Resolved either way, it yields entirely the local state or entirely the head state, and both are valid.

The loop therefore terminates, and it terminates in a valid state.

**Worked example.** Local moves task 42 into quadrant B. Remote deletes board section B and, in the same commit, moves its tasks elsewhere. Task 42 and B's container sit in different units, and each unit is clean on its own. The integrity pass finds 42 pointing into a missing target and joins the units into one conflict:
- "keep mine" restores B and keeps 42 there;
- "keep theirs" keeps B deleted and returns 42 to its previous place.

Both outcomes are valid. No half-merged mixture is possible.

### 12.5 Applying: rebasing the overlay onto head

For every `k ∈ T`, let `H(k) = R(k)` (the value at head) and `F(k)` = the value from `M` after resolution:

```text
write current(k) = F(k)                       # only if changed; emits origin = remote / resolution
if canon(F(k)) == canon(H(k)): delete pending row
else: upsert pending row with before = H(k), keeping its grp; held_unit = unit id if the unit is held
base_revision = head.revision
base_digest   = verified digest (12.6)
save ent_conflicts records for held units (ancestor = B, local = L, remote = R)
```

After a pull, pending rows describe exactly "local differs from head", which is what the next push publishes.

### 12.6 Digest verification and recovery

```text
computed = base_digest + Σ over k ∈ remoteNet of ( h(k, R(k)) − h(k, B(k)) )
```

The computed value must equal `head.stateDigest`. Verification is skipped only when ingestion migrations (17.4) transformed values, because the digests were then taken over different shapes.

**On mismatch, or if head < base:**
1. Roll back.
2. Redo the pull through the full-state path (12.1).
3. Verify `stateDigest(stateAt(head))` against `head.stateDigest`.
   - If it matches, the local base was wrong and has been healed.
   - If it does not, the server data is inconsistent: `problem = integrity`. Automatic sync stops, and the user is offered **take cloud as-is** or **overwrite cloud with this device** (13.5).

### 12.7 Pulling into an already-held unit

If a pull touches a document in a held unit, the unit stays held. Its conflict record's `remote` side is updated to the new head value, while `ancestor` keeps the original common ancestor.

---

## 13. Conflicts

### 13.1 Conflict units

`db.conflicts.watch()` yields `ConflictUnit`s:

```text
ConflictUnit
  id, detectedAt, reasons: [bothChanged | deleteVsEdit | fieldConflict(keys) | integrity(details)]
  entries: [ { collection, id, ancestor?, local?, remote?, conflictingFields? } ]
```

Every entry carries all three sides, so a conflict screen can show base / mine / theirs without extra fetches.

### 13.2 Resolutions

```dart
db.conflicts.resolve(unitId, Resolution.keepLocal);
db.conflicts.resolve(unitId, Resolution.keepRemote);
db.conflicts.resolve(unitId, Resolution.custom({key: valueOrAbsent, ...}));  // every entry must be given
```

- **keepRemote** writes the remote values locally. The pending rows cancel out through normal coalescing, because the documents now equal head.
- **keepLocal** clears `held_unit`. The local values stay pending and publish on the next push.
- **custom** writes the given values and validates integrity. On violation it is refused, with details.

After any resolution, integrity is re-checked (12.4, steps 3–5). A resolution can surface a new conflict, and the UI simply shows it.

Every resolution appends an entry to the sync log (13.4) and emits a change event with origin `resolution`.

### 13.3 Conflict policies

| Policy | Behavior |
|---|---|
| `ask` | Units are held until the user resolves them. Non-conflicting changes keep syncing (11.1 excludes only held groups). |
| `preferRemote` | "First committed wins." Resolve as `keepRemote` automatically. |
| `preferLocal` | "Last to sync wins." Resolve as `keepLocal` automatically. |

**Defaults: VCS → `ask`; Realtime → `preferRemote`.** Both are configurable per device and can be exposed to users.

**Why `preferRemote` for realtime.** In the retry loop, the device that retries always commits last. A "later commit wins" rule (v2) therefore means *whoever syncs last wins*. A phone offline for a week would come back and silently overwrite a week of desktop edits. `preferRemote` keeps what other devices have already seen and built on, and it penalizes the stale side.

Nothing is lost under either automatic policy. The discarded side is written to the sync log and can be reinstated with one tap. Held conflicts are **never** auto-resolved retroactively (for example, after switching from VCS to realtime): the user was asked, so the framework does not decide for them later.

### 13.4 The sync log

`ent_sync_log` is a **synced** framework collection, so a decision made on one device is visible and reversible on every device:

```text
{ id, at, deviceLabel, automatic: bool, policy, choice, summary,
  discarded: [ { collection, id, value | ABSENT } ] }
```

- `db.conflicts.log()` lists entries. `db.conflicts.reinstate(entryId)` writes the discarded values back as an ordinary local transaction (one group), which then syncs normally and is integrity-checked.
- Retention: the newest 200 entries or 90 days, whichever keeps more (`HistoryOptions.syncLogRetention`, `syncLogMaxAge`). The core prunes old entries as ordinary, isolated deletes in the same transaction that writes a new entry, after every unit of a merge is applied, so the pruning syncs and every device converges on the same log.

### 13.5 Blunt instruments

These map directly to the original three-way prompt ("pull / do nothing / override remote"). Both go through normal compare-and-swap. **There is no server-side force operation.**

- **`discardLocalAndPull()`:** writes a local backup (15.6), sets every pending document back to its base value, then pulls.
- **`overwriteRemoteWithLocal()`:** writes a local backup, labels head as a restore point `before overwrite`, then applies *target state = current local state* on top of head (the same mechanism as restore, 15.5) and pushes.

---

## 14. Modes

Both modes use the same store, overlay, commits, merge, conflicts, history and backend. **A mode is only a set of triggers and a default conflict policy.** It is device-local, stored in `ent_meta`, and never migrates data.

### 14.1 VCS mode

| Operation | Behavior |
|---|---|
| Local writes | Apply immediately and add to the overlay. No network. |
| `db.sync.push({message})` | Publish (11). If the remote moved, it pulls and merges automatically. Clean results publish. Conflicts are held and shown, and everything else still publishes. |
| `db.sync.pull()` | Fetch and merge (12). Clean changes apply. Conflicts are held under `ask`. |
| `db.sync.sync()` | `pull()` then `push()`. |
| Remote awareness | `head()` on start, on resume and every `remoteCheckEvery` (default 5 min). This is metadata only and applies nothing, so the app can show "cloud has newer changes — pull?" (`relation == remoteAhead` or `diverged`). |
| Autosave (optional) | `VcsOptions.autoPushEvery: Duration?` runs `push()` on a timer whenever there are local changes. Autosave pushes are not restore points unless a message is given. |

Every user-initiated push is a **restore point** (15.1). This is what "keep the last N states" means in VCS mode.

### 14.2 Realtime mode

| Trigger | Action |
|---|---|
| Local transaction commits | `push()` after a `debounce` (default 2 s), capped by `maxDelay` (default 10 s) during continuous editing. |
| Backend hint | `pull()` after 500 ms. |
| Poll fallback | `pull()` every 60 s while in the foreground. |
| App resume | Full cycle. |
| App pause | Best-effort final push, time-limited. |
| Once a day | A `daily` restore point on the first successful cycle after local midnight. |

Merging uses the realtime conflict policy (default `preferRemote`), so realtime never stops to ask unless the app chooses `ask`.

### 14.3 Switching

`db.sync.setMode(SyncMode.realtime | SyncMode.vcs)` is one call. The app can expose it as one setting.

- **VCS → Realtime:** triggers start, and the first cycle pulls then pushes. Existing held conflicts stay held (13.3).
- **Realtime → VCS:** the scheduler waits for the running cycle and any in-flight commit, then stops automatic triggers. The overlay, base, history and conflicts are untouched.

Per-collection modes are deliberately not supported (28). Local-only collections (5.3) cover "never sync this".

---

## 15. History, restore and backups

### 15.1 Restore points (R4)

A restore point is a label on a revision: `{ revision, label, kind, pinned, deviceLabel, createdAt }`.

| Kind | Created by |
|---|---|
| `commit` | Every user-initiated VCS push, labelled with its message if one is given. |
| `daily` | Realtime mode, once per day. Optionally VCS too. |
| `manual` | `db.history.mark(label)`, which labels the current head after pushing. |
| `beforeRestore`, `beforeOverwrite` | Automatically, before those operations. |

Retention: the newest `keep` unpinned restore points (default 10; R4's "last 3" is `keep: 3`), plus all pinned ones. Because a restore point stores no data, retention costs only the commits needed to reach it.

### 15.2 Checkpoints

A checkpoint is `{ revision, schemaVersion, stateDigest, entities: [{collection, id, value}] }`. It reuses the commit change encoding, so there is one serialization format.

- **Who builds it.** Any device whose base equals head (right after a successful cycle with nothing held) builds the checkpoint from `baseState()`, which is exact, and uploads it. No server-side state materialization is required.
- **When.** When `head − latestCheckpoint ≥ 200` commits, or ≥ 5,000 changed documents, or the latest checkpoint is older than 30 days with commits since.
- **Verification.**
  - The server accepts a checkpoint only if its `stateDigest` equals that of the commit at the same revision.
  - Every client recomputes the digest from the content when downloading.
  - Concurrent checkpoints from two devices are both valid.

### 15.3 Retention and compaction

After uploading a checkpoint, the device computes:

```text
P      = oldest retained restore point revision (after pruning restore points beyond retention)
anchor = newest checkpoint with revision ≤ P   (or the latest checkpoint when there are no restore points)
delete restore points beyond retention         (backend.deleteRestorePoints)
compact(anchor)                                # server deletes commits ≤ anchor and checkpoints < anchor
```

Server-side invariants, enforced regardless of client bugs:
- `compact(anchor)` requires a checkpoint to exist **at** `anchor`;
- it refuses if any pinned restore point is older than `anchor`.

Bootstrap and every retained restore point therefore always stay reachable. A concurrent reader that loses commits mid-fetch gets `HistoryUnavailable` and falls back to full state (12.1).

### 15.4 `stateAt(revision)`

```text
cp = backend.checkpoint(atOrBefore: revision)   # or the implicit empty state at 0
fold backend.commits(after: cp.revision, upTo: revision) over cp
verify digest against the commit at `revision`
```

### 15.5 Restore

Restore is **target-state application**, always moving forward:

```text
restore(point):
  run a cycle first (if online); if pending changes remain, write a local backup (15.6)
  label current head as a restore point `beforeRestore`
  target = stateAt(point.revision)            # migrated if older schema
  loop (at most 5 rounds):
     local transaction (origin = restore, one group): make every synced collection equal target
     push
     on Conflict: pull, then re-apply target on top of the new head and retry
```

- The revision counter never rewinds; other devices converge through normal pulls.
- The restore itself is undoable through its `beforeRestore` point.
- Re-applying the target after a conflict preserves the user's explicit intent, even under `preferRemote`.

### 15.6 Local backups

These protect data that was **never published** and therefore exists nowhere else. A full snapshot of the synced collections (compressed JSON in `ent_backups`) is written before any operation that discards unpublished local changes:
- `discardLocalAndPull`;
- `overwriteRemoteWithLocal`;
- restore;
- account switch;
- `abandonInflight`.

Retention: `localBackups` (default 3). API: `db.history.localBackups()` and `db.history.restoreLocalBackup(id)`. The latter applies the backup as a target state, as in 15.5.

### 15.7 Maintenance operations

- `db.sync.abandonInflight()`: for a commit stuck on a permanent transport failure. It is safe (11.2) and writes a backup first.
- `db.sync.rebuildBase()`: forces the full-state pull path (12.6).

---

## 16. Accounts and bootstrap

### 16.1 Signed-out use

The app works fully without an account. Base is revision 0 (the empty state), so every document the user creates is pending. **Signing up is simply the first push**, with no special adoption code.

### 16.2 Signing in

| Local owner | Behavior |
|---|---|
| none (signed-out data) | Claim the data for the account, then pull. If the remote is empty, the first push publishes everything. If not, the three-way merge is against base 0: distinct entities merge cleanly, and same-id entities (singletons, seeds) merge by policy. |
| same account | Resume. |
| different account | `relation = accountMismatch` with `pendingCount`. The app calls `db.sync.switchAccount(discardUnpublished: bool)`. The switch writes a local backup, clears synced collections and the overlay, resets the base to 0, and bootstraps. With `discardUnpublished: false` and pending changes, it refuses. |

Credentials never enter the core. The adapter provides an `AccountSource` (a stream of `accountId?`) and handles tokens itself.

### 16.3 New-device bootstrap and seed data

A new device has base 0. A pull then uses `commits(after: 0)`, or falls back to the full-state path when history was compacted: latest checkpoint plus the commits after it. Cost is bounded by dataset size plus recent activity; the device never replays lifetime history.

**Seed data must use deterministic ids and deterministic content.** A fresh device's default board then equals the default board already in the account, and merges cleanly instead of appearing twice. Seeds the user has since edited merge by policy like any other document.

### 16.4 Signing out

Sync stops and local data remains (still owned by that account). Signing back in as the same account resumes.

---

## 17. Schema evolution

### 17.1 Versions

The app schema declares:
- `version`: this build's format;
- `compatibleSince`: the oldest version that can safely read and write data this build writes.

**Additive changes** (a new top-level field, a new collection) keep `compatibleSince` unchanged. Older builds keep working and preserve the new fields (5.5).

**Breaking changes** (renames, changed meaning, new structure inside an existing field) set `compatibleSince = version` and ship a migration.

### 17.2 Server gate

- Each commit carries `schemaVersion` and `compatibleSince`.
- The head keeps `minVersion = max(minVersion, commit.compatibleSince)`.
- A submit with `schemaVersion < head.minVersion` is rejected (`schemaTooOld`).
- A client with `version < head.minVersion` reports `remoteSchemaTooNew` and neither pulls nor pushes.

A single breaking release therefore fences off older builds, while additive releases never force lockstep updates.

### 17.3 Local migrations

`migrations: {toVersion: (collection, doc) → doc | ABSENT}`. These are pure, deterministic functions, run at open when `local_schema_version < version`, in one transaction that:
- transforms current documents **and** pending `before` values, so the base stays "head, in the new shape";
- recomputes `base_digest` from `baseState()`;
- is not journaled. Untouched documents are not republished.

### 17.4 Ingestion migrations

Values arriving in commits or checkpoints with `schemaVersion < version` go through the same migration chain before merging. Documents on the server may therefore be in mixed shapes. Every reader normalizes on read, and every checkpoint written by a newer build is uniform.

---

## 18. Backend contract

### 18.1 Interface

```dart
abstract interface class SyncBackend {
  /// Current head, or null when the account has never committed.
  Future<Head?> head();

  /// Commits with revision in (after, upTo], ascending, at most [limit] per call.
  /// Throws HistoryUnavailable if any commit in that range was compacted.
  Future<List<Commit>> commits({required int after, required int upTo, int limit = 200});

  /// Compare-and-swap publish. MUST be idempotent on request.commitId.
  Future<SubmitResult> submit(CommitRequest request);

  Future<Checkpoint?> checkpoint({required int atOrBefore});
  Future<void> putCheckpoint(Checkpoint checkpoint);          // idempotent per revision

  Future<List<RestorePoint>> restorePoints();
  Future<void> putRestorePoint(RestorePoint point);
  Future<void> deleteRestorePoints(List<RestorePointKey> keys);

  /// Deletes commits with revision <= anchor and checkpoints with revision < anchor.
  /// MUST refuse unless a checkpoint exists at exactly [anchor] and no pinned restore point precedes it.
  Future<void> compact({required int anchor});

  /// Optional. Fires when head may have moved. Carries no data.
  Stream<void>? get hints;
}

sealed class SubmitResult {}
class Accepted extends SubmitResult { final int revision; }
class Conflict extends SubmitResult { final int headRevision; }
class Rejected extends SubmitResult { final RejectReason reason; }   // schemaTooOld | invalid | quotaExceeded
```

### 18.2 Errors

Adapters translate every failure into one of:
- `Transient`: retry with backoff;
- `AuthRequired`;
- `HistoryUnavailable`;
- `Fatal(code, message)`.

The core never inspects vendor exceptions.

### 18.3 Wire format

```json
{
  "commitId": "0192b5e4-7c1a-7d3e-9f10-2b6c8a4e1f00",
  "parent": 183,
  "schemaVersion": 3,
  "compatibleSince": 2,
  "deviceId": "3f1c…",
  "deviceLabel": "Pixel 8",
  "clientTime": 1759140000000,
  "message": null,
  "stateDigest": "9f2c…64 hex…",
  "changes": [
    { "collection": "tasks",  "id": "t42", "op": "put",    "group": 0, "value": { "title": "…" } },
    { "collection": "boards", "id": "b1",  "op": "put",    "group": 0, "value": { "name": "…" } },
    { "collection": "journal","id": "j7",  "op": "delete", "group": 1 }
  ]
}
```

- A stored `Commit` adds `"revision"` and `"committedAt"` (server time, display only).
- Changes carry after-values only. The receiver reconstructs its own base (7.4), so before-images never need to cross the wire.
- `clientTime` and `deviceLabel` are display metadata and are never used for ordering.

### 18.4 Required server semantics

`submit` performs these steps, in this order, atomically:

1. Authenticate. The account is derived from the session and never taken from the request.
2. **Idempotency:** if `commitId` already exists for the account, return `Accepted(its revision)`. This check comes before everything else.
3. Lock the head, or create it if absent and `parent == 0`.
4. **Schema gate:** `schemaVersion < head.minVersion` → `Rejected(schemaTooOld)`.
5. **CAS:** `parent != head.revision` → `Conflict(head.revision)`.
6. Insert the commit at `head.revision + 1`. Update the head (`revision`, `stateDigest`, `schemaVersion`, `minVersion = max(minVersion, compatibleSince)`).
7. If `message` is set, insert a `commit` restore point.
8. Return `Accepted(revision)`.

Other server guarantees:
- revisions are dense and strictly increasing;
- a commit appears atomically or not at all;
- `putCheckpoint` verifies the digest against the commit at that revision (15.2);
- `compact` enforces its invariants (15.3);
- hints never carry document data.

### 18.5 Firestore feasibility (for a later adapter)

- The head document is updated in a transaction for CAS and idempotency.
- Commits live in a subcollection keyed by revision.
- Checkpoints are chunked to respect the 1 MB document limit (internal to the adapter).
- Compaction invariants are enforced by a callable function.
- Hints come from a snapshot listener on the head document.

The contract needs nothing Firestore lacks.

---

## 19. Supabase reference adapter

### 19.1 Schema

```sql
create table public.ent_heads (
  user_id        uuid primary key references auth.users on delete cascade,
  revision       bigint not null,
  schema_version int    not null,
  min_version    int    not null,
  state_digest   text   not null,
  updated_at     timestamptz not null default now()
);

create table public.ent_commits (
  user_id          uuid   not null references auth.users on delete cascade,
  revision         bigint not null,
  commit_id        uuid   not null,
  parent           bigint not null,
  schema_version   int    not null,
  compatible_since int    not null,
  state_digest     text   not null,
  device_id        text   not null,
  device_label     text,
  client_time      bigint,
  message          text,
  changes          jsonb  not null,
  committed_at     timestamptz not null default now(),
  primary key (user_id, revision),
  unique (user_id, commit_id)
);

create table public.ent_checkpoints (
  user_id        uuid   not null references auth.users on delete cascade,
  revision       bigint not null,
  schema_version int    not null,
  state_digest   text   not null,
  entities       jsonb  not null,
  created_at     timestamptz not null default now(),
  primary key (user_id, revision)
);

create table public.ent_restore_points (
  user_id      uuid   not null references auth.users on delete cascade,
  revision     bigint not null,
  kind         text   not null,
  label        text,
  pinned       boolean not null default false,
  device_label text,
  created_at   timestamptz not null default now(),
  primary key (user_id, revision, kind)
);
```

### 19.2 Access rules

- **RLS:** `select` own rows on all four tables. **No insert, update or delete policies.** Clients cannot write these tables directly.
- **Writes go only through RPCs:** `ent_submit(p_request jsonb)`, `ent_put_checkpoint(p_checkpoint jsonb)`, `ent_put_restore_point(...)`, `ent_delete_restore_points(...)` and `ent_compact(p_anchor bigint)`. These are `security definer`, use `set search_path = ''` with fully qualified names, derive the user from `auth.uid()`, and enforce 18.4 and 15.3.
  - This is stricter than Quadra's `security invoker` design: a buggy or old client cannot bypass CAS, the schema gate or the compaction invariants.
- **Privileges:** `revoke execute … from public, anon`; `grant execute … to authenticated`.
- **Naming:** `RETURNS TABLE` columns are prefixed `out_` (for example `out_status`, `out_revision`). This avoids the column-name ambiguity that left Quadra's `commit_snapshot()` unfinished.

### 19.3 Hints

`ent_heads` is added to the `supabase_realtime` publication. It contains only revision metadata, so no user data travels on the socket. The adapter subscribes filtered by `user_id` and refreshes the socket's auth token whenever the session refreshes.

### 19.4 Conformance

The adapter must pass the shared contract suite (23.4) against a local stack started with `supabase start`, not only against production.

---

## 20. Scheduling and reliability

- **Single flight.** The leader runs one engine queue. Cycles, restores, overwrites and account switches are serialized. A trigger arriving mid-cycle sets a rerun flag, which collapses to one extra cycle. Local resolutions and writes never wait for the network.
- **Cycle order.** Resolve the in-flight commit, then pull, then push. Checkpoint or compaction work runs afterwards if due, at low priority, and is skipped when offline.
- **Retry.** Exponential backoff with jitter: 1 s, 2 s, 4 s … up to 5 min, reset on success. `AuthRequired` pauses until the account source emits.
- **Offline.** Writes never touch the network. The overlay is durable. `problem = offline` is informational.
- **Idempotency.** Commit ids plus the durable in-flight record (11.2). Checkpoints are idempotent per revision, restore points per `(revision, kind)`.
- **Lifecycle.** The Flutter package forwards resume and pause. Timers stop in the background. Resume triggers a check (VCS) or a cycle (realtime).
- **Bounded loops.** The push/pull CAS retry is limited to 5 rounds per cycle, then backs off. Two realtime devices therefore cannot livelock.

---

## 21. Application API (Dart sketch)

```dart
final db = await EntanglementDb.open(
  path: 'quadra.sync.db',
  schema: Schema(
    version: 1, compatibleSince: 1,
    collections: [boards, tasks, completions, triage, journal, categories, settings, deviceSettings],
    migrations: {},
  ),
  backend: SupabaseSyncBackend(client),          // also provides AccountSource
  options: SyncOptions(
    defaultMode: SyncMode.vcs,                   // used until the user picks one
    vcs: VcsOptions(conflictPolicy: ConflictPolicy.ask, autoPushEvery: null,
                    remoteCheckEvery: Duration(minutes: 5)),
    realtime: RealtimeOptions(conflictPolicy: ConflictPolicy.preferRemote,
                              debounce: Duration(seconds: 2), maxDelay: Duration(seconds: 10),
                              poll: Duration(seconds: 60)),
    history: HistoryOptions(keepRestorePoints: 10, dailyRestorePoints: true, localBackups: 3),
    deviceLabel: 'Pixel 8',
  ),
);

// Data
await db.write((tx) async { ... });
db.query(tasks).where('boardId', isEqualTo: id).watch();
db.changes;                                     // Stream<ChangeEvent> with origin

// Sync
db.sync.status;                                 // Stream<SyncStatus>
db.sync.setMode(SyncMode.realtime);
db.sync.push(message: 'Before the trip');
db.sync.pull();
db.sync.sync();
db.sync.discardLocalAndPull();
db.sync.overwriteRemoteWithLocal();
db.sync.switchAccount(discardUnpublished: false);

// Conflicts
db.conflicts.watch();                           // Stream<List<ConflictUnit>>
db.conflicts.resolve(unitId, Resolution.keepLocal);
db.conflicts.log();
db.conflicts.reinstate(logEntryId);

// History
db.history.restorePoints();
db.history.mark('Cleaned up boards', pinned: true);
db.history.restore(point);
db.history.localBackups();
db.history.restoreLocalBackup(id);
```

---

## 22. Portability and conformance

### 22.1 Normative artifacts

```text
spec/
  README.md                    # sections 5–19 of this document, kept in sync
  vectors/
    canonical_json.json        # value → canonical string (JCS edge cases: numbers, escapes, key order)
    digest.json                # [collection, id, value] → entityHash; states → stateDigest; update sequences
    overlay.json               # sequences of writes/commits → expected ent_pending rows (incl. in-flight cases)
    decide.json                # base/local/remote/policy → decision
    units.json                 # touched sets + groups + refs → units, conflicts, integrity unions
    relation.json              # status inputs → relation
    scenarios/*.json           # scripted multi-device runs → expected final states per device
  packages/entanglement_supabase/supabase/migrations/0001_entanglement.sql
```

### 22.2 Porting to React Native

| Dart | TypeScript |
|---|---|
| `entanglement` | `@sync/core`: same module boundaries, same pure functions |
| `SqlExecutor` over `package:sqlite3` | `SqlExecutor` over `op-sqlite` (JSI, synchronous available) |
| `sealed class` / `switch` | discriminated unions / `switch (x.kind)` |
| `Stream<T>` | `subscribe(cb) → unsubscribe` (plus RxJS/hooks sugar in the RN package) |
| `Future<T>` | `Promise<T>` |
| `entanglement_supabase` | `@sync/supabase` against the same SQL |
| `Collection<T>` with codecs | same shape; codecs are plain functions |

A port is done when every vector passes and the scenario suite converges against the same local Supabase stack as the Dart implementation.

---

## 23. Testing

### 23.1 Vectors

Pure functions run against `spec/vectors` in both implementations.

### 23.2 Engine tests

These use in-memory SQLite and the `InMemoryBackend`, which is also the reference implementation of 18.4. They cover:
- every relation transition;
- every push outcome, including an edit during upload and an undo during upload;
- pull fast-forward;
- incremental versus full-state pulls, which must agree;
- integrity unions;
- each resolution;
- sync-log reinstate;
- restore under concurrent commits;
- compaction racing a reader;
- account switch;
- passive-connection writes;
- local and ingestion migrations.

### 23.3 Simulation harness

This is the most important test investment. It is deterministic and seeded:
- N devices, each with its own database and scheduler, share one `InMemoryBackend`.
- The backend has fault injection: drop request, drop response after commit, duplicate delivery, delay or lose hints, compact at random.
- Devices perform random operations from a small app schema that has references and aggregates, sync at random, switch modes, restore, and resolve conflicts.
- Crash points are injected through an `SqlExecutor` wrapper: after the in-flight record is written, after server acceptance but before the local acknowledgement, and mid-apply.

After quiescence under automatic policies, it asserts:
- all devices have identical state digests;
- every reference is valid on every device;
- every value that was ever committed is either in the final state or in the sync log / restore history;
- revisions strictly increase;
- no commit id is applied twice;
- mode switches never change document state.

### 23.4 Adapter conformance

One suite runs against `InMemoryBackend` and every adapter (local Supabase first). It covers:
- idempotent submit, including submitting the same id after acceptance;
- CAS;
- the schema gate;
- dense revisions;
- `HistoryUnavailable` after compaction;
- checkpoint digest verification;
- the compaction invariants;
- the hint subscription;
- RLS isolation between two accounts.

---

## 24. Package layout

```text
sync_framework/
├── spec/                    # normative spec, vectors, reference SQL (22.1)
├── packages/
│   ├── entanglement/           # pure Dart: store, overlay, merge, engine, scheduler, InMemoryBackend
│   ├── entanglement (lib/sqlite.dart)/         # SqlExecutor over package:sqlite3
│   ├── entanglement_supabase/       # SyncBackend + AccountSource for Supabase
│   └── entanglement_flutter/        # lifecycle wiring, sqlite3_flutter_libs, optional status/conflict widgets
└── tools/
    └── simulator/           # multi-device simulation harness (23.3)
```

---

## 25. Adopting it in Quadra

> **Done (2026-09).** Both Quadra clients run on Entanglement. The one-time migration code described below has been removed; this section is kept as the record of how the adoption was planned. Current behaviour is in how-it-works.md §15.

### 25.1 Collections

| Quadra data | Collection | Sync | Merge | References |
|---|---|---|---|---|
| Boards (quadrants and sections nested) | `boards` | yes | `fieldwise`, `{quadrants, sections}` as one group | — |
| Tasks (subtasks nested) | `tasks` | yes | `fieldwise`, `{completed, lastCompleted, subtasks}` grouped | board (with quadrant/section check); category |
| Completion history | `completions` | yes | `wholeDocument` | none (history outlives deleted tasks) |
| Triage inbox | `triage` | yes | `fieldwise` | — |
| Journal | `journal` | yes | `fieldwise` | — |
| Categories | `categories` | yes | `wholeDocument` | — |
| Display prefs that belong to the user (show dates, category chips, strikethrough, hide completed) | `settings` singleton `id: "settings"` | yes | `fieldwise` | — |
| Layout prefs tuned to a screen (grid gap, quadrant min height), focus settings | `deviceSettings` singleton | **no** | — | — |

Notes for the port:
- **Board order** stays as a `position` field on each board. A reorder is one transaction, so its writes are coupled.
- **Board ids on tasks.** If tasks do not currently store their board id, add it during import so the quadrant reference can be checked.
- **Cascades.** Deleting a category or quadrant must clear or move the references in the same transaction. Write-time integrity will surface any place Quadra currently leaves ids dangling.
- **Tombstones go away.** `deletedAt`, `revision` and `SyncOutboxEntries` disappear; deletions are real deletes locally and recorded in commits.
- **Reminders and completion feedback** use `ChangeEvent.origin` (8.2) instead of diffing snapshots.
- **Home-widget isolate.** It opens `EntanglementDb` as `SyncRole.passive` (8.3).
- **Web.** If Quadra ships a web build, the SQLite WASM executor must exist before adopting the framework.

### 25.2 Migration without data loss (R9)

1. **Ship Quadra's snapshot sync first**, so every device converges on one cloud state. That work is nearly done, and it protects the data in the meantime.
2. **Before installing the framework build anywhere, sync every device** on the snapshot build.
3. **First launch of the framework build** imports the Drift database into framework collections in one local transaction (origin `migration`). Because base is 0, everything is pending. The Drift file is kept untouched as a fallback for at least two releases.
4. **First device:** the framework remote is empty, so the first push publishes the import as revision 1. Its message records the legacy snapshot version it came from.
5. **Every other device:**
   - If its data is clean against its legacy snapshot base (the hash matches), it **discards its import** and bootstraps from the framework remote. Its data is already in revision 1.
   - If it was dirty, it merges its import against the framework remote with base 0. Identical documents merge cleanly, and real differences appear as conflict units.
6. `user_snapshots`, `snapshot_history` and `sync_changes` are dropped in a later server migration, once no old build remains.

---

## 26. Implementation phases

Each phase ends with its tests green. No phase depends on UI work.

| Phase | Contents | Exit criteria |
|---|---|---|
| **1. Local store** | Collections, documents, JCS, unknown-field carry-over, indexes, queries, watch, change events, transactions, groups, overlay and coalescing, refs with write-time integrity, local-only collections, local migrations, passive connections. | Vectors: `canonical_json`, `overlay`. Store tests. |
| **2. Protocol and VCS** | Digest, backend contract, `InMemoryBackend`, push with in-flight handling, pull (incremental and full-state), decide, units, integrity passes, held conflicts, resolutions, sync log, status/relation, schema gate, VCS operations, blunt instruments, account lifecycle. | All vectors. Simulation harness converges with 3 devices under fault injection. |
| **3. Supabase adapter** | SQL, RPCs, RLS, hints, auth wiring. | Conformance suite green on local Supabase and on `InMemoryBackend`. |
| **4. History** | Restore points, checkpoints with verification, compaction, `stateAt`, restore, local backups, bootstrap from checkpoint. | Simulation with random compaction and restores. |
| **5. Realtime** | Scheduler triggers, debounce/maxDelay, hints, poll, daily points, mode switching. | Simulation mixing modes. Two physical devices over a week of normal use. |
| **6. Quadra adoption** | Section 25. | Every device migrated; old tables dropped. |
| **Later** | TypeScript port; Firebase adapter; ingestion-migration tooling polish; web executor; Rust consolidation if two implementations become a burden. | — |

---

## 27. Requirements traceability

| Requirement | Satisfied by |
|---|---|
| R1 two modes | 14 |
| R2 explicit push/pull, app-defined autosave | 14.1 (`push`, `pull`, `autoPushEvery`, remote awareness without applying) |
| R3 user-resolved three-way merge | 12, 13 (`ask` default in VCS; base / mine / theirs per unit) |
| R4 keep last N states | 15.1 restore points (`keepRestorePoints`), 15.6 local backups |
| R5 realtime keeps VCS capabilities | 14 (same machinery), 13.4 reversible log, 15 history in both modes |
| R6 one-setting switch | 14.3 |
| R7 backend-agnostic | 18 contract, 18.5 Firestore feasibility, 23.4 conformance suite |
| R8 Flutter now, RN later | 3, 22 |
| R9 lossless adoption | 25.2, 15.6, 16.2 |

---

## 28. Changes from v2

| v2 | v3 | Why |
|---|---|---|
| Rust core, FFI, Flutter and RN bindings in v1 | Pure-Dart core; portability through a normative spec, shared vectors and a mechanical port | The Rust cost is paid up front, and pays off only once a second language exists. Rust remains possible behind the same spec. |
| Typed field schema materialized into SQLite columns; typed query layer unspecified | JSON documents, generated index columns, a small query builder with watch | Removes DDL generation, local column migrations and an ORM. Aggregates become natural. Unknown fields become free. |
| "Atomic change sets", but merges per entity | Coupling groups from transactions and commits; merges and conflicts per unit | Merging entities independently could produce states no device ever had. |
| No referential integrity | References validated on write and after every merge, with a termination proof | Dangling references were the main failure of Quadra's old log. |
| Coalescing unspecified with respect to grouping and uploads | Groups relabel on coalesce; in-flight rows are never eliminated; `before` is advanced on acceptance | Closes a silent divergence when an edit is undone mid-upload. |
| Realtime default "commit made later wins" | `preferRemote` ("first committed wins"), configurable; every automatic decision goes into a synced, reversible sync log | The retrying device always commits last, so v2's rule meant a stale offline device overwrote newer work. |
| Per-collection `realtime / manual / local` policies | One mode per device, plus `sync: false` collections | A transaction spanning collections in different modes cannot be atomic. |
| Server-side force overwrite | None. Overwrite and restore are target-state applications through normal CAS | Smaller trusted server surface; one code path. |
| A checkpoint at each VCS commit as a retention policy | Restore points are labels on revisions; checkpoints are compaction anchors | Keeps "last N states" without O(data) per commit. |
| Tombstone retention; resurrection risk for long-offline devices | The full-state fallback is an exact three-way merge using the reconstructed base | Nothing to retain, nothing resurrects. |
| Strict schema version ordering | `version` + `compatibleSince`, head `minVersion`, defined unknown-field carry-over, local and ingestion migrations | Additive releases no longer force lockstep updates. |
| No divergence detection | An additive state digest on every commit and checkpoint, verified on every pull, with self-healing recovery | Sync bugs show up immediately instead of after data drifts. |
| Error and retry mixed into relation states | Relation / activity / problem are separate | Apps can render each independently. |
| Single-process ownership assumed | Multiple connections are safe; one sync leader; passive instances | Quadra's widget isolate writes data. |
| — | `ChangeEvent.origin` | Apps must not fire side effects (reminders, completion feedback) for pulled changes. |
| Server writes through invoker functions and table policies | Definer RPCs only; no table write policies; `out_`-prefixed result columns | Clients cannot bypass CAS or retention invariants. Avoids the Quadra RPC ambiguity. |
| Firebase adapter in v1 | Deferred; contract checked for Firestore feasibility | One real adapter plus the in-memory reference keeps the contract honest without doubling v1. |

---

## 29. Deferred

- TypeScript/React Native implementation (22.2).
- Firebase adapter (18.5).
- Web target through SQLite WASM. **Required before Quadra's web build adopts Entanglement** (Quadra ships a web target); see the README's known gaps.
- Background-isolate executor.
- Code generation for typed collections.
- Character-level merge for long text fields (journal bodies). v1 treats them as a field-level conflict.
- Sharing data between accounts.
- End-to-end encryption of payloads, which the digest and wire format are compatible with.
- A Rust core replacing both implementations.
