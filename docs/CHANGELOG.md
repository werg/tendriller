# Tendriller Changelog & Sunsetting Policy

<!-- Generated from releases/entries/*.json by scripts/release-changelog.mjs. Do not edit manually. -->

This changelog lists **notable changes** that matter to agents and app builders: major new capabilities (`feature`), API deprecations (`deprecation`), breaking upgrades (`breaking`), and security advisories requiring client action (`security`). Routine bugfixes and internal refactors are intentionally omitted.

- Machine-readable JSON feed: [/api/changelog](https://tendriller.dev/api/changelog) (supports `?since=YYYY-MM-DD`, `?since_core=VERSION`, `?category=...`)
- Signed live agent broadcasts: [/api/broadcasts](https://tendriller.dev/api/broadcasts) (`tendril broadcasts` / MCP `get_broadcasts`)

## Sunsetting policy

Tendriller uses short, predictable sunsetting windows instead of accumulating permanent legacy compatibility layers:

- **Experimental / preview APIs:** **7–14 days** notice (`deprecation` entry + signed agent broadcast with `sunset_at`), then removed.
- **Stable public SDK, host & tutorial APIs:** **30 days** notice (`deprecation` entry + signed agent broadcast with `sunset_at`, migration guidance, and version-matched targeting), then removed cleanly with a `breaking` entry that supersedes the deprecation.
- **Security fixes requiring client action:** Immediate `security` broadcast (`urgent` or `critical`) alongside a patched release; vulnerable legacy paths are disabled after **24–72 hours** (or immediately if actively exploited).
- **Zero noise for humans:** Deploy-driven broadcasts only target `agents` and `mcp`. Human dashboard/page banners are reserved for manual one-off operator notices (maintenance windows, active incidents, or critical agentless-page interventions).

## Returning to a fallow workspace

If you open an app workspace that has not been touched recently (or whose installed `@tendriller/core` lags the host):

1. Run `tendril status` — it checks `versions.core` and your last broadcast sync timestamp and surfaces a `catchup` advisory when stale.
2. Run `tendril changelog --since YYYY-MM-DD` (or `tendril changelog --since-core VERSION`, or fetch `/changelog.md` / `tendril_guide(topic: "changelog")`).
3. Address any `security`, `breaking`, or `deprecation` entries first (upgrading the pinned `firstApp.release` kit and republishing if required), then review new `feature` entries before building custom workarounds.

## Entries

<a id="2026-11-26-realtime-sfu-billing-and-self-host"></a>

### 2026-11-26 · [Feature] Cloudflare Realtime SFU/TURN, plan headroom APIs & self-hosting

Core `0.3.0-rc.17` · Slug `2026-11-26-realtime-sfu-billing-and-self-host` · Agent broadcast `announcement/info`

Added hybrid P2P/SFU call transport (shared/media/sfu-transport.mjs), short-lived TURN ICE credentials (_tendril/peers/ice), live account plan/quota headroom on GET /api/agent and MCP get_profile, and structured quota_exceeded errors.

Multi-party video rooms can use `createHybridMediaTransport` (`shared/media/sfu-transport.mjs`) to stay direct P2P on open NAT and automatically promote to Cloudflare Realtime SFU (`_tendril/peers/sfu/*`) when strict NAT or >4 video peers need it. Inspect account headroom via `GET /api/agent` or MCP `get_profile`, and consult `/pricing.md` or `/self-host.md` whenever a `429`/`413` `quota_exceeded` error is returned.

Reference: [/docs/PRICING.md](https://tendriller.dev/docs/PRICING.md)

<a id="2026-11-26-outbound-oauth-and-org-tieins"></a>

### 2026-11-26 · [Feature] Outbound OAuth connections & GitHub/Google org admission

Core `0.3.0-rc.17` · Slug `2026-11-26-outbound-oauth-and-org-tieins` · Agent broadcast `announcement/info`

Added Tier A (agent-held, X25519-sealed) and Tier B (host-brokered, client-wrapped) outbound OAuth connections plus admin-signed GitHub Org/Team and Google Workspace group admission with automatic offboarding.

Use `@tendriller/core/connections`, `shared/helpers/connections.mjs`, and `tendril connection providers|connect|list|pull|revoke` to connect third-party OAuth providers with zero plaintext tokens stored at rest. Team workspaces can also bind page membership to GitHub Org/Team or Google Workspace groups via `tendril page group`.

Reference: [/docs/OAUTH_CONNECTIONS.md](https://tendriller.dev/docs/OAUTH_CONNECTIONS.md)
