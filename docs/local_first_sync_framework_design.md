# Local-First Sync Framework — Final Design Plan

## 1. Purpose

Build a reusable, backend-agnostic synchronization framework for local-first CRUD applications.

The framework is designed around a simple principle:

> **The local application database is the working source of truth. Remote synchronization is a protocol layered around that local state.**

The framework must support two interchangeable operating modes:

1. **Version Control System (VCS) Mode** — changes are published and remote state is pulled explicitly, either by a user action or by an application-defined automatic trigger such as an autosave policy.
2. **Real-Time Mode** — the same underlying synchronization system operates automatically and incrementally, minimizing friction and network transfer while retaining VCS capabilities such as checkpoints, history, restore, and conflict resolution.

Switching between modes must not migrate or reinterpret application data. Mode selection is configuration only.

The framework must also be **independent of any particular remote database or cloud vendor**. Supabase, Firebase, a custom HTTP service, a SQL backend, or another remote system should be supported by implementing an adapter against the framework's abstract backend contract.

---

## 2. Design goals

### Primary goals

- Offline-first operation with the local database available at all times.
- Explicit VCS-style synchronization for simple personal applications.
- Optional low-friction realtime synchronization for multi-device use.
- The same data model and synchronization semantics in both modes.
- Atomic logical changes rather than raw database-row replication.
- Three-way merge using a known common ancestor.
- Automatic merging where changes are independent and merge rules permit it.
- Explicit user conflict resolution when automatic merging is unsafe or impossible.
- Versioned checkpoints that can be restored.
- Configurable retention of prior checkpoints/backups.
- Efficient new-device bootstrap without replaying the entire historical change log.
- Bounded remote synchronization history rather than an ever-growing permanent log.
- Pluggable remote backends.
- Pluggable local database adapters.
- Testability of the core synchronization engine without a real backend.
- Schema/version safety so older clients cannot overwrite state they do not understand.

### Non-goals

The first version is not intended to be:

- A universal collaborative editing/CRDT framework.
- A raw SQL replication system.
- A requirement that every application field be independently mergeable.
- A requirement that every synchronization event correspond to exactly one database row.
- A vendor-specific Supabase abstraction disguised as a generic framework.

The framework should remain useful for small-to-moderate, user-owned CRUD datasets where whole-state checkpoints are inexpensive and simultaneous editing is relatively uncommon.

---

## 3. Core architectural principle

The framework should consist of a **vendor-neutral synchronization core** surrounded by concrete adapters.

```text
                         APPLICATION
                              │
                              ▼
                    ┌───────────────────┐
                    │   Local Database  │
                    │  (materialized    │
                    │   working state)  │
                    └─────────┬─────────┘
                              │
                              ▼
                    ┌───────────────────┐
                    │   Sync Core       │
                    │                   │
                    │ state / revisions │
                    │ changes / commits │
                    │ merge / conflicts │
                    │ checkpoints       │
                    │ VCS / realtime    │
                    └─────────┬─────────┘
                              │
                 abstract backend contracts
                              │
                     ┌────────┴────────┐
                     │                 │
                     ▼                 ▼
              Supabase Adapter   Firebase Adapter
                     │                 │
                     ▼                 ▼
                 Supabase           Firebase
```

The core must not know whether the remote implementation uses:

- Postgres / Supabase
- Firestore / Firebase
- REST
- GraphQL
- a custom SQL API
- object storage plus an API
- another synchronization service

Likewise, the core must not directly depend on SQLite, Drift, Core Data, Room, IndexedDB, etc.

Adapters expose the capabilities required by the protocol.

---

## 4. Layer boundaries

The framework is divided into four conceptual layers.

### 4.1 Application layer

Owns the actual product/domain model:

- tasks
- boards
- journals
- settings
- etc.

It decides what constitutes a syncable entity, how to serialize it, and how entities relate to one another.

### 4.2 Local adapter layer

Provides access to the application's materialized local state.

The adapter is responsible for:

- reading syncable state
- applying an atomic change set
- replacing the database from a checkpoint/snapshot
- recording synchronization metadata
- participating in local transactions
- optionally reporting the logical changes caused by a transaction

The core does not directly manipulate SQL tables.

### 4.3 Synchronization core

Contains all protocol and state-machine logic:

- revisions
- bases/common ancestors
- pending changes
- commits
- checkpoints
- change-set batching
- three-way merge
- conflict detection
- conflict policies
- mode scheduling
- retry/backoff
- mode switching
- schema compatibility
- bootstrap/catch-up logic
- history/restore semantics

