# Local-First Sync Framework — Design (v2)

## 1. Purpose

Build a reusable, backend-agnostic synchronization framework for local-first CRUD applications.

The framework is designed around a simple principle:

> **The local application database is the working source of truth. Remote synchronization is a protocol layered around that local state.**

The framework must support two interchangeable operating modes:

1. **VCS Mode** — changes are published and remote state is pulled explicitly, either by a user action or by an application-defined automatic trigger such as an autosave policy.
2. **Real-Time Mode** — the same underlying synchronization system operates automatically and incrementally, minimizing friction and network transfer while retaining VCS capabilities such as checkpoints, history, restore, and conflict resolution.

Switching between modes must not migrate or reinterpret application data. Mode selection is configuration only.

The framework must be **independent of any particular remote database or cloud vendor**. Supabase, Firebase, a custom HTTP service, a SQL backend, or another remote system should be supported by implementing an adapter against the framework's abstract backend contract.

The framework must be **importable from both React Native and Flutter applications**. This determines the implementation strategy (section 3): a shared Rust core with thin platform bindings, rather than per-platform implementations.

## 2. Design goals

### Primary goals

- Offline-first operation with the local database available at all times.
- Explicit VCS-style synchronization for simple personal applications.
- Optional low-friction realtime synchronization for multi-device use.
- The same data model and synchronization semantics in both modes.
- Atomic logical change sets rather than raw database-row replication.
- Three-way merge using a known common ancestor.
- Automatic merging where changes are provably independent and merge rules permit it.
- Explicit user conflict resolution when automatic merging is unsafe or impossible.
- Versioned checkpoints that can be restored.
- Configurable retention of prior checkpoints/backups.
- Efficient new-device bootstrap without replaying the entire historical change log.
- Bounded remote synchronization history rather than an ever-growing permanent log.
- Pluggable remote backends behind one abstract contract.
- **Framework-owned local SQLite**: the framework owns the physical database, journal, transactions, and replication metadata. The application defines a logical schema; the framework materializes it.
- Logical schema definitions with framework-generated storage, serialization, and change tracking.
- Testability of the core synchronization engine without a real backend.
- Schema/version safety so older clients cannot overwrite state they do not understand.

### Non-goals

The first version is not intended to be:

- A universal collaborative editing/CRDT framework.
- A raw SQL replication system.
- A requirement that every application field be independently mergeable.
- A requirement that every synchronization event correspond to exactly one database row.
- A vendor-specific Supabase abstraction disguised as a generic framework.
- A pluggable local-database engine layer (supporting arbitrary app-owned databases such as Drift, Room, or Core Data directly). This is deferred as future work; v1 standardizes on framework-owned SQLite (see section 6).

The framework should remain useful for small-to-moderate, user-owned CRUD datasets where whole-state checkpoints are inexpensive and simultaneous editing is relatively uncommon.

## 3. Implementation strategy: Rust core, thin platform SDKs

The framework must be importable from React Native and Flutter. No single application language covers both (TypeScript excludes Flutter; Dart excludes React Native), and maintaining two independent implementations of a synchronization engine guarantees protocol drift. The framework is therefore implemented as a **shared Rust core** with thin platform bindings:

- **Rust core** (`sync-core`): schema materialization, SQLite storage via `rusqlite` with bundled SQLite (identical storage behavior on every platform, no per-platform database drivers), transactions, change journal, revision state, three-way merge, conflict model, VCS/realtime modes, checkpoints, scheduling, retry.
- **Flutter binding**: `flutter_rust_bridge` generates the Dart API over `dart:ffi`.
- **React Native binding**: a Nitro Module (new architecture) wrapping the Rust static library. Requires the RN new architecture; the legacy bridge is not supported.
- **Web**: possible later via WASM from the same core. The SQLite-on-WASM piece needs a dedicated spike before it is promised; it is not in v1 scope.

### FFI-first API design

The core API is designed for the FFI boundary from day one, because that discipline is painful to retrofit:

- Opaque handles (integers) for database and subscription objects; no pointers or complex types cross the boundary.
- Records and change sets cross as serialized JSON; the binary protocol between core and backend adapters stays in Rust.
- Async operations complete via callbacks/channels; errors are structured codes with messages, never panics across FFI.
- No generics or trait objects in the FFI surface; the surface is versioned explicitly.
- Platform SDKs own only: handle lifecycle, idiomatic observables (Dart streams, RN event emitters), app-backgrounding behavior, and auth-token callbacks. They own no synchronization logic.

