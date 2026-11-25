# Real wall clock idle / overnight measurement

This maintained runner observes an **existing isolated synthetic staging application** for 24 or 48 actual hours. It deploys nothing, signs nobody in, creates no applications and calls no model while waiting. Use a dedicated Worker, fresh Tendril/Admission DO namespaces and dedicated synthetic account/page/native store/browser profile. Other traffic in the same Worker or namespace pollutes attribution. Isolation does not grant another account-level Free allowance.

The operator deploys staging first, confirms its source/composition/schema, then prepares a dedicated synthetic agent workspace on that service origin: `tendril workspace init --service ORIGIN --owner EMAIL --handle soak`, `npm run page:new -- soak`, `npm run init -- soak`, build and publish the signed UI with `tendril agent run` running, completes owner sign-in (which claims the agent and its pages) and browser enrollment, and verifies native/browser replication. Never reuse reviewer services or a real user's app. Resume the workspace's existing private storage (`.tendriller/agent/` and `.tendriller/pages/<page-id>/`); preserve operation IDs and signing attempts. Run only one agent program for that workspace, and stop the preparation agent program before the soak starts it again.

## Inputs and setup

Use Node 24 and the repository's installed `@playwright/test`/Chromium and Wrangler. `npm ci` installs the pinned packages without changing package.json. Follow the ordinary service-origin readiness checks before installing any downloaded app/starter packages. This tooling adds no deployment or onboarding flow.

Copy `scripts/idle-soak/config.example.json` and `adapter.example.mjs` **outside every repository**, into an operator-owned directory (0700), with files 0600. Replace every placeholder:

- `hours`: exactly 24 or 48. Each closed/background/foreground quiet phase lasts one third: 8/8/8h or 16/16/16h. Warmup, transitions, reconnect checks and analytics lag are additional time.
- `account`, `worker`, `namespaces`: exact dedicated deployed account, Worker name and all relevant Tendril/Admission namespace IDs from the deployment. IDs stay private; evidence uses namespace ordinal labels. Add any additional participating DO namespaces.
- `pageUrl`: clean HTTPS page URL on that same staging service origin, without tokens/query/fragment. `provenance.sourceCommit` and `compositionId`: exact deployed 40/64 hex identities; record schema/environment/direct-or-relay transport privately as well.
- `native.argv`: the maintained `scripts/idle-soak/native-bootstrap.mjs` as an argument array, with absolute `cwd` set to the prepared agent workspace (the folder holding `tendriller.json`). The bootstrap requires exactly one registered, initialized page with its `pages/<slug>/agent.mjs`, the agent credential `.tendriller/agent/credential.json` and the installed `@tendriller/tools`; another page in the same workspace would be opened by the same agent program and is rejected (`DEDICATED_SOAK_WORKSPACE_REQUIRED`). It starts the workspace's one `tendril agent run` as its child with an IPC channel; the observer preload reaches it through `NODE_OPTIONS` and its counters are relayed unchanged. Start via Node directly. No shell. The process must survive optional MCP exit; run the agent program, not an MCP connection whose lifetime controls it. Observed native global fetch calls have a 30-second deadline combined with the caller's own signal. The agent program's stderr is discarded to avoid leaking app data; only its fixed-shape JSON reports are read.
- `browserProfile`: dedicated persistent Chromium directory with completed enrollment. No profile may already be in use. `adapter`: absolute private module path. Tailor the example to the synthetic app, with bounded `ready`, `settle`, and `reconnect` barriers. The example uses the first-app notes UI, explicitly connects the enrolled device and requires `#submit:enabled` and a fresh coherent-read render of the exact private `expectedNoteCount` (not the always-editable fieldset). It does not perform sign-in or enrollment.
- `wrangler`: absolute installed `wrangler/bin/wrangler.js`. `wrangler login` must already be valid for the account. The collector captures `wrangler auth token --json` privately in memory with piped stdout/stderr, supports bearer or global-key credentials, and never prints credential values. No token is placed in argv, config, checkpoints or evidence.
- A persistent **headed Chromium display** is needed to verify real `document.visibilityState`. A dedicated Chromium is attached through public `connectOverCDP({noDefaults:true})`; normal Playwright launches force focus emulation and disable background throttling, which would distort this measurement. A second blank tab backgrounds the app, and bringing the app to front restores foreground residency. The runner fails if observed visibility differs. Do not substitute mocked visibility, a frozen page, laptop sleep or simulated clock time. A continuously available Xvfb display is suitable if verified on the host. Supply DISPLAY/XAUTHORITY to the user service as needed. Keep the host awake and online.

