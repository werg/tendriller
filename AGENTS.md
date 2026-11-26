# Working with Tendriller

## Build an application for a user

Read [the agent entry point](agent.md), then follow [Build an app](docs/BUILD_AN_APP.md) and [State models](docs/STATE_MODELS.md).
Deliver the [running application](docs/AGENT_DELIVERY.md): start provisioning early, prepare and publish before claim, give the human the ready page URL without asking for a claimed reply, and verify browser operation and peer convergence.

The agent program (`tendril agent run`) admits new devices and runs native features; never make its reachability a prerequisite for an admitted browser's reads or durable writes. Use the [capability map](docs/CAPABILITIES.md) and import/adapt the starter helper modules (`docs/tutorial/shared/`) before implementing custom plumbing.

Start at the requested service origin's `/api/service`, `/.well-known/tendriller.json` (using its immutable `firstApp.release` composition route), and `/api/readiness`. Require open creation readiness (`mode: "open"`, `creation.available: true`). Install with `npm ci --ignore-scripts` — Chronolog v2 requires **zero native C/C++ builds** (Node 22.15+ built-in `node:sqlite` + portable `quickjs-ng` & `sqlite-cas.wasm`).

One **agent** has one `ta_` credential, one Ed25519 signing key, and one X25519 wrap key shared across its pages (`tendriller.json`, `pages/<slug>/`, `shared/`, private `.tendriller/`). Every agent chooses a unique speakable lowercase `@handle` (`^[a-z][a-z0-9_-]{1,31}$`) and optional `bio` (≤160 chars). With account-linked MCP, register via `register_agent` and retain locally with `tendril workspace adopt`.

### Chronolog v2 architecture rules for agents

1. **Flat timestamp-ordered CRDT:** Every operation is immutable and Ed25519-signed; canonical order is solely `(authorTimestampMs, author, opId)`. No host, peer, or finalizer assigns operation order.
2. **Hash-pinned ES Module reducers in `$reducers`:** Write application logic as ES Modules pinned in CAS (`imports` + `topics` in `createChainGenesis`). Every peer — browser, Node agent, and opt-in hosted MCP — runs the exact same QuickJS-NG reducer code. Do **not** build a separate `domain.js` bundle!
3. **Built-in SQLite-CAS + Postgres-style write RLS:** Import `{ open } from 'chronolog:sqlite'` for relational state, FTS5, and `sqlite-vec` over 4 KiB Merkle-paged CAS. Use `chronolog/rls` (`applyRls`, `ensureTableOwners`, `getOwnedTables`, `recordTableOwners`) for SQL write guards (`actor()`, `op_id()`, `op_time()`) and safe user-owned dynamic tables. Schema changes (`CREATE TABLE`, `ALTER TABLE`, `DROP TABLE`) are ordinary signed transactions — never freeze schema in host metadata.
4. **Strict blind-host control partition:** On private chains, `$*` control topics (`$reducers`, `$permissions`, `$keys`, `$finality`, `$publications`, `$signal_policy`) are public control ops replayed by Tendriller's blind Worker (`TopicKernel({ blindHostMode: true })`). Application topics are encrypted under epoch keys held only by admitted readers; HPKE lockboxes live in `$keys`.
5. **Atomic admission & revocation:** `session.admitMember(...)` atomically updates `$permissions` and seals current + historical epoch HPKE lockboxes into `$keys`. `session.removeMember(pk, { rotate: true })` revokes a member and rotates the epoch key. On `finality: none`, late revocations immediately roll back invalidated provisional `$publications` releases and close revoked peer sockets on the host.
6. **Optional finality (`$finality`):** Ordinary apps default to `finality: none`. Finality checkpoints never assign order; missing finality never blocks local authoring. Retain original `operationId` and signed bytes across uncertain replies (`session.operations.retry`).
7. **Reactive UI over coherent snapshots:** Prefer `createLiveView` / `session.query` + separate local drafts (`createViewStore`). Late earlier operations can revise SQL outcomes, rows, and schema — invalidate and rederive rather than accumulating arrival events as UI truth.

## Verify the user experience

A request for a full-featured application requires domain views, not a raw JSON editor. Exercise every main flow in a real browser at desktop and phone widths; verify offline authoring, reload persistence, peer convergence, deep links, Back, keyboard access, and error states.

## Contribute to this repository

Use Node 22.15 or newer (`npm ci --ignore-scripts`). Read [development](docs/DEVELOPMENT.md) before editing. `npm run check` is the core gate; `npm run check:release` includes browser qualification. Run `npm run contract:generate` after executable metadata-schema changes.

Keep the host application-neutral:
- `server/` owns authentication, OAuth 2.1, blind public-control `TopicKernel`, signed `$publications` R2 assets, introductions/relay, and RAM-only hosted MCP (`quickjs-ng` + `sqlite-cas.wasm`). Zero `node:*` imports in `dist/engine/worker.mjs`.
- `contract/` owns the public SDK.
- `session/` owns browser/worker/native owners, v2 admission, participation, and diagnostics.
- `collaboration/` owns the optional `chronolog:sqlite` collaboration ES Module reducer and client.
- `runtime/` owns zero-Chronolog browser composition, offline cache, sensors, and optional voice.
- `tools/` consumes built public artifacts only.
- `docs/tutorial/` is the public starter workspace; never import it into `server/` or `runtime/`.

### Release changelog, sunsetting & deploy broadcasts

Tendriller compiles `releases/entries/<YYYY-MM-DD>-<slug>.json` during `npm run build` into `docs/CHANGELOG.md` and `server/src/release-changelog.json`. Add entries ONLY for major features, security advisories, deprecations (with `sunset_at`), or breaking removals; automated deploy broadcasts target `audiences: ["agents", "mcp"]` only. Run `npm run build` after adding an entry.
