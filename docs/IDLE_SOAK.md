# Real wall clock idle / overnight measurement

This maintained runner observes an **existing isolated synthetic staging application** for 24 or 48 actual hours. It deploys nothing, signs nobody in, creates no applications and calls no model while waiting. Use a dedicated Worker, fresh Tendril/Admission DO namespaces and dedicated synthetic account/page/native store/browser profile. Other traffic in the same Worker or namespace pollutes attribution. Isolation does not grant another account-level Free allowance.

The operator deploys staging first, confirms its source/composition/schema, completes owner sign-in and device enrollment, publishes the signed UI and verifies native/browser replication. Never reuse reviewer services or a real user's app. Resume the native participant's existing private storage; preserve operation IDs and signing attempts. Run only one native participant for that store.

## Inputs and setup

Use Node 24 and the repository's installed `@playwright/test`/Chromium and Wrangler. `npm ci` installs the pinned packages without changing package.json. Follow the ordinary service-origin readiness checks before installing any downloaded app/starter packages. This tooling adds no deployment or onboarding flow.

Copy `scripts/idle-soak/config.example.json` and `adapter.example.mjs` **outside every repository**, into an operator-owned directory (0700), with files 0600. Replace every placeholder:

- `hours`: exactly 24 or 48. Each closed/background/foreground quiet phase lasts one third: 8/8/8h or 16/16/16h. Warmup, transitions, reconnect checks and analytics lag are additional time.
- `account`, `worker`, `namespaces`: exact dedicated deployed account, Worker name and all relevant Tendril/Admission namespace IDs from the deployment. IDs stay private; evidence uses namespace ordinal labels. Add any additional participating DO namespaces.
- `pageUrl`: clean HTTPS page URL on that same staging service origin, without tokens/query/fragment. `provenance.sourceCommit` and `compositionId`: exact deployed 40/64 hex identities; record schema/environment/direct-or-relay transport privately as well.
- `native.argv`: exact existing Node participant command (or the maintained `scripts/idle-soak/native-bootstrap.mjs`, with cwd set to the already installed starter) as an argument array, and its absolute `cwd`. Start via Node directly so the observer preload is inherited. No shell. The process must survive optional MCP exit; run the application participant, not an MCP connection whose lifetime controls it. Observed native global fetch calls have a 30-second deadline combined with the caller's own signal. Native stdout/stderr are discarded to avoid leaking app data.
- `browserProfile`: dedicated persistent Chromium directory with completed enrollment. No profile may already be in use. `adapter`: absolute private module path. Tailor the example to the synthetic app, with bounded `ready`, `settle`, and `reconnect` barriers. The example uses the first-app notes UI, explicitly connects the enrolled device and requires `#submit:enabled` and a fresh coherent-read render of the exact private `expectedNoteCount` (not the always-editable fieldset). It does not perform sign-in or enrollment.
- `wrangler`: absolute installed `wrangler/bin/wrangler.js`. `wrangler login` must already be valid for the account. The collector captures `wrangler auth token --json` privately in memory with piped stdout/stderr, supports bearer or global-key credentials, and never prints credential values. No token is placed in argv, config, checkpoints or evidence.
- A persistent **headed Chromium display** is needed to verify real `document.visibilityState`. A dedicated Chromium is attached through public `connectOverCDP({noDefaults:true})`; normal Playwright launches force focus emulation and disable background throttling, which would distort this measurement. A second blank tab backgrounds the app, and bringing the app to front restores foreground residency. The runner fails if observed visibility differs. Do not substitute mocked visibility, a frozen page, laptop sleep or simulated clock time. A continuously available Xvfb display is suitable if verified on the host. Supply DISPLAY/XAUTHORITY to the user service as needed. Keep the host awake and online.

**Default run scope: native-only, without the optional MCP adapter.** The maintained bootstrap records `native-only-without-mcp-adapter`. It opens the app first and counts actual pairing reconciliation (notifications, retries and expiry), participation-status and session-change callbacks. No optional assistant module is imported in this mode.

### Optional native MCP adapter and event forwarding

To measure the existing app's approved tool provider as well, append `--assistant` to the maintained bootstrap's argument array. Add `--events` only when the same app already has approved event permissions and a reviewed event-prefix checkpoint:

```json
"native": {
  "argv": ["/ABSOLUTE/PATH/TO/node", "/ABSOLUTE/QUALIFIED/CHECKOUT/scripts/idle-soak/native-bootstrap.mjs", "--assistant", "--events"],
  "cwd": "/PRIVATE/synthetic-starter"
}
```

Before starting this mode:

1. Stop the previous soak runner and confirm its native participant has exited **before any proposal, owner review or other preparation traffic**. Such traffic contaminates provider quiet windows even if it originates outside the observed process. Preserve its interrupted checkpoint; it earns no completed 48-hour credit. Never open a concurrent owner for the same native store.
2. In that same retained app, the operator explicitly runs its canonical `assistant.mjs prepare` (with `--events` iff the measured bootstrap will use events), retains the existing assistant key, and completes normal owner review on the selected service origin. Confirm the exact proposal, reader/command permissions, optional event permissions and selected native signer. Do not replace the application, device, resident host credential, original setup intent or operation records. A changed key, capability set, host credential or proposal needs explicit matching review before a soak.
3. If using events, inspect a coherent applied read of the exact existing synthetic event prefix. Retain the original cursor and the reviewed revision/event IDs, and prepare the app's `assistant-event-cursor.json` at that verified boundary. Do not reset an uncertain cursor, silently skip new events, replay previously exported events, create replacement notes or discard retained progress. This is explicit private operator preparation, never bootstrap setup or quiet-window work.
4. Use the already installed app's canonical `runAssistant`. Its `prepareAssistant` request on startup is permitted only as an **idempotent** resumption of the operator-precompleted matching proposal/review. No setup, consent automation or model invocation belongs in the measured bootstrap. If approval is absent or mismatched, do not begin a quiet segment; correct the operator preparation outside measurement.

