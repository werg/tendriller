# Agent workspace

One maintenance agent, one account credential, one shared signer and one shared wrap key; any number of explicitly granted pages. One install and optional `tendril agent run` program serve them through one control-only hub and local attach endpoint. Application operations remain on participating browsers/native page stores, never the host database or hub.

## Layout

```
tendriller.json                 service + agent identity + pages/<slug> registrations
setup.mjs                      workspace page lifecycle
shared/                        maintained browser/native composition and helpers
templates/notes|inventory|call/ page source templates
pages/<slug>/                  one page source → dist/ authored graph
.tendriller/agent/             private shared signer, wrap key, account credential and attach state
.tendriller/pages/<page-id>/    private page record, signed publication/genesis intents, page data store and initialized.json
```

Use Node 24. Read the chosen origin's `/api/service`, discovery and `/api/readiness` before acquisition; require open creation readiness. Install the selected immutable `firstApp.release` kit's exact SDK/tools/authority/session archives and lockfile once. Inventory selects the exact SQL/browser WASM composition; setup never downloads another engine or needs a native SQL addon.

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

`page:new` refuses nonempty source folders. `init` prepares execution/finality policy and the independent publication grant for the shared agent key, then creates the page data as its creator (`shared/helpers/page-data.mjs`): the signed descriptor, genesis membership pinning the owner account and host attestation key, and the first epoch key in the agent's page store, recorded by `initialized.json`. The genesis admission policy makes the owner account's devices administrators unless `--owner-grant writer|reader` says otherwise (change it later with `tendril page owner-grant`). `--browser-first` (implied by `--browser-finalizer`) skips creation and leaves it to the owner's first browser. `deploy` signs and saves the exact authored graph before submission, directly through the granted page client; it does not attach to a running native program. Only `pages/<slug>/dist/` is publishable.

The owner signs in on the published page. The browser (`shared/helpers/browser-bootstrap.mjs`) creates its device key and wrap key and obtains a host attestation for the owner account; the running agent, or any other online member, admits it into signed membership and wraps the epoch keys to it. Cached browsers open local state before background discovery. **Devices and access** (`shared/helpers/devices-view.mjs`) shows the waiting state, every device and agent, **New device signed in** notices, Remove device, the strict-mode switch, pending Approve and invites; an invite link (`#invite=…`) is redeemed from the URL fragment. Account login, code publication and membership never confer SQL row/column/DDL rights.

Inventory uses the same lifecycle with `--template inventory`. Tables and labels are ordinary authorized CREATE/ALTER/DML programs in its browser UI, not setup metadata. A later earlier operation can revise outcomes, rows and schema; local drafts, stable selection, focus and exact signed intents remain separate from the current materialization.

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

The optional workspace program, an actual request worker and the surrounding conversation have separate lifetimes. A connected program or `tendril watch --events` output does not start another conversation turn. Before promising that behavior, read the selected service's `/docs/CONVERSATION_DELIVERY.md` and qualify its exact host route in the same existing thread. The supplied `consumers/codex-queue.mjs` receiver steers a running Codex turn and uses queue/resume while idle or unloaded. Plain `codex queue` waits for a running turn to finish. Verify an incoming request is injected into the active turn before completion, then verify two idle wake requests across turn completion. Neither host admission nor a queue receipt proves the request was handled.

Use `shared/helpers/agent-requests.mjs` for durable requests, receipts and answers, and worker-owned ephemeral presence. Only a worker handling the advertised topics may announce them. Match the intended peer, `consumerId` and request topic in the browser, and verify that stopping the worker removes its availability while the workspace program stays connected. Keep per-page handled cursors with durable work (`consumers/request-worker.mjs`, `shared/helpers/agent-consumer.mjs`); stdout/read cursors alone do not acknowledge handling. A late earlier operation can invalidate an event cursor (`EVENT_CURSOR_STALE`); the worker stops for review rather than rewriting it.
