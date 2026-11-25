# Host operations

Tendriller deploys one application-neutral Cloudflare Worker engine (`@tendriller/engine`) with a filtered Chronolog authority and publication participant and optional account-linked `/mcp` gateway. Application execution stays on enrolled peers.

## Fresh storage baseline

Check the current Durable Object schema revision with `node scripts/storage-schema.mjs`: **revision 12** (consolidated page, signed authority, publication, and assistant delivery tables). A mismatched existing schema is rejected before mutation, so provision a fresh Durable Object namespace.

This pre-release target uses fresh matching storage only — there are no legacy migration paths or compatibility readers:
1. Initialize fresh D1 `ACCOUNTS` using Wrangler `d1 migrations apply ACCOUNTS --remote --config <selected-config>` and the ordered `server/migrations/0001_accounts.sql` (accounts, OAuth, assistant connections), `0002_agents.sql` (agents, page grants, join codes), `0003_broadcasts.sql` (Ed25519-signed system broadcasts, signing keys, and fleet version inventory), and `0004_account_limits.sql` (configurable per-account caps in `service_state`) migrations (exported as `@tendriller/engine/{accounts,agents,broadcasts,limits}-schema`). Verify `d1_migrations` records all four; applying raw SQL alone leaves the journal empty and makes the next CI apply attempt duplicate table creation. This initializes new storage only; it is not conversion of an older database.
2. Provision fresh `Tendril`, `Admission` and `AgentHub` Durable Object namespaces (`Tendril` and `Admission` matching revision 12; `AgentHub` is one object per agent, holding its single control-traffic connection).
3. Missing or mismatched storage fails closed without mutating existing records.

`scripts/provision.mjs` plans and provisions fresh named Worker, D1, R2, and domain resources and writes a complete Wrangler config. Review resource names and page-domain isolation before deploying.

## Required s10 → fresh s11 cutover precondition

Changing the configured Worker name to `tendriller-staging-s11` or
`tendriller-production-s11` does **not** transfer existing public routes.
Wrangler rejects a wildcard route assigned to another Worker. Noninteractive
custom-domain replacement does not resolve that wildcard conflict. Keep normal
deployment held until a qualified engine has been uploaded to the selected new
Worker and the existing route owners have been reassigned and verified.

This cutover retains the service origins, not the old application/account data.
Use fresh s11 D1, `Tendril`/`Admission` namespaces and R2 bindings. There is no
migration, export/conversion, compatibility reader, or old-namespace attachment.
A namespace bootstrap must not invoke the older engine or initialize schema10
objects: inspect the new namespace object inventories before deployment. Leave
the fresh service in `creation_paused` while preparing it. Reuse privately held
provider registrations/signing secrets as appropriate for the same origins, but
validate OAuth configuration against the current strict schema and create new
review/test accounts in the fresh D1. Never log agent tokens, join codes or other credentials.

### Hold automatic deployment before merging/publishing

Read and retain previous values, then set these **repository Actions variables**
(they are deployment gates, separate from the D1 service mode):

| Variable | During cutover preparation |
| --- | --- |
| `STAGING_READY` | `false` |
| `PRODUCTION_READY` | `false` |
| `STAGING_STORAGE_SCHEMA` | `11` |
| `PRODUCTION_STORAGE_SCHEMA` | `11` |

For each READY variable, use the repository variable API and verify readback:

```sh
gh api repos/werg/tendriller/actions/variables/STAGING_READY
gh api --method PATCH repos/werg/tendriller/actions/variables/STAGING_READY \
  -f name=STAGING_READY -f value=false
```

Repeat for `PRODUCTION_READY`; inspect staging/production environment variables
for overrides as well. Do not change the schema gates to bypass qualification.
The hold allows immutable master publication while preventing a conflicting
canonical deploy. A passing PR graph is not the published master graph. Keep
both READY values false until qualified-publication GO and the environment's
preparation below; never race an external route change against automatic deploy.

### Upload qualified bytes before replacing any binding

Perform staging first. Keep production's READY gate false and its routes on s10
until remote staging acceptance and MCP qualification pass for the selected
source and manifest.

1. Verify the exact final master source, public source-tagged manifest/hash,
   complete artifact hashes and restored sealed deployment graph as described in
   [release composition](RELEASE_COMPOSITION.md). Run the existing public-release
   and deployment-artifact checks with the artifact job's exact expectations.
   Deployments consume those bytes with `--no-bundle`; do not rebuild or relabel
   a PR/candidate graph as master. Abort if current master differs from the
   qualified source.