## 4. Core architectural principle

The framework consists of a **vendor-neutral synchronization core** surrounded by concrete adapters and thin platform bindings.

```text
                    APPLICATION (RN / Flutter)
                    typed API · queries · UI · business logic
                              │
                              ▼
              ┌───────────────────────────────────┐
              │        Platform SDK (thin)        │
              │   Dart / TS bindings · handles    │
              │   observables · lifecycle         │
              └────────────────┬──────────────────┘
                               │  FFI boundary (opaque handles, JSON)
                               ▼
              ┌───────────────────────────────────┐
              │         Sync Core (Rust)          │
              │                                   │
              │ schema · entities · transactions  │
              │ change journal · revisions        │
              │ three-way merge · conflicts       │
              │ checkpoints · VCS / realtime      │
              │ scheduling · retry                │
              │                                   │
              │  ┌──────────────┐                 │
              │  │ Framework-   │                 │
              │  │ owned SQLite │                 │
              │  └──────────────┘                 │
              └────────────────┬──────────────────┘
                               │  abstract backend contract
                ┌──────────────┴──────────────┐
                │                             │
                ▼                             ▼
         Supabase Adapter              Firebase Adapter
                │                             │
                ▼                             ▼
            Supabase                       Firebase
```

The core must not know whether the remote implementation uses Postgres, Firestore, REST, GraphQL, a custom SQL API, object storage plus an API, or another synchronization service. It must not know whether it is called from Dart or TypeScript.

## 5. Layer boundaries

### 5.1 Application layer

Owns the product/domain model and defines the **logical schema** (section 6): entity types, fields, identity, and merge policies. It performs all reads and writes through the framework's transaction API and never touches SQLite directly. It decides which sync mode and per-collection policies to expose, and renders conflict and checkpoint UI from the structured results the framework produces.

### 5.2 Platform SDK layer (thin)

The Dart and TypeScript packages generated/written over the FFI boundary. Responsibilities strictly limited to: opening/closing database handles, exposing queries and change notifications idiomatically per platform, forwarding auth tokens via a registered callback, and managing lifecycle (backgrounding, multi-instance). No sync logic lives here; it must be replaceable without touching the core.

### 5.3 Synchronization framework (Rust core)

Owns everything between the platform SDK and the backend adapter:

- logical schema materialization into SQLite tables, indexes, and serialization code
- local transactions and the change journal (with before-images)
- pending change sets, revision state, base reconstruction
- three-way merge engine and conflict model
- VCS and realtime mode scheduling, debounce, single-flight execution, retry/backoff
- checkpoint creation, retention, restore
- schema compatibility enforcement

### 5.4 Remote backend adapter

Translates framework operations into the concrete remote service API. Responsible for authentication transport, API calls, server-side transactions and compare-and-swap, storage of revisions/change history/checkpoints, backend-native realtime subscriptions (as hints), and backend error translation. The adapter must not implement business-level merge logic.

## 6. Storage ownership (v1 principle)

> **The application defines the logical data model. The framework owns the physical local database, synchronization journal, transactions, and replication metadata.**

This is the v1 decision, and it is load-bearing. The hardest problem in realtime mode is not sending changes to a backend — it is **reliably knowing exactly what changed**: which logical entity, its previous state, which transaction it belonged to, whether it was an atomic user-visible operation or a cascade, whether it was a deletion. If the application owned an arbitrary database, the framework would need a reliable change-capture integration for every database technology it supports, and some databases have no sufficiently reliable change-notification mechanism at all. The framework would be making its hardest problem dependent on every storage engine it supports.

With framework-owned SQLite, the framework always knows what happened, because it performed the transaction. Change tracking becomes reliable, atomic change sets become enforceable, before-images become straightforward, realtime and VCS use exactly the same local machinery, and the backend adapter stays genuinely backend-agnostic instead of compensating for arbitrary local storage.

### Logical schema

Developers do not provide raw SQLite DDL. They define a logical schema, conceptually:

```text
Task
    id: UUID
    title: String
    completed: Boolean
    quadrantId: UUID
    updatedAt: DateTime

Quadrant
    id: UUID
    name: String
```

