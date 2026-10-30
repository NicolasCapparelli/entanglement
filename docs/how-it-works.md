# How Entanglement works (and how Quadra uses it)

**Read this first.** It explains every moving part of Entanglement, the local-first sync framework, and how the two Quadra clients are built on it. It goes from the big picture down to the details, so you can stop once you know enough for your task. Section numbers are stable; link to them.

When you need the formal rule behind something, the normative design is [design.md](design.md). Code comments cite it as "spec §N". This guide explains *how it all fits together*; the design explains *what must be true and why*.

---

## Contents

1. [The idea in two minutes](#1-the-idea-in-two-minutes)
2. [Where everything lives](#2-where-everything-lives)
3. [Vocabulary](#3-vocabulary)
4. [The life of a write](#4-the-life-of-a-write)
5. [The life of a push](#5-the-life-of-a-push)
6. [The life of a pull](#6-the-life-of-a-pull)
7. [Conflicts](#7-conflicts)
8. [Modes and scheduling](#8-modes-and-scheduling)
9. [History, restore and backups](#9-history-restore-and-backups)
10. [Accounts, first launch and importing](#10-accounts-first-launch-and-importing)
11. [Schema evolution](#11-schema-evolution)
12. [The server](#12-the-server)
13. [On-device storage](#13-on-device-storage)
14. [Two implementations, one protocol](#14-two-implementations-one-protocol)
15. [Entanglement in Quadra](#15-entanglement-in-quadra)
16. [Testing](#16-testing)
17. [Common tasks](#17-common-tasks)
18. [Rules and gotchas](#18-rules-and-gotchas)

---

## 1. The idea in two minutes

Every device keeps a **complete local database** and works on it directly. Nothing ever waits for the network. Sync is a protocol layered on top, and it works like a single-branch **git**:

| git | Entanglement |
|---|---|
| working tree | the local database |
| uncommitted changes | the **pending overlay**: what changed locally since the last sync |
| `HEAD` of the remote | the **head**: the account's latest **revision** on the server |
| the commit you last pulled | the **base**: the revision this device last agreed with |
| `git push` | **push**: publish the pending changes as one **commit** (refused if someone pushed first) |
| `git pull` | **pull**: fetch newer commits and **three-way merge** them into local data |
| merge conflict | **conflict unit**: held until someone chooses a side |
| tags | **restore points** |

There are two **modes**, and they differ only in *when* things happen:

- **VCS mode:** nothing leaves or arrives until you push or pull, or an autosave timer does. You're told when the cloud has newer changes.
- **Realtime mode:** changes push a moment after you make them, and pull as soon as the server says something moved. Conflicts resolve by a policy, and every automatic decision is logged and can be undone.

Switching mode is one call and never touches data.

What makes it trustworthy:

- **The server orders everything.** Revisions are assigned by the server, never taken from device clocks.
- **Every commit is compare-and-swap.** It says which revision it was built on, and the server refuses it if the head has moved. The device then pulls, merges, and tries again. Nothing is ever silently overwritten.
- **The base is exact.** Each pending change remembers the value it replaced, so the device can always reconstruct the precise state at its base revision. That makes three-way merges correct even after months offline.
- **Merges keep related data together.** Documents changed in one transaction merge or conflict *as a unit*, and references between documents (a task's board) are checked after every merge. A merge can't produce a state no device ever had.
- **Every state is fingerprinted.** Each commit carries a digest of the whole state it produces. A device that ends up with a different state detects it immediately and repairs itself.

## 2. Where everything lives

```
Projects/
├── Entanglement/                    ← the framework (this repository)
│   ├── docs/                        how-it-works.md (this), design.md, supabase-setup.md
│   ├── packages/                    Dart
│   │   ├── entanglement/            the core (pure Dart): store, engine, merge, protocol, in-memory server
│   │   ├── entanglement_flutter/    Flutter glue: open the database file (native + web), app lifecycle
│   │   └── entanglement_supabase/   Supabase backend + the server SQL
│   ├── ts/packages/                 TypeScript (npm workspace)
│   │   ├── core/                    @entanglement/core: the same core; sql.js executor
│   │   └── supabase/                @entanglement/supabase: the same Supabase backend
│   ├── spec/vectors/                data files both implementations must reproduce exactly
│   └── tool/vendor.mjs              copies the framework into an app
│
├── quadra-app/                      ← Quadra, Flutter (mobile, desktop, web)
│   ├── vendor/entanglement/         vendored copy of the Dart packages + these docs
│   ├── supabase/migrations/0002_entanglement.sql   vendored server SQL
│   └── docs/                        quadra-sync-schema.md, supabase.md, fixtures/
│
└── quadra/                          ← Quadra, Obsidian plugin (TypeScript)
    ├── vendor/entanglement/         vendored npm tarballs (built) + these docs
    └── docs/                        copies of the schema doc + fixture
```

### Why vendoring

Each app must build and ship on its own, so apps never point at `Projects/Entanglement`. They **carry a copy**:

- **Dart apps** get the package **sources**. Dart has no compiled package format; source is how pub packages ship. The app depends on them by path (`path: vendor/entanglement/entanglement`) and excludes `vendor/**` from its analyzer.
- **TypeScript apps** get **built npm tarballs** (`dist/` JavaScript + `.d.ts` types). The app installs them from its own folder (`"@entanglement/core": "file:vendor/entanglement/…tgz"`). Tarballs install as real copies rather than links, so the app has exactly one copy of shared dependencies such as supabase-js. Two copies of the Supabase client class would fail TypeScript's type checks.

Updating an app is always the same routine: change Entanglement, run `node tool/vendor.mjs …` (§17), re-resolve dependencies in the app, run its tests, and commit. Every vendored folder has a `VENDORED.md` saying exactly which Entanglement commit it came from. **Never edit vendored files.**

## 3. Vocabulary

| Term | Meaning |
|---|---|
| **Document** | The unit of data: a JSON object identified by `(collection, id)`. Anything that must change atomically is one document (a board with its quadrants; a task with its subtasks). |
| **Collection** | A named set of documents with one set of rules: which fields this build knows, indexes for queries, references, merge policy, and whether it syncs at all (`sync: false` = device-local). |
| **Canonical JSON** | RFC 8785 encoding: sorted keys, ECMAScript number formatting. Every comparison uses it, so "equal" means byte-equal. A Dart `1.0` and a JavaScript `1` are the same value. |
| **Revision** | A server-assigned, gap-free counter per account. Revision 0 is the empty state. |
| **Head** | The account's latest revision, plus its state digest and schema gate. |
| **Base** | The revision this device last agreed with, plus the digest of that state. |
| **Pending overlay** | One row per document that differs from its base value. Each row stores the document's `before` value (its value at base). |
| **Coupling group** | Documents written in one transaction are coupled: they publish together and merge or conflict together. Coupling is transitive until published. |
| **Commit** | One publication: every publishable pending change, with its coupling groups, advancing the head by exactly one revision. |
| **State digest** | The sum (mod 2^256) of SHA-256 hashes of every live document. Being additive, it updates in O(changes). Every commit and checkpoint carries one. |
| **Relation** | How this device stands against the cloud: `upToDate`, `localAhead`, `remoteAhead`, `diverged`, `conflicted`, `remoteEmpty`, `signedOut`, `accountMismatch`, `remoteSchemaTooNew`. |
| **Conflict unit** | A group of documents both sides changed incompatibly (or that would break a reference), held until resolved. |
| **Sync log** | A *synced* collection (`ent_sync_log`) recording every conflict decision and the values it discarded, so any decision can be undone from any device. Keeps the newest 200 entries, plus any from the last 90 days. |
| **Checkpoint** | A complete state at one revision, stored so new devices bootstrap without replaying history, and so old commits can be deleted. |
| **Restore point** | A label on a revision ("Before the trip", "Daily 2026-09-29"). Restoring recreates that state as a *new* commit. |
| **Local backup** | A full copy of this device's synced data, saved before any action that discards unpublished changes. Local only. |

## 4. The life of a write

App code never touches SQLite. Everything goes through a transaction:

```dart
await db.write((tx) async {
  await tx.put(tasks, task);                       // insert or replace
  await tx.patch(boards, boardId, {'name': 'Work'});
  await tx.delete(notes, noteId);
});
```
```ts
await db.write(async (tx) => { await tx.put(tasks, task); });
```

Step by step, inside `EntanglementStore.transact` / `StoreTxn.put` (`store.dart` / `store.ts`):

1. **One SQLite transaction** (`BEGIN IMMEDIATE`) opens, behind the store's lock. All database access is serialised, so a transaction never sees another half-done.
2. **Unknown fields are carried over.** If the stored document has top-level keys this build doesn't declare in the collection's `fields`, they're copied into the new value. An older build (or another client) editing a document never strips a field it doesn't understand.
3. **The value is encoded as canonical JSON and written** to the collection's table (`c_<collection>`). Writing an identical value is a no-op. The reference index `ent_refs` is updated from the collection's `refs` function.
4. **The pending overlay is updated** (synced collections only):
   - **First change since base:** a pending row is created with `before` = the old value.
   - **Already pending:** the row keeps its original `before`, and its coupling group merges with this transaction's group.
   - **Back to the base value** (an edit, then an exact undo): the row is deleted. Nothing is left to publish.
5. **References are checked** at the end of the transaction, not per statement. If any document now points at a missing target, or a target was deleted while still referenced, the whole transaction rolls back with `IntegrityViolation`. **Cascades are the app's job:** delete the tasks in the same transaction as their board.
6. **After commit, a change event fires**, listing the collections and keys touched and an **origin**: `local`, `remote`, `resolution`, `restore`, `migration` or `external`. Queries being watched re-run. The sync engine counts pending changes and, in realtime mode, schedules a push.

**Rules inside a transaction:**
- Only await `tx` calls.
- Use `tx.get` and `tx.query`, not `db.get` and `db.query`, which wait for the transaction you're in. Dart detects this and fails fast; JavaScript can't, and logs a warning after 5 seconds.

**Reads** (`db.get`, `db.query(c).where(...).orderBy(...).get()`, `.watch()`) are always local. `where` and `orderBy` accept any top-level field. Declared `indexes` become generated SQLite columns with indexes, which only makes them faster.

**Other connections:** a second instance on the same file, such as a home-screen widget's background isolate, opens as `SyncRole.passive`. It writes normally, journaled in the same database. The main (leader) instance notices through `PRAGMA data_version` (`checkForExternalChanges`, called on app resume) and publishes those writes.

## 5. The life of a push

`push()` (`engine.dart` / `engine.ts`, "Push (spec §11)"):

1. **Resolve any in-flight commit first** (see step 5).
2. **Choose what to publish:** every pending row, except those held by an unresolved conflict *and anything that depends on held data*. The engine validates references against the state the commit would produce, where held documents stay at their cloud value, and holds back any group that would break one. (A task created on a board whose deletion is still in conflict can't publish before the board is settled.)
3. **Build the commit:**
   - the changes (new values only; the server never needs the old ones);
   - the coupling groups;
   - `parent` = this device's base revision;
   - the new state digest (base digest − hashes of the old values + hashes of the new);
   - schema version, device label, optional message.
4. **Record it as in flight, durably, before sending** (`ent_inflight`). Every included pending row is marked with the sequence number it had.
5. **Submit and settle:**
   - **Accepted at revision N:** each included row is dropped if unchanged since it was marked. If it was edited again during the upload, its `before` becomes the committed value, so the newer edit stays pending on top. Base = (N, the commit's digest).
   - **Conflict** (someone else committed first): clear the in-flight marks, **pull and merge** (§6), and try again, up to 5 rounds.
   - **Rejected:** schema too old, or invalid. It stops and reports.
   - **No answer** (offline, timeout, lost response): the in-flight record stays. The next attempt resends *the identical commit*. The server recognises the commit id, and a commit the server already accepted is simply acknowledged. Nothing is ever committed twice.

While a row is in flight it's never deleted by the "back to base" rule. Otherwise an undo made mid-upload would be lost: the server would hold the edit while the device thought nothing was pending.

## 6. The life of a pull

`pull()` (`engine.dart` / `engine.ts`, "Pull (spec §12)"):

1. **Ask for the head** (a cheap metadata read). No head: the account is empty. Head schema too new for this build: stop, and report `remoteSchemaTooNew`. Head = base: nothing to do.
2. **Fetch what changed since base:**
   - **Normally:** the commits after base.
   - **If history was compacted past base** (a long-offline device): the **full state** at head, from the newest checkpoint plus the commits after it.

   Both are correct, because this device can reconstruct its exact base state: current values, with each pending row's `before` swapped back in. "Present at base, absent now" means deleted remotely. Nothing resurrects.
3. **Verify:** base digest + the remote changes must equal the head's digest. If not, this device's base was wrong somehow. It redoes the pull from full state, which rebuilds the base exactly. If even that doesn't match, the server copy is inconsistent, and sync stops and reports it.
4. **Decide each touched document** (every locally pending document, plus every remotely changed one), with B = base, L = local, R = remote:

   | Situation | Result |
   |---|---|
   | L = R | nothing to do |
   | only remote changed (L = B) | take remote |
   | only local changed (R = B) | keep local |
   | one side deleted, the other edited | conflict (`deleteVsEdit`) |
   | both changed | the collection's **merge policy**: `wholeDocument` → conflict; `fieldwise` → per top-level key (or declared group of keys) take whichever side changed, conflict only if the same key changed differently; `custom` → the app's function |

5. **Form units.** Documents coupled locally (same group) or remotely (same group within a commit) are joined into units. A unit is *clean* if none of its documents conflict.
6. **Integrity pass.** Tentatively apply every clean unit, keeping local values for conflicted ones, and check references. Any document now pointing at nothing joins its target's unit, and that unit becomes a conflict with reason `integrity`. Repeat until stable. This always terminates in a valid state: in the worst case one unit takes an all-local or all-remote side, and both of those were valid.
7. **Apply the conflict policy** to newly conflicted units:
   - `ask` → hold them;
   - `preferRemote` → take the cloud's side;
   - `preferLocal` → keep this device's side.

   Automatic choices are written to the **sync log** with the values they replaced.
8. **Rebase, in one transaction.** Write the merged values. Then rewrite the pending overlay relative to the *new* head: a document still differing from head stays pending, with `before` = its head value; everything else is clean. Held units keep their rows, marked, and get conflict records (ancestor, local, remote). Base = head.

After a pull, "pending" means exactly "what this device has that the head doesn't", which is what the next push publishes.

## 7. Conflicts

A **held** unit stays on the device. Everything not coupled to it keeps syncing. The app shows `conflictCount` and the units (`conflicts()`), each entry carrying **ancestor**, **local** and **remote** values, so a UI can show base / mine / theirs.

Resolving (`resolve(unitId, …)`):

- **keepLocal:** unmark the unit; its values publish on the next push.
- **keepRemote:** write the cloud's values locally; the pending rows cancel out.
- **custom:** write the given value for every entry.

Every resolution is recorded in the **sync log**. `reinstate(logEntryId)` writes the discarded values back as an ordinary edit, which then syncs.

Policies are per device and per mode (`setConflictPolicy`). Defaults:

| Mode | Default policy | Why |
|---|---|---|
| VCS | `ask` | The user is present and explicitly syncing. |
| Realtime | `preferRemote` ("first committed wins") | The retrying device always commits last. A "last writer wins" rule would let a phone that was offline for a week silently overwrite a week of work. The cloud's version is what other devices already have. Every automatic decision can be undone from the log. |

## 8. Modes and scheduling

Everything the engine does goes through **one queue**, so pushes, pulls, restores and account switches never overlap. Local writes never wait for it.

| | VCS | Realtime |
|---|---|---|
| After a local edit | nothing (the status shows pending changes) | push after 2 s of quiet, at most 10 s after the first edit |
| Remote changes | checks the head every 5 min and on resume (metadata only); **never applies without a pull** | server hint (Supabase Realtime) → pull after 0.5 s; also polls every 60 s, and on resume |
| Autosave | optional `autoPushEvery` | built in |
| Restore points | every user-initiated push, plus one daily | one daily |

`sync()` = pull, then push. Failures in automatic cycles retry with exponential backoff (1 s … 5 min). `resume()` and `pause()` hook into the app lifecycle: pause makes realtime mode attempt a final push. `setMode` is persisted per device and takes effect immediately.

## 9. History, restore and backups

- **Restore points** are labels on revisions. They store no data, so they're cheap. Kinds: `commit`, `daily`, `manual` (`mark(label)`), `beforeRestore`, `beforeOverwrite`. The newest 10 unpinned are kept, plus every pinned one.
- **Checkpoints:** after a successful cycle, when 200 commits have passed since the last checkpoint (or it's 30 days old), the device uploads its exact base state as a checkpoint. The server accepts it only if its digest matches the commit at that revision. Then it **compacts**: deletes commits and checkpoints older than the newest checkpoint that still covers the oldest retained restore point. **Pinned restore points block compaction past them.**
- **Restore** (`restore(point)`): back up unpublished local changes, label the current head `beforeRestore`, rebuild the state at that revision, write it as ordinary local changes, and push. The revision counter never goes back; other devices just pull. If someone commits meanwhile, it pulls and re-applies the target.
- **Overwrite the cloud with this device** (`overwriteRemoteWithLocal`): the same mechanism, with this device's current state as the target.
- **Discard local changes and pull** (`discardLocalAndPull`): back up, revert every pending document to its base value, pull.
- **Local backups:** before any of the above, and before an account switch, a full copy of synced data goes into `ent_backups` (the newest 3 are kept). `restoreLocalBackup(id)` applies one as a target state.

## 10. Accounts, first launch and importing

- **The owner is recorded per database.** Data created while signed out belongs to whoever signs in first; it's already pending against revision 0, so the first sync publishes or merges it. Signing in as a *different* account puts the device in `accountMismatch` until `switchAccount()`, which backs up and wipes local synced data.
- **A fresh device** has base 0 and pulls: from commits, or from the latest checkpoint plus the commits after it.
- **`importState({puts, deletes, label})`** brings in data from outside, such as a previous sync system:
  - **The first device** (the account has no head) publishes its data and **pins** that revision as a restore point named `label`.
  - **Every later device** rebuilds the state at that pinned revision as its base, writes its own data on top as local edits, each document in its own coupling group, and pulls. That's a proper three-way merge whose common ancestor is the first import. Data identical on both sides merges to nothing; later changes merge in; changes on both sides since conflict.
  - **`deletes`** lists only documents the device has a *record* of deleting. Absence alone can't tell "deleted" from "never seen".
  - **Unknown fields** are carried over from the anchor, so a client that doesn't know a field can't strip it.
  - **Unpin the anchor** once every device has imported (`setPinned(point, false)`).

## 11. Schema evolution

A `Schema` has a `version`, a `compatibleSince`, and optional `migrations` (`toVersion → (collection, doc) → doc`).

- **Additive changes** (new field, new collection): bump `version`, keep `compatibleSince`. Older builds keep working and preserve the new data untouched (unknown fields, and "opaque" unknown collections).
- **Breaking changes** (rename, new meaning, new structure inside an existing field): set `compatibleSince = version` and add a migration.
  - The server then refuses commits from older versions (`schemaTooOld`), and older builds see `remoteSchemaTooNew`: update the app.
  - Stored documents are migrated on open, and incoming older-format data is migrated as it arrives.
- **Downgrades are refused:** a database written by a newer build won't open (`LocalSchemaTooNew`).

## 12. The server

The only server code is SQL: `packages/entanglement_supabase/supabase/migrations/0001_entanglement.sql`. Apps vendor it; Quadra's copy is `quadra-app/supabase/migrations/0002_entanglement.sql`. The same rules are also implemented by the in-memory reference server `InMemoryServer`, used in tests. A second implementation of the same rules is the Durable Object in `ts/packages/cloudflare` (see [cloudflare-setup.md](cloudflare-setup.md)): one object per account on SQLite, where its single-threaded execution takes the place of row locks.

| Object | Role |
|---|---|
| `ent_heads` | One row per account: revision, state digest, schema gate (`min_version`), and how far history is compacted. |
| `ent_commits` | The commits after the compaction point. `(user_id, commit_id)` is unique, which is what makes retries idempotent. |
| `ent_checkpoints` | Full states at chosen revisions. |
| `ent_restore_points` | Labels, pinned or not. |
| `ent_submit(p_request)` | Under a row lock: idempotency check → schema gate → compare-and-swap → insert commit → advance head → add a restore point if the commit has a message. Returns `(out_status, out_revision)`. |
| `ent_put_checkpoint`, `ent_put_restore_point`, `ent_delete_restore_points`, `ent_compact` | The other writes, each enforcing its rules (checkpoint digest must match its commit; compaction needs a checkpoint at the anchor and no pinned point before it). |

- **Security:** row-level security lets users *read* only their own rows. There are no write policies at all. Every write goes through the `security definer` functions above, so even a buggy or outdated client can't bypass the rules.
- **Realtime:** `ent_heads` is published to Supabase Realtime. A change to it is only a *hint* to go and check. Its row holds no user data.
- **Adapters:** `SupabaseSyncBackend` (Dart and TypeScript) maps these to the framework's `SyncBackend` interface and translates errors into four kinds: transient (retry), auth required, history unavailable (use full state), fatal.

## 13. On-device storage

One SQLite database per app:

| Table | Contents |
|---|---|
| `c_<collection>` | `(id, doc)` per collection, plus a generated `ix_<field>` column and index for each declared index |
| `ent_meta` | device id, owner account, base revision and digest, counters, mode, per-mode conflict policy, schema version |
| `ent_pending` | the overlay: `before`, coupling group, sequence, in-flight marker, held-unit id |
| `ent_refs` | reverse reference index, for "who points at this?" |
| `ent_inflight` | at most one commit awaiting a definitive answer |
| `ent_conflicts` | held conflict entries (ancestor, local at detection, remote) |
| `ent_backups` | local full-state backups |

Where the file lives:

| Platform | Location |
|---|---|
| Flutter native | the app support directory (`openAppDatabase`) |
| Flutter web | SQLite WASM in IndexedDB. It needs `sqlite3.wasm` at the web root; Quadra ships it. |
| Obsidian | sql.js, loaded into memory and saved as a file through a `persist` callback (debounced; call `flush()` on unload) |

## 14. Two implementations, one protocol

Dart and TypeScript implement the same design, module for module:

| Concern | Dart (`packages/entanglement/lib/src/`) | TypeScript (`ts/packages/core/src/`) |
|---|---|---|
| Canonical JSON | `canonical.dart` | `canonical.ts` |
| Digests | `digest.dart` | `digest.ts` |
| Collections, schema | `schema.dart` | `schema.ts` |
| Three-way decision, units | `merge.dart` | `merge.ts` |
| Wire types, backend interface | `protocol.dart` | `protocol.ts` |
| Reference server | `in_memory_backend.dart` | `inMemoryBackend.ts` |
| Local store, overlay | `store.dart` | `store.ts` |
| Transactions, queries | `tx.dart`, `query.dart` | `tx.ts`, `query.ts` |
| Engine | `engine.dart` | `engine.ts` |
| Facade | `entanglement_db.dart` (`EntanglementDb`) | `db.ts` (`EntanglementDb`) |
| SQLite | `sqlite_executor.dart` (native + WASM) | `sqljs.ts` (sql.js) |

**Differences, all cosmetic:**

| Concern | Dart | TypeScript |
|---|---|---|
| Change notifications | `Stream`s | `onChange(listener)` / `onStatus(listener)`, returning an unsubscribe function |
| Resolutions, choices | classes | tagged objects |
| Re-entrant database access | refused outright | only warned about |

**How they stay identical:**

- **`spec/vectors/`** holds generated data that both test suites must reproduce: canonical JSON edge cases, digests, every three-way decision case, and `wire.json`. `wire.json` is a commit sequence written by Dart, which TypeScript must parse, re-encode byte-for-byte and fold to the same state. Regenerate with `dart run tool/vectors.dart` (in `packages/entanglement`); both suites then insist the other follows.
- **The same scenario tests, contract suite and 300-run simulation** exist in both languages.
- **The contract suite has run live against Supabase** from both.

## 15. Entanglement in Quadra

Quadra has two clients: the **Flutter app** (`quadra-app`) and the **Obsidian plugin** (`quadra`). They share one account and one set of documents.

### 15.1 The shared schema

Defined in `quadra-app/docs/quadra-sync-schema.md`, implemented by `quadra_schema.dart` (app) and `src/entanglement/schema.ts` (plugin):

| Collection | Document | Merge |
|---|---|---|
| `boards` | a board ("quadra") with its quadrants and sections, plus `position` | field-wise |
| `tasks` | a task with its subtasks | field-wise with clock, `{completed, subtasks, lastCompleted}` grouped |
| `completions` | a completion record, id `"<taskId>\|<dateKey>"` | whole document |
| `triage` | a triage note | field-wise with clock |
| `journal` | a journal entry (app only; the plugin preserves it without reading it) | field-wise with clock |
| `categories` | a category, plus `position` | field-wise |
| `settings` | singleton `settings`: the display toggles | field-wise |
| `deviceSettings` (app, local-only) | `layout` (grid gap, quadrant height); `setup` and `seed` markers | n/a |

Rules to know:

- **Nulls are absent.** Both clients strip null values at every depth before writing. The same content always produces the same document, so neither client keeps "changing" what the other wrote.
- **"Field-wise with clock"** ignores `updatedAt` when merging and keeps the larger one. Every edit bumps `updatedAt`, so without this, two devices editing different fields of one task would always conflict.
- **`fields` differs per client on purpose:** it's what *that* client understands. The plugin's task fields omit the app's `reminderTime`, which is exactly why the plugin preserves it.
- **No references are declared** in schema v1. Both clients tolerate dangling ids (a task whose category was deleted elsewhere). Deleting a board deletes its tasks, in the app's repository and the plugin's own logic, in the same transaction.
- **Kept in step by a shared fixture:** `docs/fixtures/quadra_schema_fixture.json` holds a dataset and the exact documents expected. The app's test generates and checks it, and the plugin's test checks its copy. A live three-step cross-client test (`quadra-app/test/live_cross_client_test.dart`, then `quadra/src/entanglement/cross_client.e2e.test.ts`) has proven app ↔ plugin round trips on a real server.

### 15.2 The Flutter app

- **Startup** (`lib/app/quadra_bootstrap.dart`):
  1. Initialise Supabase (if configured).
  2. Open the Entanglement database (`quadra_entanglement.db`).
  3. On a brand-new database, run first-launch setup (§15.4).
  4. Return a `QuadraStorage` with the repository, the database, the sync engine and auth.

  `main.dart` passes it to `QuadraApp`.
- **Data access:** `EntanglementQuadraRepository` implements the app's existing `QuadraRepository` interface, so the controller and screens didn't change. It turns models into documents and back, keeps board order in `position` (new boards go last), and deletes a board's tasks with it.
- **Sync UI:**
  - **`SyncBanner`**, above the board, shows *Pull* when the cloud is ahead, *Sync* when both sides changed (VCS), *Review* for conflicts, and an update notice when needed. It slides in rather than popping, and **Later** hides it until the situation changes.
  - **`SyncCommitButton`**, in the board's header, commits in VCS mode while there are uncommitted changes (with a count badge). That is the normal state after almost every edit, so it lives in the header rather than the banner, where it would shift the board on the first edit.
  - **`SyncAccountScreen`** has sign-in; status; Commit (with an optional label), Pull and Sync; mode; conflict policy; conflicts with Keep mine / Keep other device's; history with Restore and Unpin; recent automatic decisions with Bring back; overwrite the cloud; discard and pull.
- **Lifecycle:** on resume, `checkForExternalChanges()` (picks up widget writes) and `sync.resume()`. On pause, `sync.pause()`.
- **Home-screen widget:** its background isolate opens the database as `SyncRole.passive` (`QuadraBootstrap.openForBackground`) and writes through the same repository.
- **Starter data:** a fresh, signed-out install seeds the starter board and remembers its fingerprint. On the first sign-in, if the board is untouched, it's dropped before merging, so the account never gets duplicate starter boards. If the account turns out to be empty, the device seeds again.
- **Defaults:** new installs start in VCS mode.

### 15.3 The Obsidian plugin

- **Mirroring:** the plugin still works on one in-memory `PluginData` object that its views mutate. `src/sync/EntanglementSync.ts` mirrors it:
  - **`save()` → the database:** every save writes each managed document (unchanged documents are no-ops; unknown fields are preserved) and deletes documents the plugin no longer has. It only touches collections the plugin manages, never `journal`.
  - **The database → the plugin:** a change with origin other than `local` (a pull, a resolution, a restore) replaces the plugin's synced data and re-renders.
- **Storage:** sql.js with its WebAssembly bundled into `main.js` (esbuild `.wasm` binary loader; build target ES2020 for BigInt). The database is saved as `entanglement.db` in the plugin folder through the vault adapter. Focus state and local preferences stay in `data.json`.
- **Supabase client:** uses Obsidian's `requestUrl` as `fetch` (to avoid CORS) and keeps the session in localStorage (`quadra-supabase-auth`), never in `data.json`.
- **Defaults:** new vaults start in realtime mode.
- **UI:** the status bar label reflects the relation, and clicking it opens conflicts if any exist, otherwise syncs. The **Resolve sync conflicts** command opens `ConflictModal`. The settings tab shows account, mode, status and Sync now, plus history with restore, overwrite the cloud, and discard and pull.

### 15.4 First launch

A brand-new database (a new install, a new vault, or a deleted database file) is set up once:

| Client | What happens |
|---|---|
| **App** (`QuadraBootstrap`) | If signed in, pull the account's data. If there are still no boards, seed the starter board and remember its fingerprint. On the first later sign-in, an untouched starter board is dropped before merging, so an account never gets duplicate starter boards. A `deviceSettings/setup` marker records that setup ran. |
| **Plugin** (`EntanglementSync.firstRun`) | If signed in, pull the account's data. If still empty and this vault has a saved `data.json`, adopt its contents. Otherwise the plugin seeds a default board. |

Pulling first is what stops a new device from publishing a second copy of data the account already has.

- **Server setup** is in `quadra-app/docs/supabase.md`.
- **History:** Quadra originally synced through an append-only log (`sync_changes`). The move to Entanglement used `importState` (§10) to merge each device's data. That one-time migration code has since been removed, and `quadra-app/supabase/migrations/0003_drop_legacy_sync_log.sql` drops the old table.

## 16. Testing

| Where | Command | What it covers |
|---|---|---|
| `Entanglement/packages/entanglement` | `dart test` | store, 31 sync scenarios, the backend contract on the in-memory server, vectors, **300 seeded simulations** |
| `Entanglement/ts` | `npm test` | the same, ported |
| `Entanglement/packages/entanglement_supabase` | `ENTANGLEMENT_SUPABASE_URL=… ENTANGLEMENT_SUPABASE_ANON_KEY=… dart test` | the contract suite against a real project |
| `Entanglement/ts` | the same variables + `npx vitest run packages/supabase` | the same, from TypeScript |
| `quadra-app` | `flutter test` | the app, the repository (persistence, merging, board cascades), the shared-schema fixture |
| `quadra` | `npm test` | the plugin's shared-schema fixture test |

- **The simulations:** 4 devices make random edits, pushes, pulls, restores, overwrites and conflict decisions while the server randomly drops requests and responses. After a quiet period, every device must hold identical state, with nothing pending, no conflicts, valid references, unique commit ids and gap-free revisions. They are the main defence against sync bugs. When one fails it prints the seed and step, so it reproduces exactly.
- **Live tests** need a scratch Supabase project set up per [supabase-setup.md](supabase-setup.md), never production. Supabase limits sign-ups to about 30 per 5 minutes, so space out full contract runs.

## 17. Common tasks

**Add a field to a Quadra document** (additive):
1. Add it to the model's JSON in *both* clients.
2. Add it to that collection's `fields` in each client that understands it.
3. Regenerate the fixture: `UPDATE_FIXTURES=1 flutter test test/quadra_schema_fixture_test.dart`, then copy it to the plugin.

No schema version bump is needed: older builds preserve the field.

**Add a collection:** declare it in both schemas (same name, same merge policy), then bump `Schema.version` and keep `compatibleSince`. Older builds store it opaquely.

**Make a breaking change:** bump `version` and set `compatibleSince` to it, add a `migrations` entry, then ship all clients together. Old builds will be told to update.

**Change the framework and ship it to Quadra:**
```bash
cd Projects/Entanglement
dart test   # in packages/entanglement, and npm test in ts/
node tool/vendor.mjs --dart ../quadra-app/vendor/entanglement --ts ../quadra/vendor/entanglement --sql ../quadra-app/supabase/migrations/0002_entanglement.sql
cd ../quadra-app && flutter pub get && flutter test
cd ../quadra && npm install ./vendor/entanglement/entanglement-core-0.1.0.tgz ./vendor/entanglement/entanglement-supabase-0.1.0.tgz --force && npm test && npm run build
```
Commit Entanglement first, so each `VENDORED.md` names a real commit. If the server SQL changed, write a *new* migration and document it; never edit one already applied.

**Debug "it didn't sync":**
- Check `sync.status`: its relation, `pendingCount`, `heldCount`, `conflictCount`, and `problem`.
- **`conflicted` or held changes:** something is waiting on a decision.
- **`remoteSchemaTooNew`:** update the app.
- **`problem.kind == integrity`:** the digests disagree. Run `rebuildBase()`, and if it persists, investigate the server data.
- **Pending changes that never publish:** they depend on held data (§5, step 2).
- **What an automatic decision threw away:** it's in `log()`.

## 18. Rules and gotchas

- **All writes go through `db.write`.** Inside it, use `tx.get` and `tx.query` only.
- **Documents are JSON objects with finite numbers.** Integers stay within ±(2^53 − 1). Store dates as epoch-ms integers or ISO strings.
- **Deterministic ids for singletons and seed data** (`settings`, …); UUIDv7 for everything else.
- **Cascades are explicit.** Delete dependents in the same transaction.
- **Never compare with device clocks.** Revisions order things; `updatedAt` is display and merge metadata only.
- **Side effects:** use a change's `origin` to skip effects for data that arrived from elsewhere, such as reminders or "task completed" feedback.
- **Unpin import anchors when done;** pinned points block compaction.
- **Never edit vendored files;** re-vendor.
- **Never point tests at a production project;** the contract suite creates users.
- **Known limitations:**
  - A resolution that would break a reference is refused rather than turned into a new conflict.
  - Web: the core (sql.js executor, two-device sync, cipher) runs in headless Chromium and WebKit (`npm run browser-check` in `ts/`, a Playwright harness). Persistence to IndexedDB/OPFS and a real browser backend have not been exercised.
