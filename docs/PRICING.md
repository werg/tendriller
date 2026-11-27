# Pricing, quotas, and zero lock-in

Start free and build freely: **offline work and direct peer-to-peer sync stay free forever** — upgrade only for hosted group video, hosted MCP execution, and larger team capacity, or self-host anytime.

- Human pricing page: [/pricing](https://tendriller.dev/pricing)
- Live account usage & billing: [/dashboard/billing](https://tendriller.dev/dashboard/billing)
- 5-minute self-hosting guide: [Self-hosting](SELF_HOSTING.md) ([/self-host](https://tendriller.dev/self-host))

## What stays free forever

- **Local-first storage & offline authoring:** Chronolog reads and durable writes on admitted devices never require a paid plan or host reachability.
- **Direct peer-to-peer WebRTC sync:** Direct browser-to-browser and browser-to-agent sync uses zero host relay or media quota.
- **Local agent execution (`tendril agent run`):** Running your own agent process on your laptop or server has no monthly call cap.
- **Zero lock-in & full export:** Export account data from `/dashboard/export` or migrate workspaces cleanly to your own Cloudflare account at any time.

## Plans & limits

| Capability | Free ($0) | Pro ($12/mo · $100/yr) | Team ($39/mo · $320/yr) | Self-Hosted ($0 OSS) |
| --- | --- | --- | --- | --- |
| Pages | 20 | 100 | 1,000 | Unlimited |
| Published asset storage (R2) | 1 GB (100 MB/page) | 20 GB (250 MB/page) | 100 GB (500 MB/page) | Unlimited (your R2) |
| Agents | 5 | 25 | 100 | Unlimited |
| Guests per page | 10 | 50 | 250 | Unlimited |
| Direct P2P WebRTC sync | Unlimited | Unlimited | Unlimited | Unlimited |
| Cloudflare Realtime SFU & TURN | 2 GB/mo TURN trial (no SFU) | 100 GB/mo SFU+TURN (up to 12 peers, 720p) | 500 GB/mo SFU+TURN (up to 50 peers, 1080p + screen) | Unlimited (your CF keys; 1 TB/mo free from CF) |
| Encrypted WebSocket relay fallback | 2 concurrent · 5 active hrs/mo · 1 hr session | 16 concurrent · 50 active hrs/mo · 2 hr session | 64 concurrent · 250 active hrs/mo · 4 hr session | Unlimited |
| Hosted MCP (`/mcp`) | 1 page · 250 calls/mo · 50 MB sync store | 25 pages · 15,000 calls/mo · 500 MB/page | 100 pages · 100,000 calls/mo · 2 GB/page | Unlimited |
| Outbound OAuth & org tie-ins | Tier A (`agent-held`, zero-trust) | + Tier B **host-brokered personal OAuth** | + **Team OAuth tie-ins** (GitHub Org/Team & Google Workspace admission, auto-offboarding & shared page-custody OAuth) | All enabled |
| Named page subdomains (`/dashboard/domains#subdomains`) | — (generated ID) | **25** pages (`my-app.tendriller.dev`) | **100** pages (`my-app.tendriller.dev`) | Unlimited |
| Custom page domains (`/dashboard/domains`) | — | — | Included (`app.yourteam.com`) | Included |
| Opt-in Pay-As-You-Go overage | Off (hard stop + P2P fallback) | $0.10/GB media · $2/10k MCP calls | $0.08/GB media · $1.50/10k MCP calls | Paid directly to Cloudflare |

## Fairness guarantees

- **Hitting a quota never locks or deletes data:** Local Chronolog state stays readable and editable offline. Downgrading from Pro or Team to Free keeps all existing pages working; only creating additional pages above the Free cap pauses until unused pages are removed or you resubscribe.
- **No surprise overage bills:** Pay-as-you-go (PAYG) is off by default. When enabled on Pro or Team, a monthly safety spend cap (default `$25`) stops overages cleanly unless the owner raises or disables the cap in `/dashboard/billing`.
- **7-day renewal grace period:** Failed renewals keep Pro/Team features active for 7 days before downgrading non-destructively to Free.
- **Merchant of Record:** Subscriptions, invoices, and global VAT/sales tax are processed by Polar.sh.

## Guidance for AI agents

1. **Inspect live plan and headroom programmatically:**
   - **Local / CLI agents:** `GET /api/agent` (and `tendril status`) returns `account.plan`, `account.unlimitedHost`, `account.quotas`, `account.usage`, and `billingUrl` / `pricingUrl` / `selfHostUrl` once the agent is claimed.
   - **MCP agents:** `get_profile` returns the same `account` object alongside service readiness and discovery URLs.
2. **Choose free local paths first when they fit:**
   - Prefer direct P2P WebRTC and local `tendril agent run` over hosted `/mcp` or relay whenever a local machine/runtime is available.
   - Only opt a page into hosted `/mcp` when remote cloud assistants (such as ChatGPT or Claude remote MCP) actually need access while the user's laptop is asleep.
   - For multi-party video calls (`templates/call/`), use `createHybridMediaTransport` (`shared/media/sfu-transport.mjs`): it keeps direct P2P free on small open-NAT calls and uses `_tendril/peers/ice` / `_tendril/peers/sfu/*` only when strict NAT or >4 video peers require it.
3. **Handle `429` / `413` `quota_exceeded` errors honestly:**
   - Every quota rejection returns structured fields: `quota`, `plan`, `used`, `limit`, `resetsAt`, `localAlternative`, `upgradeUrl`, `pricingUrl`, and `selfHostUrl`.
   - **Never** create a replacement account, duplicate workspace, or delete user data to work around a quota.
   - Report the exact `quota`, `used`/`limit`, and `resetsAt` to the human, offer the free `localAlternative` (such as direct P2P or local `tendril agent run`), and link both `upgradeUrl` and `selfHostUrl`.
