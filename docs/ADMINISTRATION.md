# Service administration

Tendriller has a backend administration API for complimentary premium access and
aggregate service usage. It is separate from ordinary accounts, page ownership,
agent grants, MCP connections, and the existing abuse/broadcast administrator.
There is no new administration UI. `scripts/admin.mjs` is the operator client;
a future private admin tendril can use the same versioned API through a trusted
server or native adapter.

## Security boundary

The `/api/admin/v1` API accepts only an independently provisioned, scoped bearer
credential. It does not accept service cookies, page keys, `ta_` agent tokens,
MCP OAuth tokens, `ADMIN_IDENTITIES`, or `BROADCAST_ADMIN_TOKEN`. A credential for
reading analytics cannot issue grants or inspect account-targeted audit records.

| Scope | Authority |
| --- | --- |
| `analytics:read` | Read aggregate service counters and inventory snapshots |
| `premium:read` | List grant history for an exact account ID |
| `premium:write` | Create and revoke bounded Pro/Team grants; receive the resulting grant record |
| `audit:read` | Read premium grant/revoke audit entries, including actors and target account IDs |

No scope confers access to page content, encryption keys, private application
state, page queries, user impersonation, arbitrary SQL, or credential management.
There is no endpoint for promoting an account to administrator. Operator
credential provisioning remains an infrastructure-level action.

Each credential is 256 random bits, with an independent ID, explicit scopes,
issue time, and expiry no more than 90 days later. The Worker stores only its
SHA-256 digest in `ADMIN_API_CREDENTIALS_JSON`, a Worker secret. The configured
credential list is revalidated on every request. Missing/empty configuration
disables the API; malformed, duplicate, or unknown configuration fails closed.
Removing a record, replacing its digest, or setting `revoked: true` revokes it
once the updated Worker secret/version is active. There is no application cache
or renewal endpoint that can prolong the credential.

Requests require the canonical service origin over HTTPS (loopback HTTP is
allowed for local development). A supplied foreign `Origin` or cross-site
Fetch Metadata value is rejected, including on reads. These routes bypass the
public API's wildcard CORS and preflight handling, return `Cache-Control:
no-store`, and never fall back to cookies. Existing edge rate-limit bindings
apply separate `admin:` keys: `AUTH_RATE` for each authenticated operator and
`FAILED_AUTH_RATE` for rejected credentials by connecting IP. The supplied
deployment configurations use 20 requests/attempts per minute respectively;
these are edge limits, not a globally atomic quota. Addresses and rejected
credentials are not persisted by the admin API.

Grant creation and first revocation write their audit record in the same SQLite
transaction through database triggers. If the audit write fails, the grant
mutation fails too. The API has no audit edit/delete operation. This is an
application integrity control, not tamper-proof storage against a compromised
Worker or database administrator.

## Provision an operator

Apply the normal D1 migrations, including `0009_premium_grants.sql` and
`0010_operational_analytics.sql`, before running this Worker revision. They are
additive migrations for the current D1 baseline. They do not reset storage or
change the Durable Object schema revision. Both are included in packaged engine
artifacts as `@tendriller/engine/premium-grants-schema` and
`@tendriller/engine/analytics-schema`.

Generate credentials on a trusted operator machine, in a private directory
outside the checkout:

```sh
node scripts/admin.mjs generate-credential \
  --id tester-operator \
  --scopes premium:read,premium:write,audit:read \
  --expires-in-days 30 \
  --token-file /private/tendriller-admin/operator.token \
  --config-file /private/tendriller-admin/operator.credentials.json
```

The parent directory must already exist. Both files must be new; creation refuses
existing files and symlinks and writes private `0600` files. The token is never
printed. The configuration is a one-record array with this shape:

```json
[
  {
    "id": "tester-operator",
    "sha256": "<64 lowercase hex characters produced by the generator>",
    "scopes": ["premium:read", "premium:write", "audit:read"],
    "issuedAt": 1795773600000,
    "expiresAt": 1798365600000
  }
]
```

The timestamp values above only illustrate epoch milliseconds; generate current
values with the command. Review and combine the record with any existing
operator records, then install the complete array on the intended environment:

```sh
npx wrangler secret put ADMIN_API_CREDENTIALS_JSON \
  --config server/wrangler.staging.jsonc \
  < /private/tendriller-admin/operator.credentials.json
