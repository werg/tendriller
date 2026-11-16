# Public service operations

The service uses `https://tendriller.dev` for accounts and the API, and a separate page origin per tendril under `tendriller.site`. Staging uses `https://staging.tendriller.dev` and per-page hosts under `tendriller.dev`. The default deployed engine has an empty trusted-extension registry. Node tools and cookbook code are not part of its Worker bundle.

Tendriller does not require Email Routing or Email Sending. Public reports use `/report`; owner notices and appeals appear in the authenticated dashboard, including a restricted view for suspended owners.

## Fresh storage baseline

This unreleased target starts from empty account and page storage. Initialize D1
with the single `server/migrations/0001_accounts.sql` schema and create fresh
Durable Object namespaces for `Tendril` and `Admission` through the one
`baseline` declaration in the deployment configuration. The page storage revision
is **4**; `node scripts/storage-schema.mjs` reads it from the authoritative
server definition. The schema guard rejects incompatible storage.

Provisioning reuses resources with matching names; it does not clear them or
translate their contents. Review the selected Worker, D1 database, and R2 bucket
before initialization, and use empty resources for this baseline. Recreate
disposable development accounts and pages normally. There is no preserved
sessions package, account migration sequence, or old-runtime serving mode.
New account storage starts with `service_state.mode='creation_paused'`.

## Why `workers.dev` cannot host the public page service

