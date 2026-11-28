# End-to-end performance benchmark

`npm run bench` measures what a user waits for on a published starter page: cold
and warm page load to first live data, two-browser convergence, a fresh device
opening a page with existing data, and (optionally) an agent-program peer. It
runs entirely on loopback: the unchanged packed engine under Miniflare, the
first-app starter downloaded from that host, and Playwright's Chromium.

```sh
npm run build                 # the harness measures the built dist/ + server/public
npm run bench                 # all scenarios, 5 runs, 10 ops
npm run bench -- --runs 10 --scenarios cold,warm
npm run bench -- --throttle   # 4x CPU + 150 ms injected RTT
```

| Flag | Meaning |
|---|---|
| `--runs N` | repetitions per load scenario (default 5) |
| `--ops N` | operations per convergence scenario (default 10) |
| `--scenarios LIST` | `cold,warm,converge,fresh-large,agent` (default all) |
| `--items N` / `--small-items N` | existing notes on the large (200) / small (10) page |
| `--throttle` | 4x CPU slowdown (CDP, measured page) + 150 ms RTT injected at the host |
| `--cpu N`, `--latency MS` | override either throttle component |
| `--root DIR` | measure another checkout's build (see "Stable baselines") |
| `--port N` | loopback HTTPS port (default 8795) |
| `--out FILE` | result path (default `test-results/bench/<timestamp>.json`) |
| `--headed`, `--keep` | show Chromium; keep the temporary world directory |

Results are written as JSON to `test-results/bench/` (gitignored), followed by a
console table, the representative cold and warm waterfalls, and the busiest host
endpoints.

## What happens

1. **World setup** (`workspace.mjs`, ~20 s): untar the engine archive (a snapshot), start
   `startPackedHost` (`scripts/first-app-fixture.mjs`) with persistent temp storage,
   download `/downloads/tendriller-first-app.tgz` from that host, `npm install` the
   dist SDK/tools archives plus the Chronolog session/authority archives that match
   `node_modules/@chronolog/*` (from `test/artifacts/` or `dist/`), register one
   workspace agent, and create/`init --browser-first`/`deploy` two notes pages,
   `small` (10 notes) and `large` (200 notes). This is the same path as
   `scripts/test-first-app.mjs` with explicit archives. `npm install` uses
   `--prefer-offline` (set `BENCH_NPM_CACHE` to pin a cache); the starter's only
   registry dependency must already be cached for a fully offline run.
2. **Owner browser**: the first browser creates each page's data, seeds the notes
   through `window.tendril.application.backend.submit`, and stays online for the
   whole run as the member that admits every new device.
3. **Scenarios**
   - `cold`: a new browser context (fresh profile = new device) opens the small
     page. Includes host attestation and automatic admission by the online owner.
   - `warm`: one admitted profile reloads the small page N times (IndexedDB and
     HTTP cache populated).
   - `converge`: the owner tab authors a note through the real form; times until
     its own list shows it (`localMs`) and until the warm profile renders it
     (`remoteMs`). Both clocks are the same machine's `Date.now()`.
   - `fresh-large`: like `cold`, on the 200-note page; done when all notes render.
   - `agent`: starts `tendril agent run` (admitted by the owner browser), then
     `tendril --page small command putNote … --wait materialized`; reports CLI time
     and time until the warm browser renders the note.

## Load metrics (ms since navigation start)

From Navigation Timing: `ttfb` (responseStart), `htmlDone`, `domContentLoaded`,
`load`. From an init script (`browser.mjs`):

| Milestone | Meaning |
|---|---|
| `runtimeDefined` | the host-injected runtime script defined `window.tendril` |
| `applicationReady` | `window.tendril` emitted `application_ready` (page installed its session backend, i.e. the session worker is attached) |
| `sessionStatus` | `#connection-status` first shows a session status |
| `canAuthor` | `#submit` enabled: device admitted, keys available |
| `tendrilReady` | the page called `window.tendril.ready()` (live view's first snapshot) |
| `firstItem` / `dataRendered` | first / all expected `#notes li` rendered |

Counters: `requests` (Playwright, page **and worker** requests started before
`dataRendered`), `transferBytes` (Resource Timing, page only), `requestBytes`
(Playwright header+body sizes), `hostRequests` / `hostWebSockets` (everything the
host received in the window, from any client, including the owner tab admitting
this device), `idleGapMs` (time before `dataRendered` with no recorded request in
flight: CPU work, timers or serial dependencies).

Each scenario stores every run plus a representative run (median
`dataRendered`) with its full waterfall: start, duration, TTFB, type (`*` =
worker), status, bytes, whether Resource Timing saw a cache hit, and the
`Server-Timing` header. If the page exposes `window.tendril.perf()` its output is
stored per run.

## Host-side request log

`host.mjs` wraps the first-app WebSocket forwarding Worker with a bench front
Worker that records each request (normalized route, status, time to response
headers, `Server-Timing`, `Content-Length`). `GET /__bench/requests?since=SEQ`
returns the log; the report aggregates it per endpoint for setup and scenarios.
Times are workerd `Date.now()` around the packed host's `fetch`, so they are
time-to-headers inside the isolate, without body streaming.

## Throttling

`--throttle` is an approximation: `Emulation.setCPUThrottlingRate` slows the
measured page's main thread only (workers are not CPU throttled), and the front
Worker delays every HTTP request by the RTT and every WebSocket message by half
of it, for all clients. TCP/TLS handshakes and bandwidth are not modeled.
CDP network emulation is not used because it does not cover the session's
SharedWorker/Worker traffic.

## Stable baselines

The engine is snapshotted at setup, but `server/public` (runtime script, starter
archive) is served live from the measured checkout. If another process rebuilds
it during a run the report sets `environment.buildChangedDuringRun`. For a stable
baseline, measure a private build:

```sh
git worktree add --detach /tmp/tendriller-baseline HEAD
cd /tmp/tendriller-baseline && ln -s /path/to/tendriller/node_modules node_modules
mkdir -p dist && cp /path/to/tendriller/dist/tendriller-tools-*.tgz /path/to/tendriller/dist/tools-*.json dist/
npm run build
cd /path/to/tendriller && npm run bench -- --root /tmp/tendriller-baseline
```

## Limits

- Loopback only: real-world RTTs dominate far more than here; use `--throttle`.
- All browsers and the host share one machine; background load skews results
  (the report records the node, Chromium and git state but not system load).
- Every `cold`/`fresh-large` run admits another device, so membership grows by
  one per run.
- Synthetic owner session; no OAuth provider.
