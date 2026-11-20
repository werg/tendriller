# Host operations

Tendriller deploys one generic engine with a filtered Chronolog participant. Hosting supplies accounts, signed controls/code, introductions and lifecycle policy. Application execution stays in owned sessions.

## Fresh baseline

Use `node scripts/storage-schema.mjs` to identify the current Durable Object schema: **revision 10**, including the pairing ledger and account-setup metadata. This pre-release version supports only fresh matching storage. Apply the account migrations in order, `0001_accounts.sql` through `0005_account_setup_recovery.sql`, and create fresh `Tendril` and `Admission` namespaces. The required account-setup migrations advance their own schema marker to revision 3 and retain allocation fences. Do not point this baseline at revision 9 page storage, reinterpret an earlier setup ledger or translate old application records. Missing or mismatched storage disables the affected operation.

`scripts/provision.mjs` plans/provisions explicitly named fresh resources and writes a complete configuration. Review the intended Worker, D1 database, R2 bucket, service domain and page-domain isolation before deploying that configuration. Checked-in staging/production configuration is not evidence that resources have been prepared for the current baseline. The service workflow requires an explicit ready variable and matching storage-schema declaration; advance these only after fresh provisioning and verification.

There is one Worker entry and one set of Durable Object classes. Staging, production and isolated branch previews consume that generic engine; no version-specific deployment subclass or cutover migration selects another implementation.

## Configuration

Account-linked page setup requires both explicit additive account migrations
`0004_account_setup.sql` and `0005_account_setup_recovery.sql`. The latter advances
the account setup schema marker to revision 3 and records an independent
allocation witness for each existing setup. It supports both earlier versions
of migration 0004 without replacing retained witnesses. The engine publishes these as
`@tendriller/engine/account-setup-schema` and
`@tendriller/engine/account-setup-recovery-schema`. They do not migrate Durable
Object data. Apply them through the selected deployment's normal D1 migration
process before enabling this release's account-bound setup route; missing or
incompatible setup storage fails closed.

The detailed setup journal and allocation witnesses are bounded and are not
automatically pruned. A missing or inconsistent record requires operator
reconciliation, including after a page was deleted and its admission record
expired. Do not delete witness rows to clear a quota or rebuild a missing
journal from an owner's current login: the retained operation, original grant,
credential commitment and allocation must agree. Restore a verified storage
checkpoint when that evidence is missing. An interrupted initialization retries
the same page and atomic initialization request; it never mints a replacement
credential or charges a second allocation.

Keep the service origin separate from every page origin. Each page must have its own hostname; placing all pages below one shared origin would merge browser storage and account-session boundaries. Configure the wildcard page route/certificate, OAuth callbacks, account database, file bucket and intended anti-abuse credentials explicitly.

Store secrets in the platform's secret store. Agent bearer tokens and OAuth/page sessions are credentials; do not publish them in logs, code assets or example configuration. The runtime creates no second browser device secret. Chronolog device signing keys and epoch keys belong to the owned application store.

The service starts with creation paused. Configure and exercise owner sign-in, page claim, account status, page-origin isolation and signed publication before opening creation. Publish the exact runtime assets required by the engine. Changing configuration or building code does not deploy it.

The optional [first-party integration OAuth server](INTEGRATION_OAUTH.md) uses the
same current GitHub/Google account login. Enable it only after applying the
additive `0002_integration_oauth.sql` account migration and registering exact
clients, MCP resource, bridge credentials and signing keys. That OAuth migration
alone adds no Durable Object schema revision; the complete current engine uses
the fresh revision 10 baseline above. Account-bound setup additionally requires
`0004_account_setup.sql`, `0005_account_setup_recovery.sql` and the client's
currently granted `tendrils:create` scope. Ordinary host deployments keep OAuth disabled when `OAUTH_CONFIG_JSON`
is absent, and existing clients acquire no new scope automatically.

## Durable Object traffic budgets