```

Installing a one-record array replaces any previously configured array. Keep
production and staging credentials separate. Use a different credential with
only `analytics:read` for an analytics adapter. The maximum is 32 records;
duplicate IDs or hashes, wildcard scopes, unknown fields/scopes, and invalid
lifetimes are rejected. An optional boolean `revoked` field can disable a record.
Never place the raw token, configuration, or operator output in public source,
release assets, logs, browser storage, or a tendril's replicated state.

Provisioning is separate from the CLI's network commands: the CLI does not
deploy, install credentials, or change Cloudflare policies. It reads the token
from a bounded private regular file, rejects symlinks and unsafe POSIX file
permissions, refuses redirects, and uses a 15-second request/body deadline. It
does not accept a token on the command line or retry mutations automatically.

## Complimentary premium grants

A grant is a separate, immutable ledger entry for an existing, active account.
Choose `pro` or `team`, an absolute expiry at most 90 days away, a client-generated
UUID, and a short operational reason. Reasons must be trimmed, 1–500 characters,
without control characters. Use a cohort or support reference; do not put private
application information in a reason.

Get the exact account ID from the account holder's authenticated `GET /auth/me`
response (`accountId`). There is no fuzzy email search or account directory in
this API. A grant cannot create an account, clear a suspension, or bypass the
service's global storage and safety limits.

```sh
node scripts/admin.mjs grant \
  --server https://tendriller.dev \
  --token-file /private/tendriller-admin/operator.token \
  --id 3bb8ab9e-7737-4b84-94a9-39c19298b272 \
  --account-id ACCOUNT_ID \
  --plan pro \
  --expires-at 2026-12-20T18:00:00Z \
  --reason 'December beta cohort'
```

Use your own UUID and future timestamp. Save the exact UUID and body before the
first attempt. An exact retry returns the existing record, even after expiry or
revocation; it never extends or reactivates access. Reusing a UUID with a different
account, tier, expiry, reason, or operator identity returns `409`. To recover a
request after changing operator identity, use grant history instead of changing
the original request. A new grant requires a new UUID.

List and revoke:

```sh
node scripts/admin.mjs grants \
  --server https://tendriller.dev \
  --token-file /private/tendriller-admin/operator.token \
  --account-id ACCOUNT_ID

node scripts/admin.mjs revoke \
  --server https://tendriller.dev \
  --token-file /private/tendriller-admin/operator.token \
  --id 3bb8ab9e-7737-4b84-94a9-39c19298b272 \
  --reason 'Testing complete'