Cloudflare assigns a distinct `<worker>.<account>.workers.dev` hostname to **each Worker**, and preview versions receive additional prefixed hostnames. Tendriller's current design serves dynamically created pages from one Worker and requires a different browser origin for every page. `workers.dev` does not offer arbitrary wildcard page hostnames routed to that one Worker. Putting every page under a path on its hostname would merge their browser origins and violate the isolation design. A fixed preview with one separate Worker per page could preserve origins, but it would require a different deployment and routing model from the dynamic public service. Do not change `pageUrl` to use one shared hostname. The service Worker alone could be previewed on `workers.dev`, but OAuth callbacks, claim links, and page navigation would remain unusable until the pages zone exists. Wait for the domain setup, then deploy staging with a certificate covering its page hostnames. See [Cloudflare's workers.dev routing](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/), [preview hostname formats](https://developers.cloudflare.com/workers/previews/custom-domains/), and [route documentation](https://developers.cloudflare.com/workers/configuration/routing/routes/).

## One-time external setup

1. Register `tendriller.dev` and `tendriller.site` and activate their Cloudflare zones. Staging pages use `*.tendriller.dev` and production pages use `*.tendriller.site`, both covered by the zones' one-level wildcard certificates. Staging service runs at `staging.tendriller.dev`.
2. Create GitHub and Google OAuth apps. Production callbacks are `https://tendriller.dev/auth/callback/github` and `/auth/callback/google`. Staging callbacks use its service hostname. GitHub needs `read:user user:email`; Google needs `openid email profile`.
   Use `https://tendriller.dev/` as the public app home page, `https://tendriller.dev/privacy` for privacy, and `https://tendriller.dev/terms` for terms after those pages are live. Upload `docs/assets/tendriller-icon-180.png` as the OAuth app icon in Google and GitHub branding settings. The repository build publishes the same icon as a favicon and uses the full logo on the service home page. [Google may ask for brand verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification) if the app is published beyond Testing.
3. Create Turnstile widgets for the service hostnames. Record each site key and secret separately.
4. Set HSTS on the pages zone, submit `tendriller.site` to the HSTS preload list, and submit it to the Public Suffix List. The Worker sends the preload header on page responses; verify the apex separately.
5. On Workers Free, monitor the included usage and its hard limits. If you enable pay-as-you-go billing, configure separate Workers and Durable Objects spending limits and account-wide email budget alerts in Cloudflare Billing. Account-wide budget alerts currently notify by email and do not provide the policy webhooks expected by `/internal/budget`; do not configure that endpoint or claim automatic pause is active until a supported notification policy and payload have been verified in staging.

## Provision and deploy

For local provisioning, sign in with `npx wrangler login`. `provision.mjs` uses that Wrangler session to create or reuse D1 databases and R2 buckets. If Wrangler shows multiple accounts, set `CLOUDFLARE_ACCOUNT_ID` to select one. Keep OAuth secrets out of the repository.

```sh
node scripts/provision.mjs staging
node scripts/provision.mjs production
npx wrangler d1 migrations apply ACCOUNTS --remote --config server/wrangler.staging.jsonc
npx wrangler d1 migrations apply ACCOUNTS --remote --config server/wrangler.production.jsonc
npm run build
node scripts/publish-runtime.mjs --config server/wrangler.staging.jsonc
node scripts/publish-runtime.mjs --config server/wrangler.production.jsonc
```

`provision.mjs` is idempotent for an environment already using this baseline. It writes Wrangler configs with the resource IDs and the generic `dist/engine/worker.mjs` entry. In Cloudflare DNS, add a proxied `AAAA` record with content `100::` for `*.tendriller.dev` (staging) and `*.tendriller.site` (production) before deploying. The default staging page host is `<id>.tendriller.dev`, separate from its service host `staging.tendriller.dev`; the Worker uses the service hostname to route service requests. Use `STAGING_PUBLIC_BASE` and `STAGING_PAGE_BASE_DOMAIN` to change staging hostnames within the `tendriller.dev` zone. Review and commit the configs before enabling CI.

After creating the OAuth apps and Turnstile widgets, export their credentials locally and run `node scripts/set-secrets.mjs staging` and `node scripts/set-secrets.mjs production`. The script pipes values to Wrangler; it does not put them in files. Add the admin identity allowlist as `ADMIN_IDENTITIES=github:<numeric subject>,google:<subject>`. The budget webhook secret and policy IDs remain optional until a compatible alert is tested.

For off-page device notifications, generate a separate stable VAPID key pair for each environment using `node scripts/vapid-keys.mjs`. Supply `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and the recommended `VAPID_SUBJECT` when running `scripts/set-secrets.mjs`; these variables are already supported by the script. Keep private keys out of git and do not rotate them during normal deployment: rotation requires devices to renew subscriptions. See the [Web Push operations and verification guide](PUSH_NOTIFICATIONS.md) and test delivery with all page tabs closed, including the installed iOS web app.

GitHub Actions runs typecheck, Worker tests, public artifact/consumer checks, tool checks, and browser tests on pull requests and branch pushes. A passing `master` run can deploy staging followed by production. Each deployment requires its `STAGING_READY` or `PRODUCTION_READY` repository variable to be `true`, and its `STAGING_STORAGE_SCHEMA` or `PRODUCTION_STORAGE_SCHEMA` variable to match `node scripts/storage-schema.mjs`. Missing or mismatched schema declarations disable the deployment jobs. Set these variables only after selecting and verifying empty storage initialized for that schema. For this target the schema variables must be `4`. The deployment uses immediate Durable Object code updates; superseded commits skip deployment. Both environments need a scoped `CLOUDFLARE_API_TOKEN` secret and `CLOUDFLARE_ACCOUNT_ID` variable. CI cannot use an interactive Wrangler login. Keep GitHub Actions as the sole automatic deployment controller so Cloudflare Builds does not bypass these checks.

Each deployed Worker has a 15-minute cron that retries suspended-account page shutdowns and restoration from the D1 `suspension_queue`. Verify that the queue drains after a forced Durable Object failure in staging. A suspended owner can sign in to a restricted dashboard and submit page or account appeals; verify that exports and page access remain denied.

Turn off Cloudflare **Browser Integrity Check** in Security Settings for both
`tendriller.dev` and `tendriller.site`. Tendriller's API and page routes serve
automated agents; this check rejects Python's default `urllib` user agent with
Cloudflare error 1010 before the Worker can authenticate or rate-limit it.
`scripts/check-deployment.mjs` probes the API with that user agent after each
deployment so a zone setting change cannot silently break agent access.

**Idle delivery cost:** The bundled Codex, Claude Code, OpenClaw, and Hermes bridges use a hibernating agent WebSocket. An open socket does not by itself keep the Durable Object active or invoke an agent model. The bridge fetches the queue only on connect, a wake notice, an acknowledgement that releases a pending batch, or a retry. Its JSON ping/pong is answered by Cloudflare without waking the object. Each open socket still counts against Cloudflare's WebSocket and Durable Object limits. Generic five-minute long polls remain available for hosts without a WebSocket client, but their pending request and timer keep the Durable Object active. Webhook and MCP Events receivers also avoid held polls.

## Live branch previews

The **Live branch previews** workflow (`.github/workflows/branch-previews.yml`)
automatically deploys passing `preview/**` branches from this repository.
It runs from `master` after a **Public service** push or manual run completes
successfully and checks that the tested commit is still the branch head. The
`preview/` namespace is explicit deployment intent; a successful release or
development branch build does not create a deployment. Other non-default
branches can be deployed with the manual action described below. Pull
request runs test GitHub's merge commit, so they do not authorize deploying the
branch tip. Fork pull requests never receive
deployment credentials. Deployment and deletion for a branch are serialized so
that a late run cannot recreate a deleted preview. A failed build or test retains
the last passing deployment.

Find the preview URL in the workflow summary or GitHub deployment environment
`preview/<key>`. The service hostname is stable for
the branch; each successful deployment updates its code and assets. The branch's
complete, case-sensitive name is hashed with SHA-256 and shortened to 12 hexadecimal
characters, so names containing slashes do not become DNS names directly.

| Component | Preview value |
|---|---|
| Worker | `tendriller-preview-<key>` |
| Service origin | `https://preview-<key>.tendriller.dev` |
| Service route | `preview-<key>.tendriller.dev/*` |
| Page origin | `https://<id>--p-<key>.tendriller.dev` |
| Page route | `*--p-<key>.tendriller.dev/*` |
| Page configuration | `PAGE_BASE_DOMAIN=tendriller.dev`, `PAGE_HOST_SUFFIX=--p-<key>` |
| Persistent resources | A separate D1 database, R2 bucket and Durable Object namespaces per branch |
| Rate limits | Separate namespace IDs for every branch and binding |

The page suffix keeps every tendril on a distinct origin under the existing
`*.tendriller.dev` certificate and proxied wildcard DNS record. Its route is more
specific than staging's wildcard route. Staging and production omit
`PAGE_HOST_SUFFIX` and retain their existing hostnames. Cloudflare's native
Worker Previews do not currently accept zone routes, so this workflow creates a
separate Worker for each branch. See [Cloudflare route matching](https://developers.cloudflare.com/workers/configuration/routing/routes/)
and [Preview resource limitations](https://developers.cloudflare.com/workers/previews/resources/).

### Credentials and availability

The workflow uses the GitHub **staging** environment's `CLOUDFLARE_API_TOKEN` secret
and `CLOUDFLARE_ACCOUNT_ID` variable. Its token must be allowed to create, update
and delete preview Workers, provision and migrate D1 databases, create and empty
R2 buckets, and manage Worker routes in the `tendriller.dev` zone. Cleanup also
needs permission to read that zone so it can resolve and verify the route IDs.
Permission to deploy an existing staging Worker alone is insufficient. Scope the
token to the project account and required zone; see [Workers permissions](https://developers.cloudflare.com/workers/authorization/workers/)
and [R2 API token permissions](https://developers.cloudflare.com/r2/api/tokens/).

Preview deployments are enabled unless the repository variable
`BRANCH_PREVIEWS_ENABLED` is set to `false`. This switch leaves cleanup enabled;
it does not remove existing previews. Keep the existing staging credentials
available for preview cleanup. Preview resources consume the account's Worker, D1, R2 and Durable Object
quotas, storage and request allowance; they are ordinary deployed resources and
remain until cleanup succeeds. Use disposable test data and inspect failed
cleanup runs before assuming resources are gone.

Branch previews deliberately configure `triggers.crons=[]`: they do not run
scheduled reconciliation. This keeps each preview from allocating another
account-wide Cron Trigger. The Worker still
supports normal requests and Durable Object alarms. Exercise scheduled
maintenance in core tests or a dedicated staging environment with cron capacity;
do not assume that a preview validates scheduled cleanup or retention behavior.
A retry explicitly clears any schedule from the same isolated preview Worker;
staging and production configurations are unchanged.

The initial preview is a live service for the branch's home page, documentation,
agent guide, assets and API. Its fresh D1 database starts with
`service_state.mode='creation_paused'`. The workflow never imports staging or
production accounts, sessions, page indexes, files or secrets.

Opening page creation requires dedicated preview OAuth/Turnstile settings and
working callbacks on that preview's service hostname. Do not reuse a staging or
production database to obtain sign-in. The lifecycle script accepts optional
`PREVIEW_GITHUB_CLIENT_ID`, `PREVIEW_GITHUB_CLIENT_SECRET`,
`PREVIEW_GOOGLE_CLIENT_ID`, `PREVIEW_GOOGLE_CLIENT_SECRET`,
`PREVIEW_TURNSTILE_SITE_KEY` and `PREVIEW_TURNSTILE_SECRET_KEY` environment
variables and installs them as the corresponding Worker secrets. For CI, save
these values as GitHub Actions secrets with those names in the **staging**
environment. Each client ID/site key must be supplied with its corresponding
secret. Register the
preview callbacks and verify sign-in before changing its service state to `open`.
Runtime publication installs every declared resource into the preview's own
bucket before deployment, including resources loaded only when a feature is used.
[Google OAuth callbacks](https://developers.google.com/identity/protocols/oauth2/web-server#uri-validation)
must be registered exactly; [GitHub callback compatibility](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#redirect-urls)
must be checked against that OAuth app's settings.
Push delivery likewise needs the preview's own VAPID settings. These integrations
are separate from a successful branch deployment and health check.

### Manual deployment and page checks

Use **Actions → Live branch previews → Run workflow** on `master`, enter the full
branch name, and choose `deploy`. The controller requires a successful **Public
service** run for that branch's current commit; it does not bypass the checks.
This explicit action supports any non-default branch, including branches outside
`preview/**`. It does not verify that release archives have been published;
complete the release checks below before requesting a release candidate preview.

The lifecycle script can also be run from a trusted checkout with the same
Cloudflare environment variables. `plan` prints the computed names without
changing resources. For `deploy`, pass the tested commit and its source checkout:

```sh
node scripts/branch-preview.mjs plan --branch feat/example
node scripts/branch-preview.mjs deploy --branch feat/example --sha "<tested-40-character-sha>" --source "<branch-checkout>"
```

Deployment writes `server/wrangler.branch-preview.json` inside that source
checkout. Keep this generated config out of version control. It identifies the
preview's own database and bucket for follow-up operations. After configuring and
verifying its identity providers, open creation against that generated config:

```sh
npx wrangler d1 execute ACCOUNTS --remote --config server/wrangler.branch-preview.json --command "UPDATE service_state SET mode='open' WHERE id=1"
```

Run `npm run test:e2e:public` with `E2E_SERVICE_BASE` set to the preview URL and
`E2E_OWNER_EMAIL` set to a verified preview account after capturing its session
with `scripts/capture-e2e-auth.mjs`. This checks claims and two distinct page
origins. Return creation to `creation_paused` if these checks fail. Successful
deployment smoke checks cover `/health`, `/`, `/api/service`, `/agent.md` and `/status`.
The `/health` response must report the checked commit, and the guide must point
to the preview's own service URL. The source checkout's shared
`scripts/check-deployment.mjs` also verifies the contract, target runtime identity,
and empty default trusted-extension registry before reporting success. These checks do
not certify OAuth, page claims, speech or push delivery.

### Cleanup and recovery

Deleting a branch triggers cleanup of its Worker and preview storage. Closing or
merging a pull request while retaining its branch does not delete the preview.
Cleanup checks that the branch is still absent before removing resources, so a
branch recreated under the same name is not removed by an older delete event.
After cleanup succeeds, recreating the branch creates a fresh preview on its next
passing run; previous preview data is not retained.

For a failed deployment, inspect the **Live branch previews** run before retrying.
Use its manual `deploy` action or rerun **Public service** for the branch's
current commit. For failed cleanup, run **Live branch previews** manually on
`master` with the deleted branch name and action `delete`. Cleanup refuses an
existing branch. The corresponding local command is
`node scripts/branch-preview.mjs delete --branch "<deleted-branch>"`; it deletes
that preview's resources and data, so check the branch name before running it.
Check Cloudflare authorization errors, account resource
limits, D1 migrations, and wildcard DNS/certificate coverage as appropriate. A
newer branch commit supersedes an older checked commit, and the controller skips
that stale deployment.

## Launch checks

- Both OAuth providers sign in and link accounts through real callbacks. Verify a named owner against verified provider email and provider subject.
- Run browser tests with two real page origins. Test sibling cookie tossing, cross-origin POST and WebSocket requests, storage isolation, and service-origin separation.
- With staging open, set `E2E_SERVICE_BASE` and `E2E_OWNER_EMAIL`, run `node scripts/capture-e2e-auth.mjs` to save a local OAuth session, then `npm run test:e2e:public`. The test creates two pages and claims them on browser open, checks distinct browser origins and blocked cross-origin actions, and deletes them afterward. Keep `.e2e-auth.json` private.
- Create pages for a verified email and open them to claim automatically, approve an agent guest invite, revoke all agent tokens, create a display link, and release a claim before a guest is approved.
- Exercise each rate and quota boundary, including concurrent writes to two tendrils of one account. Check D1 reserved bytes against Durable Object file ledgers.
- Submit page and external reports; verify automatic holds, account suspension, appeals, restore, notices, and audit entries.
- Verify the page-owned conversation UI with keyboard and text input. Check queued, accepted, and rejected states, delayed receipts, reconnect, and the distinction between a reply arriving and the page acknowledging its presentation.
- For pages that explicitly enable the optional voice adapter, verify speech input on a representative phone. Check consent, model integrity, transcription latency, active-use feedback, stop, and the chosen recognizer's local or remote processing boundary. There is no automatically enabled microphone or wake-phrase mode.
- Test the selected speech-output path on actual devices: first and cached startup, autoplay after a deliberate tap, interruption, mute, background behavior, and failed or blocked downloads. Optional neural output uses the pinned `phonon-tts` resources in the immutable runtime and its model download; a page must deliberately enable it. Check the application's text alternative and fallback policy. See [voice behavior](HANDS_FREE.md) and [pinned-model verification](E2E_TESTING.md#optional-speech-and-pinned-model-verification).
- Put legally reviewed `terms.html`, `privacy.html`, `acceptable-use.html`, `copyright.html`, and `law-enforcement.html` in `legal/`. Run `node scripts/check-legal.mjs` before deploy. The sign-in screen and dashboard must link to those published pages. Verify the minimum age and rights process in the reviewed text.
- Monitor Free-tier limits or, if paid usage is enabled, verify spending limits and email budget alerts. Automatic `service_state` budget transitions require a compatible webhook policy and staging test before they can be relied upon.

## Runbooks

**Pause creation:** `npx wrangler d1 execute ACCOUNTS --remote --config server/wrangler.production.jsonc --command "UPDATE service_state SET mode='creation_paused' WHERE id=1"`. Use `read_only` to stop writes. Return to `open` only after checking the triggering condition.

**Mass takedown:** Set `read_only`, then use the allowlisted `/admin` console to disable targeted tendrils or suspend an account with a recorded reason. Keep evidence for 90 days. Restore through `/admin` after reviewing an appeal; restored reports are disqualified from future threshold counts.

**Leaked agent token:** Disconnect the token on its page. Inspect recent activity and replace the page if needed. Rotate OAuth client secrets through their provider consoles and `set-secrets.mjs`; service sessions should be invalidated if compromise is suspected.

**Storage discrepancy:** Compare `service_state.reserved` with the sum of `tendrils.reserved`. The tendril alarm reconciles each local file ledger with its D1 row. Pause writes while resolving a persistent mismatch, then recheck before reopening.

**OAuth outage:** Keep creation paused if claims cannot complete. Check provider status and callback URLs. Restore only after both real sign-in paths pass.

## Runtime publication and release verification

`npm run build` produces the SDK, runtime, and generic engine. Operational tools
are optional and are built with `npm run build:tools`; they never enter the
Worker graph. `npm run check:release` validates all four artifacts and the browser
behavior before `npm run release:artifacts` records their exact source and hashes.
See [development and release commands](DEVELOPMENT.md).

Runtime resource definitions live in `runtime/resources.mjs`. The runtime
publisher verifies SHA-256 hashes and uploads the declared resources to immutable
keys in the selected `FILES` bucket before Worker deployment. A page publication
identifies its authored files and exact target runtime so relative assets, lazy
modules, preview, and offline execution use a coherent graph. Reading a cookbook
or installing the CLI adds no implicit page assets.

After deployment, run `node scripts/check-deployment.mjs <https-service-origin>`.
It verifies public health and agent instructions, normal automated-client access,
the target service contract, an empty trusted-extension registry, and the runtime
manifest identity. Then create a fresh authenticated page and verify owner
claiming, event delivery, a published update, and separate page origins. Open page
creation only after those checks and the environment's identity callbacks pass.

Deliberately extended deployments need their own public metadata and real host
checks for the selected module's authorization and transactions. The ordinary
service check intentionally requires no installed workflow. A preview fixture
cannot substitute for those enforcement checks.