This is the reusable framework itself.

### 4.4 Remote backend adapter

Translates framework operations into the concrete remote service API.

A backend adapter is responsible for:

- reading the current remote revision/state metadata
- uploading a commit or checkpoint
- retrieving changes since a revision
- retrieving a checkpoint
- storing/retrieving checkpoint history
- enforcing compare-and-swap / revision preconditions
- exposing realtime notifications when the backend supports them
- authenticating requests
- mapping backend errors into framework-level errors

The adapter must not implement business-level merge logic.

---

## 5. Fundamental synchronization concepts

### 5.1 Materialized local state

The normal application database remains the primary working representation.

The application should never need to reconstruct itself by replaying the synchronization history.

### 5.2 Sync entity

A **sync entity** is the smallest logical unit the framework treats as independently mergeable or replaceable.

It is not necessarily a physical database row.

Examples:

```text
Task
JournalEntry
Board
Quadrant
Settings
```

An entity can represent an aggregate when multiple physical rows must remain atomic.

This distinction is essential because raw row-level replication can temporarily create states that never existed in the source application.

### 5.3 Atomic change set

A **change set** is a logically atomic set of entity changes produced by one local transaction or one intentional synchronization operation.

Example:

```text
Move Task 42 from Quadrant A to Quadrant B

ChangeSet:
  Task#42       updated
  Quadrant#A    updated
  Quadrant#B    updated
```

Remote devices must apply the complete change set atomically.

### 5.4 Revision

A **revision** is a server-assigned monotonically increasing position in the synchronization history.

The revision is the authoritative ordering mechanism.

Wall-clock timestamps are metadata only and must never be used to establish causality or ordering.

Example:

```text
revision 100
revision 101
revision 102
...
```

Both VCS commits and realtime incremental commits advance the same revision space.

### 5.5 Base / common ancestor

Each device records the remote revision and corresponding local state at which it last agreed with the remote.

Conceptually:

```text
             BASE
            /    \
        LOCAL   REMOTE
```

The base is required for real three-way merge.

A content hash alone is insufficient for merging because a hash identifies a state but does not contain the state itself.

The framework should therefore retain access to the actual base checkpoint locally, or be able to retrieve the exact base from the backend when needed.

### 5.6 Pending changes

Pending changes are the local changes that exist after the current base and have not yet been durably published/acknowledged.

They are synchronization infrastructure, not the application's source-of-truth data model.

---

## 6. Checkpoints

A **checkpoint** is a complete representation of the syncable application state at a specific revision.

Checkpoints provide:

- new-device bootstrap
- recovery
- restore points
- efficient history navigation
- bounded synchronization history
- a safe fallback when incremental history is unavailable

A checkpoint contains the complete syncable state, not just changed records.

Checkpoint storage is independent from incremental change history.

Conceptually:

```text
Checkpoint v100
    ↓
Changes v101, v102, v103, ...
    ↓
Checkpoint v200
    ↓
Changes v201, v202, ...
```

Old incremental history can be garbage-collected once checkpoints make it unnecessary for supported clients to catch up.

---

## 7. User-visible backup/checkpoint history

The framework should optionally maintain a user-visible history of checkpoints.

Configuration might look conceptually like:

```text
retainCheckpoints = 3
```

meaning the framework preserves the latest three historical restore points in addition to the current state.

This is distinct from synchronization history.

### Synchronization history

Internal protocol data used to move devices forward incrementally.

### User checkpoint history

Intentional or automatically created complete states that the user can restore.

Realtime mode must retain this capability. Realtime synchronization must never turn off the ability to restore historical checkpoints.

---

## 8. Version Control System Mode

VCS mode is the explicit synchronization model.

### Local edits

Local edits are immediately applied to the local database.

No remote request is required.

The framework records the resulting pending changes locally.

### Commit

A commit may be triggered by:

- an explicit user button
- an application-defined autosave trigger
- another developer-defined event

The framework packages the current pending work into an atomic commit.

For simplicity and maximum safety, the VCS commit path may use a complete checkpoint as its representation even when incremental change information is available.

This gives VCS mode a simple mental model:

```text
Working State
     │
     │ commit
     ▼
Checkpoint / Revision
```

### Pull

Pull is likewise explicit.

The framework determines whether the remote has advanced and whether the local state has diverged from the common base.

Possible outcomes:

```text
UpToDate
LocalAhead
RemoteAhead
Diverged
```

### Three-way merge

When both sides changed relative to the common base, the framework performs three-way comparison:

```text
             Base
            /    \
        Local    Remote
            \    /
             Merge
```

Independent changes should be automatically merged when entity/field merge rules permit.

Unmergeable concurrent changes are presented as conflicts to the application/user.

### Conflict actions

The framework should support at minimum:

- keep local
- keep remote
- manually resolve
- merge automatically where safe
- cancel / defer

Force-overwrite operations must still create a recoverable history point when possible.

---

## 9. Real-Time Mode

Realtime mode is **not a separate synchronization architecture**.

It is VCS mode with automated publication and incremental transport.

### Local edits

The same local transaction machinery records changes.

### Automatic commit

Instead of waiting for the user/application to invoke commit:

```text
local transaction
      ↓
change set
      ↓
optional debounce/coalescing
      ↓
automatic commit
```

Commits should be batched around logical transactions and can be coalesced when safe.

The framework should not require one network request per local edit.

### Remote updates

When a remote revision becomes available:

```text
remote notification / poll
          ↓
      fetch changes
          ↓
    compare with base
          ↓
     apply / merge
```

Realtime notifications should normally be treated as **hints to check the authoritative backend**, not as the authoritative data transport themselves.

This keeps realtime transport replaceable and allows polling/fallback when notifications are missed.

### Incremental transport

Realtime mode should normally transmit only the change sets required to advance a device from its current revision to the remote revision.

A complete checkpoint remains available as a bootstrap/fallback mechanism.

---

## 10. Shared state machine

Both modes use the same relationship model.

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

Additional states may include:

- RemoteEmpty
- SignedOut
- MigrationRequired
- RemoteSchemaTooNew
- LocalSchemaTooNew
- HistoryUnavailable
- AuthenticationRequired
- Error / RetryPending

The core should expose these as explicit typed states rather than making callers infer them from exceptions.

---

## 11. Three-way merge model

The merge engine is backend-independent.

Inputs:

```text
base
local
remote
```

Outputs:

```text
merged state
or
conflict set
```

### Default merge behavior

At minimum, the framework should understand these cases:

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

The developer should be able to provide policies such as:

```text
WholeEntityConflict
FieldWiseMerge
CustomMerge
LastWriterWins (explicit opt-in)
```

The framework must never silently apply a potentially destructive merge policy merely because it is convenient.

### Future extension

More sophisticated collaborative data types can eventually be supported without changing the core storage protocol. CRDT-like behavior may be implemented as an advanced merge policy, but is not a requirement for the first framework version.

---

## 12. Deletes and tombstones

Whole checkpoints naturally represent deletion by omission.

Incremental synchronization cannot do this because absence from a delta is ambiguous.

Therefore realtime change history must represent deletion explicitly:

```text
revision 201
    Task#42 DELETE
```

These tombstones are synchronization history, not necessarily permanent rows in the application database.

They may be garbage-collected after a suitable checkpoint makes them unnecessary for all supported catch-up paths.

---

## 13. Server-side protocol requirements

The abstract backend must provide the semantic guarantees below, regardless of implementation technology.

### Authoritative revision ordering

The server assigns the canonical revision.

Client clocks are never used for ordering.

### Compare-and-swap

A commit should be accepted only when its expected parent/base revision is still current, unless the framework explicitly performs a validated force/overwrite operation.

This prevents concurrent commits from silently overwriting each other.

### Atomic commit

A logical change set must appear remotely as one committed unit.

### Change retrieval

A device should be able to request:

```text
changes after revision X
```

when incremental history exists.

### Checkpoint retrieval

A device should be able to request a complete checkpoint.

### Checkpoint history

The backend may retain a configured number of historical checkpoints.

### Realtime notification

Where supported, the adapter may expose a notification mechanism such as database changefeeds, WebSockets, or Firebase listeners.

The core should not depend on the notification mechanism being reliable; it must have a polling/fallback path.

---

## 14. Remote backend adapter interface

The exact programming language/API can vary, but the conceptual interface should resemble:

```dart
abstract interface class SyncBackend {
  Future<RemoteHead?> fetchHead();

  Future<RemoteCheckpoint> fetchCheckpoint({
    required Revision revision,
  });

  Future<RemoteChanges> fetchChanges({
    required Revision after,
  });

  Future<CommitResult> commit({
    required Revision expectedRevision,
    required ChangeSet changes,
    required SchemaVersion schemaVersion,
  });

  Future<CommitResult> commitCheckpoint({
    required Revision expectedRevision,
    required Checkpoint checkpoint,
    required SchemaVersion schemaVersion,
  });

  Future<List<CheckpointInfo>> listCheckpoints();

  Future<RemoteCheckpoint> restoreCheckpointSource({
    required CheckpointId checkpoint,
  });

  Stream<RemoteRevisionHint> revisionHints();
}
```

The actual interface should be minimized to the capabilities the core truly needs. It should not expose Supabase/Firebase concepts directly.

A Firebase adapter and Supabase adapter should therefore implement exactly the same semantic contract.

---

## 15. Local adapter interface

Likewise, the synchronization engine should not know the local persistence technology.

Conceptually:

```dart
abstract interface class SyncLocalStore<TSnapshot> {
  Future<TSnapshot> readSnapshot();

  Future<void> replaceSnapshot({
    required TSnapshot snapshot,
    required Revision baseRevision,
  });

  Future<LocalSyncState> readSyncState();

  Future<void> updateSyncState(LocalSyncState state);

  Future<BaseCheckpoint?> readBaseCheckpoint();

  Future<void> storeBaseCheckpoint(BaseCheckpoint checkpoint);

  Future<PendingChanges> readPendingChanges();

  Future<void> recordPendingChanges(ChangeSet changes);

  Future<void> acknowledgeChanges(Revision revision);

  Future<void> applyChangesAtomically(ChangeSet changes);
}
```

The exact API should probably combine some operations into transaction-scoped abstractions once the implementation is designed, but the separation of responsibilities is important.

---

## 16. Application integration contract

The application needs to define:

### Serialization

How application state becomes a checkpoint representation.

### Entity identity

How sync entities are uniquely identified.

### Change extraction

How a local transaction maps to a change set.

### Apply logic

How a remote change set modifies local state.

### Merge policy

How the framework handles simultaneous changes to the same entity.

### Schema version

Which serialized state formats the application understands.

The framework handles the synchronization mechanics around these definitions.

---

## 17. Schema evolution

Because checkpoints and change sets can outlive a particular application build, schema compatibility is a core protocol concern.

The framework must track a serialized schema version.

Rules:

- A client must never overwrite a newer remote schema with an older representation it does not understand.
- A client must not blindly apply a checkpoint or change set with a newer schema version.
- Schema upgrades must be explicit and testable.
- Adding a new persisted field must update both checkpoint serialization and incremental synchronization semantics.

For incompatible migrations, the framework should report an explicit `SchemaTooNew` / `MigrationRequired` state rather than guessing.

---

## 18. Mode switching

Mode changes must not require data migration.

### VCS → Realtime

Recommended sequence:

```text
stop automatic sync
      ↓
resolve or publish pending local changes
      ↓
establish a synchronized base
      ↓
start realtime listeners/polling
      ↓
enable automatic incremental commits
```

### Realtime → VCS

Recommended sequence:

```text
finish in-flight commit
      ↓
stop automatic publication
      ↓
retain current base/history/pending infrastructure
      ↓
enter explicit commit/pull behavior
```

The local DB format, checkpoints, revisions, and merge machinery remain unchanged.

This allows a product to expose a single setting such as:

```text
Sync mode: VCS | Real-time
```

without requiring the user to understand the underlying architecture.

---

## 19. Scheduling and reliability

The synchronization core should provide reusable scheduling behavior.

### Debouncing

Coalesce bursts of edits into a logical synchronization batch where safe.

### Single-flight execution

Never run overlapping sync cycles against the same local synchronization state.

### Retry/backoff

Transient backend failures should retry automatically with bounded exponential backoff.

### Poll fallback

Realtime mode should periodically poll the backend so a missed notification cannot permanently stall synchronization.

### Offline behavior

Network failure must not block local writes.

Pending changes remain durable until acknowledged by the remote backend.

### Idempotency

Commits and change applications should be safe to retry without creating duplicate logical effects.

Adapters should translate backend-specific duplicate/timeout behavior into stable framework semantics.

---

## 20. Bootstrap and new-device synchronization

A new device should not replay the entire lifetime of the user's application history.

Preferred flow:

```text
1. obtain latest suitable checkpoint
2. install checkpoint locally
3. obtain incremental changes after checkpoint revision
4. apply changes atomically/in order
5. establish base
6. begin normal VCS or realtime operation
```