**Default run scope: native-only, without the optional MCP adapter.** The maintained bootstrap records `native-only-without-mcp-adapter`. It counts every report the agent program makes for the hub and the soak page: setup status and retries, participation status, application changes and assistant status. The page must have no prepared assistant (`assistant.json`) in this mode, because the page module would start its adapter anyway (`ASSISTANT_PREPARATION_MISMATCH`).

### Optional native MCP adapter and event forwarding

To measure the existing app's approved tool provider as well, append `--assistant` to the maintained bootstrap's argument array. Add `--events` only when the same app already has approved event permissions and a reviewed event-prefix checkpoint:

```json
"native": {
  "argv": ["/ABSOLUTE/PATH/TO/node", "/ABSOLUTE/QUALIFIED/CHECKOUT/scripts/idle-soak/native-bootstrap.mjs", "--assistant", "--events"],
  "cwd": "/PRIVATE/synthetic-agent-workspace"
}
```

Before starting this mode:

1. Stop the previous soak runner and confirm its native participant has exited **before any proposal, owner review or other preparation traffic**. Such traffic contaminates provider quiet windows even if it originates outside the observed process. Preserve its interrupted checkpoint; it earns no completed 48-hour credit. Never open a concurrent owner for the same native store.
2. Verify the workspace agent's grant for the soak page includes `assistant:manage` (`tendril status` lists its grants and scopes; the owner grants an existing page with the agent's checkbox on the dashboard). The bootstrap never broadens scopes or registers agents. In that same retained workspace, the operator explicitly runs the page's `assistant.mjs` preparation (`npm run assistant:prepare -- <slug>`, with `--events` iff the measured bootstrap will use events), retains the existing assistant key, and completes normal owner review on the selected service origin. Confirm the exact proposal, reader/command permissions, optional event permissions and selected native signer. Do not replace the application, device, agent credential or operation records. A changed key, capability set, agent credential or proposal needs explicit matching review before a soak.
3. If using events, inspect a coherent materialized read of the exact existing synthetic event prefix. Retain the original cursor and the reviewed revision/event IDs, and prepare the app's `assistant-event-cursor.json` at that verified boundary. Do not reset an uncertain cursor, silently skip new events, replay previously exported events, create replacement notes or discard retained progress. This is explicit private operator preparation, never bootstrap setup or quiet-window work.
4. The page's own `agent.mjs` connects the approved adapter inside the agent program from the retained `assistant.json`; the bootstrap verifies that a preparation exists and that its `forwardEvents` equals the selected `--events` mode (`ASSISTANT_PREPARATION_MISMATCH` otherwise). No setup, proposal, consent automation or model invocation belongs in the measured bootstrap. If approval is absent or mismatched, do not begin a quiet segment; correct the operator preparation outside measurement.