The framework turns this into SQLite tables, indexes, serialization, and change tracking. The SDKs eventually generate strongly typed Dart/TypeScript APIs around it, so the developer thinks `Task.create(...)` / `Task.update(...)` / `Task.delete(...)` rather than `UPDATE tasks SET ...` — and the framework knows those operations are synchronization operations.

## 7. Fundamental synchronization concepts

### 7.1 Materialized local state

The framework-owned SQLite database remains the primary working representation. The application should never need to reconstruct itself by replaying the synchronization history.

### 7.2 Sync entity

A **sync entity** is the smallest logical unit the framework treats as independently mergeable or replaceable. It is not necessarily a physical database row:

```text
Task
JournalEntry
Board
Quadrant
Settings
```

An entity can represent an aggregate when multiple physical rows must remain atomic. This distinction is essential because raw row-level replication can temporarily create states that never existed in the source application.

### 7.3 Atomic change set

A **change set** is the foundational protocol object: a logically atomic set of entity changes produced by one local transaction, each carrying before- and after-images.

```text
ChangeSet
    id: UUID                # transactionId
    parentRevision: u64     # base revision this was built against
    changes: Change[]

Change
    entityType: String
    entityId: String
    operation: create | update | delete
    before: EntityState | null
    after: EntityState | null
```

Example — moving Task 42 from Quadrant A to Quadrant B:

```text
ChangeSet 184, parentRevision: 183
    Task:42
        operation: update
        before: { quadrantId: A, ... }
        after:  { quadrantId: B, ... }
    Quadrant:A
        operation: update
        before: {...}
        after:  {...}
    Quadrant:B
        operation: update
        before: {...}
        after:  {...}
```

Remote devices apply the complete change set atomically, and all changes in a change set share one revision. A `create` has `before: null`; a `delete` has `after: null`.

**Coalescing.** Repeated local edits to the same entity collapse: the pending entry keeps the original `before` and the latest `after`. If the user edits Task A five times, one pending change remains. If the final state equals the original (`after == before`), the pending change is eliminated entirely — an edit followed by a perfect undo correctly counts as clean.

### 7.4 Revision

A **revision** is a server-assigned monotonically increasing position in the synchronization history. It is the authoritative ordering mechanism. Wall-clock timestamps are metadata only and must never be used to establish causality or ordering. Because "last writer" is defined by commit order rather than device clocks, revision ordering eliminates clock-skew as a conflict-resolution hazard.

Both VCS commits and realtime incremental commits advance the same revision space.

### 7.5 Base / common ancestor

Each device records the remote revision it last agreed with. Three-way merge needs the actual ancestor *state*, not just its revision — a hash identifies a state but does not contain it. The framework does **not** store a complete second copy of the database for this. Instead, the base is **reconstructed locally from pending-change before-images**: base entity state = current state with pending changes reverted. For entities with no pending change, base state is current state. Storage overhead is therefore proportional to what the user actually changed, not 2× the database, and base availability never depends on the backend.

Conceptually:

```text
             BASE (reconstructed)
            /    \
        LOCAL   REMOTE
```

### 7.6 Pending changes

Pending changes are the local changes that exist after the current base and have not yet been durably published and acknowledged. They form a **delta overlay** over the last synchronized base (section 7.3), stored durably in the framework-owned database. They are synchronization infrastructure, not the application's source-of-truth data model. Network failure never blocks local writes; pending changes simply wait.

## 8. Checkpoints

A **checkpoint** is a complete representation of the syncable application state at a specific revision. Checkpoints provide new-device bootstrap, recovery, restore points, efficient history navigation, bounded synchronization history, and a safe fallback when incremental history is unavailable.

**Commit ≠ checkpoint.** A commit is incremental (a change set advancing the revision). A checkpoint is a snapshot (complete state). Creating a checkpoint at a VCS commit is a retention/history *policy*, not part of the synchronization protocol. Conflating them reintroduces O(data) transfer per commit.

```text
Checkpoint v100
    ↓
Changes v101, v102, v103, ...
    ↓
Checkpoint v200
    ↓
Changes v201, v202, ...
```

Old incremental history can be garbage-collected once checkpoints make it unnecessary for supported clients to catch up. Checkpoint payloads reuse the change-set record encoding ("every entity, as one batch"), so there is exactly one serialization format to maintain.