```

Revocation is idempotent and preserves the first revoking actor, timestamp, and
reason. A later revoke returns that original result. Revoked grants cannot be
edited back to active. Revocation or expiry applies on subsequent entitlement
checks and SQL quota writes without waiting for cron. It does not forcibly
terminate previously admitted in-flight work, erase pages, or delete data above
the lower quota. Work that consumes new capacity must satisfy the current limits;
releasing storage remains possible after a downgrade.

### Relationship to paid billing

`accounts.plan`, its materialized caps, and Polar subscriptions remain the
underlying billing state. The effective entitlement is the higher of the billed
tier and live complimentary grants, with at least the grant's canonical quotas.
Existing larger account overrides and unlimited self-host settings are preserved.
Page count, resident count, and storage reservation are also enforced atomically
against live grants in D1, so these checks agree with the application resolver.

While any complimentary grant is active, PAYG is disabled for new consumption.
The account's existing paid subscription and PAYG preference remain intact and
resume after grants end. Existing billable usage from before a grant is still
billable. New metered MCP calls and media bytes covered by the grant are recorded
as complimentary units as well as total usage. Complimentary units remain exempt
after expiry, revocation, or a later subscription signup, so testing cannot turn
into a delayed overage charge. Finite included allowances still apply; this does
not create an unlimited test account.

MCP grant coverage is evaluated at the trusted entitlement-check timestamp, so
an already admitted call stays exempt if its meter runs after expiry or revocation.
SFU reports contain a coalesced byte count. The server retains each session's last
usage-report time; if any grant overlaps that interval, the whole report is
complimentary. This deliberately favors the account holder because the server
cannot split client-reported bytes across the exact expiry instant. Subsequent
intervals entirely after the grant ends use ordinary billing. Client timestamps
cannot select the exemption interval. Reporting/relay measurement limits remain
as described below. Grants do not reset the monthly usage period. During a grant,
total usage is compared with the granted allowance; after it ends, exempt MCP/media
units are excluded from the underlying plan's usage allowance and charge calculation.

## Service analytics

The collector uses existing backend metering and the scheduled handler. It
does not install scripts in pages, observe browser interaction, replay private
logs, query application tables, or contact page Durable Objects to take snapshots.

| Metric | Source and meaning |
| --- | --- |
| `mcpCalls` | Metered hosted-participant attempts, including some that later fail; not all gateway tools or successful application operations |
| `relayMs` | Metered host relay activity time |
| `relayBytes` | Bytes recorded by the existing relay meter |
| `mediaBytes` | Client-reported SFU receive bytes; excludes TURN usage and provider-measured egress |
| Account counts | Total and accounts not suspended/deleting; not daily active users |
| Page counts | Total, active service records, and active resident pages; no page IDs |
| Agent counts | Registered and unrevoked agents; not proof that a process is online |
| Storage reservation/capacity | Global reserved capacity and configured service cap; not measured disk bytes |

Only UTC date keys and fixed numeric columns enter the analytics tables. There
are no account IDs, page IDs, URLs, paths, IP addresses, referrers, user agents,
tokens, payloads, topic names, custom labels, or exception text. Account-specific
billing usage and operator audit history remain distinct, access-controlled data.

Usage is aggregated when existing metering flushes. This adds one small aggregate
write to each successful usage flush, not every HTTP request or relay packet.
Inventory is captured by the existing 15-minute cron; one latest snapshot per UTC
day is retained. Inventory values are gauges and must never be summed across days.
The same maintenance task deletes records older than today plus the previous
89 UTC days. Self-hosted operators must keep the scheduled handler enabled for
snapshots and physical retention cleanup; reads always enforce the retention
window even if maintenance is delayed. Branch previews disable cron and local
development has no schedule; their inventory remains absent/stale and physical
cleanup waits until the scheduled handler runs.

```sh
node scripts/admin.mjs analytics \
  --server https://tendriller.dev \
  --token-file /private/tendriller-admin/analytics.token \
  --from 2026-11-01 --to 2026-11-27
