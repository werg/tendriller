# Tendriller

Tendriller lets an agent create a private, offline-first web app for you, update it live, and receive UI interactions and sensor inputs (location, motion, camera, voice) from your devices — gated by your GitHub or Google sign-in.

Under the hood, every Tendriller app runs on one owned **Chronolog v2** peer session (`@chronolog/peer-session`): a **Merkle-DAG CRDT with hash-pinned ES Module reducers and built-in deterministic SQLite-CAS**.

## Why Chronolog v2 is cool

Most local-first stacks force an awkward choice: either a rigid sync engine tied to a central server, or a hand-rolled event log with fragile ad-hoc migrations and heavyweight native C++ builds. Chronolog v2 collapses all of that into four tiny, composable primitives:

1. **A flat, timestamp-ordered block soup.** Every write is an immutable, Ed25519-signed operation ordered solely by `(authorTimestampMs, author, opId)` — no hash-linked commit chains, no coordinator, no server-assigned sequence numbers. Replicas merge sets in any order and always converge on the exact same state.
2. **Hash-pinned ES Module reducers in `$reducers` (QuickJS-NG WASM).** Application logic — *and* control logic (`$permissions`, `$keys`, `$finality`, `$publications`, `$signal_policy`) — is just standard ES Modules pinned by content hash (`cas:sha256-...`) inside a Merkle-DAG Content-Addressed Store (CAS). Every browser tab, Node agent, and opt-in hosted MCP Worker executes the exact same reducer code deterministically — **no separate `domain.js` bundle, no native C++ addons, zero `node-gyp`**.
3. **Built-in deterministic SQLite over Merkle-paged CAS (`chronolog:sqlite`).** Need SQL, FTS5 full-text search, or `sqlite-vec` vector search? Import `{ open } from 'chronolog:sqlite'` inside any reducer! Stock SQLite runs over a deterministic 4 KiB Merkle-paged CAS VFS (`sqlite-cas.wasm`), with kernel-bound `actor()`, `op_id()`, and `op_time()`, UTC timestamps, a 3-mode authorizer (`admin` / `user` / `readonly`), **Postgres-style write RLS (`chronolog/rls`)**, and safe **user-owned dynamic tables** (`CREATE TABLE` / `ALTER TABLE` / `DROP TABLE` as ordinary signed transactions!).
4. **A strict blind-host public-control partition.** On private encrypted chains, Tendriller's Cloudflare Worker Durable Object runs `TopicKernel({ blindHostMode: true })` over *only* public `$*` control operations (`$permissions`, `$keys`, `$finality`, `$publications`). It derives bit-for-bit identical membership and release state to every full replica — rolling back provisional releases or closing WebSockets automatically if a late revocation arrives — without ever holding epoch keys or reading encrypted application data!

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

**Build an app:** follow [Build an app](docs/BUILD_AN_APP.md) for **register agent → create page → write ES Module reducer (JSON/KV or `chronolog:sqlite` + `chronolog/rls`) & initialize v2 genesis → publish signed UI → owner sign-in → member admits browser (atomic `$permissions` + `$keys` HPKE lockboxes) → author and replicate → verify**. Agents starting from a domain should read [`/agent.md`](https://tendriller.dev/agent.md) or [`/.well-known/tendriller.json`](https://tendriller.dev/.well-known/tendriller.json). One agent (one credential, one signing key) maintains many pages from one local workspace; see [multi-page agents](docs/MULTI_PAGE_AGENTS.md). Deliver the [running application](docs/AGENT_DELIVERY.md), and consult the [capability map](docs/CAPABILITIES.md) before writing custom plumbing.

Give each app a recognizable favicon: set `icon` to an emoji such as `🌱` and Tendriller converts it to an SVG automatically. HTTPS image URLs work too. See [favicons and page branding](docs/BROWSER_API.md#favicons-and-page-branding).

## Keep a page on your phone

Open **Page options** on any published page to add it to your Home Screen (native install prompt on supporting browsers; **Share → Add to Home Screen** on iOS/iPadOS). **Save for offline use** caches that release's immutable page files; application state and device admission remain owned by the Chronolog v2 session. See [Browser API](docs/BROWSER_API.md#home-screen-setup).

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
- [Session bootstrap](docs/SESSION_BOOTSTRAP.md) — native/browser identity, v2 genesis, admission, and safe resume
- [Agent delivery](docs/AGENT_DELIVERY.md) — provisioning, process lifetime, and completion evidence
- [Start from MCP](docs/MCP_AGENT_GUIDE.md) — using `tendril_guide` and account-linked `/mcp`
- [Connect ChatGPT](docs/CHATGPT_INTEGRATION.md) — plugin install, workspace sharing, and per-app consent
- [Cloudflare assistant](docs/CLOUDFLARE_ASSISTANT.md) — hosting and enrolling apps on `/mcp`
- [Troubleshooting](docs/TROUBLESHOOTING.md) — failing stages, safe retries, and next actions
- [Multi-page agents](docs/MULTI_PAGE_AGENTS.md) — one agent, one credential and one signing key for many pages
- [Agents and grants](docs/AGENT_BINDINGS.md) — agent credentials, join codes, per-page grants and scopes
- [Test a release locally](docs/LOCAL_HOST.md) — verified local host, test owner, publication, and admission

### Reference and operations
- [Agent guide](agent.md) — concise agent workflow and Chronolog v2 reducer recipes
- [Architecture](docs/ARCHITECTURE.md) — Chronolog v2 central-pipe design, blind Worker host, and package boundaries
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
- [Three-repository qualification](docs/RELEASE_COMPOSITION.md) — composing core, Chronolog, and cookbooks
- [Agent onboarding acceptance](docs/AGENT_ONBOARDING_TEST.md) — cold-start domain evaluation
- [Cookbooks](https://github.com/werg/tendriller-contrib) — larger examples and independent qualification

## Build and verify

Requires Node 22.15+ (uses Node's built-in `node:sqlite`, zero native C/C++ builds!):

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
| `docs/` | Guides, protocol reference, operations, and downloadable Chronolog v2 starter workspace |

Pre-release target: storage is initialized cleanly from its fresh baseline schema (DO schema revision 15) with no legacy readers or migration layers.
