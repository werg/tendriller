# Self-hosting Tendriller on Cloudflare

Tendriller is open-source and runs on a single Cloudflare Worker with D1, R2, and SQLite-backed Durable Objects. Self-hosting gives you unlimited account quotas (`NULL` caps) and lets you pay Cloudflare directly.

## What it costs on your own Cloudflare account

- **Cloudflare Workers Paid ($5/month base):** Strongly recommended before serving hosted MCP or public traffic. Removes the Free plan’s 10 ms CPU ceiling (needed for QuickJS-NG and `sqlite-cas.wasm` in hosted MCP) and includes 10M Worker requests, 1M Durable Object requests, 400k GB-s DO duration, 25B D1/DO SQL reads, 50M writes, and 10 GB R2 storage with zero egress.
- **Cloudflare Realtime SFU & TURN (optional):** Includes **1,000 GB/month free** shared egress across SFU and TURN, then **$0.05/GB** egress (ingress is free, and TURN used with Cloudflare Realtime SFU is free).

## 1. Provision Worker, D1, R2, and domains

Requires Node 22.15+ and a Cloudflare account with your service and page domains active:

```sh
git clone https://github.com/werg/tendriller.git
cd tendriller
npm ci
npm run build

PRODUCTION_PUBLIC_BASE=https://app.yourdomain.com \
PRODUCTION_PAGE_BASE_DOMAIN=pages.yourdomain.com \
node scripts/provision.mjs production --name my-tendriller --fresh
```

## 2. Apply D1 migrations and set unlimited caps

```sh
npx wrangler d1 migrations apply ACCOUNTS --remote --config server/wrangler.my-tendriller.jsonc
npx wrangler d1 execute ACCOUNTS --remote --config server/wrangler.my-tendriller.jsonc \
  --command "UPDATE service_state SET mode='open', account_page_cap=NULL, account_resident_cap=NULL, account_storage_cap=NULL WHERE id=1"
```

When `service_state` caps are `NULL`, every account on your host automatically gets unlimited pages, residents, storage, workspace agents, guests, hosted MCP calls, and host relay time.

## 3. Configure secrets and deploy

At minimum, configure your host attestation signing identity and one sign-in method (GitHub/Google OAuth or single-owner passphrase `LOCAL_PASSWORD_HASH` + `LOCAL_OWNER_EMAIL`):

```sh
# Required: host attestation key (see docs/OPERATIONS.md)
npx wrangler secret put HOST_ATTESTATION_KEY --config server/wrangler.my-tendriller.jsonc

# Optional: Cloudflare Realtime SFU & TURN (unlocks multi-party SFU + TURN traversal)
npx wrangler secret put CF_REALTIME_APP_ID --config server/wrangler.my-tendriller.jsonc
npx wrangler secret put CF_REALTIME_API_TOKEN --config server/wrangler.my-tendriller.jsonc
npx wrangler secret put CF_TURN_KEY_ID --config server/wrangler.my-tendriller.jsonc
npx wrangler secret put CF_TURN_API_TOKEN --config server/wrangler.my-tendriller.jsonc

npx wrangler deploy --config server/wrangler.my-tendriller.jsonc
```

Polar.sh billing secrets (`POLAR_ACCESS_TOKEN`, `POLAR_WEBHOOK_SECRET`, `POLAR_PRODUCTS_JSON`) are completely optional — leave them unset on a private or self-hosted deployment.

### Outbound OAuth & Org/Team tie-ins (optional)

Every self-hosted instance automatically unlocks both Tier A (`agent-held`), Tier B (`host-brokered`, personal & shared team `page` custody), BYO custom OAuth 2.1 providers (`custom:<slug>`), and GitHub/Google org group admission:

- **Dedicated config encryption key (recommended):** Set `OAUTH_CONFIG_KEY` (32 random bytes) so BYO `client_secret`s and inbound HMAC webhook secrets are AES-256-GCM encrypted in D1 independently of `HOST_ATTESTATION_KEY`.
- **Built-in third-party providers:** GitHub and Google automatically reuse your existing login OAuth apps and `/auth/callback/{github,google}` callback URLs out of the box (with Google incremental authorization `include_granted_scopes=true`), or you can override either with a dedicated client in `OUTBOUND_OAUTH_CLIENTS_JSON`. For other providers, register OAuth apps with redirect URI `https://app.yourdomain.com/auth/outbound/callback/<provider>` and upload them via `OUTBOUND_OAUTH_CLIENTS_JSON` (or run `node scripts/setup-oauth.mjs --config server/wrangler.my-tendriller.jsonc`).
- **Instant GitHub org offboarding (optional):** Set `GITHUB_ORG_WEBHOOK_SECRET` and point org/GitHub App webhooks (`organization`, `membership`) to `https://app.yourdomain.com/api/webhooks/github-org`.

## 4. Move an existing workspace to your self-hosted instance

1. Download your account export from `/dashboard/export` on your previous host if you want an archive.
2. In your workspace, point `tendriller.json` (or initialize a fresh workspace via `npx tendril workspace init --service https://app.yourdomain.com ...`) to your new service origin.
3. Run `npm run init -- <slug>` and `npm run deploy -- <slug>` for each page you want to host there.

See [Host operations](OPERATIONS.md) for deployment verification, OAuth setup, and storage schema details, and [WebRTC media](WEBRTC_MEDIA.md) for hybrid direct/SFU rooms.
