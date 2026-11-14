# Public service operations

The application has one service model: `https://tendriller.dev` for accounts and the API, and one page origin per tendril under `tendriller.site`. The repository is not ready for production deployment until the launch checks below pass.

## Why `workers.dev` cannot host the public page service

Cloudflare assigns one `<worker>.<account>.workers.dev` hostname to each Worker. Tendriller's page isolation requires a different browser origin for every `<id>.tendriller.site` page. The `workers.dev` namespace does not provide the dynamic wildcard hostnames needed here. Putting every page under a path on one Worker hostname would merge their browser origins and violate the isolation design. Do not deploy a path-based public preview or change `pageUrl` to use one shared hostname. The service Worker alone could be previewed on `workers.dev`, but OAuth callbacks, claim links, and page navigation would remain unusable until the pages zone exists. Wait for the domain setup, then deploy staging with a certificate covering its page hostnames. See [Cloudflare's workers.dev routing](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/) and [route documentation](https://developers.cloudflare.com/workers/configuration/routing/routes/).

## One-time external setup

1. Register `tendriller.dev` and `tendriller.site` and activate their Cloudflare zones. Create a certificate that covers `*.staging.tendriller.site` if using the default staging pages domain. Production pages use the one-level wildcard `*.tendriller.site`.
2. Create GitHub and Google OAuth apps. Production callbacks are `https://tendriller.dev/auth/callback/github` and `/auth/callback/google`. Staging callbacks use its service hostname. GitHub needs `read:user user:email`; Google needs `openid email profile`.
3. Create Turnstile widgets for the service hostnames. Record each site key and secret separately.
4. Configure Email Routing for `abuse@tendriller.dev` to invoke the production Worker. Create a separate, hard-to-guess forwarding recipient on the same domain, route it to the Worker, and set its full address as the `ABUSE_FORWARD_ADDRESS` secret. Give that private recipient to Cloudflare for forwarded complaints; keep it out of public pages. The handler parses up to 256 KB of MIME and records page URLs. Mail to the public address is intake evidence; mail to the private recipient causes an immediate hold. Test both paths before launch and rotate the private recipient if it leaks.
5. Set HSTS on the pages zone, submit `tendriller.site` to the HSTS preload list, and submit it to the Public Suffix List. The Worker sends the preload header on page responses; verify the apex separately.
6. Create Cloudflare budget notification policies and a generic webhook destination at `https://tendriller.dev/internal/budget`. Set a destination secret; its value must equal `BUDGET_WEBHOOK_SECRET`. Configure one policy ID for creation pause and one for read only. Also set account spending limits for Workers and Durable Objects in Cloudflare Billing.
7. Enable Google Web Risk and create a restricted API key for `WEB_RISK_API_KEY`. Page versions with outbound URLs need the lookup service.
8. Enable Cloudflare Email Sending for `tendriller.dev` and verify `notices@tendriller.dev` can send through the generated `EMAIL` binding. The Worker sends hold/restoration notices to owner emails and one acknowledgement per signed-in reporter per page per day.

## Provision and deploy

Use a scoped Cloudflare API token with Zone Read, DNS Edit, D1 Edit, R2 Edit, Workers Scripts Edit, Workers Routes Edit, and Custom Domains Edit. Keep the token and OAuth secrets out of the repository.

```sh
export CLOUDFLARE_ACCOUNT_ID=...
export CLOUDFLARE_API_TOKEN=...
node scripts/provision.mjs staging
node scripts/provision.mjs production
npx wrangler d1 migrations apply ACCOUNTS --remote --config server/wrangler.staging.jsonc
npx wrangler d1 migrations apply ACCOUNTS --remote --config server/wrangler.production.jsonc
node scripts/install-speech.mjs tendriller-staging-files --remote
node scripts/install-speech.mjs tendriller-production-files --remote
```

`provision.mjs` is idempotent. It writes Wrangler configs with the resource IDs. Review and commit those configs before enabling CI. The default staging page host is `<id>.staging.tendriller.site`; its certificate needs to cover two subdomain levels. Use `STAGING_PUBLIC_BASE` and `STAGING_PAGE_BASE_DOMAIN` to change staging hostnames.

After creating the OAuth apps, Turnstile widgets, and budget destination, export their credentials locally and run `node scripts/set-secrets.mjs staging` and `node scripts/set-secrets.mjs production`. The script pipes values to Wrangler; it does not put them in files. Add the admin identity allowlist as `ADMIN_IDENTITIES=github:<numeric subject>,google:<subject>`. Configure `BUDGET_PAUSE_POLICY_ID` and `BUDGET_READ_ONLY_POLICY_ID` as secrets too.

GitHub Actions runs typecheck and tests on pull requests. Once staging launch checks pass, set repository variable `STAGING_READY=true`, the scoped `CLOUDFLARE_API_TOKEN` secret, and `CLOUDFLARE_ACCOUNT_ID` variable in the staging environment. A push to `main` applies migrations and deploys staging. Production tags `v*` deploy only with `PRODUCTION_READY=true` and the corresponding production environment values.

Each deployed Worker has a 15-minute cron that retries suspended-account page shutdowns and restoration from the D1 `suspension_queue`. Verify that the queue drains after a forced Durable Object failure in staging. A suspended owner receives a 30-day, one-use appeal link by email; verify delivery before launch.

## Launch checks

- Both OAuth providers sign in and link accounts through real callbacks. Verify a named owner against verified provider email and provider subject.
- Run browser tests with two real page origins. Test sibling cookie tossing, cross-origin POST and WebSocket requests, storage isolation, and service-origin separation.
- With staging open and an owner key created, set `E2E_SERVICE_BASE` and `E2E_ACCOUNT_KEY`, run `node scripts/capture-e2e-auth.mjs` to save a local OAuth session, then `npm run test:e2e`. The test creates two claimed pages, checks distinct browser origins and blocked cross-origin actions, and deletes them afterward. Keep `.e2e-auth.json` private.
- Create and claim pages, approve an agent guest invite, revoke all agent tokens, create a display link, and release a claim before a guest is approved.
- Exercise each rate and quota boundary, including concurrent writes to two tendrils of one account. Check D1 reserved bytes against Durable Object file ledgers.
- Submit page, external, and forwarded-email reports; verify automatic holds, account suspension, appeals, restore, notices, and audit entries.
- Verify speech on a mid-range phone. Download occurs only after a deliberate microphone tap; confirm model hash, 30-second limit, transcription time, and that audio never leaves the browser.
- Put legally reviewed `terms.html`, `privacy.html`, `acceptable-use.html`, `copyright.html`, and `law-enforcement.html` in `legal/`. Run `node scripts/check-legal.mjs` before deploy. The claim screen's terms and privacy links must resolve to those published pages. Verify the minimum age and rights process in the reviewed text.
- Verify budget notifications change `service_state` at both thresholds, test recovery, configure Cloudflare spending limits, and check alert delivery.

## Runbooks

**Pause creation:** `npx wrangler d1 execute ACCOUNTS --remote --config server/wrangler.production.jsonc --command "UPDATE service_state SET mode='creation_paused' WHERE id=1"`. Use `read_only` to stop writes. Return to `open` only after checking the triggering condition.

**Mass takedown:** Set `read_only`, then use the allowlisted `/admin` console to disable targeted tendrils or suspend an account with a recorded reason. Keep evidence for 90 days. Restore through `/admin` after reviewing an appeal; restored reports are disqualified from future threshold counts.

**Leaked account key:** Revoke the named key in `/dashboard`. Inspect its `last_used` and the account's tendrils. If agent tokens were also exposed, disconnect them on each page. Rotate OAuth client secrets through their provider consoles and `set-secrets.mjs`; service sessions should be invalidated if compromise is suspected.

**Storage discrepancy:** Compare `service_state.reserved` with the sum of `tendrils.reserved`. The tendril alarm reconciles each local file ledger with its D1 row. Pause writes while resolving a persistent mismatch, then recheck before reopening.

**OAuth outage:** Keep creation paused if claims cannot complete. Check provider status and callback URLs. Restore only after both real sign-in paths pass.