## 9. User-visible checkpoint history

The framework maintains a user-visible history of checkpoints, distinct from internal synchronization history:

- **Synchronization history**: internal protocol data (recent change sets) used to move devices forward incrementally.
- **User checkpoint history**: intentional or automatically created complete states the user can restore.

Configuration is a retention policy (e.g. `retainCheckpoints = 20`), FIFO. Realtime mode must retain restore capability — automatic synchronization must never turn off the ability to restore historical checkpoints. Auto-checkpoint triggers: on a schedule (e.g. daily in realtime mode), explicitly by the user, and always before a restore ("pre-restore" checkpoint — the safety net gets its own safety net).

## 10. Version Control System Mode

VCS mode is the explicit synchronization model. Local edits apply immediately to the local database with no remote request; the framework records the resulting pending change set.

A commit packages the current pending change set(s) and publishes them **atomically as deltas**:

```text
Working State
     │
     │ commit (publish pending change sets)
     ▼
Revision N+1        (+ optional checkpoint, per retention policy)
```

Pull is likewise explicit. The framework determines whether the remote has advanced and whether local state has diverged from the common base, yielding `UpToDate`, `LocalAhead`, `RemoteAhead`, or `Diverged` (section 12). On `Diverged`, the framework performs three-way merge (section 13); independent changes merge automatically, and unmergeable changes surface as structured conflicts.

## 11. Real-Time Mode

Realtime mode is **not a separate synchronization architecture**. It is VCS mode with automated publication and incremental transport. The only meaningful difference between the modes is how aggressively the framework moves the system toward the next synchronized revision.

```text
local transaction
      ↓
change set (before/after journal)
      ↓
optional debounce/coalescing
      ↓
automatic commit (CAS against parent revision)
```

Commits are batched around logical transactions and coalesced when safe; the framework must not require one network request per local edit. Remote notifications are treated as **hints to check the authoritative backend**, never as the authoritative transport — this keeps realtime replaceable and allows polling fallback when notifications are missed.

### The CAS → fetch → merge → recommit loop

This is the hot path of realtime mode and is specified explicitly. Suppose devices A and B share base revision 100 and both modify Task 42. A submits first:

```text
A: submit(changeSet, expectedParent: 100) → ACCEPTED, revision 101
B: submit(changeSet, expectedParent: 100) → CONFLICT, currentRevision = 101
```

On conflict, B does not surface an error. It rebases:

```text
local change
    ↓
optimistic local application
    ↓
submit (CAS on parent revision)
    │
    ├── success → advance base to new revision
    │
    └── conflict
           ↓
       fetch changes (base → current head)
           ↓
       three-way merge (base reconstructed from before-images)
           ↓
       ┌─ clean merge → submit merged change set against head → new revision
       └─ unresolvable → apply default conflict policy (section 13), log resolution
```

Single-flight execution guarantees no overlapping sync cycles against the same local state; a request arriving mid-cycle sets a rerun flag. Transient failures retry with bounded exponential backoff.

## 12. Shared state machine

Both modes use the same relationship model, computed per sync batch from base revision, pending changes, and remote head:

```text
                         ┌──────────────┐
                         │   UpToDate   │
                         └──────┬───────┘
                                │
                  local / remote changes
                                │
                 ┌──────────────┴──────────────┐
                 ▼                             ▼
           LocalAhead                    RemoteAhead
                 │                             │
              commit                           pull
                 │                             │
                 └──────────────┬──────────────┘
                                ▼
                           UpToDate

          local AND remote changed since base
                                │
                                ▼
                            Diverged
                                │
                 ┌──────────────┴──────────────┐
                 ▼                             ▼
          automatic merge                user conflict
                 │                             │
                 └──────────────┬──────────────┘
                                ▼
                           UpToDate
```

Additional explicit typed states: `RemoteEmpty`, `SignedOut`, `MigrationRequired`, `RemoteSchemaTooNew`, `LocalSchemaTooNew`, `HistoryUnavailable`, `AuthenticationRequired`, `Error` / `RetryPending`. The core exposes these as typed states rather than making callers infer them from exceptions.

## 13. Three-way merge model