```

Dates are inclusive UTC days. The API defaults to 30 days, accepts at most 90
retained days, rejects future dates and unknown/repeated query parameters, and
supports no account/page filters. It returns `schemaVersion: 1`, a daily series,
totals, the latest retained inventory snapshot, explicit coverage, and limitations.
The latest inventory snapshot can fall outside the requested historical range;
its own day and capture timestamp identify it. Missing days are `null`, not
measured zeroes. Totals are `null` when no usage was observed. There is no historical
backfill or assertion that a sample means the entire day was measured.

Collection failures never fail an ordinary user operation. They produce only a
fixed warning code. An unavailable analytics schema/read returns `503` rather
than a misleading empty success. The counters are operational estimates: the
existing relay meter buffers data in memory and may undercount after hibernation
or eviction, including resumed sockets until they reconnect; SFU volume is
client-reported. Daily attribution uses the meter's timestamp (the entitlement
check for MCP, reporting/flush time for media and relay).
This API does not claim authoritative costs, complete request traffic, CPU,
latency, actual D1/R2 disk usage, or unique visitors. Those remain Cloudflare
provider metrics; the existing `scripts/idle-soak/cloudflare.mjs` adapter can
inform a later service-wide metrics integration. Routine invocation logs remain
disabled in the supplied configurations.

These are aggregates without identifying dimensions, not a formal differential
privacy guarantee. An operator with outside knowledge about a tiny deployment
may infer activity from changes in totals. Keep analytics access restricted.

## HTTP contract

All endpoints are on the service origin. Supply
`Authorization: Bearer <operator token>`; JSON writes also require
`Content-Type: application/json`. Bodies are limited to 4 KiB. No HTTP route
accepts arbitrary metadata or silently ignores an undeclared input field.

| Method and path | Scope | Input / result |
| --- | --- | --- |
| `GET /api/admin/v1` | Any configured scope | API version, operator ID, permitted scopes |
| `POST /api/admin/v1/premium-grants` | `premium:write` | `{id, accountId, plan, expiresAt, reason}` → `{grant, created}`; `201` new, `200` retry |
| `POST /api/admin/v1/premium-grants/:id/revoke` | `premium:write` | `{reason}` → `{grant, revoked}`; `200`, including repeat revocation |
| `GET /api/admin/v1/premium-grants` | `premium:read` | Required `accountId`; optional `limit`/`before` → `{grants, nextCursor}` |
| `GET /api/admin/v1/analytics` | `analytics:read` | Optional `from`/`to` → service-only daily metrics and coverage |
| `GET /api/admin/v1/audit` | `audit:read` | Optional `limit`/`before` → `{entries, nextCursor}` for premium actions only |

Limits default to 50 and must be 1–100. Treat returned cursors as opaque and pass
them unchanged as `before`. Audit entries expose `id`, `actor`, `action`,
`subject` (target account), `reason`, and `createdAt`; `reason` is the stored JSON
record of the grant details/reason. Grant history includes creator/revoker IDs,
expiry and reason. There is no account-wide or page-wide enumeration endpoint.
The audit feed excludes the existing abuse and page audit actions.

Common failures: `400` invalid input, `401` inactive/missing credential, `403`
scope/origin denial, `404` disabled API or absent grant/eligible account, `409`
grant UUID conflict, `413` body limit, `415` unsupported content type, `429` edge
rate limit, and `503` unavailable administration/analytics. Unknown routes/methods
return `404`. A failed connection or `503` can leave a mutation's outcome unknown;
retain its exact request and retry or inspect grant history before issuing a new ID.

## Recommended deployment and future admin tendril

For human operators, put the admin route behind Cloudflare Access with a narrow
identity policy, MFA/passkeys and short sessions, in addition to these application
scopes. For an automated adapter, use a separate Access service credential if
that gate is enabled. This PR does not provision Access or claim MFA is enforced.
Do not interpret a normal Tendriller session or an unverified forwarded email
header as proof of privileged identity.

If Access identity is later consumed in application code, verify the JWT signature,
the fixed trusted issuer, the exact admin application's audience, expiration and
not-before. Tendriller currently has Workers Static Assets: Cloudflare documents
that `ctx.access` is not passed through that assets router. Use supported JWT
validation or a dedicated admin Worker instead of assuming `ctx.access` works here.

A future private admin tendril should declare narrow domain commands/queries,
such as `grantPremium`, `revokePremium`, `listGrants`, and `serviceUsage`. Its
trusted native/Worker adapter holds the corresponding operator credential and
calls these APIs. Authenticate each command's signed actor and approved capability
before using that credential. Membership of an arbitrary tendril must never imply
service-wide admin rights. Keep analytics-only adapters separate from grant writers.
The UI and replicated application state contain no operator token. Preserve grant
UUIDs and their exact inputs through uncertain command outcomes.

The [Cloud Computation proposal](CLOUD_ACTIONS.md) develops this adapter boundary
into a joint premium package using Workers for Platforms, Dynamic Workers, and
secret-backed capabilities.
It is a design proposal; this administration release does not implement hosted
user code or a customer secrets vault.

If operational needs grow, a dedicated admin Worker, separate analytics database,
short-lived identity-bound authorization, and an external append-only audit sink
can reduce the impact of a compromised component further. The current tables are
logically separated inside the same D1 database, so they are not infrastructure
isolation from an operator with database credentials.

Primary security references:

- [OWASP authorization guidance](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html)
- [OWASP logging guidance](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)
- [Cloudflare Access for Workers and its limitations](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)
- [Cloudflare Access JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)

## Verification

`npm run check` is the core gate. Focused regressions cover the admin origin and
scope boundary, invalid/expired/revoked credentials, grant/audit atomicity,
idempotent retries, immediate quota expiry/revocation, coexistence with billing,
complimentary usage exemption, aggregate privacy/retention, and safe CLI behavior.
The administration code does not require a browser UI test. Apply and qualify
the normal release/deployment workflow separately before operating it on live data.