2. Check fresh D1's baseline journal and namespace inventories. Publish the
   verified immutable runtime/resources to that environment's new FILES bucket
   using `scripts/publish-runtime.mjs` and its selected canonical config.
3. Derive a temporary route-free config **outside the clean source checkout**
   from that final canonical config. Retain its exact s11 DO/D1/R2 bindings,
   secrets and other runtime settings. Use absolute paths to the verified engine
   and restored static assets, `routes: []`, `workers_dev: false`,
   `preview_urls: false`, and `triggers: { crons: [] }`. Upload the actual engine
   with Wrangler `deploy --no-bundle --durable-objects-code-update-mode immediate`
   and the qualified `SERVICE_SOURCE_COMMIT`/`SERVICE_COMPOSITION_ID` values.
   This upload must have no public routing targets.
4. Record the successful deployment/version and verify the uploaded current main
   module's bytes against the sealed engine SHA-256, plus its source/composition
   settings and target s11 bindings. A temporary 503 namespace bootstrap is
   **never** an eligible route target. Merely creating the Worker is insufficient.
5. Refresh the existing routes/custom-domain inventory. Require each exact
   pattern to belong to the expected old-s10 Worker (or the already-verified new
   s11 Worker for an idempotent retry); an unknown owner is a stop condition.
   After qualified upload, conditionally open only the selected fresh D1 as
   described below and verify its mode. Do not overwrite `read_only` or mutate
   old D1.
