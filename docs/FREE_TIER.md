# Operating within the Cloudflare Free tier

Optimize for remaining quota, especially Durable Object SQL rows written, rather than a projected dollar bill. A Free-plan limit can interrupt service even when another product has ample allowance. The figures below were checked against Cloudflare's documentation on **2026-11-18**; they are planning inputs, not observations of the deployed account.

## Separate budgets

| Product and meter | Free allowance | Period |
| --- | --- | --- |
| Workers requests | 100,000 | Day |
| Worker CPU | 10 ms per invocation | Invocation limit |
| Durable Objects compute requests | 100,000 | Day |
| Durable Objects duration | 13,000 GB-s | Day |
| Durable Objects SQL rows read / written | 5 million / 100,000 | Day |
| Durable Objects SQL stored data | 5 GB total | Account storage |
| D1 rows read / written | 5 million / 100,000 | Day |
| D1 stored data | 5 GB total; 500 MB per database | Account / database storage |
| R2 Standard storage | 10 GB-month | Month |
| R2 Standard Class A / Class B operations | 1 million / 10 million | Month |

Sources: [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [R2 pricing](https://developers.cloudflare.com/r2/pricing/).

DO SQL and D1 have separate pools despite matching row allowances. An HTTP request can consume a Worker request, a DO request, DO SQL rows and D1 rows. R2 operations are separate again. R2's monthly free allowance is not a hard daily shutdown budget; exceeding it can incur charges independently of the Workers plan.

Daily limits reset at 00:00 UTC. Aggregate each product's usage across the account. Production, staging and previews have separate resources, but the checked-in production/staging configurations name the same Cloudflare account: creating another namespace or database does not create another allowance. Include `Admission`, test traffic, cleanup and reconciliation in the totals. SQLite-backed DOs are available on Free; both checked-in `Tendril` and `Admission` declarations use SQLite.

SQL counts rows examined or changed, not statements or returned results. An unindexed lookup can read a growing table; indexes also add work when modified. DO `setAlarm()` consumes a row write, and deletes consume writes. Avoid using a count of `db.run()` calls as a complete quota measurement. See [D1 row accounting](https://developers.cloudflare.com/d1/platform/pricing/) and [DO storage accounting](https://developers.cloudflare.com/durable-objects/platform/pricing/).

## What a normal session uses

Application execution, commands and replication belong to the owned Chronolog session. Once direct RTC is established, ordinary edits do not require a Tendriller control request. Startup, authority/publication reads, introductions, coarse discovery leases and lifecycle work still use the host. Measure those separately from application activity; see [peer participation](PEER_CONNECTIONS.md).

Relay fallback keeps application payloads opaque but routes them through the DO. Each successfully delivered data packet normally causes an incoming binary message and an incoming recipient receipt. The outgoing forwarded packet and credit are different from those incoming events. Cloudflare applies a 20:1 incoming-WebSocket-message ratio for compute request billing; analytics display raw messages. Use the account's quota meter alongside raw traffic instead of comparing the raw message chart directly with the request allowance. [DO request accounting](https://developers.cloudflare.com/durable-objects/platform/pricing/)

The host already accepts hibernatable WebSockets and installs an automatic response for the fixed `{"t":"ping"}` message. Eligible idle time does not accrue DO duration, including the interval before actual hibernation. This does not remove application messages, alarms, authorization work or storage reads after a cold start. Preserve hibernation: do not add a repeating server timer or an indefinitely pending operation. See [hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/), [lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/) and [auto-response](https://developers.cloudflare.com/durable-objects/api/state/#setwebsocketautoresponse).

Relay host/account authorization lasts 30 seconds and refreshes ten seconds before expiry. Local revocation is checked on every packet. The one-hour relay lifetime and 30-second stalled-receipt deadline remain in force. Reducing SQL or redundant alarm writes must preserve these bounds, fail-closed behavior, signed publication retention and ad-hoc expiry.

## Usage reduction in the host

The implementation targets repeated host work, while preserving the existing protocol and authorization decisions:

| Path | Reduction | Remaining work |
| --- | --- | --- |
| Relay packets | Cache local authorization lookups while their underlying data is unchanged | Expiry checks, mutation invalidation, cold-start reads and periodic account revalidation |
| Alarm scheduling | Keep a suitable existing alarm instead of writing the same or a later deadline repeatedly | Earlier deadlines, fired alarms and cold-start reconciliation still require attention |
| Resident and unclaimed page HTTP/API activity | Avoid persisting an idle-expiry timestamp that these retention rules do not use | Authorized activity on a claimed ad-hoc page still updates expiry; unclaimed, held and cleanup deadlines remain unchanged |
| Page routing | Avoid duplicate page authorization and DO calls for public shared runtime assets | Page-specific content and API routes still require authorization |
| Orphan-file cleanup | Build the retained-hash reference set once with `NOT IN`, replacing a correlated lookup per stored file | Retained signed publications still protect all referenced files; this query rewrite adds no index and keeps schema revision 9 |

These reduce different meters; none establishes a fixed number of supportable users. Local regression results below establish avoided work and unchanged access behavior, not Cloudflare billing measurements.

The checked-in configurations use `assets.run_worker_first: true`. Public shared-asset routing can remove DO/D1 work while still invoking the Worker. Serving an asset directly through Cloudflare Static Assets can avoid that invocation; doing so requires deliberate path routing and equivalent headers. Keep private authored page content behind its existing authorization. [Static asset billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/) and [selective routing](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/)

Likewise, browser `Cache-Control` is not evidence that an R2 binding read hit the CDN. Explicit [Cache API integration](https://developers.cloudflare.com/r2/examples/cache-api/) can avoid repeated R2 reads for suitable public immutable assets, but still invokes Worker code. Compare browser-cache hits, edge-cache hits and R2 operations separately before claiming a saving.

### Local regression evidence

The Workerd tests exercise real local Durable Objects and SQLite. Routing counts measure actual Worker-to-DO delegations; their prior counts follow the previous router's admission-plus-handler path. SQL figures are cursor measurements, excluding alarm API writes and platform bookkeeping. The alarm-helper test uses simulated storage. No live Cloudflare account metrics were collected for these results.

| Scenario | Observed result and scope |
| --- | --- |
| Authored page/file/API routing | One DO delegation per request, reduced from the previous two; endpoint errors remain intact |
| Public shared runtime and brand assets | Zero DO delegations for GET/HEAD, reduced from the previous one |
| Optional model/resource and scoped service-worker paths | One admission DO delegation remains; private access gates and service-worker scope are preserved |
| Warm relay, separately tested for agent, owner and guest | 32 delivered binary packets plus 32 recipient receipts cause **0 SQL calls, 0 rows read and 0 rows written** after initial cache warm-up |
| Resident and unclaimed page activity | 20 authenticated agent HTTP requests cause **0 `last_access` writes**, reduced from the previous per-request write |
| Claimed ad-hoc page activity | The same 20 requests still cause **20 `last_access` writes** and advance idle expiry; anonymous page traffic does not refresh it |
| Cleanup with 1,024 distinct retained hashes across 16 versions | Old correlated query: **525,824 rows read**; new reference-set query: **2,048**, a **99.61% reduction for this fixture**; all retained files remain |
| Alarm helper, simulated storage | 100 concurrent redundant schedule calls cause **one `setAlarm()` call**; an earlier deadline is retained or advanced, and a failed write is retried |

Sources: [page routing tests](../server/test/page-cost.public.test.ts), [relay SQL tests](../server/test/relay-cost.public.test.ts), [expiry and cleanup tests](../server/test/usage.public.test.ts), [alarm-helper tests](../server/test/alarm.test.ts). Relay tests also cover immediate local revocation, expiry with a warm cache, transaction rollback, and rebuilding authorization after actual local DO eviction. Existing relay/recovery tests exercise the unchanged authorization and recovery deadlines. These checks do not establish production duration, a daily user capacity, or equivalent percentage savings for a different workload.

For comparison, the same instrumented warm relay fixture was also run against the original `d076461` commit. Its 32 delivered packets and 32 receipts examined 128 SQL rows with two agent endpoints, 192 with an agent and owner, and 256 with an agent and guest. All three now examine zero rows while the cache is warm and unchanged. This comparison excludes alarm API writes and cold-start work.

## Small planning examples

These are calculations under stated assumptions. They exclude unrelated activity and are not capacity promises.

- **Relay renewal:** one page with a continuously available relay and a successful renewal approximately every 20 seconds has `86,400 / 20 = 4,320` renewal intervals per day. Its four sockets share the page's alarm; do not multiply this by four. One necessary `setAlarm()` per interval is already about 4.3% of the account's daily DO write allowance. Ten such pages use about 43,200 alarm writes, before other writes, reconnects or independently timed sessions. The relay reconnects after its one-hour lifetime, so a real trace includes those boundaries.
- **Packet amplification:** 10,000 successfully forwarded binary packets normally produce approximately 20,000 incoming relay messages after receipts, or 1,000 compute-request equivalents under the published 20:1 ratio. Add upgrades, alarms and other host requests. Warm authorization caches reduce SQL reads, not this traffic count; packet size reduction alone does not reduce the message count.
- **Duration:** one object continuously unable to hibernate uses `0.128 GB × 86,400 s = 11,059.2 GB-s/day`, about 85% of the duration allowance. This is a diagnostic worst case, not a description of the hibernatable relay. Socket-open hours are not a substitute for measured active duration.

## Measure before changing policy

Record the revision, schema, environment, account, UTC interval, client count and selected transport for each comparison. Use matching scenarios and include a cold start; a cache that only helps while warm must be reported as such.

| Scenario | Measure |
| --- | --- |
| Cold page load, then reload with browser cache | Worker/DO requests, D1/DO rows, static-asset and R2 reads |
| Direct session: idle, then a fixed set of edits | Control traffic separately from peer traffic; no host call per ordinary edit |
| Relay: idle, then a fixed packet/receipt sequence | Upgrades, incoming frames, renewal alarms, `setAlarm()` calls, SQL reads/writes and duration |
| Relay after hibernation or local credential mutation | First-use reads, immediate local revocation, unchanged 30-second account-policy bound |
| Resident, unclaimed and claimed ad-hoc request sequences | `last_access` writes and unchanged retention/expiry behavior |
| Reconciliation, publication and cleanup | Scan sizes, row writes, retained file references and R2 operations |

Use the public fixture's `hostTraffic` for HTTP and transport counts. Local counters for SQL cursors and alarm calls can isolate a regression, but they omit platform bookkeeping and do not prove production duration. Run the existing contract/server checks and relevant public-consumer scenarios; use live staging only when separately authorized.

For deployed measurements, inspect account totals and each DO namespace's **Metrics** tab, then filter to the test page if useful. Record requests, duration, SQL rows read/written and storage; separate `Tendril` from `Admission`. D1's **Metrics > Row Metrics** and query result `meta.rows_read` / `meta.rows_written` identify account-database work. Also record Worker requests/CPU/errors and R2 storage/Class A/Class B operations. [DO metrics](https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/) and [D1 metrics](https://developers.cloudflare.com/d1/observability/metrics-analytics/)

Keep headroom for staging, cleanup, publication bursts and retries. Per-minute request and relay packet limits bound bursts; they are not daily row quotas. Do not add a durable usage write for every packet merely to count packets. Prefer aggregate platform metrics and temporary or sampled diagnostic instrumentation. The next optimization should target the measured limiting meter, without extending revocation windows or deleting retained publication history.
