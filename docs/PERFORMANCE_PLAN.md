# Performance overhaul plan (Tendriller + Chronolog)

Status: in progress (2026-11-28). Pre-launch, so wire formats, storage layouts and
APIs may change freely. Constraint: every step stays peer-to-peer capable; central
resources (Worker, DO, R2, Cache API) are optional accelerators only.

## 1. Measured baseline (chronolog `pnpm bench`, KV reducer, private log)

| N=400 ops | baseline |
|---|---|
| local submit | 22 ms/op (9 QuickJS contexts, 7 `describe` calls, ~27 KB SHA-256 per op) |
| cold sync to a fresh peer | 4.8 s, 18.7 MB on the wire (~47 KB/op) |
| live op A→B | 90 ms, 90 KB on the wire per op |
| reconnect, nothing new | 7.8 s, 41.6 MB |

CPU profile of the run: 30% QuickJS `evalCode` (modules recompiled per call), ~25%
JSON+hex record codec (`encodeRecord`/`decodeRecord`/`hexToBytes`), 20% GC.

Root causes (file references in chronolog `packages/`):
- Sync pushes the full fact set on every connect and change; there is no reconciliation.
  Knowledge is per-connection, not seeded from hello (`peer-session/src/network.ts`, `network-facts.ts`).
- Derived CAS (one O(N) seen-ops node per op, SQLite page versions) is replicated (`session.ts exportFacts`).
- Wire is canonical JSON with hex bytes, decoded in 5 passes (`authority/src/codec.ts`, `network-wire.ts`).
- Kernel per op: `hashSeenOpsSet` O(N log N) + O(N) CBOR/SHA, `structuredClone` of all topics,
  `buildVisibleOutcomes` O(N), whole-map `computeStateRoot` (`materializer/src/kernel.ts`).
- Fresh QuickJS context and module compile per reduce/query/describe (`quickjs-sandbox.ts`).
- Per-op signed retention receipts, verify-before-dedupe, O(N) `inspectOperation` per envelope.

## 2. Instrumentation

- Chronolog: `perfCount`/`perfTime`/`perfCounters` in `@chronolog/canonical` (process-wide counters:
  sha256 bytes, CBOR, Ed25519, VM contexts and calls, kernel and session timings, wire bytes by message type).
- Chronolog bench: `bench/sync.bench.ts` (`pnpm bench`), JSON results in `bench/results/`.
- Tendriller server: `Server-Timing` on page, asset, API and control paths, plus an opt-in timing log.
- Tendriller browser: `performance.mark`/`measure` across the boot path (`tendril:*`), exposed via
  `window.tendril.perf()` and diagnostics.
- Tendriller e2e bench: local packed host + Playwright measuring cold and warm page load to first data
  render, first-peer convergence, and op round trip, with JSON output for comparison.

## 3. Chronolog changes (protocol v3)

1. Kernel O(1)-per-op: drop the per-op seen-ops CAS node (seen set kept in memory, committed lazily
   at snapshot/checkpoint), copy-on-write topic states, lazy `opOutcome` host call, incremental
   per-topic state root, per-topic describe cache, cheaper snapshots.
2. Session: decode once, dedupe before verify, incremental rematerialize, no per-op retention signing,
   indexed `inspectOperation`.
3. Sync: small hello (no facts), range-fingerprint set reconciliation over fact ids (1 RTT when
   equal), batched binary fact frames of raw signed bytes, live push of new facts only,
   never replicate derived CAS.
4. Wire: binary CBOR messages with raw bytes; no JSON/hex on hot paths.
5. Snapshot bootstrap served over the wire and by the host, followed by suffix-only sync.

## 4. Tendriller changes

Server: isolate TTL caches (subdomain, entitlements, service mode, ICE), 304 before byte reads,
memoized publication manifest and injected HTML, key-aware `Db` invalidation, batched `meta` preload,
incremental control-state replay (no re-verify of stored ops, no full-blob reads), relay per-packet
CPU, lazy cold route modules.

Client: inline configuration, `modulepreload` hints, non-blocking runtime script, parallel
participation refresh, single boot `syncControl`, shorter dial delays, stale-while-revalidate first paint.

## 5. Results

Recorded in section 6 as each step lands (bench JSON under chronolog `bench/results/` and
tendriller `test-results/bench/`).