The merge engine is backend-independent. Inputs are `base` (reconstructed per section 7.5), `local`, and `remote`; outputs are merged state or a conflict set.

### Default merge behavior

```text
Base == Local && Base == Remote
    → unchanged

Base == Local && Base != Remote
    → take remote

Base != Local && Base == Remote
    → take local

Base != Local && Base != Remote
    → invoke entity/field merge policy
```

### Merge policies

Developers may provide `WholeEntityConflict`, `FieldWiseMerge`, `CustomMerge`, or explicit opt-in `LastWriterWins`. The framework must never silently apply a potentially destructive merge policy merely because it is convenient.

### Default realtime policy

Realtime mode needs an explicit default so frictionless operation never stalls on an unspecified behavior: **automatically merge whenever the framework can prove the changes are independent** (different entities, or different fields of the same entity once field-wise merge exists); **otherwise resolve deterministically by server revision order** — the change committed later wins — **and record the resolution in sync history**. This is deterministic three-way merge with developer-defined semantics, not generic CRDT behavior, and field-level merging can be added incrementally without changing the protocol. Resolutions must be visible (e.g. a sync-activity record), because silent data loss destroys trust in a sync engine.

## 14. Deletes and tombstones

Whole checkpoints naturally represent deletion by omission. Incremental synchronization cannot do this because absence from a delta is ambiguous, so realtime change history represents deletion explicitly as a change with `operation: delete` and `after: null`. These tombstones are synchronization history, not necessarily permanent rows in the application database; they may be garbage-collected after a checkpoint makes them unnecessary for all supported catch-up paths. A device that has been offline longer than tombstone retention must fall back to a full checkpoint bootstrap rather than incremental catch-up, or it will resurrect deleted entities.

## 15. Server-side protocol requirements

The abstract backend must provide these semantic guarantees regardless of implementation technology:

- **Authoritative revision ordering.** The server assigns the canonical revision. Client clocks are never used for ordering.
- **Compare-and-swap.** A commit is accepted only when its expected parent revision is still current, unless the framework explicitly performs a validated force/overwrite operation. This prevents concurrent commits from silently overwriting each other and drives the rebase loop in section 11.
- **Atomic commit.** A logical change set appears remotely as one committed unit.
- **Change retrieval.** A device can request changes after revision X while incremental history exists.
- **Checkpoint retrieval and checkpoint history.** The backend retains a configured number of historical checkpoints.
- **Realtime notification.** Where supported, the adapter may expose database changefeeds, WebSockets, or platform listeners. The core treats these as hints and always has a polling fallback.

A server-side **materialized current state** is an implementation *optimization*, not a protocol requirement: a backend can always derive current state from the latest checkpoint plus subsequent changes. Maintaining it makes bootstrap and inspection cheap, and the adapter boundary hides the choice.

## 16. Remote backend adapter interface

The interface is minimized to what the core truly needs and must not expose backend-vendor concepts; a Firebase adapter and a Supabase adapter implement exactly the same semantic contract. Conceptually (Rust):

```rust
trait SyncBackend {
    async fn get_current_revision(&self) -> Result<u64, BackendError>;
    async fn get_changes_since(&self, revision: u64)
        -> Result<Vec<CommittedChangeSet>, BackendError>;
    async fn submit_changeset(
        &self,
        expected_parent: u64,
        changeset: ChangeSet,
        schema_version: u32,
    ) -> Result<SubmitResult, BackendError>;
    // ^ Accepted { new_revision } | Conflict { current_revision }

    // Checkpoint capability (separable; see below)
    async fn store_checkpoint(&self, meta: CheckpointMeta, payload: Vec<u8>)
        -> Result<(), BackendError>;
    async fn list_checkpoints(&self) -> Result<Vec<CheckpointMeta>, BackendError>;
    async fn fetch_checkpoint(&self, id: &str) -> Result<Vec<u8>, BackendError>;
    async fn delete_checkpoint(&self, id: &str) -> Result<(), BackendError>;

    // Realtime hints only — never authoritative transport
    fn subscribe_revision_hints(&self, on_hint: HintCallback) -> Subscription;
}
```

Checkpoint storage is a **separable capability**: core synchronization works on every backend, while checkpoint/restore UI is enabled only where the adapter implements it. Large-payload handling (e.g. chunking around document size limits) is each adapter's internal business; the trait always sees the whole payload. Authentication travels via a token callback registered by the platform SDK; the core never holds credentials.