6. Replace each existing route by its ID using the Cloudflare
   [route replacement API](https://developers.cloudflare.com/api/resources/workers/subresources/routes/methods/update/):
   `PUT /zones/{zone_id}/workers/routes/{route_id}` with the unchanged `pattern`
   and the selected new `script`. Read back ID, pattern, owner and fail-open
   setting. For production's service domain, the generic account-domain attachment
   API can return HTTP 409 while the old Worker owns the hostname. After the
   wildcard route points at the verified new Worker, use Wrangler's custom-domain
   replacement from the exact restored graph and canonical production config,
   keeping crons empty in the temporary config. Noninteractive Wrangler overrides
   the existing origin through its domain changeset/records operation; inventory
   and restrict the targets to `tendriller.dev` first. Pass the same source and
   composition variables with `--no-bundle`, then verify domain ownership and
   the current module bytes again. No domain deletion is needed.
   **Do not delete/unassign routes first**, move the domain to the bootstrap,
   or alter unrelated/shared bindings.

| Environment | Existing binding | Required new owner |
| --- | --- | --- |
| Staging | `staging.tendriller.dev/*` | `tendriller-staging-s11` |
| Staging | `*--p-9a9a9a9a9a9a.tendriller.dev/*` | `tendriller-staging-s11` |
| Production | `*.tendriller.site/*` | `tendriller-production-s11` |
| Production | custom domain `tendriller.dev` | `tendriller-production-s11` |

Each binding replacement points directly at the uploaded qualified engine.
Cloudflare has no atomic transaction spanning all four bindings; record partial
progress and observe propagation. If a step fails, stop further changes and
reconcile the exact observed owners against the same graph. Do not create an
unassigned-route/placeholder interval or claim an unsuccessful CI run passed.

### Restore gates and run normal same-source qualification

After staging's uploaded engine and route ownership are verified, restore
`STAGING_READY=true` (its recorded normal value), keeping
`PRODUCTION_READY=false`. Dispatch `.github/workflows/service.yml`:

```sh
gh api repos/werg/tendriller/commits/master --jq .sha
# Require that full SHA to equal the qualified, published source before dispatch.
gh api --method POST repos/werg/tendriller/actions/workflows/service.yml/dispatches \
  -f ref=master
```

The workflow has no dispatch inputs and its deployment condition requires
`refs/heads/master`; dispatching a bare SHA does not satisfy that gate. Verify
the new run's `head_sha` and exact manifest/artifact identities rather than
assuming it selected the intended source. A newer master needs its own qualified
publication. Normal deployment must restore the sealed graph without rebuilding
its bytes and find all selected routes already owned by s11.

Require staging smoke, remote staging acceptance and MCP qualification green.
Only then repeat qualified upload/verified takeover for production and restore
`PRODUCTION_READY=true`. When the completed same-source run already has all
release, publication and staging gates green, rerun its production job by its
actual job ID (`POST /repos/{owner}/{repo}/actions/jobs/{job_id}/rerun`). Verify
that this creates a real production deployment with the original manifest and
successful predecessors; a skipped job is not success. If the job cannot be
rerun, dispatch the normal workflow again on unchanged master. Its own staging
acceptance and MCP gates still precede production. Verify production readiness
source/runtime/composition, creation availability and the post-deployment MCP
qualification; a READY flag alone proves none of them. All restored artifact
bytes must match the immutable public graph; stop on any mismatch.

For each environment, once its verified new engine owns all its public bindings
and smoke checks pass, retire that environment's **old-s10** cron before normal
deployment installs the new cron. This ordering frees the old slot when the
account is at its free-plan cron limit; do not remove a still-active production
schedule while preparing staging. Remove only the retired Worker's triggers with the
[schedules API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/schedules/methods/update/)
(`PUT /accounts/{account_id}/workers/scripts/{old_script}/schedules`, body `[]`)
and verify its old schedule is empty. After both cutovers, verify no public routes, custom domains,
workers.dev or preview endpoints remain attached to those exact retired Workers.
Only remove known obsolete bindings still owned by them; never detach s11 or
unknown shared resources. Old stored resources may remain inert; this requires
no data export, namespace transfer, resource deletion or local process restart.

## Configuration and secrets

- **Origin isolation:** keep `PUBLIC_BASE` (service origin) strictly separate from page hostnames (`*.pages.example`). Configure wildcard page routes/certificates so every page gets its own browser origin and storage boundary.
- **Secrets:** store OAuth provider secrets, `OAUTH_SIGNING_JWK`, `ASSISTANT_STORE_KEY` (32 random bytes base64 for webhook secret encryption and inbox tickets), optional `BROADCAST_SIGNING_JWK` / `BROADCAST_PUBLIC_JWKS` (Ed25519 OKP JWKs for signing system broadcasts; falls back to D1 `broadcast_keys` when unset), optional `BROADCAST_ADMIN_TOKEN` (for CI/CLI access to `/api/admin/broadcasts`), and anti-abuse secrets in the platform secret store. Never embed secrets in logs, source, or published assets.
- **Optional OAuth & `/mcp`:** disabled when `OAUTH_CONFIG_JSON` is absent. Configure exact `resource` (`<PUBLIC_BASE>/mcp`), registered clients, `OAUTH_SIGNING_JWK`, and optional `ASSISTANT_CALLBACK_ORIGINS` (space-separated allowed HTTPS webhook origins). See [OAuth setup](INTEGRATION_OAUTH.md) and [Cloudflare assistant setup](CLOUDFLARE_ASSISTANT.md).
- **Initial mode:** fresh deployments start in `creation_paused`. Verify sign-in, page claim, origin isolation, and signed publication before opening creation.
- **Agent ledger integrity:** `agents`, `agent_grants` and `agent_join_codes` hold only SHA-256 hashes of agent tokens and join codes, public keys and per-page grants. Never delete grant rows by hand to clear a limit; revoke the agent or remove the grant through the dashboard so page objects close its sockets. Restore a verified backup if storage is inconsistent.

## Traffic budgets and Free-tier operation

- **Rate limits:** authenticated page HTTP/API requests and host control WebSocket frames charge `PAGE_RATE` (600/min per page, namespace 107); claimed pages also charge `ACCOUNT_RATE` (1,800/min per owner, namespace 108); agent tokens are bounded at 300/min. Exceeding limits returns HTTP 429 (`page_rate_limited` / `account_rate_limited`) or WebSocket close 1013.
- **Relay & hibernation:** relay data packets use explicit credit/byte bounds rather than HTTP request limits; idle relays do not renew authorization until traffic resumes (30s revalidation bound). Inbound assistant and live inbox sockets use Durable Object hibernation with no idle keepalives or polling.
- **Free-tier sharing:** Cloudflare rate limits are approximate per-location counters, while daily Durable Object SQL row allowances are shared across namespaces in one account. See [Free-tier guide](FREE_TIER.md).
- **Timing headers:** OAuth callbacks and dashboard routes emit `Server-Timing` for state, provider, D1, and page-summary phases (page summaries have a 3s deadline).

## Validation and deployment

Run `npm run check:release` against a clean commit checkpoint and verify `dist/provenance.json` and `dist/manifest.json` hashes before staging or production deployment. Deployment restores the exact sealed deployment archive (`--no-bundle`); it never rebuilds bytes on the fly.

- Verify host outages separately from peer availability: initialized devices keep authoring and materializing locally, and direct peer sessions continue working while the host is unreachable.
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
