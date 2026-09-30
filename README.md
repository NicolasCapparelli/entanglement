# Entanglement

A local-first sync framework for personal apps. The local SQLite database is always the working copy; sync is a git-style commit protocol on top of it, in two modes:

- **VCS mode:** nothing leaves or arrives until you push or pull (or an autosave timer does). Pulls three-way merge; conflicts wait for your decision.
- **Realtime mode:** the same commits, pushed a moment after edits and pulled as soon as the server hints. Conflicts resolve by policy, and every automatic decision is logged and reversible.

Implemented twice, in **Dart** (Flutter) and **TypeScript** (Obsidian, browsers, React Native later), speaking one wire format to one Supabase schema.

**Start with [docs/how-it-works.md](docs/how-it-works.md).** It explains every part, and how Quadra uses them. The formal design is [docs/design.md](docs/design.md) ("spec §N" in code).

## Layout

| Path | What it is |
|---|---|
| `packages/entanglement` | Dart core: store, pending overlay, merge, engine, in-memory reference server, SQLite executor (native and WASM) |
| `packages/entanglement_flutter` | Flutter glue: opening the database file (native and web), app lifecycle |
| `packages/entanglement_supabase` | Dart Supabase backend, and **the server SQL** (`supabase/migrations/0001_entanglement.sql`) |
| `ts/packages/core` | `@entanglement/core`: the TypeScript core, and the sql.js executor |
| `ts/packages/supabase` | `@entanglement/supabase`: the TypeScript Supabase backend |
| `spec/vectors` | Data both implementations must reproduce exactly |
| `tool/vendor.mjs` | Copies the framework into an app |
| `docs/` | how-it-works.md, design.md, supabase-setup.md (scratch test project) |

## Using it in an app

Apps don't depend on this repository by path; they **vendor** a copy so they build and ship on their own:

```bash
node tool/vendor.mjs --dart <app>/vendor/entanglement      # Flutter app: package sources
node tool/vendor.mjs --ts   <app>/vendor/entanglement      # TypeScript app: built npm tarballs
node tool/vendor.mjs --sql  <app>/supabase/migrations/NNNN_entanglement.sql
```

Each target gets a `VENDORED.md` recording the source commit and how to wire it up:

- **Flutter:** use path dependencies to `vendor/entanglement/<package>`, and add `analyzer: exclude: [vendor/**]`.
- **npm:** `npm install ./vendor/entanglement/*.tgz --force`.

Current users: `../quadra-app` (Flutter) and `../quadra` (Obsidian plugin), listed in `APPS` in `tool/vendor.mjs`.

### Changing Entanglement

All framework work happens here, in this repository; never edit an app's `vendor/entanglement/`. To ship a change to the apps:

```bash
git commit ...                    # vendoring refuses uncommitted changes (--allow-dirty to experiment)
node tool/vendor.mjs --apps       # re-vendor every app (Dart source, TS tarballs, docs)
node tool/vendor.mjs --status     # which apps are behind HEAD
```

Then, in each app, re-resolve dependencies (`flutter pub get` / `npm install ./vendor/entanglement/*.tgz --force`), run its tests, and commit `vendor/entanglement/` together with any app changes it needs. Server SQL changes are vendored by hand into a new numbered migration (`--sql`), because an applied migration is never rewritten.

A minimal Dart app:

```dart
final tasks = Collection<Task>('tasks',
    decode: Task.fromJson, encode: (t) => t.toJson(), idOf: (t) => t.id,
    fields: {'id', 'title', 'done', 'order', 'updatedAt'},
    merge: const MergePolicy.fieldwise());

final db = await EntanglementDb.open(
  executor: await openAppDatabase('app.db'),              // entanglement_flutter
  schema: Schema(version: 1, collections: [tasks]),
  backend: SupabaseSyncBackend(client),                    // entanglement_supabase
  accounts: SupabaseAccountSource(client),
);
await db.write((tx) async => tx.put(tasks, task));
db.query(tasks).orderBy('order').watch();
await db.sync!.push(message: 'Before the trip');
```

The TypeScript API is the same, with listener callbacks in place of streams (see how-it-works §14).

## Tests

```bash
cd packages/entanglement && dart test     # store, sync scenarios, contract, vectors, 300 simulations
cd ts && npm install && npm test          # the same, in TypeScript
```

The live Supabase contract suites need a *scratch* project (see [docs/supabase-setup.md](docs/supabase-setup.md)):

```bash
cd packages/entanglement_supabase && ENTANGLEMENT_SUPABASE_URL=… ENTANGLEMENT_SUPABASE_ANON_KEY=… dart test
cd ts && ENTANGLEMENT_SUPABASE_URL=… ENTANGLEMENT_SUPABASE_ANON_KEY=… npx vitest run packages/supabase
```

After an intentional change to encoding, digests, merge rules or the wire format, regenerate the vectors with `dart run tool/vectors.dart` (in `packages/entanglement`). Both suites then enforce them.

## Status

- **Framework (both languages):** complete per the design. Both Supabase adapters pass the full contract suite against a live project.
- **Quadra:** both clients run on Entanglement. A live app ↔ plugin round trip is tested.
- **Known limitations:**
  - Web has compiled but not run in a browser.
  - A resolution that would break a reference is refused rather than turned into a new conflict.
  - The sync log's retention isn't enforced yet.
  - `importState` pins its anchor restore point; unpin it once every device has imported.