## 17. Application-facing API

Because the framework owns local storage, there is no "local adapter interface" to an app-owned database. Instead the framework exposes a transaction API that the application (via the platform SDK) programs against:

```text
db = SyncDb.open(path, schema, backend, options)

# schema-driven, typed once codegen exists
db.transact(|tx| {
    tx.tasks.insert({ title: "Buy milk", quadrantId: q1 })
    tx.tasks.update(task42, { quadrantId: q2 })
    tx.quadrants.update(q1, { ... })
})  # → one atomic ChangeSet with before/after images, journaled automatically

db.tasks.query(...).observe(|tasks| render(tasks))  # offline-first reads, always local
db.sync.status.observe(|s| showBadge(s))             # state machine state, pending count, revision
db.sync.now()                                       # manual sync (VCS mode)
db.sync.setMode(Realtime | Vcs)
db.checkpoints.create(label)
db.checkpoints.list() -> [CheckpointMeta]
db.checkpoints.restore(id)                          # pre-restore checkpoint + forward-only apply
db.conflicts.observe(|conflicts| ...)               # structured ConflictSets for user resolution
```

All writes go through `transact`, so change capture is total and automatic — never "optional." Raw SQL access, if exposed at all, is explicitly outside the synchronization contract.

## 18. Application integration contract

To adopt the framework, an application defines:

- **Logical schema**: entity types, fields, identity (client-generated UUIDv7 so offline creates need no server round-trip).
- **Merge policies**: per entity type, chosen from the framework's policy set or custom.
- **Schema version**: which serialized formats the build understands.
- **Sync mode and per-collection policy**: which collections sync `realtime`, `manual` (`VCS`), or `local` (never leaves the device).
- **UX**: conflict presentation, checkpoint management UI, status display.

The framework handles everything else: storage, change capture, revisions, merge execution, scheduling, checkpoints, restore, and backend communication. Notably, "change extraction" is *not* an application burden — it falls out of the transaction API.

## 19. Schema evolution

Checkpoints and change sets outlive application builds, so schema compatibility is a protocol concern. The framework tracks a serialized schema version with these rules:

