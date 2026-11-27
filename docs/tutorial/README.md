# Agent workspace

One maintenance agent, one account credential, one shared signer and one shared wrap key; any number of explicitly granted pages. One install and optional `tendril agent run` program serve them through one control-only hub and local attach endpoint. Application operations remain on participating browsers/native page stores, never the host database or hub.

## Layout

```
tendriller.json                 service + agent identity + pages/<slug> registrations
setup.mjs                      workspace page lifecycle
shared/                        maintained browser/native composition and helpers
templates/notes|inventory|knowledge|call/ page source templates
pages/<slug>/                  one page source → dist/ authored graph
.tendriller/agent/             private shared signer, wrap key, account credential and attach state
.tendriller/pages/<page-id>/    private page record, signed publication/genesis intents, page data store and initialized.json
```

Use Node 22.15+ (`npm ci --ignore-scripts`). Read the chosen origin's `/api/service`, discovery and `/api/readiness` before acquisition; require open creation readiness. Install the selected immutable `firstApp.release` kit's exact SDK/tools/authority/session archives once. Both JSON reducers (`notes`) and deterministic SQLite-CAS + RLS reducers (`inventory`, `knowledge`) run on `@chronolog/peer-session` (`quickjs-ng` + `sqlite-cas.wasm`) directly from `$reducers`.

## Create → initialize → publish → owner sign-in

```sh
npx tendril workspace init --service https://YOUR_HOST --owner owner@example.com --handle notes-agent
npm run page:new -- notes --template notes --name "Shared notes"
npm run init -- notes
npm run deploy -- notes
npm run agent        # keep running: it admits the owner's browsers
# Give the ready page_url now; do not wait for a claimed reply.
```

Alternatively use the account-linked route: `tendril workspace key --service ORIGIN --handle HANDLE`, call `register_agent` with its public arguments, retain the result privately, then `tendril workspace adopt --service ORIGIN --credential FILE`. The account and explicit per-page grants are independent of data membership and keys. Join an existing owner-approved agent with `workspace join`; existing pages need the dashboard's explicit agent grant and `tendril page grant <slug> <id>`. Keep the same service origin, credential and shared key across uncertain replies; never create another agent merely to retry.

`page:new` refuses nonempty source folders. `init` prepares host metadata and creates the Chronolog `LogGenesis` (`$reducers` ES Modules pinned in CAS, `$permissions` pinning the owner account and host attestation key, `$keys`, `$finality`, `$publications`) plus epoch 0 key locally (`shared/helpers/page-data.mjs`), recorded by `initialized.json`. The genesis admission policy makes the owner account's devices administrators unless `--owner-grant writer|reader` says otherwise. `--browser-first` skips agent creation and leaves it to the owner's first browser. `deploy` signs a `$publications` public-control op and uploads the built UI assets from `pages/<slug>/dist/` to R2.

The owner signs in on the published page. The browser (`shared/helpers/browser-bootstrap.mjs`) creates its device key and X25519 wrap key and obtains a host-signed Ed25519 attestation (`signHostAttestationV2`); the running agent (or any online administrator) calls `session.admitMember(...)` to atomically add the device to `$permissions` AND seal historical + current epoch HPKE lockboxes into `$keys`. Cached browsers open local state before background discovery.

Inventory uses the same lifecycle with `--template inventory` and showcases `chronolog:sqlite` (stock SQLite + FTS5 + `sqlite-vec` over 4 KiB Merkle-paged CAS) alongside Postgres-style write RLS (`chronolog/rls`) and dynamic user-owned tables (`CREATE TABLE` / `ALTER TABLE` / `DROP TABLE` as ordinary signed transactions!). Knowledge (`--template knowledge`) adds local-first encrypted AI memory with combined FTS5 BM25 + `sqlite-vec` k-NN + RRF hybrid search and write RLS (`shared/helpers/hybrid-memory.mjs`). Owners can also remix existing pages or import a portable `PageBlueprint` directly from `/dashboard`.