The optional mode records `native-with-mcp-adapter` and an explicit `coverage.eventsForwarding` boolean from the selected `--events` mode; adapter-online status alone never implies event-forwarding coverage. Verify one retained synthetic MCP command, approved event delivery and a coherent browser read during the explicit preflight, before quiet measurement. Preserve the exact original event prefix and operation ID; if the operator adds a permitted test note, update `expectedNoteCount` to the verified new count. No domain writes are allowed after quiet measurement begins. The adapter runs on the agent program's page owner; the bootstrap opens no second owner and copies no assistant lifecycle. It separately emits fixed boolean assistant-status IPC on real online/offline changes. Coverage records the latest `mcpOnline`, its `mcpStatusAt` timestamp and explicit `eventsForwarding` plus `eventsForwardingBlocked`; these are last-observed state, not proof of uninterrupted connectivity. Every quiet boundary remains busy while the MCP scope is selected and the latest online state is not true, even after the initial one-shot ready message. An event-forwarding activity failure also blocks initial readiness and quiet eligibility until operator repair/restart, while leaving the healthy provider and native owner running. This blockage remains recorded across provider reconnection. An offline transition restarts the active quiet barrier, and a reconnection restores eligibility. During a measured segment it is recorded as observed activity/overrun; it does not kill the native app or abort the 48-hour run merely because the optional adapter briefly disconnects.

Its initial readiness message additionally requires actual `adapter_online`. Assistant setup/status and adapter reports also count as observed native callbacks. The event loop, approval/revocation fencing, failure backoff and event forwarding remain owned by the page module inside the agent program. Cleanup sends SIGTERM to the agent program, which closes every page owner, the hub and the attach socket; only its reported `running: false` and a natural zero exit produce the fixed `native-owned-shutdown` IPC receipt. The dedicated bootstrap then explicitly disposes its own process with code zero. `processDisposal: true` records this policy; code zero does not claim graceful completion of every remote close handshake. An unexpected agent exit, agent revocation or unclean shutdown cannot emit that receipt or take the successful disposal path. Transport teardown after process disposal is outside frame-observer coverage, never part of quiet credit.

Both scopes report model dispatch as **unobserved**: `counts.modelTurns` remains **null**, not zero. MCP provider/event-forwarding coverage does not establish a ChatGPT/model turn or future conversation wake. The aggregate result remains incomplete until actual external model-dispatch coverage is supplied separately. `--events` without `--assistant` is rejected.

The driver verifies a coherent read before hiding the page. It performs no UI
interaction during hidden quiet time; after that interval ends, it brings the app
forward for the explicit reconnect/read boundary. The first-app close action
requires a reload before reconnecting its retained device.

The adapter's `reconnect` must prove a real application session reconnect (ideally a materialized cross-participant read). Merely checking that an old “connected” label remains visible is insufficient. An explicit offline/online transition and app disconnect/reconnect are boundary activity. They are measured separately; no commands are injected into quiet phases. Active retry has three attempts / 30 seconds, with expiry/cancellation; never add retry loops to the quiet wait.

`audit()` returns coverage booleans for actual model dispatch and native wakeup instrumentation. Defaults are false; reports show **null**, never zero, for unobserved counts. Instrument a private native bootstrap with `globalThis[Symbol.for('tendriller.idle-soak.record')]('wakeups')` at actual setup-notification processing and `('modelTurns')` at actual model dispatch, or use the adapter's event-driven `observe({record,signal})`. Only claim coverage after all relevant dispatch paths are instrumented. A running native callback is not evidence of a future ChatGPT conversation wake.

## Concrete invocation

With absolute paths filled and private file permissions set, choose the qualified checkout (the systemd/config templates also require this absolute path):

```bash
SOAK_CHECKOUT=/absolute/qualified/tendriller
node "$SOAK_CHECKOUT/scripts/idle-soak/metrics.mjs" --config /PRIVATE/idle-soak/config.json --state /PRIVATE/idle-soak/run-48h --probe
node "$SOAK_CHECKOUT/scripts/idle-soak/run.mjs" --config /PRIVATE/idle-soak/config.json --state /PRIVATE/idle-soak/run-48h
```

