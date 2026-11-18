# Host operations

Tendriller deploys one generic engine with a filtered Chronolog participant. Hosting supplies accounts, signed controls/code, introductions and lifecycle policy. Application execution stays in owned sessions.

## Fresh baseline

Use `node scripts/storage-schema.mjs` to identify the current Durable Object schema. This pre-release version supports only fresh matching storage. Initialize the account database from `server/migrations/0001_accounts.sql` and create fresh `Tendril` and `Admission` namespaces. Do not point a new application baseline at existing page storage or translate old application records.

`scripts/provision.mjs` plans/provisions explicitly named fresh resources and writes a complete configuration. Review the intended Worker, D1 database, R2 bucket, service domain and page-domain isolation before deploying that configuration. Checked-in staging/production configuration is not evidence that resources have been prepared for the current baseline. The service workflow requires an explicit ready variable and matching storage-schema declaration; advance these only after fresh provisioning and verification.

There is one Worker entry and one set of Durable Object classes. Staging, production and isolated branch previews consume that generic engine; no version-specific deployment subclass or cutover migration selects another implementation.

## Configuration

Keep the service origin separate from every page origin. Each page must have its own hostname; placing all pages below one shared origin would merge browser storage and account-session boundaries. Configure the wildcard page route/certificate, OAuth callbacks, account database, file bucket and intended anti-abuse credentials explicitly.

Store secrets in the platform's secret store. Agent bearer tokens and OAuth/page sessions are credentials; do not publish them in logs, code assets or example configuration. The runtime creates no second browser device secret. Chronolog device signing keys and epoch keys belong to the owned application store.

The service starts with creation paused. Configure and exercise owner sign-in, page claim, account status, page-origin isolation and signed publication before opening creation. Publish the exact runtime assets required by the engine. Changing configuration or building code does not deploy it.

## Durable Object traffic budgets

The host charges page HTTP/API requests that reach the Durable Object and host control WebSocket messages to `PAGE_RATE` (600/minute per page). Claimed pages also charge `ACCOUNT_RATE` (1,800/minute across that owner's pages). Unclaimed pages have no account key. Relay data packets have their own packet, byte and credit bounds and are excluded from these request budgets; local authorization caching reduces repeated SQL lookups but cold starts and invalidation still require reads. The existing agent-token limit remains 300 requests/minute. Limit failures return HTTP 429 (`page_rate_limited` or `account_rate_limited`); control sockets close with 1013. The checked-in configurations and `scripts/provision.mjs` install the same limits, in separate namespaces 107 and 108.

Cloudflare's rate limiting counters are approximate and local to a Cloudflare location. They bound ordinary request volume without adding a database write to each request; they are not exact daily SQL-row quotas or a guarantee against a single expensive query. Monitor actual Durable Object rows read and written at the account and namespace level. A query plan that scans a growing table still needs an index or a bounded query. The Free plan's daily Durable Object row allowances are shared: one production page can exhaust the quota for subsequent reads or writes in other namespaces, including staging.

Use [the Free-tier operating guide](FREE_TIER.md) for the separate Worker, Durable Object, D1 and R2 budgets, measured local regression results, relay renewal/receipt calculations and a before/after measurement plan. Production and staging have independent resources but share quotas when deployed to the same account. Hibernatable sockets already avoid idle duration; focus on unnecessary SQL and alarm writes without relaxing the 30-second relay authorization lifetime, ad-hoc expiry or signed-code retention. Orphan cleanup now scans a retained-hash reference set instead of repeating a correlated lookup; it adds no index and keeps storage schema revision 9. Local regression counts do not establish deployed quota headroom.

Successful OAuth callbacks include `Server-Timing` for state lookup, provider token exchange, provider profile, and account writes. Authenticated dashboard responses include session lookup, account database work, and page-summary time. Use browser Network timing on the callback and dashboard to identify the slow phase. Page summaries have a three-second deadline and a missing summary does not prevent dashboard navigation.

## Validation and deployment

Run `npm run check:release` against an exact checkpoint. Verify source provenance and archive hashes. Use the existing release/deployment workflow only for an explicitly authorized target. Service smoke checks compare contract and immutable runtime identity and require the participant limits advertised by the host.

The current-generation application can operate without host requests while its coordinator is reachable. Test control outages separately from coordinator loss. A host restart must preserve signed authority, publication head, historical code and operation retries. Code rollback is always a new authorized signed publication.

## Isolated branch previews

The branch-preview controller selects a passing exact branch head and provisions isolated Worker/account/file resources. It checks that the branch still exists before deployment. The free-tier live preview slot holds one branch at a time: deploying another branch first removes previous preview resources, including its D1 database and R2 bucket. CI still tests every branch without a live preview. Preview names and deletion targets derive from the branch; cleanup must remain scoped to its resources.

Previews use the same engine and code artifacts. They begin with creation paused and need their own working identity callbacks before accepting claims. Their disabled scheduled reconciliation means they do not qualify production scheduling. See `scripts/branch-preview.mjs plan --branch <branch>` for the concrete resource plan; deploying or deleting it is an external action.

## Operational response

Service state can pause creation or make the host read-only. Page/account holds revoke access and close introduction sockets; session device revocation is a separate signed control decision. Use account notices and appeal/review facilities for the host's moderation workflow.

Inspect reserved file bytes against host/account ledgers when diagnosing storage discrepancies. Retained signed releases keep their immutable file references; orphan cleanup must not delete those assets. Page/account deletion deliberately removes hosted resources, while independently retained application data remains subject to the application's own policy.

The account dashboard shows host lifecycle/publication activity. Local camera, microphone and location activity is tracked and stopped on the device; it is not a host sensor-history product. Use measured application/host traffic and actual deployment metrics when making capacity or cost claims.

## Headless staging validation

Run `npm run test:e2e:public` from the repo root with Wrangler authenticated to the staging Cloudflare account and Chromium installed for Playwright. Temporarily open page creation in the schema 9 staging database if it is paused, then restore the previous mode when the run is finished. The suite targets `https://staging.tendriller.dev` and provisions a disposable owner and 15-minute service session directly in the staging D1 database. The session uses the same cookie and account lookup as an OAuth session. No public test endpoint or permanent credential is required. The suite exercises the normal page claim, signed publication and live invitation routes, then removes its pages and account. OAuth provider consent and callback behavior are separate from this fixture.

The suite creates four pages by default, or six with Chronolog SQL enabled, and paces creation for the staging per-IP limit. Allow the per-minute window to reset before rerunning it from the same runner. Separate daily IP limits still apply.

To include the live database case, build the Chronolog checkout's public archive with `node tools/package-peer-session.mjs --sql-native --output /tmp/chronolog-staging-archive`. Install the archive in a separate consumer directory with `npm install --prefix /tmp/chronolog-staging-consumer --ignore-scripts <archive.tgz>`. Set `E2E_CHRONOLOG_CONSUMER=/tmp/chronolog-staging-consumer` when running the suite. This adds two SQL scenarios. In the checklist, two peers race to claim the same task, the losing peer cannot finish it, and the completed assignment survives reconnect and coordinator takeover. In private intake, an uninvited account cannot open the page, the respondent can correct an answer, the facilitator cannot overwrite it, and a stale draft cannot replace the current answer. The field inspection specimen exercises notes and a supplied photo through an offline reload, reconnection and local discard. Browser SQL execution and OPFS are qualified separately by the Chronolog package workflow.