The optional mode records `native-with-mcp-adapter` and an explicit `coverage.eventsForwarding` boolean from the selected `--events` mode; adapter-online status alone never implies event-forwarding coverage. Verify one retained synthetic MCP command, approved event delivery and a coherent browser read during the explicit preflight, before quiet measurement. Preserve the exact original event prefix and operation ID; if the operator adds a permitted test note, update `expectedNoteCount` to the verified new count. No domain writes are allowed after quiet measurement begins. It passes the already-open observed owner and its reconciliation wrapper to canonical `runAssistant` through the `open` hook; no second owner or copied assistant lifecycle is created. Its readiness message requires actual `adapter_online`, native following/coordinating participation, successful initial reconciliation and a successful application query. Assistant setup/status and adapter reports also count as observed native callbacks. The event loop, approval/revocation fencing, failure backoff and event forwarding remain owned by the canonical app helper. Cleanup closes the shared owner exactly once.

Both scopes report model dispatch as **unobserved**: `counts.modelTurns` remains **null**, not zero. MCP provider/event-forwarding coverage does not establish a ChatGPT/model turn or future conversation wake. The aggregate result remains incomplete until actual external model-dispatch coverage is supplied separately. `--events` without `--assistant` is rejected.

The driver verifies a coherent read before hiding the page. It performs no UI
interaction during hidden quiet time; after that interval ends, it brings the app
forward for the explicit reconnect/read boundary. The first-app close action
requires a reload before reconnecting its retained device.

The adapter's `reconnect` must prove a real application session reconnect (ideally an applied cross-participant read). Merely checking that an old “connected” label remains visible is insufficient. An explicit offline/online transition and app disconnect/reconnect are boundary activity. They are measured separately; no commands are injected into quiet phases. Active retry has three attempts / 30 seconds, with expiry/cancellation; never add retry loops to the quiet wait.

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

Before measuring, the native bootstrap must confirm application activation,
participation readiness and initial setup reconciliation; `--assistant` also requires the actual approved adapter to be online. Each residency boundary
then requires no observed in-flight client requests and two seconds with no
observed client activity, bounded to thirty
seconds total. Continuous startup activity fails that barrier; startup traffic
is retained in total counters and earns no idle credit. These timers are cleared
before the quiet segment begins. The report also hashes the actual runner.

Atomic fsync checkpoints are saved on events and phase boundaries; waiting uses one native timer per phase, no health polling or model turns. Restart resumes the same config/profile/native records. A crashed/interrupted quiet interval is incomplete and must run afresh; no unobserved gap earns measurement credit. Completed intervals remain retained, and interruption/failure history prevents a clean pass. Use a fresh run directory for a clean rerun. A local PID lock rejects simultaneous runners. Reboot/PID reuse may require checking and removing a stale runner.lock manually. The same native participant must not be independently supervised a second time.

The process is expected to remain alive for 48h **plus** warmup/reconnects and default 15-minute ingestion lag. Reports record native start/exit timestamps. During collection the browser/native participant have stopped. The service requires the persistent machine/display; page residency, MCP and this runner do not establish future model wake support.

## Activity timeline

Reports retain the latest 256 observed counter events in `activityTimeline`, with
`activityTimelineDropped` counting older entries removed from that timeline.
Counter totals, phase deltas and zero-budget overruns retain every observation;
timeline eviction never subtracts traffic. Old checkpoints without these events
have an empty timeline: timestamps and transport causes cannot be reconstructed.

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
`rendezvous`, `relay`, `assistant-provider`, `publication-watch`, `control` and
`other`. Classification uses URL pathname only and retains no URL, query, method,
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

Run `node --test scripts/test/idle-soak-native-bootstrap.test.mjs scripts/test/idle-soak-warmup.test.mjs scripts/test/idle-soak.test.mjs` and `node --test contract/test/setup-watch.test.mjs`. These cover virtual 48h inactivity, revoked-watch expiry, bounded retries/cancellation, residency/reconnect observations, missing/schema-denied metrics, hourly scoped queries, budgets and private persistence. They do not establish live hibernation, provider billing, the real desktop browser's visibility behavior or a completed overnight soak. Parent integration owns the repository-wide check gates.

Primary documentation inspected 2026-11-20: [DO analytics](https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/), [Workers analytics](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/), [dynamic GraphQL introspection](https://developers.cloudflare.com/analytics/graphql-api/features/discovery/introspection/), [GraphQL authentication](https://developers.cloudflare.com/analytics/graphql-api/getting-started/authentication/), [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/). The collector uses authenticated live schema discovery because field availability and entitlement can differ by account.

Focused implementation qualification: `npm ci --ignore-scripts --no-audit --no-fund`; 20 focused tests passed; `xvfb-run -a node scripts/idle-soak/check-browser.mjs` passed against a local synthetic HTTP fixture with real headed Chromium. Authenticated exact staging-s10 queries returned Worker requests/CPU/duration and DO invocations/duration/SQL rows; no permission denial was observed. Namespace 1 and both storage gauges returned no data for the selected preceding hour and remain unavailable. This probe is not isolated-soak evidence. The settings/dataset name collision is regression-tested: analytics dataset fields must have filter arguments, rather than selecting the same-named AccountSettings field.

The systemd template is a template, not an installed/verified service. Replace its `.example` suffix with `.service`, fill executable/checkpoint/display paths, and validate the resulting unit on the operator host. No remote resources were deployed or deleted while implementing the tooling.