The host charges authenticated page HTTP/API requests and host control WebSocket messages to `PAGE_RATE` (600/minute per page). Claimed pages also charge `ACCOUNT_RATE` (1,800/minute across that owner's pages). Unauthenticated requests can still reach the Durable Object before admission. Unclaimed pages have no account key. Relay data packets have their own packet, byte and credit bounds and are excluded from these request budgets; local authorization caching reduces repeated SQL lookups but cold starts and invalidation still require reads. The existing agent-token limit remains 300 requests/minute. Limit failures return HTTP 429 (`page_rate_limited` or `account_rate_limited`); control sockets close with 1013. The checked-in configurations and `scripts/provision.mjs` install the same limits, in separate namespaces 107 and 108.

Cloudflare's rate limiting counters are approximate and local to a Cloudflare location. They bound ordinary request volume without adding a database write to each request; they are not exact daily SQL-row quotas or a guarantee against a single expensive query. Monitor actual Durable Object rows read and written at the account and namespace level. A query plan that scans a growing table still needs an index or a bounded query. The Free plan's daily Durable Object row allowances are shared: one production page can exhaust the quota for subsequent reads or writes in other namespaces, including staging.

Use [the Free-tier operating guide](FREE_TIER.md) for separate Worker, Durable Object, D1 and R2 budgets and the cost-conscious defaults. Idle relays do not renew authorization; their next traffic reauthorizes before forwarding under the same 30-second bound. Authenticated ad-hoc activity is persisted in minute buckets, granting a full idle window with at most one extra minute of retention after eviction. Public bundled runtime/brand assets can bypass the Worker, and immutable R2 bytes are cached behind the existing access checks. Custom/error logs remain enabled at full sampling while automatic invocation records are disabled. Production and staging have independent resources but share quotas in the same account. Those traffic reductions originally required no schema change; the later setup/pairing implementation requires fresh schema revision 10 and preserves the same retained signed-code semantics. Local regression counts establish avoided work, not deployed quota headroom.

Successful OAuth callbacks include `Server-Timing` for state lookup, provider token exchange, provider profile, and account writes. Authenticated dashboard responses include session lookup, account database work, and page-summary time. Use browser Network timing on the callback and dashboard to identify the slow phase. Page summaries have a three-second deadline and a missing summary does not prevent dashboard navigation.

## Validation and deployment

Run `npm run check:release` against an exact checkpoint. Verify source provenance and archive hashes. Use the existing release/deployment workflow only for an explicitly authorized target. Service smoke checks compare contract and immutable runtime identity and require the participant limits advertised by the host.

The current-generation application can operate without host requests while its coordinator is reachable. Test control outages separately from coordinator loss. A host restart must preserve signed authority, publication head, historical code and operation retries. Code rollback is always a new authorized signed publication.

## Isolated branch previews

The branch-preview controller selects a passing exact branch head and provisions isolated Worker/account/file resources. It checks that the branch still exists before deployment. The free-tier live preview slot holds one branch at a time: deploying another branch first removes previous preview resources, including its D1 database and R2 bucket. CI still tests every branch without a live preview. Preview names and deletion targets derive from the branch; cleanup must remain scoped to its resources.

Previews use the same engine and code artifacts. They begin with creation paused and need their own working identity callbacks before accepting claims. Their disabled scheduled reconciliation means they do not qualify production scheduling. See `scripts/branch-preview.mjs plan --branch <branch>` for the concrete resource plan; deploying or deleting it is an external action.

## Operational response

Service state can pause creation or make the host read-only. Page/account holds revoke access and close introduction sockets; session device revocation is a separate signed control decision. Use account notices and appeal/review facilities for the host's moderation workflow.

### Inspect and restore staging readiness

Inspect the anonymous machine-readable surface before starting an onboarding
exercise. `/api/readiness` is separate from the strict `/api/service` contract
and does not reserve an account, page or quota:

```sh
TENDRILLER_ORIGIN=https://staging.tendriller.dev
curl --fail-with-body --show-error --silent "$TENDRILLER_ORIGIN/api/readiness"
```

Record the selected origin, `environment`, `build`, `checkedAt`, `mode`,
`creation` and `writes` with the exact deployment checkpoint. Verify that
`serviceOrigin` equals this origin and that the source/composition identities
match the intended deployment. A missing identity requires deployment evidence;
do not infer it from the runtime hash. The modes mean:

| Mode | Creation | Existing writes | Operator action |
| --- | --- | --- | --- |
| `open` | Available subject to admission and quotas | Available subject to authorization | Continue the intended exercise; creation still rechecks live state. |
| `creation_paused` | Blocked | Available subject to authorization | Inspect why the pause was selected before intentionally reopening it. |
| `read_only` | Blocked | Blocked | Resolve the operational incident before deliberately changing the mode. |
| `unavailable` or no valid readiness response | Unverified and blocked | Unverified | Check the Worker deployment, D1 binding/schema, platform errors and quotas; do not guess a mode or switch origins. |

A 404 means the selected deployment lacks the readiness endpoint. Deploy the
qualified compatible composition through the normal release gate before using
new setup clients. A 503 or malformed response is not evidence that the database
contains `creation_paused`.

An authenticated operator can inspect the actual staging row without changing
it. Verify the account, Worker and `ACCOUNTS` binding in the selected
configuration first:

```sh
node node_modules/wrangler/bin/wrangler.js d1 execute ACCOUNTS --remote \
  --config server/wrangler.staging.jsonc --json \
  --command 'SELECT id, mode FROM service_state WHERE id=1'
```

Only when reopening this exact staging deployment is intended, record its
previous mode and use a conditional transition. This command changes a known
creation pause; it cannot override a concurrent switch to read-only:

```sh
node node_modules/wrangler/bin/wrangler.js d1 execute ACCOUNTS --remote \
  --config server/wrangler.staging.jsonc --json \
  --command "UPDATE service_state SET mode='open' WHERE id=1 AND mode='creation_paused'"
```

Require exactly one changed row, then reread both the database mode and the
same-origin readiness response. Zero changes means the observed mode changed or
the row is absent: inspect again and stop the reopening attempt. Do not create a
replacement row, reset storage, or relax schema checks as a repair. Recovery
from read-only is a separate deliberate operator decision after its cause is
resolved.

If an operator explicitly authorizes a temporary qualification window whose
previous mode was `creation_paused`, the operator records that decision and
restores the previous mode after the test with the same configuration and
`UPDATE service_state SET mode='creation_paused' WHERE id=1 AND mode='open'`.
Verify the changed-row count and readiness again; a concurrent read-only
incident must remain read-only. Qualification workflows, the native reviewer,
`scripts/run-staging-acceptance.mjs` and direct browser fixtures never perform
that transition. They require open public readiness and the exact selected
source before fixture/account creation, and stop on a pause or identity mismatch.
Repository checks and onboarding repair work do not change deployed service modes.

### Recover an interrupted native MCP qualification fixture

Native MCP qualification requires a clean `build:artifacts` plus
`release:artifacts` composition. Its workflow runs `scripts/review/preflight.mjs`
before renewing reviewer credentials, and the fixture checks the selected
origin and exact deployed build again before creation and at completion. A
successful artifact build alone is not live qualification. The report
separately identifies native tool execution, browser snapshot/login checks,
browser-owned application peers, first-app kit qualification, ChatGPT web and
model behavior.

The current fixture never opens staging or records a mode-change operation.
If recovery files from an older runner include `creation-mode.json`, preserve
them as historical evidence of that older operation. Inspect the current mode
and operator activity before any separately authorized restoration; do not replay
an old mode write or override a concurrent read-only decision.

If the create child fails after saving its handle, cleanup uses that handle on
its verified original origin. If no handle survived, creation remains uncertain:
retain the private project, mark cleanup incomplete, and inspect the original
account/host evidence. Delete only a positively identified qualification-owned
page; do not create again, bulk-delete unclaimed pages or discard the private
recovery files to make a run appear clean.

Inspect reserved file bytes against host/account ledgers when diagnosing storage discrepancies. Retained signed releases keep their immutable file references; orphan cleanup must not delete those assets. Page/account deletion deliberately removes hosted resources, while independently retained application data remains subject to the application's own policy.

The account dashboard shows host lifecycle/publication activity. Local camera, microphone and location activity is tracked and stopped on the device; it is not a host sensor-history product. Use measured application/host traffic and actual deployment metrics when making capacity or cost claims.

## Headless staging validation

Run `npm run test:e2e:public` from a clean checkout matching the deployed source, with Wrangler authenticated to the staging Cloudflare account and Chromium installed for Playwright. First verify the fresh revision 10 namespace, required account migrations, source/runtime identity and open creation readiness. If staging is paused, the test stops before provisioning accounts or sessions; only an explicitly authorized operator may restore readiness under the procedure above. The suite targets `https://staging.tendriller.dev` and then provisions a disposable owner and 15-minute service session through the configured `ACCOUNTS` binding. The session uses the same cookie and account lookup as an OAuth session. No public test endpoint or permanent credential is required. The suite exercises normal page claim, signed publication and live invitation routes, then removes its known pages and account. OAuth provider consent and callback behavior are separate from this fixture.

The suite creates four pages by default, or six with Chronolog SQL enabled, and paces creation for the staging per-IP limit. Allow the per-minute window to reset before rerunning it from the same runner. Separate daily IP limits still apply.

To include the live database case, build the Chronolog checkout's public archive with `node tools/package-peer-session.mjs --sql-native --output /tmp/chronolog-staging-archive`. Install the archive in a separate consumer directory with `npm install --prefix /tmp/chronolog-staging-consumer --ignore-scripts <archive.tgz>`. Set `E2E_CHRONOLOG_CONSUMER=/tmp/chronolog-staging-consumer` when running the suite. This adds two SQL scenarios. In the checklist, two peers race to claim the same task, the losing peer cannot finish it, and the completed assignment survives reconnect and coordinator takeover. In private intake, an uninvited account cannot open the page, the respondent can correct an answer, the facilitator cannot overwrite it, and a stale draft cannot replace the current answer. The field inspection specimen exercises notes and a supplied photo through an offline reload, reconnection and local discard. Browser SQL execution and OPFS are qualified separately by the Chronolog package workflow.

For browser-owned SQL, pack the Chronolog session with both `--sql-native --sql-browser` and install that archive in the consumer directory. Build the matching WASM assets using `node tools/build-wasm-engine.mjs --emsdk <pinned-emsdk> --output <wasm-directory>` from the same Chronolog checkout. Set `E2E_CHRONOLOG_WASM=<wasm-directory>` alongside `E2E_CHRONOLOG_CONSUMER`. This adds two pages to the suite. It publishes the browser Worker and verified WASM assets as signed page files, admits a separate guest through the browser approval flow, and exercises checklist actions and private answer corrections across two Chromium contexts over the deployed relay. The test runner supplies test-device enrollment and keys out of band. The inspection camera check uses Chromium's virtual camera.

Run the **Live staging acceptance** workflow from `master` for the complete jig. Its public source/readiness job runs before the separate SQL fixture checkout and dependency builds. The service workflow calls the same gate after a successful staging deployment and before production promotion. The hosted runner uses the normal staging quota. The suite creates at most ten pages per clean run and paces requests to respect the five-per-minute budget. Keep parallel runs off the same staging environment. To run locally, install Chromium and WebKit with `npx playwright install --with-deps chromium webkit`, set `E2E_MOBILE_MATRIX=1` and the optional Chronolog asset paths above, then run `node scripts/run-staging-acceptance.mjs`. The wrapper checks current readiness before spawning Playwright, and each directly invoked staging fixture repeats that check before writing an account. Neither path opens or restores a service mode. These separately pinned SQL fixtures do not qualify the new events-only first-app composition; the exact-kit first-app runner records that evidence independently.

The mobile jig uses an iPhone WebKit profile and an Android Chromium profile. It simulates camera permission denial, touch controls and loss of connectivity. The regular Chromium check uses a virtual camera and verifies that capture releases its track. These results do not qualify camera switching, permission prompts or operating system suspension on physical phones.
