# Host operations

Tendriller deploys one application-neutral Cloudflare Worker engine (`@tendriller/engine`) with a filtered Chronolog control participant and optional account-linked `/mcp` gateway. Application execution stays on enrolled peers.

## Fresh storage baseline

Check the current Durable Object schema revision with `node scripts/storage-schema.mjs`: **revision 11** (consolidated page, pairing, publication, and assistant delivery tables).

This pre-release target uses fresh matching storage only — there are no legacy migration paths or compatibility readers:
1. Initialize the D1 `ACCOUNTS` database from the single unified schema `server/migrations/0001_accounts.sql` (exported as `@tendriller/engine/accounts-schema`, account-setup schema revision 3).
2. Provision fresh `Tendril` and `Admission` Durable Object namespaces matching revision 11.
3. Missing or mismatched storage fails closed without mutating existing records.

`scripts/provision.mjs` plans and provisions fresh named Worker, D1, R2, and domain resources and writes a complete Wrangler config. Review resource names and page-domain isolation before deploying.

## Configuration and secrets

- **Origin isolation:** keep `PUBLIC_BASE` (service origin) strictly separate from page hostnames (`*.pages.example`). Configure wildcard page routes/certificates so every page gets its own browser origin and storage boundary.
- **Secrets:** store OAuth provider secrets, `OAUTH_SIGNING_JWK`, `ASSISTANT_STORE_KEY` (32 random bytes base64 for webhook secret encryption and inbox tickets), and anti-abuse secrets in the platform secret store. Never embed secrets in logs, source, or published assets.
- **Optional OAuth & `/mcp`:** disabled when `OAUTH_CONFIG_JSON` is absent. Configure exact `resource` (`<PUBLIC_BASE>/mcp`), registered clients, `OAUTH_SIGNING_JWK`, and optional `ASSISTANT_CALLBACK_ORIGINS` (space-separated allowed HTTPS webhook origins). See [OAuth setup](INTEGRATION_OAUTH.md) and [Cloudflare assistant setup](CLOUDFLARE_ASSISTANT.md).
- **Initial mode:** fresh deployments start in `creation_paused`. Verify sign-in, page claim, origin isolation, and signed publication before opening creation.
- **Setup ledger integrity:** `account_setups` and `account_setup_allocations` enforce atomic non-double-charging retries. Never delete allocation witness rows to clear quotas; restore a verified backup if storage is inconsistent.

## Traffic budgets and Free-tier operation

- **Rate limits:** authenticated page HTTP/API requests and host control WebSocket frames charge `PAGE_RATE` (600/min per page, namespace 107); claimed pages also charge `ACCOUNT_RATE` (1,800/min per owner, namespace 108); agent tokens are bounded at 300/min. Exceeding limits returns HTTP 429 (`page_rate_limited` / `account_rate_limited`) or WebSocket close 1013.
- **Relay & hibernation:** relay data packets use explicit credit/byte bounds rather than HTTP request limits; idle relays do not renew authorization until traffic resumes (30s revalidation bound). Inbound assistant and live inbox sockets use Durable Object hibernation with no idle keepalives or polling.
- **Free-tier sharing:** Cloudflare rate limits are approximate per-location counters, while daily Durable Object SQL row allowances are shared across namespaces in one account. See [Free-tier guide](FREE_TIER.md).
- **Timing headers:** OAuth callbacks and dashboard routes emit `Server-Timing` for state, provider, D1, and page-summary phases (page summaries have a 3s deadline).

## Validation and deployment

Run `npm run check:release` against a clean commit checkpoint and verify `dist/provenance.json` and `dist/manifest.json` hashes before staging or production deployment. Deployment restores the exact sealed deployment archive (`--no-bundle`); it never rebuilds bytes on the fly.

- Verify control outages separately from coordinator loss: direct peer sessions continue working while the host is unreachable.
- Verify host restart preserves signed authority, publication head, historical immutable code, and idempotent retries. Code rollback is always a new signed publication.

## Isolated branch previews

`scripts/branch-preview.mjs plan --branch <branch>` computes an isolated Worker/D1/R2 plan for one passing branch head. The free-tier preview slot holds one branch at a time and deletes previous preview resources before deploying another. Previews start in `creation_paused` with scheduled reconciliation disabled.

## Service readiness and operational modes

Check anonymous readiness before onboarding or qualification runs:

```sh
TENDRILLER_ORIGIN=https://staging.tendriller.dev
curl --fail-with-body --show-error --silent "$TENDRILLER_ORIGIN/api/readiness"
```

Verify `serviceOrigin`, `build`, `mode`, `creation.available`, and `writes.available`:

| Mode | Creation | Existing writes | Operator action |
| --- | --- | --- | --- |
| `open` | Allowed (subject to quotas) | Allowed | Proceed; creation still rechecks live state. |
| `creation_paused` | Blocked | Allowed | Inspect why it was paused before reopening. |
| `read_only` | Blocked | Blocked | Resolve the incident before changing mode. |
| `unavailable` / 404 / 503 | Blocked | Unverified | Inspect deployment, D1 schema, and quotas; never switch origins. |

Inspect current staging mode without mutating:

```sh
node node_modules/wrangler/bin/wrangler.js d1 execute ACCOUNTS --remote \
  --config server/wrangler.staging.jsonc --json \
  --command 'SELECT id, mode FROM service_state WHERE id=1'
```

Conditionally reopen from `creation_paused` (never overriding `read_only`):

```sh
node node_modules/wrangler/bin/wrangler.js d1 execute ACCOUNTS --remote \
  --config server/wrangler.staging.jsonc --json \
  --command "UPDATE service_state SET mode='open' WHERE id=1 AND mode='creation_paused'"
```

Require exactly 1 changed row and re-read `/api/readiness`. To re-pause after a bounded qualification window, run the inverse conditional update (`WHERE id=1 AND mode='open'`). Automated qualification runners never mutate service mode.

## Headless staging validation and MCP qualification

- **Staging E2E (`npm run test:e2e:public`):** targets `https://staging.tendriller.dev`, requires open readiness and matching build identity, provisions a short-lived synthetic owner via `ACCOUNTS`, exercises claim, signed publication, and live invitations, and cleans up its own pages/account. Optional `E2E_CHRONOLOG_CONSUMER` and `E2E_CHRONOLOG_WASM` add native and browser SQL scenarios.
- **Full staging acceptance (`node scripts/run-staging-acceptance.mjs`):** checks readiness first, runs browser SQL opening checks and live scenarios (plus mobile WebKit/Chromium matrix when `E2E_MOBILE_MATRIX=1`).
- **Live MCP qualification (`npm run test:plugin:live`):** requires clean `build:artifacts` + `release:artifacts` matching the deployed build, runs real Codex MCP tool checks against an isolated synthetic app, and removes only its own fixture. If a fixture fails before saving its handle, retain the private directory and reconcile manually instead of bulk-deleting pages.
- **Storage reconciliation:** retained signed releases keep immutable R2 references; orphan cleanup must preserve them. Page/account deletion removes hosted resources while peer-retained Chronolog data follows application policy.
