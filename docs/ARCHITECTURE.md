# Architecture

Tendriller is built around **Chronolog v2 (`chronolog`) as the central pipe**. Every application runs over one owned Chronolog v2 session (`@chronolog/peer-session`) that combines:
- a flat, timestamp-ordered CRDT operation set (`(authorTimestampMs, author, opId)`),
- a Merkle-DAG Content-Addressed Store (`ContentAddressedStore` over `node:sqlite` or IndexedDB — zero native C/C++ builds),
- a deterministic QuickJS-NG WASM sandbox (`TopicKernel`) running hash-pinned ES Module reducers from `$reducers`,
- built-in deterministic SQLite-CAS (`chronolog:sqlite`, `sqlite-cas.wasm` with FTS5 + `sqlite-vec` + `chronolog/rls`), and
- end-to-end encrypted peer replication (direct WebRTC + hibernating WebSocket relay) plus ephemeral signals (`@chronolog/signals`).

## Chronolog v2 as the central pipe

| Pipe / transport | Package | Role and boundary |
| --- | --- | --- |
| Full peer session | `@chronolog/peer-session` (`/native`, `/worker`, `/browser`) | Durable local storage (`node:sqlite` / IndexedDB), `TopicKernel`, QuickJS-NG + `sqlite-cas.wasm`, operation journal, signals, chunked content, direct WebRTC + WS relay. |
| Blind-host control kernel | `@chronolog/peer-session/kernel` + `@chronolog/authority` | Pure `TopicKernel({ blindHostMode: true })` running in Tendriller's Cloudflare Worker Durable Object over *only* public `$*` control operations (`$reducers`, `$permissions`, `$keys`, `$finality`, `$publications`, `$signal_policy`). |
| Reactive views & draft store | `@chronolog/peer-session` (`createLiveView`, `createViewStore`) | Coherent snapshot reads + separate local drafts and retained operation references. |
| Durable topic outbox | `@chronolog/peer-session` (`forwardSessionEvents`) | Cursor-based event pump bound to `revision.digest`. |
| Scoped tool pipe | `@chronolog/peer-session` (`createApplicationTools`, `createScopedApplicationTools`) | Capability-scoped, revision-aware tool surface for local agents and hosted MCP. |
| Local owner attachment | `@chronolog/peer-session` (`createApplicationOwner`, `connectApplicationOwner`) | Multi-tab browser and multi-CLI native attachment to one retained signing profile. |

## Ownership and reasoned exceptions

| Component | Owner | Why it is structured this way |
| --- | --- | --- |
| Application state, reducers, SQLite-CAS, replication, signals | Chronolog v2 session (peers) | All application data and epoch keys stay strictly on admitted devices. Zero server-side application database. |
| Blind public-control host (`server/`) | Tendriller Cloudflare Worker + Durable Objects (schema revision 15) | Provides authenticated HTTPS origins, OAuth 2.1, immutable signed R2 asset hosting, WebRTC introductions/relay, and a blind `TopicKernel({ blindHostMode: true })` over `$*` public control topics. Reconciles active served code releases and WebSocket access automatically on late revocations. Zero `node:*` imports. |
| Opt-in hosted MCP participant (`server/src/mcp-participant.ts`) | Tendriller Worker DO (RAM-only per call) | Zero plaintext keys and zero plaintext data at rest: X25519-sealed keys unwrap strictly in RAM from the OAuth Bearer token, hydrate an ephemeral `ApplicationSession` with static `quickjs-ng` + `sqlite-cas.wasm` directly from `$reducers` (no separate `domain.js`!), persist only encrypted envelopes + sealed private CAS chunks back to `mcp_store`, and discard all plaintext material on exit. |
| Browser runtime & standalone tools (`runtime/`, `tools/`) | `@tendriller/runtime`, `@tendriller/tools` | Intentionally zero `@chronolog/*` runtime dependency in `runtime/` so page boot, offline cache, sensors, and voice stay tiny and decoupled. |
| Owner lifecycle & host glue (`session/`) | `@tendriller/core/{browser-owner,worker-owner,native-owner,admission,participation,native-rtc,diagnostics}` | Thin browser (WebLock dedicated Worker + tab RTC host) and Node (IPC supervisor + `node:sqlite` effect journal) wrappers over `@chronolog/peer-session`. |
| Multi-participant coordination (`collaboration/`) | `@tendriller/core/collaboration` | Optional ES Module reducer over `chronolog:sqlite` and client for addressed tasks, claims, and fan-in. |

## Strict two-way public / encrypted control partition

On private logs (`privateLog: true`), operations are partitioned strictly by visibility:
- **Public control operations (`visibility: 'public'`)** may update *only* `$*` control topics (`$reducers`, `$permissions`, `$keys`, `$finality`, `$publications`, `$signal_policy`), and their reducers may read *only* public `$*` topics and public CAS nodes.
- **Encrypted application operations (`visibility: 'encrypted'`)** are AES-256-GCM encrypted under the active epoch key and may update *only* non-`$` application topics.
- Idempotency (`seenOpsRoot`) is scoped to `(visibility, author, operationId)`, so an encrypted operation can never collide with or influence a public control operation.

Because of this invariant, Tendriller's blind Cloudflare Worker derives bit-for-bit identical `$permissions`, `$keys`, `$finality`, and `$publications` state to every full peer!

## Build boundaries

- `@tendriller/core` — host SDK, blind-host control client, session owners, v2 admission, participation, and collaboration.
- `@tendriller/runtime` — browser kernel, optional voice module, manifest, and assets.
- `@tendriller/engine` — bundled Cloudflare Worker (`dist/engine/worker.mjs` + static `emscripten-module.wasm` + static `sqlite-cas.wasm`), `Tendril` / `Admission` / `AgentHub` Durable Objects, D1 migrations, and public Vitest fixture.
- `@tendriller/tools` — self-contained `tendril` and `tendril-preview` executables consuming built public artifacts.

`scripts/check-boundaries.mjs` verifies zero `node:*` imports in `dist/engine/worker.mjs`, clean `chronolog-authority-package/v2` (`dirty: false`) provenance, and strict package boundaries.