If the change history is unavailable or too old, fall back to a newer checkpoint.

This keeps synchronization cost bounded by current dataset size plus recent activity rather than total lifetime activity.

---

## 21. Restore semantics

Restoring an old checkpoint should not rewind the global revision counter.

Instead:

```text
current revision = 500
restore checkpoint from revision 420
             ↓
create new commit based on restored state
             ↓
revision 501
```

This preserves monotonic ordering and prevents other devices from encountering a remote revision that appears to move backward.

The restored state therefore becomes a new current state while the original historical checkpoint remains available according to retention policy.

---

## 22. Conflict UX

The synchronization core should produce a structured conflict result rather than forcing the UI to understand protocol internals.

Example:

```text
ConflictSet
  entity: Task#42
    base:   "Buy milk"
    local:  "Buy oat milk"
    remote: "Buy almond milk"

  entity: Journal#7
    base:   unchanged
    local:  changed
    remote: unchanged
    → automatically resolved
```

The application can render this however it wants:

- modal
- bottom sheet
- diff screen
- notification
- background resolution UI

The framework provides data and decisions, not product-specific presentation.

---

## 23. Backend adapter responsibilities vs framework responsibilities

### Framework owns

- synchronization state machine
- revision semantics
- three-way merge
- conflict detection/resolution model
- local pending-change tracking
- checkpoint creation/restoration
- mode switching
- VCS scheduling
- realtime scheduling
- batching/debouncing
- retry/backoff
- schema compatibility
- bootstrap/catch-up logic
- retention policies
- protocol-level error handling

### Backend adapter owns

- authentication transport
- API calls
- database queries
- server-side transactions
- server-side CAS implementation
- storage of checkpoints/change history
- backend-native realtime subscriptions
- serialization to backend-specific primitives
- backend error translation
- security rules/RLS/permissions

### Application owns

- domain schema
- local database tables/collections
- entity identity
- local transaction semantics
- serialization
- merge policies
- UX
- which synchronization mode to expose
- how/when to trigger VCS commits or mode changes

---

## 24. Suggested package/module structure

A possible framework package structure:

```text
sync/
├── core/
│   ├── sync_engine
│   ├── sync_state_machine
│   ├── revision
│   ├── change_set
│   ├── commit
│   ├── checkpoint
│   ├── base_state
│   ├── conflict
│   └── errors
│
├── merge/
│   ├── merge_engine
│   ├── merge_policy
│   ├── field_merge
│   └── conflict_set
│
├── local/
│   ├── local_store.dart
│   ├── local_change_tracker.dart
│   └── local_metadata_store.dart
│
├── remote/
│   ├── sync_backend.dart
│   ├── remote_revision.dart
│   └── remote_notification.dart
│
├── scheduling/
│   ├── debounce
│   ├── retry
│   ├── polling
│   └── realtime_scheduler
│
├── adapters/
│   ├── supabase/
│   ├── firebase/
│   └── ...
│
└── api/
    └── public framework API
```

Adapters should live outside the core package where practical so the core has no dependency on any particular backend SDK.

---

## 25. Testing strategy

The synchronization core must be heavily tested without a real cloud backend.

### Core state-machine tests

Test every transition between:

- UpToDate
- LocalAhead
- RemoteAhead
- Diverged
- RemoteEmpty
- schema incompatibility
- unavailable history

### Merge tests

Given exact `base`, `local`, and `remote` states, verify:

- identical state
- local-only changes
- remote-only changes
- independent changes
- conflicting changes
- creates
- updates
- deletes
- rename/reordering cases where supported

### Crash/retry tests

Simulate failures:

- before commit
- after server acceptance but before client acknowledgement
- during change retrieval
- during checkpoint replacement
- during mode switching
- during checkpoint restore

The resulting behavior must remain idempotent and recoverable.

### Adapter contract tests

Every backend adapter should run the same abstract contract suite.

For example:

```text
SupabaseAdapterContractTest
FirebaseAdapterContractTest
CustomHttpAdapterContractTest
```

This is critical to ensuring that backend implementations remain semantically equivalent even though their APIs differ.

### Property/invariant tests

Useful invariants include:

- a successful commit never loses already committed remote changes
- revisions never decrease
- applying the same change set twice has no additional logical effect
- a failed local snapshot replacement leaves the prior local state intact
- restoring a checkpoint always produces a new forward revision
- switching modes does not alter application state
- offline local edits never require network access to succeed

---

## 26. Security requirements