The second command is a foreground diagnostic invocation. For the actual unattended run, copy `scripts/idle-soak/idle-soak.service.example` to `~/.config/systemd/user/tendriller-idle-soak.service`, replace every absolute path (including Node), and configure the persistent display. Then:

```bash
systemctl --user daemon-reload
systemctl --user enable --now tendriller-idle-soak.service
systemctl --user status tendriller-idle-soak.service
```

The user's systemd manager must persist after logout (administrator enables lingering if necessary). The unit uses `KillMode=control-group`, 60s restart backoff, at most three starts/day, private umask, and a 20s shutdown deadline. Do not use a 48h GitHub Actions job or leave the foreground shell as the lifetime guarantee. No service is installed or started by this implementation.

Before measuring, the native bootstrap must observe a connected agent hub, the
page reported `running`, following/coordinating participation and a connected setup
channel with no reported reconciliation failure (`pairing_unavailable`,
`awaiting_owner_claim`, `setup_retry`) since; `--assistant` also requires the actual approved adapter to be online.
An empty successful reconciliation is not reported by the agent program, so this
is the observed setup state, not proof that a reconciliation pass completed. Each residency boundary
then requires no observed in-flight client requests and two seconds with no
observed client activity, bounded to thirty
seconds total. Continuous startup activity fails that barrier; startup traffic
is retained in total counters and earns no idle credit. These timers are cleared
before the quiet segment begins. The report also hashes the actual runner. Chromium can report a SharedWorker's main script as a creator-side Playwright request without a corresponding Playwright response/finish event. At startup and explicit reconnect only, the driver independently attaches to that SharedWorker's CDP target before execution. It requires `Network.loadingFinished` on the same session with `requestId === targetId`, and an executable worker reply identifying that exact target URL, before completing the matching pending script URL. The original request counter remains counted; unrelated requests stay pending. The adapter must still complete its fresh coherent application read while visible. The CDP observer detaches before the page is hidden or a quiet interval begins, and each residency/reconnect event records fixed completion evidence. This adds no idle probing, excludes no class of worker requests and invents no HTTP response or HTTP byte measurement.

Atomic fsync checkpoints are saved on events and phase boundaries; waiting uses one native timer per phase, no health polling or model turns. Restart resumes the same config/profile/native records. A crashed/interrupted quiet interval is incomplete and must run afresh; no unobserved gap earns measurement credit. Completed intervals remain retained, and interruption/failure history prevents a clean pass. Use a fresh run directory for a clean rerun. A local PID lock rejects simultaneous runners. Reboot/PID reuse may require checking and removing a stale runner.lock manually. The same native participant must not be independently supervised a second time.

The process is expected to remain alive for 48h **plus** warmup/reconnects and default 15-minute ingestion lag. Reports record native start/exit timestamps. During collection the browser/native participant have stopped. The service requires the persistent machine/display; page residency, MCP and this runner do not establish future model wake support.

## Activity timeline

Reports retain the latest 256 observed counter events in `activityTimeline`, with
`activityTimelineDropped` counting older entries removed from that timeline.
Counter totals, phase deltas and zero-budget overruns retain every observation;
timeline eviction never subtracts traffic. Old checkpoints without these events
have an empty timeline: timestamps and transport causes cannot be reconstructed.

`coverage.byteScope` is `websocket-frames`: `bytesSent` and `bytesReceived`
count observed WebSocket frame payload bytes only. Native fetch observations
increment `requests` but do not measure HTTP request or response body bytes.
Neither counter establishes total network or wire-protocol byte usage.

Each entry records the runner's observer-receipt timestamp `at` as numeric UTC
epoch milliseconds, fixed source/counter/category labels, numeric count, phase
(`closed`, `background`, `foreground`, or `boundary`) and a `stopping` flag.
Receipt time is not transport initiation time or a server timestamp. Array order
preserves receipt ordering when events share a millisecond. A stop-request marker
is persisted before abort; later teardown observations remain counted. If a stop
marker itself is eventually evicted, `stopRequestedAt` still retains the latest
attempt's boundary. Resuming starts a new stop boundary and preserves the earlier
timeline, interruption history and measured overruns.

