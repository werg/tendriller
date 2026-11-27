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

<a id="2026-11-27-chronolog-v2-platform-capabilities"></a>

### 2026-11-27 · [Feature] Chronolog v2 platform unlocks: blind async mailbox, public/multisig governance, local hybrid memory, live evolution, lazy media & federated MCP SQL

Core `0.3.0-rc.17` · Slug `2026-11-27-chronolog-v2-platform-capabilities` · Agent broadcast `announcement/info`

Adds blind store-and-forward async sync mailbox, zero-OAuth public/multisig governance with author blocking, user-mode FTS5 + sqlite-vec & sqlite-helpers, streaming/LRU content cache, live evolution, portable blueprints/remix, and federated MCP SQL.

Key additions for agents and MCP assistants:
- Blind store-and-forward async mailbox (`peers.syncMailbox`) + cache-first instant offline `openPageGenesis`: relays opaque AEAD envelopes for offline private devices and verified public ops for offline-creator public pages without ever seeing plaintext or epoch keys.
- Zero-OAuth public (`openMembers` with `blockAuthor`/`unblockAuthor` moderation) and M-of-N (`multisigMembers`) governance with unified `session.permissions()`, `shared/helpers/governance.mjs` security & Hosted MCP active banners, and CLI `permissions set-open|block-author|unblock-author|multisig-*`.
- Local-first encrypted AI memory & hybrid search (`templates/knowledge` + `shared/helpers/hybrid-memory.mjs`), user-mode FTS5/`sqlite-vec` DML directly in `chronolog/sql`, and concise `chronolog/sqlite-helpers` (`defineSqlReducer`, `withDb`).
- Safe live schema & ES Module reducer evolution (`shared/helpers/live-evolution.mjs`, `shared/ui/schema-explorer.mjs`, CLI `reducers publish` & `sql migrate-file`).
- Unified lazy P2P media (`session.content` with `putStream`/`readStream`/`pin`/`pruneCache`, `shared/helpers/lazy-media.mjs`, CLI `content put|get`) and `$publications` history & rollback (`shared/helpers/publications-view.mjs`, CLI `publication-history`).
- Portable secret-free `PageBlueprint` (`@tendriller/core/blueprint`), one-click Remix (`POST /dashboard/t/:id/remix`), Blueprint import (`POST /dashboard/pages/from-blueprint`), 4-line `shared/helpers/page-worker.mjs` (`servePageWorker`), and opt-in `$finality` scheduling.
- Hosted MCP live `sqlSchemas` introspection in `describe_application`, read-only `query_sql` (`/v1/apps/:appId/sql`), and parallel `query_multiple_applications` across up to 8 opted-in pages.

Reference: [/docs/STATE_MODELS.md](https://tendriller.dev/docs/STATE_MODELS.md)

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

<a id="2026-11-26-chronolog-v2-reducers-and-sqlite-cas"></a>

### 2026-11-26 · [Breaking] Breaking upgrade: Chronolog v2 Merkle-DAG reducers, chronolog-db (SQLite-CAS), pluggable authority & zero native builds

Core `0.3.0-rc.17` · Slug `2026-11-26-chronolog-v2-reducers-and-sqlite-cas` · Agent broadcast `upgrade/urgent`

Chronolog v2 replaces v1 authority/genesis, DoltLite, better-sqlite3, and separate domain.js bundles with hash-pinned QuickJS-NG ES Module $reducers, deterministic Merkle-paged SQLite-CAS (chronolog-db + write RLS), and pluggable $permissions (--authority attested|multisig|open). Storage cutover retires pre-v2 pages and agent tokens; export and reconcile local data before recreating pages.

Account, token, and old-page lifecycle: Cutting over to the Chronolog v2 storage namespace retires pre-v2 pages (old page URLs show a 404 transition screen in browsers) and invalidates host-issued pre-v2 agent tokens (`401 unauthorized: Invalid or revoked agent token`). Local `.tendriller/` device stores, offline browser IndexedDB state, and authored `pages/` source are never deleted by the host. Recoverable upgrade workflow (see /docs/V2_MIGRATION.md): (1) Export current materialized data and reconcile any pending offline edits from local devices BEFORE creating replacements — never silently recreate pages with empty state. (2) Upgrade to Node 22.15+ and upgrade the workspace kit cleanly with `npx tendril workspace upgrade --kit <verified-first-app.tgz>` (regenerates `package-lock.json` and verifies archive hashes). (3) Re-enroll the same workspace agent with `npx tendril workspace reenroll` (preserves your existing Ed25519 signing key and X25519 wrap key while archiving old credentials and page bindings). (4) Create v2 pages (`npm run page:new`, `npm run init`, `npm run deploy`), import the exported data, verify pending edits and peer sync, and only then acknowledge this broadcast (`tendril broadcasts ack <id>`). Broadcast reception alone is never migration completion.

Reference: [/docs/V2_MIGRATION.md](https://tendriller.dev/docs/V2_MIGRATION.md)
