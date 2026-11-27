# Tendriller

**A live, local-first web face for your AI agent — private and end-to-end encrypted by default, offline-ready, and evolvable on the fly.**

Tendriller lets you and your AI agent launch an interactive web app across your phone, laptop, and tablet in seconds. Talk to your page, share camera/mic/GPS/hardware sensors on your terms, sync asynchronously even when your devices aren't online at the same time, and invite friends or teams — or opt into zero-login public pages, moderated open boards, and M-of-N multisig governance with clear, honest security badges. One-click **Remix** or import a secret-free `PageBlueprint` directly from `/dashboard`.

---

## Under the hood: why Chronolog is cool

Every Tendriller app runs on one owned **Chronolog** peer session (`@chronolog/peer-session`): a **flat timestamp-ordered CRDT log with hash-pinned ES Module reducers and built-in deterministic `chronolog-db` (SQLite-CAS)**. It brings everything together in five composable primitives:

1. **A flat, timestamp-ordered operation set with instant snapshot reopen.** Every write is an immutable, Ed25519-signed operation ordered solely by `(authorTimestampMs, author, opId)` — no hash-linked commit chains, no coordinator, no server-assigned sequence numbers. Local materialized snapshot caching (`materialized-cache`) and portable epoch-encrypted snapshots (`exportMaterializedSnapshot`) let cold tabs and ephemeral Hosted MCP calls reopen in **O(1)** (or suffix-only replay) while automatically rewinding cleanly on late out-of-order arrivals.
2. **Hash-pinned ES Module topic reducers (`$reducers`) that evolve live.** `$reducers` maps each topic to a content-addressed ES Module (`cas:sha256-...`) running in deterministic QuickJS-NG WASM. Dry-run and hot-publish new reducers or SQL migrations live (`shared/helpers/live-evolution.mjs`, `tendril reducers publish`), or omit `$reducers` mutations to freeze rules forever. Permissions (`$permissions`) are pluggable too — host-attested `attestedMembers`, zero-OAuth `openMembers` (with `blockAuthor` / `unblockAuthor` moderation), M-of-N `multisigMembers` (with signed peer join requests and 6-digit out-of-band verification codes), or a custom ES Module reducer. Every browser tab, Node 22.15+ agent, and opt-in Hosted MCP Worker runs the exact same hash-pinned ES Module code deterministically.
3. **First-class `chronolog-db` (`chronolog/sql`, `chronolog/sqlite-helpers` & `chronolog:sqlite`) with FTS5 + `sqlite-vec`.** Bind topics directly to `chronolog/sql` for relational tables, use `chronolog/sqlite-helpers` (`defineSqlReducer`, `withDb`, `rowsToObjects`) for concise custom SQLite reducers, or build encrypted local-first AI memory with FTS5 BM25 + `sqlite-vec` k-NN + RRF hybrid search (`templates/knowledge/`). Every transaction runs over deterministic 4 KiB Merkle-paged SQLite (`sqlite-cas.wasm` — including FTS5 and `sqlite-vec` writes directly in `mode: 'user'`), with kernel-bound `actor()`, `op_id()`, `op_time()`, **Postgres-style write RLS (`chronolog/rls`)**, and safe **user-owned dynamic tables** (`CREATE TABLE` / `ALTER TABLE` / `DROP TABLE` as ordinary signed transactions).
4. **Unified streaming P2P media, SW peer recovery, agent auto-pinning & portable blueprints.** Stream photos, audio, and large files lazily over P2P via `session.content` (`putStream` / `readStream` / `pin` / `pruneCache`) without bloating host storage; `tendril agent run` auto-pins recent content under a bounded budget so mobile uploads stay reachable after the phone sleeps; the browser Service Worker transparently recovers host-pruned (`404`/`410`) historical `$publications` assets from connected peers with SHA-256 verification; and `@tendriller/core/blueprint` + `/dashboard` **Remix** clone app logic/schema with zero private rows or keys.
5. **Strict blind-host control partition + unified blind mailbox & Hosted MCP.** On private logs, Tendriller's Cloudflare Worker Durable Object runs `TopicKernel({ blindHostMode: true })` over *only* public `$*` control topics (`$permissions`, `$keys`, `$finality`, `$publications`) and relays *only* opaque AEAD envelopes through one unified blind store-and-forward mailbox (zero plaintext and zero private SQLite pages on the host). Browsers, offline mobile devices, CLI agents, and opt-in RAM-only Hosted MCP (which also caches an epoch-encrypted materialized snapshot for fast `/mcp` calls, live `sqlSchemas`, read-only `query_sql`, and up-to-8-page `query_multiple_applications`) all converge seamlessly through the same blind mailbox.