Transport categories are `setup-watch`, `discovery-watch`, `invitations`,
`rendezvous`, `relay`, `assistant-provider`, `publication-watch`, `agent-hub`,
`control` and `other`. `agent-hub` is the agent program's one multiplexed
`/api/agent/hub` connection: setup notices, discovery, invitations, rendezvous and
assistant adapter streams of every page travel inside it, so native frames on it
cannot be attributed to one stream. Page routes classify the same under
`/api/agent/pages/<id>/` and the browser's `/_tendril/` paths. Classification uses URL pathname only and retains no URL, query, method,
body, identifier, token or arbitrary label. A category describes a path shape,
not a verified transport cause. A delayed notification, renewal, reconnect and
shutdown race must not be attributed without corresponding evidence.

The reported wakeup scope is public setup/pairing reconciliation,
participation-status and application-change callbacks. It excludes kernel-internal
activity and AI/model turns. Zero such callbacks does not establish zero kernel
wakeups or zero AI activity. These observers do not expand the declared coverage
of uninstrumented network libraries, subprocesses or external model dispatch.

## Provider metrics and permissions

The collector authenticates only read-only GraphQL queries to Cloudflare's API; it never tails Worker logs or polls application endpoints. Baseline is a separate pre-run hour; final queries cover each observed quiet interval, in exclusive-end UTC one-hour windows. Analytics requests do not invoke the measured Worker. A 5–60 minute configurable ingestion lag runs after sockets close because open WebSocket invocations may appear only when closed. No simulated-time result supplies billing duration.

Current schema introspection selects available fields and records the schema hash and field descriptions/units. Expected datasets:

| Dataset | Scope | Observations |
| --- | --- | --- |
| `workersInvocationsAdaptive` | exact scriptName | requests/errors, cpuTimeUs, duration GB-s, wallTime |
| `durableObjectsInvocationsAdaptiveGroups` | each namespaceId | raw invocations, errors, wallTime |
| `durableObjectsPeriodicGroups` | each namespaceId | activeTime/cpuTime microseconds, duration GB-s, WebSocket messages, SQL rows and legacy storage operation units |
| `durableObjectsStorageGroups` | each namespaceIds_has | max storedBytes gauge per interval; not a sum or a storage write count |

Requires account access plus **Account Analytics Read** and the relevant Workers/DO analytics access/plan entitlement. Wrangler's ordinary deployment OAuth grant may lack analytics permission. Introspection success alone does not prove dataset access. The probe records HTTP status and numeric Cloudflare codes, omitting error messages that can echo private scope. A denied HTTP 200 GraphQL response remains unavailable. Unsupported filters never fall back to account-wide data. Absent rows, null fields, expired auth, rate limits, and missing fields remain unavailable, not zero. Recollect after ingestion lag or correcting permissions:

```bash
systemctl --user stop tendriller-idle-soak.service
node "$SOAK_CHECKOUT/scripts/idle-soak/metrics.mjs" --config /PRIVATE/idle-soak/config.json --state /PRIVATE/idle-soak/run-48h
```

Do not recollect concurrently with the runner. Retention/plan windows can expire; export promptly. The tool reports available storage gauges/rows but does not invent R2/D1 metrics, billed duration from socket hours, or total invoice data. Adaptive datasets may be sampled, and periodic/storage datasets have their own aggregation semantics. No missing metrics are zero-filled.

## Budgets and evidence

