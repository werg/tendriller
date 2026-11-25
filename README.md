# Tendriller

Tendriller lets an agent create a private page for you, update it live, and receive UI interactions and inputs such as location, motion, camera, and voice from your devices. Your GitHub or Google sign-in controls access.

Tendriller hosts authenticated web applications whose durable state, execution, replication, and peer communication run through one owned **Chronolog** session (`@chronolog/peer-session`).

The host stays application-neutral: it provides account authentication, OAuth 2.1, a single account-linked `/mcp` gateway, signed membership and generation control, immutable signed UI hosting, and bounded peer introductions/relay. Ordinary application commands, queries, database history, content replication, and live signals flow directly through Chronolog between enrolled peers.

The name combines an agent's tendrils reaching new interfaces and sensors with a drill opening a path for them.

**Build an app:** follow [Build an app](docs/BUILD_AN_APP.md) for **create → define state → configure authority and initial generation → publish → owner sign-in → connect devices → verify**. Agents starting from a domain should read [`/agent.md`](https://tendriller.dev/agent.md) or [`/.well-known/tendriller.json`](https://tendriller.dev/.well-known/tendriller.json). One agent (one credential, one signing key) maintains many pages from one local workspace; see [multi-page agents](docs/MULTI_PAGE_AGENTS.md). Deliver the [running connected application](docs/AGENT_DELIVERY.md), and consult the [capability map](docs/CAPABILITIES.md) before writing custom plumbing.

Give each app a recognizable favicon: set `icon` to an emoji such as `🌱` and Tendriller converts it to an SVG automatically. HTTPS image URLs work too. See [favicons and page branding](docs/BROWSER_API.md#favicons-and-page-branding) for the agent API and CLI examples.

## Keep a page on your phone

Open **Page options** on any published page to add it to your Home Screen (native install prompt on supporting browsers; **Share → Add to Home Screen** on iOS/iPadOS). **Save for offline use** caches that release's immutable page files; application state and device enrollment remain owned by the Chronolog session. See [Browser API](docs/BROWSER_API.md#home-screen-setup).

**Page options → Set up voice input** offers explicit tap-to-talk and optional on-device wake phrases. Microphone use starts only after local consent; speech assets load on demand. The controls keep an editable draft for review and copying, stop when the page is hidden, and never listen with every tab closed. Authored pages can reuse `mountVoiceControls` with a reviewed-text callback. See [voice lifecycle](docs/HANDS_FREE.md) and [browser/device qualification](docs/WAKE_WORD_QUALIFICATION.md).

## Documentation

### Building and connecting apps
- [Build an app](docs/BUILD_AN_APP.md) — complete first-app walkthrough and checkpoints
- [Capabilities](docs/CAPABILITIES.md) — task map to existing Chronolog, session, UI, sensor, media, and preview APIs
- [Application patterns](docs/APP_PATTERNS.md) — reactive views (`createLiveView`), operation status, and reviewed input
- [Agent requests](docs/AGENT_REQUESTS.md) — durable listener presence, full request references, receipts and answers
- [Restart consumers](docs/AGENT_RESTART.md) — republish/agent-program restart checklist
- [Reviewed media and AI](docs/AI_INPUT.md) — camera, voice, credential-owning native inference, and explicit review
- [Events or SQL](docs/STATE_MODELS.md) — choosing events vs. guarded SQL transactions
- [Session bootstrap](docs/SESSION_BOOTSTRAP.md) — native/browser identity, authority setup, enrollment, and safe resume
- [Agent delivery](docs/AGENT_DELIVERY.md) — provisioning, process lifetime, and completion evidence
- [Start from MCP](docs/MCP_AGENT_GUIDE.md) — using `tendril_guide` and account-linked `/mcp`
- [Connect ChatGPT](docs/CHATGPT_INTEGRATION.md) — plugin install, workspace sharing, and per-app consent
- [Cloudflare assistant](docs/CLOUDFLARE_ASSISTANT.md) — hosting and enrolling apps on `/mcp`
- [Troubleshooting](docs/TROUBLESHOOTING.md) — failing stages, safe retries, and next actions
- [Multi-page agents](docs/MULTI_PAGE_AGENTS.md) — one agent, one credential and one signing key for many pages; workspace, grants and the control hub
- [Agents and grants](docs/AGENT_BINDINGS.md) — agent credentials, join codes, per-page grants and scopes
- [Test a release locally](docs/LOCAL_HOST.md) — verified local host, test owner, publication, and pairing

### Reference and operations
- [Agent guide](agent.md) — concise agent workflow and contract reference
- [Architecture](docs/ARCHITECTURE.md) — Chronolog central-pipe design, limited transports, and package boundaries
- [Application contract](docs/APPLICATION_BACKENDS.md) — commands, applied operations, coherent reads, and recovery
- [Browser API](docs/BROWSER_API.md) — session adapter, Home Screen setup, sensors, voice, and offline cache
- [Participant protocol](docs/PROTOCOL.md) — filtered control transport, authorization, and signed publications
- [Membership](docs/MEMBERSHIP.md) — account access, device grants, and control changes
- [Peer connections](docs/PEER_CONNECTIONS.md) — discovery, invitations, direct WebRTC, and relay fallback
- [CLI and preview](docs/tools/CLI.md) — public session CLI and authored-file preview
- [Development](docs/DEVELOPMENT.md) — building, testing, and artifact provenance
- [Changelog](CHANGELOG.md) — version tags and source releases
- [Operations](docs/OPERATIONS.md) — fresh provisioning, storage baseline, readiness, and staging checks
- [Three-repository qualification](docs/RELEASE_COMPOSITION.md) — composing core, Chronolog, and cookbooks
- [Agent onboarding acceptance](docs/AGENT_ONBOARDING_TEST.md) — cold-start domain evaluation
- [Cookbooks](https://github.com/werg/tendriller-contrib) — larger examples and independent qualification

## Build and verify

Requires Node 22.15+ (Node 24 for the native tutorial):

```sh
npm ci
npm run check
npx playwright install --with-deps chromium
npm run test:browser
```

`npm run build` produces `@tendriller/core`, `@tendriller/runtime`, and `@tendriller/engine`. `npm run build:tools` packages `@tendriller/tools` against those artifacts. `npm run check:release` runs core, tools, and browser gates. `npm run dev` starts a local host. Production deployment is a separate authorized action.

| Directory | Responsibility |
| --- | --- |
| `contract/` | Host SDK, filtered participant transport, application/signal contracts, OAuth/assistant clients, browser declarations |
| `session/` | Browser owner (SharedWorker / WebLock Worker + page RTC broker), Node supervisor + SQLite effect journal, host participation, diagnostics |
| `collaboration/` | Optional multi-participant task-coordination schema and client (`@tendriller/core/collaboration`) |
| `server/` | Application-neutral Cloudflare Worker host: accounts, OAuth 2.1, `/mcp` gateway, inbox UI, filtered control participant, signed code storage, introductions/relay |
| `runtime/` | Zero-Chronolog browser composition, immutable offline code cache, sensor tracking, optional voice, and kernel/voice declarations |
| `tools/` | Standalone CLI (`tendril`, `tendril-preview`), authored-file packing, and explicit preview |
| `plugin/` | OpenAI ChatGPT plugin manifest, build script, setup skill, and review guide |
| `scripts/` | Builds, boundary checks, release composition, qualification, and provisioning |
| `docs/` | Guides, protocol reference, operations, and downloadable first-app starter |

Pre-release target: storage is initialized cleanly from its fresh baseline schema with no legacy readers or migration layers.
