# Benchmarks

## Size check for Mille (60k documents)

Mille spec §5.2 asks whether Entanglement copes with a Monarch-sized account. Run it with
`npm run bench:size` in `ts/` (script: `ts/bench/sizeCheck.ts`; `DOCS` and `BATCH` env vars override
the size). It is a benchmark, not a test.

**Workload.** 60,000 documents shaped like Mille's: 5,000 `txns`, 5,000 `txn_notes`, 24,000 per-day
`balances`, about 23,700 `inv_txns`, 2,000 `securities`, plus accounts, categories and rules.
Committed in 60 commits of 1,000 documents (a realistic import/feed batch), one `db.write` plus one
`push` per batch, with a checkpoint taken at the end.

**Environment.** Node 24.8, Apple-silicon Mac, sql.js (WASM SQLite) executor, `InMemoryBackend`, so
network time is excluded. Single run, no warm-up control; treat as +/-20%.

| | Plain | Encrypted (`KeyCipher`) |
|---|---|---|
| Local writes, 60 batches | 1.9 s | 1.8 s |
| Pushes: digest, seal, submit, checkpoint | 2.2 s (slowest 174 ms) | 3.2 s (slowest 693 ms, the checkpoint) |
| Checkpoint, 60,000 docs | 18.1 MiB (2.3 MiB gzip) | 24.6 MiB (15.5 MiB gzip) |
| First sync of a new device (pull from checkpoint) | 1.4 s | 3.3 s |
| Digest of the full state from scratch | 0.15 s | |

Reading the numbers:
- **Commit digest time is not a problem.** The digest is additive, so a commit costs time proportional
  to its changes. Recomputing from scratch for all 60k documents takes 0.15 s.
- **Checkpoint size is the real cost.** Ciphertext does not compress, so the encrypted checkpoint is
  about 15 MiB on the wire (24.6 MiB as stored JSON). It is downloaded once per new device and once
  per checkpoint refresh (every 200 commits or 30 days by default).
- **Steady state is cheap.** A daily feed batch is tens of documents; only the first sync and
  checkpoint creation are heavy.

**Phone timing was not measured** (no device here). Estimate: JavaScript on Hermes/JSC is roughly
3 to 6 times slower than Node, and sealing/opening 60k documents dominates the encrypted case, so
expect about 10 to 20 s for a first sync of the encrypted checkpoint on a recent phone, plus the
~15 MiB download. This is a one-time cost per new device and should run in the background with
progress shown. Measure on hardware before relying on it.

**Per-day balances vs the per-month fallback.** Per-day balances (24k of 60k documents) are
acceptable: the first-sync estimate is tolerable and steady-state cost is unaffected. The per-month
fallback would cut roughly 40% of documents (about 24k down to about 800) and shrink the first sync
by about the same proportion, so keep it in reserve if phone measurements show a first sync over
about 30 s, or if history grows far beyond Monarch's span (per-day balances add about 15k documents
per year for 40 accounts).
