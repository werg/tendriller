# Operating within the Cloudflare Free tier

The defaults below avoid unnecessary work by design: quiet sessions should not renew policy, immutable bytes should be reused, repeated unchanged state should not be rewritten, and shared public assets should bypass application code. A Free-plan limit can interrupt service even when another product has ample allowance. Budget figures were checked against Cloudflare's documentation on **2026-11-18**; they are planning inputs, not observations of the deployed account.

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

Logs have a separate allowance. Through November 30, 2026, Workers Free includes 200,000 log events per day with three-day retention. From December 1, [Observability pricing](https://developers.cloudflare.com/observability/pricing/) changes this to 0.5 GB per day of shared ingestion with seven-day retention; reaching that allowance stops new telemetry ingestion until the daily reset. Deployment defaults disable automatic invocation logs, avoiding a routine record for every fetch, WebSocket event and alarm. Custom/error logs stay enabled at full sampling; aggregate platform metrics remain available. The tradeoff is losing routine invocation records in log queries. Logging settings do not increase execution or SQL quotas. [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)

## What a normal session uses

Application execution, commands and replication belong to the owned Chronolog session. Once direct RTC is established, ordinary edits do not require a Tendriller control request. Startup, authority/publication reads, introductions, coarse discovery leases and lifecycle work still use the host. Measure those separately from application activity; see [peer participation](PEER_CONNECTIONS.md).

Relay fallback keeps application payloads opaque but routes them through the DO. Each successfully delivered data packet normally causes an incoming binary message and an incoming recipient receipt. The outgoing forwarded packet and credit are different from those incoming events. Cloudflare applies a 20:1 incoming-WebSocket-message ratio for compute request billing; analytics display raw messages. Use the account's quota meter alongside raw traffic instead of comparing the raw message chart directly with the request allowance. [DO request accounting](https://developers.cloudflare.com/durable-objects/platform/pricing/)

The host already accepts hibernatable WebSockets and installs an automatic response for the fixed `{"t":"ping"}` message. Eligible idle time does not accrue DO duration, including the interval before actual hibernation. This does not remove application messages, alarms, authorization work or storage reads after a cold start. Preserve hibernation: do not add a repeating server timer or an indefinitely pending operation. See [hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/), [lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/) and [auto-response](https://developers.cloudflare.com/durable-objects/api/state/#setwebsocketautoresponse).

Relay host/account authorization lasts 30 seconds from the start of its policy read. Idle relays let that authorization expire without a renewal alarm. Their next packet or receipt triggers one shared session refresh before forwarding; it checks page policy once and each distinct non-owner participant account once. Local revocation is still checked on every packet and after every asynchronous policy check. A five-second active-only timeout and a transient queue bounded to 132 events / 1,213,440 bytes prevent an unavailable policy store from accumulating traffic. Failure, revocation or overflow closes the session. No payload enters durable storage or hibernation attachments. The one-hour relay lifetime, 30-second pairing limit and 30-second stalled-receipt deadline remain in force.

## Usage reduction in the host

The implementation targets repeated host work, while preserving the existing protocol and authorization decisions:

| Path | Reduction | Remaining work |
| --- | --- | --- |
| Relay packets | Cache local authorization lookups; renew account policy only when expired admission next carries traffic | Fresh policy before forwarding after expiry; immediate local revocation; bounded transient refresh queue |
| Alarm scheduling | Keep a suitable existing alarm instead of writing the same or a later deadline repeatedly; failed work retains platform retry backoff | Earlier deadlines, successful fired alarms and cold-start reconciliation still require attention |
| Page activity | Skip unused resident/unclaimed timestamps; coalesce authenticated ad-hoc activity into minute buckets | First claim and lifetime transitions start a full idle window; rounding upward grants at most one extra minute, never early expiry; invalid credentials do not refresh it |
| Page routing | One DO admission for authored content; bundled public runtime/brand files bypass Worker execution | Locally valid page credentials pass rate admission before one fresh D1 policy read for the owner and any guest; invalid links and local sessions are rejected before traffic admission |
| Immutable R2 objects | Reuse raw bytes across requests through a named Cache API cache; cold HEAD uses metadata only | Private responses and injected HTML are never shared; authored requests retain admission/publication-membership checks, and optional resources retain admission |
| Control/publication reads | Reuse bounded verified identity/authority snapshots while local storage is unchanged | Fresh account policy and local authorization remain; mutations, rollback and eviction invalidate snapshots |
| Admission | Cache exact live/hourly counts until mutations or a time boundary require rebuilding | Durable ledger mutations and cold-start reconstruction remain authoritative |
| Metadata retries | Conditional UPSERTs skip writes when serialized values are unchanged | Actual changes still persist and invalidate caches |
| Orphan-file cleanup | Build the retained-hash reference set once with `NOT IN`, replacing a correlated lookup per stored file | Retained signed publications still protect all referenced files; this query rewrite adds no index and keeps schema revision 9 |

These reduce different meters; none establishes a fixed number of supportable users. Local regression results below establish avoided work and unchanged access behavior, not Cloudflare billing measurements.

The checked-in configurations use selective `assets.run_worker_first` patterns. The current complete bundled runtime ID and explicit root brand/favicon paths go directly to Static Assets with generated response headers. New publication manifests emit those same-origin root runtime URLs. Historical runtime IDs stay on Worker routing so missing bundled files can reach retained R2 objects. An explicit negative pattern returns a static 404 rather than falling back, so excluding every runtime ID would break old publications. The build synchronizes the bundled-ID exclusion in existing deployment configurations; generated environments derive it from the current release. Scoped legacy runtime routes continue to work. Private authored files, optional resources and scoped service-worker installation are not static exclusions. [Static asset billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/) and [selective routing](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/)

The named raw-byte cache uses the configured service origin, immutable storage key and integrity policy, never visitor cookies or query strings. Authored source is checked against its content hash before insertion; executable optional resources retain their integrity check. Authored HTML is injected separately for every admitted request. Complete successful objects alone enter the cache; validators and ranges are applied afterward. Small objects may populate in the background. For a large unbuffered object, a cold fill uses a separate R2 stream so it can populate the cache without holding or cloning the download stream. Warm reads use the cache. Cache locality and eviction mean this reduces repeated reads without guaranteeing an account-wide hit rate. [Cache API integration](https://developers.cloudflare.com/r2/examples/cache-api/)

### Local regression evidence

The Workerd tests exercise real local Durable Objects and SQLite. Routing counts measure actual Worker-to-DO delegations; their prior counts follow the previous router's admission-plus-handler path. SQL figures are cursor measurements, excluding alarm API writes and platform bookkeeping. The alarm-helper test uses simulated storage. No live Cloudflare account metrics were collected for these results.

| Scenario | Observed result and scope |
| --- | --- |
| Authored page/file/API routing | One DO delegation per request, reduced from the previous two; endpoint errors remain intact |
| Public shared runtime and brand assets | Zero DO delegations for GET/HEAD, reduced from the previous one |
| Bundled root runtime and brand assets | Real local static routing reaches the asset service without invoking a sentinel Worker; historical IDs still reach the Worker |
| Optional model/resource and scoped service-worker paths | One admission DO delegation remains; private access gates and service-worker scope are preserved |
| Warm relay, separately tested for agent, owner and guest | 32 delivered binary packets plus 32 recipient receipts cause **0 SQL calls, 0 rows read and 0 rows written** after initial cache warm-up |
| Resident and unclaimed page activity | 20 authenticated agent HTTP requests cause **0 `last_access` writes**, reduced from the previous per-request write |
| Claimed ad-hoc page activity | 20 requests across 20 seconds after claim cause **at most one additional `last_access` write**, with at least the full idle window and at most 60 seconds of extra retention |
| Quiet relay | No authorization deadline or idle policy refresh; expired admission reauthorizes on resumed traffic, including after actual eviction |
| Repeated immutable asset requests | Archived runtime, optional-resource and authored source bytes are reused after one R2 GET in each fixture; cold HEAD performs only R2 HEAD |
| Repeated metadata assignment | 20 identical assignments cause **zero SQL rows written**; mutating and resaving a cached object still persists the changed bytes |
| Warm control, definition and publication reads | 60 operations cause **zero local SQL calls, rows or signature verifications**; all 80 fresh account-policy queries in the owner/agent fixture remain |
| Warm admission counts | 20 reservations cause **zero aggregate queries or aggregate rows read**, after rebuilding the exact counts from the durable ledger |
| Admission cleanup with 1,000 old live records | 20 sweeps read **20 rows** at the advancing index boundary; the previous predicate read **at least 20,000** in the same fixture |
| Cleanup with 1,024 distinct retained hashes across 16 versions | Old correlated query: **525,824 rows read**; new reference-set query: **2,048**, a **99.61% reduction for this fixture**; all retained files remain |
| Alarm helper, simulated storage | 100 concurrent redundant schedule calls cause **one `setAlarm()` call**; an earlier deadline is retained or advanced, and a failed write is retried |

Sources: [page routing tests](../server/test/page-cost.public.test.ts), [static routing](../scripts/test/static-assets.test.mjs), [asset cache](../server/test/asset-cache.public.test.ts), [relay SQL](../server/test/relay-cost.public.test.ts), [relay renewal](../server/test/peer-relay.public.test.ts), [expiry and cleanup](../server/test/usage.public.test.ts), [metadata](../server/test/db.public.test.ts), [control reads](../server/test/control-cost.public.test.ts), [admission](../server/test/admission-cost.test.ts), [alarm helper](../server/test/alarm.test.ts). Regressions cover immediate revocation, expired leases, mutation/rollback, late policy replies, bounded queues, stream/validator behavior and actual local DO eviction. These checks do not establish production duration, a daily user capacity, or equivalent percentage savings for a different workload.

For comparison, the same instrumented warm relay fixture was also run against the original `d076461` commit. Its 32 delivered packets and 32 receipts examined 128 SQL rows with two agent endpoints, 192 with an agent and owner, and 256 with an agent and guest. All three now examine zero rows while the cache is warm and unchanged. This comparison excludes alarm API writes and cold-start work.

## Small planning examples

These are calculations under stated assumptions. They exclude unrelated activity and are not capacity promises.

- **Removed idle renewal:** the former 20-second refresh schedule implied `86,400 / 20 = 4,320` policy renewal intervals per day for one continuously available pair, or roughly 4.3% of the daily DO write allowance if each required an alarm write. Quiet sessions now have **zero policy-renewal alarms**. Pairing, one-hour lifetime, outstanding-receipt and ordinary page maintenance alarms remain; a completed burst can leave one conservative progress alarm. Active traffic reauthorizes only after its 30-second policy lease expires.
- **Ad-hoc activity:** 600 authenticated HTTP requests within one UTC minute bucket previously caused 600 inactivity writes. The minute-bucket policy needs at most one write for that bucket, without shortening the full 24-hour window. An always-active page has at most 1,440 such writes/day, plus first-claim/lifetime transitions and unrelated mutations. Resident pages have no inactivity writes.
- **Packet amplification:** 10,000 successfully forwarded binary packets normally produce approximately 20,000 incoming relay messages after receipts, or 1,000 compute-request equivalents under the published 20:1 ratio. Add upgrades, alarms and other host requests. Warm authorization caches reduce SQL reads, not this traffic count; packet size reduction alone does not reduce the message count.
- **Duration:** one object continuously unable to hibernate uses `0.128 GB × 86,400 s = 11,059.2 GB-s/day`, about 85% of the duration allowance. This is a diagnostic worst case, not a description of the hibernatable relay. Socket-open hours are not a substitute for measured active duration.

The visible waiting page uses an authenticated hibernatable WebSocket for first-publication delivery. A stable watch sends no periodic readiness requests. A disconnect triggers one authenticated readiness check and a bounded reconnect delay. Hidden or offline tabs close their watch and reconnect when available.

Runtime deployment checks the target bucket for immutable files before uploading. A complete retained release reuses those bytes and skips downloading the declared speech dependencies. A missing or mismatched bundled file is repaired before deployment.

## Verify the deployed result

Record the revision, schema, environment, account, UTC interval, client count and selected transport for each comparison. Use matching scenarios and include a cold start; a cache that only helps while warm must be reported as such.

| Scenario | Measure |
| --- | --- |
| Cold page load, then reload with browser cache | Worker/DO requests, D1/DO rows, static-asset and R2 reads |
| Direct session: idle, then a fixed set of edits | Control traffic separately from peer traffic; no host call per ordinary edit |
| Relay: idle, then a fixed packet/receipt sequence | No idle policy renewal; first resumed refresh, incoming frames, legitimate deadline alarms, SQL reads/writes and duration |
| Relay after hibernation or local credential mutation | First-use reads, immediate local revocation, unchanged 30-second account-policy bound |
| Resident, unclaimed and claimed ad-hoc request sequences | `last_access` writes; full idle window and at most one minute of ad-hoc grace after eviction |
| Reconciliation, publication and cleanup | Scan sizes, row writes, retained file references and R2 operations |

Use the public fixture's `hostTraffic` for HTTP and transport counts. Local counters for SQL cursors and alarm calls can isolate a regression, but they omit platform bookkeeping and do not prove production duration. Run the existing contract/server checks and relevant public-consumer scenarios; use live staging only when separately authorized.

For deployed measurements, inspect account totals and each DO namespace's **Metrics** tab, then filter to the test page if useful. Record requests, duration, SQL rows read/written and storage; separate `Tendril` from `Admission`. D1's **Metrics > Row Metrics** and query result `meta.rows_read` / `meta.rows_written` identify account-database work. Also record Worker requests/CPU/errors and R2 storage/Class A/Class B operations. [DO metrics](https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/) and [D1 metrics](https://developers.cloudflare.com/d1/observability/metrics-analytics/)

Keep headroom for staging, cleanup, publication bursts and retries. Per-minute request and relay packet limits bound bursts; they are not daily row quotas. Do not add a durable usage write for every packet merely to count packets. Aggregate platform metrics can validate these defaults after deployment without adding application traffic. Preserve authorization bounds and retained publication history when extending the implementation.