```
  ┌─────────────────────────────────────────────────────────────────────┐
  │                        Signed Operation Set                         │
  │   (authorTimestampMs, author, opId)  — flat CRDT, zero coordinator  │
  └───────────────┬─────────────────────────────────────┬───────────────┘
                  │ Public Control ($*)                 │ Encrypted App Topics
                  ▼                                     ▼
  ┌───────────────────────────────┐     ┌────────────────────────────────┐
  │ Tendriller Blind Worker Host  │     │  Admitted Browser / Node Peers │
  │ TopicKernel(blindHostMode)    │     │  Full TopicKernel (QuickJS-NG) │
  │ • $permissions & attestations │     │  • JSON/KV reducers            │
  │ • $keys (HPKE lockboxes)      │     │  • chronolog:sqlite (4KiB CAS) │
  │ • $finality checkpoints       │     │  • chronolog/rls write guards  │
  │ • $publications -> R2 assets  │     │  • Direct WebRTC + WS relay    │
  │ (Zero epoch keys / app data!) │     │  • Optional hosted MCP (in RAM)│
  └───────────────────────────────┘     └────────────────────────────────┘
```

The name combines an agent's tendrils reaching new interfaces and sensors with a drill opening a path for them.

**Build an app:** follow [Build an app](docs/BUILD_AN_APP.md) for **register agent → create page → write ES Module reducer (JSON/KV or `chronolog:sqlite` + `chronolog/rls`) & initialize log genesis → publish signed UI → owner sign-in → member admits browser (atomic `$permissions` + `$keys` HPKE lockboxes) → author and replicate → verify**. Agents starting from a domain should read [`/agent.md`](https://tendriller.dev/agent.md) or [`/.well-known/tendriller.json`](https://tendriller.dev/.well-known/tendriller.json). One agent (one credential, one signing key) maintains many pages from one local workspace; see [multi-page agents](docs/MULTI_PAGE_AGENTS.md). Deliver the [running application](docs/AGENT_DELIVERY.md), and consult the [capability map](docs/CAPABILITIES.md) before writing custom plumbing.

Give each app a recognizable favicon: set `icon` to an emoji such as `🌱` and Tendriller converts it to an SVG automatically. HTTPS image URLs work too. See [favicons and page branding](docs/BROWSER_API.md#favicons-and-page-branding).

## Keep a page on your phone

Open **Page options** on any published page to add it to your Home Screen (native install prompt on supporting browsers; **Share → Add to Home Screen** on iOS/iPadOS). **Save for offline use** caches that release's immutable page files; application state and device admission remain owned by the Chronolog session. See [Browser API](docs/BROWSER_API.md#home-screen-setup).

**Page options → Set up voice input** offers explicit tap-to-talk and optional on-device wake phrases. Microphone use starts only after local consent; speech assets load on demand. Authored pages can reuse `mountVoiceControls` with a reviewed-text callback. See [voice lifecycle](docs/HANDS_FREE.md).

## Documentation

### Building and connecting apps
- [Build an app](docs/BUILD_AN_APP.md) — complete first-app walkthrough and checkpoints
- [State models: JSON reducers & SQLite-CAS + RLS](docs/STATE_MODELS.md) — writing QuickJS-NG ES Module reducers, `chronolog:sqlite`, `chronolog/rls`, and dynamic user tables
- [Capabilities](docs/CAPABILITIES.md) — task map to existing Chronolog, session, UI, sensor, media, and preview APIs
- [Application patterns](docs/APP_PATTERNS.md) — reactive views (`createLiveView`), operation status, and reviewed input
- [Agent requests](docs/AGENT_REQUESTS.md) — worker-owned ephemeral presence, full request references, durable receipts and answers
- [Same-conversation delivery](docs/CONVERSATION_DELIVERY.md) — active-turn steering, idle wake, multi-page checkpoints and host qualification
- [Restart consumers](docs/AGENT_RESTART.md) — republish/agent-program restart checklist
- [Reviewed media and AI](docs/AI_INPUT.md) — camera, voice, credential-owning native inference, and explicit review
- [Session bootstrap](docs/SESSION_BOOTSTRAP.md) — native/browser identity, genesis, admission, and safe resume
- [Agent delivery](docs/AGENT_DELIVERY.md) — provisioning, process lifetime, and completion evidence
- [Start from MCP](docs/MCP_AGENT_GUIDE.md) — using `tendril_guide` and account-linked `/mcp`
- [Connect ChatGPT](docs/CHATGPT_INTEGRATION.md) — plugin install, workspace sharing, and per-app consent
- [Cloudflare assistant](docs/CLOUDFLARE_ASSISTANT.md) — hosting and enrolling apps on `/mcp`
- [Troubleshooting](docs/TROUBLESHOOTING.md) — failing stages, safe retries, and next actions
- [Multi-page agents](docs/MULTI_PAGE_AGENTS.md) — one agent, one credential and one signing key for many pages
- [Agents and grants](docs/AGENT_BINDINGS.md) — agent credentials, join codes, per-page grants and scopes
- [Test a release locally](docs/LOCAL_HOST.md) — verified local host, test owner, publication, and admission

### Reference and operations
- [Agent guide](agent.md) — concise agent workflow and Chronolog reducer recipes
- [Architecture](docs/ARCHITECTURE.md) — Chronolog central-pipe design, blind Worker host, and package boundaries
- [Application contract](docs/APPLICATION_BACKENDS.md) — commands, stored and materialized operations, coherent reads, and optional finality
- [Browser API](docs/BROWSER_API.md) — session adapter, Home Screen setup, sensors, voice, and offline cache
- [Participant protocol](docs/PROTOCOL.md) — blind public-control sync, authorization, and signed publications
- [Membership](docs/MEMBERSHIP.md) — `$permissions`, `$keys` HPKE lockboxes, invites, strict mode, and revocation
- [Authority records and publications](docs/AUTHORITY_AND_PUBLICATIONS.md) — blind-host control sync, `$publications` code chain, and finality reconciliation
- [Peer connections](docs/PEER_CONNECTIONS.md) — discovery, invitations, direct WebRTC, and relay fallback
- [CLI and preview](docs/tools/CLI.md) — public session CLI and authored-file preview
- [Development](docs/DEVELOPMENT.md) — building, testing, and artifact provenance
- [Changelog](CHANGELOG.md) — version tags and source releases
- [Operations](docs/OPERATIONS.md) — fresh provisioning, storage baseline, readiness, and staging checks
- [Service administration](docs/ADMINISTRATION.md) — scoped operator APIs, complimentary premium grants, and aggregate usage
- [Cloud Computation proposal](docs/CLOUD_ACTIONS.md) — future hosted agents, cloud tasks, and secret-backed capabilities
- [Three-repository qualification](docs/RELEASE_COMPOSITION.md) — composing core, Chronolog, and cookbooks
- [Agent onboarding acceptance](docs/AGENT_ONBOARDING_TEST.md) — cold-start domain evaluation
- [Cookbooks](https://github.com/werg/tendriller-contrib) — larger examples and independent qualification

## Build and verify

Requires Node 22.15+ (uses Node's built-in `node:sqlite`):

```sh
npm ci --ignore-scripts
npm run check
npx playwright install --with-deps chromium
npm run test:browser
```

`npm run build` produces `@tendriller/core`, `@tendriller/runtime`, and `@tendriller/engine` (including static `emscripten-module.wasm` for QuickJS-NG and `sqlite-cas.wasm` for hosted MCP). `npm run build:tools` packages `@tendriller/tools` against those artifacts. `npm run dev` starts a local host. Production deployment is a separate authorized action.

| Directory | Responsibility |
| --- | --- |
| `contract/` | Host SDK, blind-host control client, application/signal contracts, OAuth/assistant clients, browser declarations |
| `session/` | Browser owner (WebLock dedicated Worker + tab RTC host), Node supervisor + `node:sqlite` effect journal, v2 admission & participation, diagnostics |
| `collaboration/` | Multi-participant task-coordination ES Module reducer over `chronolog:sqlite` and client (`@tendriller/core/collaboration`) |
| `server/` | Application-neutral Cloudflare Worker blind host: accounts, OAuth 2.1, `/mcp` gateway (QuickJS-NG + `sqlite-cas.wasm` in RAM), `TopicKernel({ blindHostMode: true })`, signed `$publications` R2 storage, introductions/relay |
| `runtime/` | Zero-Chronolog browser composition, immutable offline code cache, sensor tracking, optional voice, and kernel/voice declarations |
| `tools/` | Standalone CLI (`tendril`, `tendril-preview`), authored-file packing, and explicit preview |
| `plugin/` | OpenAI ChatGPT plugin manifest, build script, setup skill, and review guide |
| `scripts/` | Builds, boundary checks, release composition, qualification, and provisioning |
| `docs/` | Guides, protocol reference, operations, and downloadable Chronolog starter workspace |

Pre-release target: storage is initialized cleanly from its fresh baseline schema (DO schema revision 15) with no legacy readers or migration layers.