Call rooms use `--template call` and include URL-addressable, hot-swappable facets (`facets.json`, `facets/stage.mjs`, `facets/notes.mjs`). Editing only `facets/*.mjs` or `facets.json` and running `npm run deploy -- <slug>` updates the live stage inside its Shadow DOM without reloading the call or dropping WebRTC media, and `?view=<id>` links open specific views over the same Chronolog data.

## The single agent program

`npm run agent` starts the ONE hub/program. It opens every initialized page from its own cached store with the shared signer and runs that page's admission: as creator it admits the owner's browsers; on a browser-first page it waits until a member admits it from its signed host grant (dashboard checkbox, `tendril page grant` or the creator grant). Admitted browsers' reads and Save never depend on it. Import data through an attached session while it runs:

```sh
npx tendril --page notes query notes null
npx tendril --page notes command putNote '{"noteId":"example","text":"hello"}' --operation original-id
npx tendril watch --events
npx tendril mcp-stdio
```

Attach calls name a page and never open a second signer; detaching does not stop the agent. Hub loss reopens bounded control streams with backoff, while existing local authoring and direct links remain independent. The hub carries no application operations. Native SQL needs its explicit matching native capability only when that optional page executes SQL.

Optional hosted MCP access is opted in per page and OAuth grant on `/connections` (`_tendril/mcp/connect`), using OAuth-token-wrapped X25519 keys with zero plaintext keys stored at rest. Local media preview never shares or stores an image without explicit consent and a configured authorized provider.

## Verify facts and lifecycle

Default finality is `none`: stored, coherent/revisable materialization, named-peer retention, finalized inclusion and exclusion are different observations. No-finality waits fail as unsupported. A configured finalizer is not demonstrated availability; sealed time can exclude genuine unseen offline work. Inspect/retry the retained original—never silently change its timestamp, signer, bytes or operation ID.

Verify desktop and 320px fresh profiles, owner sign-in admitted by the agent, offline graph save/CRUD/reload, second-device admission and Remove device, convergence, actual peer receipts, late earlier DDL/state, denied SQL rights, keyboard/focus/Back/deep links, long content, unavailable optional features and cancellation. Keep before/after screenshots. A static preview or installed adapter is not qualification. Stop all browsers/native processes and live synchronization and new-device admission stop; saved local work does not require them. Report actual process lifetimes and exact untested boundaries. Production rollout is separate.

## Connect a request worker or conversation

The optional workspace program, an actual request worker and the surrounding conversation have separate lifetimes. A connected program or `tendril watch --events` output does not start another conversation turn. Before promising that behavior, read the selected service's `/docs/CONVERSATION_DELIVERY.md` and qualify its exact host route in the same existing thread. The supplied `consumers/codex-queue.mjs` receiver steers a running Codex turn and uses queue/resume while idle or unloaded (plain `codex queue` waits for a running turn to finish). For Google Antigravity, use `consumers/antigravity-bridge.mjs` (`--mode agentapi` for continuous `agentapi send-message` delivery with workspace verification and live `ConversationService` presence, `--mode wait` for reactive one-shot background-task wake, or `--mode new-conversation` for isolated unattended runs; see `/docs/ANTIGRAVITY_INTEGRATION.md`). Verify an incoming request is injected into the active turn before completion, then verify two idle wake requests across turn completion. Neither host admission nor a queue receipt proves the request was handled.

Use `shared/helpers/agent-requests.mjs` for durable requests, receipts and answers, and worker-owned ephemeral presence. Only a worker handling the advertised topics may announce them. Match the intended peer, `consumerId` and request topic in the browser, and verify that stopping the worker removes its availability while the workspace program stays connected. Keep per-page handled cursors with durable work (`consumers/request-worker.mjs`, `shared/helpers/agent-consumer.mjs`); stdout/read cursors alone do not acknowledge handling. A late earlier operation can invalidate an event cursor (`EVENT_CURSOR_STALE`); the worker stops for review rather than rewriting it.