Each quiet phase has explicit **zero** budgets for observed HTTP requests, socket opens/closes, frames/bytes, model turns and wakeups. Provider request/duration/SQL-row/WebSocket-message budgets are also zero for the isolated quiet windows. Legitimate expiry, relay lifetime, maintenance alarms or auto-reconnect may exceed these diagnostic budgets; retain and explain the actual overrun rather than silently raising them. Storage `max.storedBytes` is an absolute high-water gauge with no zero budget: retained application state is expected. Compare baseline and final gauges manually; their difference is not a precise write count or a billed storage delta.

`checkpoint.json`, `baseline.json`, browser profile, config and native store stay private. `report.json` contains fixed-vocabulary numeric counters, UTC timestamps in epoch milliseconds, code/status failures, provider values/units/schema hash, public deployment commit/composition, hashed provenance/adapter identity, coverage and budgets. It contains no credentials, application payloads, raw response bodies, socket URLs, Worker/account/namespace identifiers or arbitrary event labels. Export the report only from a runner-created trusted checkpoint:

```bash
node "$SOAK_CHECKOUT/scripts/idle-soak/export.mjs" --checkpoint /PRIVATE/idle-soak/run-48h/checkpoint.json --output /PRIVATE/idle-soak/evidence.json
```

Review evidence before publication. A pass requires all three complete real-wall intervals, no interruptions/failures, covered model/wakeup counters, all requested metrics and no budget overruns. Missing permissions or missing observer coverage is an incomplete result. Virtual-time unit tests prove scheduling invariants only. Browser counters cover context HTTP/page WebSockets; native counters cover global fetch/WebSocket (including setup-watch); other socket libraries, workers, WebRTC, subprocesses and OS traffic require additional instrumentation. Do not claim these scoped observers measure all network traffic. Other participants/provider metrics may reveal additional activity.

Stop with `systemctl --user disable --now tendriller-idle-soak.service`. Retain evidence and private records until review. Cleanup is operator-scoped: delete only the dedicated deployment's Worker, exact recorded DO namespaces/resources, synthetic page/account and private test profile/store after confirming no shared bindings. The runner intentionally contains no remote-delete command; do not delete a shared staging namespace or bulk-clean an account.

## Verification and references

Run `node --test scripts/test/idle-soak-native-bootstrap.test.mjs scripts/test/idle-soak-worker-bootstrap.test.mjs scripts/test/idle-soak-warmup.test.mjs scripts/test/idle-soak.test.mjs` and `node --test contract/test/setup-watch.test.mjs`. These cover virtual 48h inactivity, revoked-watch expiry, bounded retries/cancellation, residency/reconnect observations, missing/schema-denied metrics, hourly scoped queries, budgets and private persistence. They do not establish live hibernation, provider billing, the real desktop browser's visibility behavior or a completed overnight soak. Parent integration owns the repository-wide check gates.

Primary documentation inspected 2026-11-20: [DO analytics](https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/), [Workers analytics](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/), [dynamic GraphQL introspection](https://developers.cloudflare.com/analytics/graphql-api/features/discovery/introspection/), [GraphQL authentication](https://developers.cloudflare.com/analytics/graphql-api/getting-started/authentication/), [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/). The collector uses authenticated live schema discovery because field availability and entitlement can differ by account.

Focused implementation qualification: `npm ci --ignore-scripts --no-audit --no-fund`; 20 focused tests passed; `xvfb-run -a node scripts/idle-soak/check-browser.mjs` passed against a local synthetic HTTP fixture with real headed Chromium. Authenticated exact staging-s10 queries returned Worker requests/CPU/duration and DO invocations/duration/SQL rows; no permission denial was observed. Namespace 1 and both storage gauges returned no data for the selected preceding hour and remain unavailable. This probe is not isolated-soak evidence. The settings/dataset name collision is regression-tested: analytics dataset fields must have filter arguments, rather than selecting the same-named AccountSettings field.

The systemd template is a template, not an installed/verified service. Replace its `.example` suffix with `.service`, fill executable/checkpoint/display paths, and validate the resulting unit on the operator host. No remote resources were deployed or deleted while implementing the tooling.