- A client must never overwrite a newer remote schema with an older representation it does not understand (the backend's CAS/submit path enforces this; the client pre-checks).
- A client must not apply a checkpoint or change set with a newer schema version; it reports `RemoteSchemaTooNew` / `MigrationRequired` instead of guessing.
- Adding a persisted field updates checkpoint serialization and change-set semantics together; schema upgrades are explicit and testable.
- Forward compatibility: unknown fields arriving from a newer build are preserved opaquely (never dropped by an older writer), so additive changes do not force lockstep app updates across devices.

## 20. Mode switching

Mode changes require no data migration — only the local DB format, checkpoints, revisions, and merge machinery are unchanged; what changes is scheduling.

**VCS → Realtime**: finish or publish pending local changes, establish a synchronized base, start listeners/polling, enable automatic incremental commits.

**Realtime → VCS**: finish the in-flight commit, stop automatic publication, retain base/history/pending infrastructure, enter explicit commit/pull behavior.

A product can expose `Sync mode: VCS | Real-time` (app-wide default, with per-collection policy override) without the user understanding the architecture.

## 21. Scheduling and reliability

- **Debouncing**: coalesce bursts of edits into logical sync batches where safe.
- **Single-flight execution**: never run overlapping sync cycles against the same local state; mid-cycle requests set a rerun flag.
- **Retry/backoff**: transient failures retry with bounded exponential backoff.
- **Poll fallback**: realtime mode polls periodically so a missed hint cannot stall sync permanently.
- **Offline behavior**: network failure never blocks local writes; pending change sets remain durable until acknowledged.
- **Idempotency**: commits carry idempotency keys (change-set IDs); retried submissions and re-applied change sets have no duplicate logical effect. Adapters translate backend-specific duplicate/timeout behavior into stable framework semantics.

## 22. Bootstrap and new-device synchronization

A new device never replays lifetime history:

```text
1. obtain latest suitable checkpoint
2. install checkpoint locally (one transaction)
3. obtain incremental changes after the checkpoint revision
4. apply changes atomically, in order
5. establish base at the current head revision
6. begin normal VCS or realtime operation
```

If incremental history is unavailable or older than tombstone retention, fall back to a newer checkpoint. Cost stays bounded by current dataset size plus recent activity.

## 23. Restore semantics

Restoring an old checkpoint must not rewind the global revision counter. Instead:

```text
current revision = 500
restore checkpoint from revision 420
             ↓
create pre-restore auto-checkpoint of current state
             ↓
apply checkpoint payload in one local transaction
(missing entities become tombstoned pending deletes)
             ↓
commit restored state as a new change set
             ↓
revision 501
```

Monotonic ordering is preserved, other devices converge through normal pull, and the pre-restore checkpoint means the restore itself is undoable. The original historical checkpoint remains available per retention policy.

## 24. Conflict UX

The core produces a structured conflict result; the application renders it however it wants (modal, bottom sheet, diff screen, notification). The framework provides data and decisions, not presentation:

```text
ConflictSet
  entity: Task#42
    base:   "Buy milk"
    local:  "Buy oat milk"
    remote: "Buy almond milk"
    → needs decision (keep local / keep remote / manual merge)

  entity: Journal#7
    base:   unchanged
    local:  changed
    remote: unchanged
    → automatically resolved (take local)
```

Because the base is reconstructed from before-images, every conflict can show all three sides without extra fetches.

## 25. Responsibility split

### Framework owns

- physical local SQLite database, schema materialization, transactions
- change journal with before-images, pending change sets, base reconstruction
- revision semantics, CAS discipline, push/pull protocol logic
- three-way merge engine and conflict model
- VCS/realtime scheduling, debounce, single-flight, retry/backoff
- checkpoints, retention, restore semantics
- schema compatibility enforcement
- FFI surface and platform SDK contracts

### Backend adapter owns

- authentication transport and token handling
- API calls, server-side transactions, server-side CAS
- storage of revisions, change history, checkpoints
- backend-native realtime subscriptions (as hints)
- large-payload chunking and backend error translation
- security rules / RLS / permissions

### Application owns

- logical schema and domain semantics
- entity identity and merge policies
- which sync mode and per-collection policies to expose
- conflict, checkpoint, and status UX
- when to trigger VCS commits or mode changes

## 26. Module structure

```text
sync-framework/
├── crates/
│   ├── sync-core/        # schema · storage (rusqlite) · transactions · journal
│   │                     # revisions · merge · state machine · scheduling
│   │                     # checkpoints · restore · schema compat
│   ├── sync-ffi/         # C-ABI surface: opaque handles, JSON, error codes
│   └── adapters/
│       ├── supabase/     # Postgres RPC + Realtime hints
│       └── firebase/     # Firestore (+ chunking for large payloads)
├── bindings/
│   ├── flutter/          # flutter_rust_bridge → Dart package
│   └── react-native/     # Nitro module → TS package
└── contract-tests/       # shared backend-adapter conformance suite
```

Adapters live outside the core crate so the core never depends on a backend SDK. The FFI crate is the only surface the platform bindings touch.

## 27. Testing strategy

The core must be heavily tested without a real backend (`cargo test` against in-memory fakes of the backend trait).

- **State-machine tests**: every transition between `UpToDate`, `LocalAhead`, `RemoteAhead`, `Diverged`, `RemoteEmpty`, schema-incompatibility, and unavailable-history states.
- **Merge tests**: given exact `base`/`local`/`remote`, verify identical, local-only, remote-only, independent, conflicting, create, update, delete, and aggregate-atomicity cases.
- **Rebase-loop tests**: concurrent commits from the same parent revision; verify the loser fetches, merges, and recommits without loss or duplication.
- **Crash/retry tests**: failures before commit, after server acceptance but before client acknowledgement, during change retrieval, during checkpoint replacement, during mode switch, during restore. Behavior must remain idempotent and recoverable.
- **Adapter contract tests**: every backend adapter runs the same conformance suite (`SupabaseAdapterContractTest`, `FirebaseAdapterContractTest`, …) so implementations stay semantically equivalent.
- **Property tests**: a successful commit never loses committed remote changes; revisions never decrease; applying a change set twice has no additional effect; failed snapshot replacement leaves prior state intact; restore always produces a forward revision; mode switches never alter application state; offline edits never require network access.

## 28. Security requirements

The framework defines the semantics; adapters enforce them:

- users access only their own synchronized state (RLS / security rules on checkpoints and history)
- clients cannot declare arbitrary server revisions authoritative without backend validation
- force overwrite remains an explicit operation that still archives the displaced state
- device identifiers/labels are metadata, never authentication
- sensitive application data is never placed into notification payloads

## 29. Storage strategy

Three distinct tiers of remote storage:

1. **Recent change history** — change sets after the latest checkpoint; what realtime catch-up reads.
2. **Checkpoints** — complete states at selected revisions; bootstrap, restore, and the GC horizon for tier 1.
3. **(Optional) server-side materialized current state** — an adapter-implemented optimization for cheap bootstrap/inspection, invisible to the protocol.

This avoids both extremes: snapshots-only (inefficient realtime) and infinite event log (unbounded storage, expensive bootstrap).

## 30. Migration from the Quadra implementation

Quadra's snapshot sync provides concepts and hard-won lessons, not code — the framework is a Rust rewrite, and porting Dart is not the goal. What survives:

| Quadra concept | Framework equivalent |
|---|---|
| `QuadraSnapshot` (whole state) | Checkpoint — retained explicitly per policy, not per sync |
| Content-hash dirty detection | Pending change-set overlay (O(changes), self-cleaning on undo) |
| Server version + CAS commit | Per-batch CAS on `parentRevision` |
| 7-state relation (whole DB) | Same states, computed per sync batch |
| `snapshot_history` (20) | Checkpoint retention policy |
| Restore = apply + forward force-commit | Restore = pre-restore checkpoint + apply + forward commit |
| Realtime-as-hint | Unchanged |
| Whole-DB conflict compare sheet | Per-entity `ConflictSet` with base/local/remote |
| Schema version gating both directions | Unchanged, plus opaque preservation of unknown fields |

## 31. Implementation phases

- **Phase 1 — Rust core: storage and transactions.** Logical schema definition and materialization, framework-owned SQLite, transaction API, change journal with before-images, pending-set coalescing. No networking; testable end-to-end locally.
- **Phase 2 — Sync protocol.** Revision state, base reconstruction, CAS submit, push/pull deltas, checkpoint bootstrap, the backend trait, and the first adapter (Supabase).
- **Phase 3 — Merge.** Three-way merge engine, merge policies, structured conflicts, default realtime policy with resolution logging.
- **Phase 4 — Checkpoints and restore.** Checkpoint creation/retention/listing, forward-only restore with pre-restore auto-checkpoint, separable `CheckpointStore` capability.
- **Phase 5 — Realtime mode.** Automatic commit scheduling, debounce, revision hints, poll fallback, and the CAS → fetch → merge → recommit loop as the tested hot path.
- **Phase 6 — Platform bindings.** `flutter_rust_bridge` Dart package and RN Nitro-module TS package; FFI hardening, lifecycle, observables.
- **Phase 7 — Second backend adapter.** Firebase against the same contract plus the shared conformance suite. This phase is what proves the abstraction is backend-agnostic rather than Supabase-shaped; it is a milestone, not an afterthought.
- **Phase 8 — Merge semantics expansion.** Field-wise and custom merge strategies only where real applications demonstrate the need. No premature CRDT complexity.

## 32. Final architectural thesis

The framework is a **local-first version-control and replication engine for application state**, with one shared core:

```text
Rust core
    + logical schema
    + backend adapter
    + merge policies
```

and a choice of:

```text
mode = VCS | REALTIME          # app-wide default
policy = realtime | manual | local   # per collection
```

without changing the application's persistence model or rewriting synchronization logic. The local database is the working source of truth; revisions order the world; change sets with before-images make the base reconstructible; checkpoints make history restorable; and the remote database — whichever one the developer chooses — remains an implementation detail, not part of the synchronization model.

*Changelog: v2 rewrites the v1 draft around four decisions — (1) Rust core with thin Flutter/RN bindings instead of a Dart framework; (2) framework-owned SQLite with developer-defined logical schema instead of pluggable local-database adapters; (3) pending change sets with before-images as the base-reconstruction strategy instead of retained base copies or backend base fetches; (4) commit ≠ checkpoint, with the CAS → fetch → merge → recommit loop specified as realtime's hot path.*
