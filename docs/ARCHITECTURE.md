# Architecture

Tendriller is built as one piece around **Chronolog (`chronolog-db`) as the central pipe**. Every application runs over one owned Chronolog session (`@chronolog/peer-session`) that supplies signing identity, durable storage, command execution, coherent queries, reactive views, live signals, content transfer, replication, and recovery across native agents and browser Workers.

Different participants connect to that same pipe through transports matched to their role and trust boundary — including explicitly limited transports for special cases.

## Chronolog as the central pipe

| Pipe / transport | Package | Role and boundary |
| --- | --- | --- |
| Full peer session | `@chronolog/peer-session` (`/native`, `/worker`, `/browser`) | Durable execution, local byte store, operation journal, queries, events, signals, chunked content, direct WebRTC and relayed ciphertext replication, and recovery. |
| Reactive views & draft store | `@chronolog/peer-session` (`createLiveView`, `createViewStore`, `operationReference`) | Coherent UI refresh over session queries/changes plus per-view local drafts and retained operation references. |
| Durable topic outbox | `@chronolog/peer-session` (`forwardSessionEvents`) | Cursor-based event pump with atomic checkpoints and automatic halt on generation recovery. |
| Scoped tool pipe | `@chronolog/peer-session` (`createApplicationTools`, `createScopedApplicationTools`, `serveApplicationToolLines`) | Capability-scoped, generation-pinned limited tool surface for local agents and remote MCP assistants. |
| Local owner attachment | `@chronolog/peer-session` (`createApplicationOwner`, `connectApplicationOwner`, `acquireApplicationOwnerLock`) | Multi-tab browser and multi-CLI native attachment to one retained signing profile without duplicating device keys. |
| Filtered control & publication transport | `@chronolog/peer-generation/participant` (`ApplicationControlParticipant`) | Limited host transport permitting only signed generation control, membership revisions, immutable public definitions, and signed UI release chains. Rejects database history, commands, generic chunks, and live signals before dispatch. |

## Ownership and reasoned exceptions

| Component | Owner | Why it is structured this way |
| --- | --- | --- |
| Application state, history, replication, signals | Chronolog session (peers) | Keeps all application logic, signing keys, and epoch keys on enrolled devices. No separate hosted app backend or JSON state executor. |
| Application-neutral host (`server/`) | Tendriller Cloudflare Worker + Durable Objects | **Reasoned exception:** browsers need authenticated HTTPS page origins, OAuth 2.1, immutable signed asset hosting, bounded WebRTC introductions/relay, and a single account-linked `/mcp` gateway. The Worker runs zero `node:*` imports (pure Web Crypto), holds no epoch keys, executes no app code, and participates in Chronolog solely through the filtered control/publication transport and hibernating assistant sockets. |
| Browser runtime & standalone tools (`runtime/`, `tools/`) | `@tendriller/runtime`, `@tendriller/tools` | **Reasoned exception:** intentionally zero `@chronolog/*` runtime dependency. Keeps page boot (`tendril.js`), Home Screen install, offline immutable asset caching, sensor tracking, optional voice, and standalone CLI/preview decoupled and tiny; apps install their Chronolog session adapter explicitly via `tendril.installApplicationBackend(...)`. |
| Owner lifecycle & host glue (`session/`) | `@tendriller/core/{browser-owner,worker-owner,native-owner,participation,native-rtc,diagnostics,transport-diagnostics}` | Thin browser (SharedWorker / WebLock Worker + page WebRTC broker) and Node (Unix-IPC supervisor + SQLite effect journal) wrappers that bind Tendriller host introductions to `@chronolog/peer-session`. |
| Multi-participant coordination (`collaboration/`) | `@tendriller/core/collaboration` | Optional domain schema and client for addressed tasks, exclusive claims, and fan-in over an ordinary Chronolog session. |

## Identities and isolation

- **Page identity vs. application identity:** each hosted page has an isolated origin and host page ID plus one independent 32-byte lowercase hex `application.id`. Chronolog's pinned descriptor binds `application.id` to its history, definition/schema, and execution manifest.
- **Independent rights:** host login (account cookies / OAuth), device signing grants (Chronolog authority), and code publication rights are separate checks. A page login or an agent's `ta_` credential never grants database rights.
- **Host storage:** D1 holds accounts, OAuth grants, assistant connection indexes (`server/migrations/0001_accounts.sql`), and agents with their page grants and join codes (`server/migrations/0002_agents.sql`); one `AgentHub` Durable Object per agent multiplexes that agent's control streams onto its page objects; each page Durable Object (schema revision 11) holds signed controls, pairing ledgers, publication heads, and assistant delivery state; R2 holds immutable signed assets. There are no application command, event-history, or database tables on the host.

## Agents and the control hub

One **agent** maintains many pages. It has one account-level credential (`ta_`
token, hashed on the host) and one signing key shared by all of its pages; pages
it creates are granted to it automatically and the owner grants existing pages.
Its one local program, `tendril agent run`, holds one `tendriller.hub.v1`
WebSocket to an `AgentHub` Durable Object for all control traffic (setup notices,
discovery, invitations, rendezvous and assistant adapter streams). Application sync
data (WebRTC data channels and relay) keeps per-page connections. See
[multi-page agents](MULTI_PAGE_AGENTS.md) and [agents and grants](AGENT_BINDINGS.md).

## Code publications

UI code is a signed Chronolog publication with predecessor, revision, and operation identity. The host verifies authority and the full file graph, writes verified immutable bytes to R2, and commits the version and signed head atomically. Exact retries are idempotent; stale heads conflict; application history recovery never rewinds the code release chain.

## Build boundaries

- `@tendriller/core` — host SDK, filtered participant client, application/signal/assistant contracts, session owner helpers, and optional collaboration client.
- `@tendriller/runtime` — browser kernel, optional voice module, manifest, and exact assets (`runtime/types/` supplies kernel and voice declarations).
- `@tendriller/engine` — bundled Cloudflare Worker (`dist/engine/worker.mjs`), `Tendril` and `Admission` Durable Objects, unified `0001_accounts.sql` schema, and public Vitest fixture (`@tendriller/engine/testing`).
- `@tendriller/tools` — self-contained `tendril` and `tendril-preview` executables consuming only built public artifacts.

`scripts/check-boundaries.mjs` enforces that the Worker imports zero `node:*` modules, the kernel imports no voice/Node/domain modules, and tools consume only public artifacts. `dist/provenance.json` records exact source commits and archive SHA-256 hashes.