The framework should define the security semantics but leave enforcement details to adapters.

At minimum:

- users can only access their own synchronized state
- backend authorization must apply to checkpoints and change history
- clients cannot choose arbitrary server revisions as authoritative without backend validation
- force overwrite must remain an explicit operation
- device identifiers/labels are metadata, not authentication
- sensitive application data should not be placed into notification payloads merely to signal changes

Supabase can implement these with RLS and transactional functions; Firebase can implement equivalent restrictions with its security model.

---

## 27. Storage strategy

The framework should distinguish three classes of remote storage:

### Current materialized state

The latest complete state for easy bootstrap and inspection.

### Incremental history

Recent change sets required for efficient realtime synchronization and catch-up.

### Checkpoints

Selected complete historical states retained for recovery/restore.

This avoids the two undesirable extremes:

```text
only snapshots
→ inefficient realtime synchronization

only infinite event log
→ unbounded history/storage and expensive bootstrap
```

The intended model is:

```text
             current state
                  │
          recent change history
                  │
      periodic / retained checkpoints
```

---

## 28. Migration from the existing Quadra implementation

The current Quadra snapshot implementation provides a strong starting point rather than something to discard.

Existing concepts that should survive:

- `QuadraSnapshot`-style complete state representation
- content hashing/canonicalization
- server-assigned versions
- CAS commit semantics
- transactional snapshot replacement
- schema version checks
- realtime-as-a-hint behavior
- bounded history
- explicit conflict policies
- backend/local/auth interfaces

The main evolution is to generalize the model:

```text
Current Quadra:
    local snapshot ↔ remote snapshot

Framework target:
    local materialized state
      ↕
    base checkpoint
      ↕
    pending atomic change sets
      ↕
    incremental remote revisions
      ↕
    complete checkpoints
```

The current all-or-nothing snapshot path should remain available as the VCS/checkpoint path and as the bootstrap/recovery mechanism for realtime synchronization.

---

## 29. Recommended implementation phases

### Phase 1 — Extract the abstract core

Extract the existing Quadra state machine into backend-neutral types and interfaces.

Implement:

- revisions
- base state
- checkpoints
- VCS commit/pull
- three-way merge interfaces
- conflict model
- history/restore
- schema validation
- scheduling/retry

No Supabase-specific types should cross the core boundary.

### Phase 2 — Formalize atomic sync units

Define the application-facing entity/change-set model.

Implement local transaction → change-set capture.

Ensure related changes can be represented as one atomic logical batch.

### Phase 3 — Add incremental backend history

Extend the backend contract with:

```text
fetchChanges(afterRevision)
commit(changeSet)
```

Maintain a bounded remote history alongside complete checkpoints.

### Phase 4 — Implement realtime mode

Build automatic batching, publication, remote notification handling, catch-up, and conflict detection on top of the same core.

### Phase 5 — Implement a second backend adapter

Supabase should be one adapter, then a second fundamentally different backend (for example Firebase) should be implemented against the same contract.

The purpose is to prove that the abstraction is truly backend-agnostic rather than merely abstracting Supabase terminology.

### Phase 6 — Optimize and expand merge semantics

Add field-aware/custom merge strategies only where real applications demonstrate the need.

Do not prematurely introduce CRDT complexity.

---

## 30. Final architectural thesis

The framework should ultimately be understood as a **local-first version-control and replication engine for application state**.

VCS mode provides the explicit workflow:

```text
edit locally
    ↓
commit when desired
    ↓
receive remote changes when desired
    ↓
three-way merge when necessary
```

Realtime mode provides the automated workflow:

```text
edit locally
    ↓
automatically publish atomic changes
    ↓
automatically consume remote changes
    ↓
automatically merge where safe
    ↓
show a conflict only when necessary
```

Both modes use the same:

- local materialized state
- sync entities
- atomic change sets
- revision numbers
- common ancestors
- merge engine
- checkpoints
- history
- restore semantics
- schema/versioning rules
- backend interface

The only meaningful difference is **how aggressively the framework moves the system toward the next synchronized revision**.

The remote database is therefore an implementation detail, not part of the synchronization model.

A developer should be able to write:

```text
SyncCore
    + LocalAdapter
    + RemoteAdapter
    + DomainSerializer
    + MergePolicies
```

and then choose:

```text
mode = VCS
```

or:

```text
mode = REALTIME
```

without changing the application's persistence model or rewriting its synchronization logic.

That is the core design target.
