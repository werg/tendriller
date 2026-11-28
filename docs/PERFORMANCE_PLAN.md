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

## 5. Results so far (2026-11-28)

**Chronolog sync v3** (chronolog `bffd52c`, `docs/PERFORMANCE.md`; not yet vendored into Tendriller):

| N=400 | KV before | KV after | SQL before | SQL after |
|---|---|---|---|---|
| submit ms/op | 22 | ~4 (flat in N) | 26 | ~5 |
| cold sync | 4.8 s, 18.7 MB | 0.6 s, 154 KB | 9.0 s, 27.5 MB | 1.1 s, 154 KB |
| live op | 90 ms, 90 KB | 7–25 ms, 0.5 KB | 254 ms, 113 KB | 17 ms, 0.5 KB |
| reconnect, nothing new | 7.8 s, 41.6 MB | ~20 ms, 4.9 KB | 18.6 s, 60 MB | 29 ms, 4.9 KB |

**Tendriller host** (server cost tests, `server/test/host-cost.public.test.ts`): warm HTML GET and
HTML 304 need 0 SQL rows and 0 R2/Cache API reads (was 6 SQL / 7 rows + 1 cache read); router D1
reads on warm page requests 1 → 0; stored ops are no longer re-verified on sync/replay; sync reads
raw bytes only for rows the caller lacks; dependency-aware `Db` invalidation; TURN credentials reused.

**E2E baseline** (`npm run bench`, `test-results/bench/baseline-d9bb3681*.json`, before chronolog v3):
cold load to data 2.6 s (7.8 s throttled), warm reload 0.54 s, fresh device with 200 notes 6.1 s
(3–4 s CPU after the worker is ready), browser→browser op 44 ms.

## 6. Next steps

1. Vendor chronolog v3 (after the incoming chronolog refactor is merged) and re-run `npm run bench`.
2. Client boot: flatten the worker module graph (7 dependent import waves, ~650 ms cold), stop the
   page re-downloading worker chunks and QuickJS wasm, preload `configuration.json`, delay the
   service-worker release cache until after boot, serve warm HTML from the offline cache.
3. Admission: replace enrollment/discovery polling (~15 requests per new device) with pushed
   notifications; serve publication subresources without the full DO admission chain.
4. Kernel: amortize the remaining ~1 ms fresh QuickJS context + module evaluation per reducer call.
