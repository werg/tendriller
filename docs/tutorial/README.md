# Browser-first agent workspace

One maintenance agent, one account credential and one shared signer; any number of explicitly granted pages. One install and optional `tendril agent run` program serve them through one control-only hub and local attach endpoint. Application operations remain on participating browsers/native page stores, never the host database or hub.

## Layout

```
tendriller.json                 service + agent identity + pages/<slug> registrations
setup.mjs                      workspace page lifecycle
shared/                        maintained browser/native composition and helpers
templates/notes|inventory/     page source templates
pages/<slug>/                  one page source → dist/ authored graph
.tendriller/agent/             private shared signer, account credential and attach state
.tendriller/pages/<page-id>/    private page record, signed publication/provisioning intents and optional data store
```

Use Node 24. Read the chosen origin's `/api/service`, discovery and `/api/readiness` before acquisition; require open creation readiness. Install the selected immutable `firstApp.release` kit's exact SDK/tools/authority/session archives and lockfile once. Inventory selects the exact SQL/browser WASM composition; setup never downloads another engine or needs a native SQL addon.

## Create → prepare → publish → browser sign-in

```sh
npx tendril workspace init --service https://YOUR_HOST --owner owner@example.com
npm run page:new -- notes --template notes --name "Shared notes"
npm run init -- notes
npm run deploy -- notes
# Give the ready page_url now. Do NOT start or wait for a native agent.
```

Alternatively use the account-linked route: `tendril workspace key --service ORIGIN`, call `register_agent` with its public arguments, retain the result privately, then `tendril workspace adopt --service ORIGIN --credential FILE`. The account and explicit per-page grants are independent of data roles and keys. Join an existing owner-approved agent with `workspace join`; existing pages need the dashboard's explicit agent grant and `tendril page grant <slug> <id>`. Keep the same service origin, credential and shared key across uncertain replies; never create another agent merely to retry.

`page:new` refuses nonempty source folders. `init` prepares execution/finality policy and the independent publication grant for the existing shared agent key. It creates NO page device, epoch key, schema or selected history. `deploy` signs and saves the exact authored graph before submission, directly through the granted page client; it does not attach to a running native program. Only `pages/<slug>/dist/` is publishable.

The owner signs in on the published page. Its first authorized browser retains its identity and epoch key before signed enrollment initializes the host-signed data root/membership/epoch commitment. Cached browsers open local state before background discovery. Fresh browsers prove their own key and receive explicit crypto grants plus a recipient-bound wrapped-key package from a reader. Account login, code publication and crypto membership never invent missing keys or confer SQL row/column/DDL rights.

Inventory uses the same lifecycle with `--template inventory`. Tables and labels are ordinary authorized CREATE/ALTER/DML programs in its browser UI, not setup metadata. A later earlier operation can revise outcomes, rows and schema; local drafts, stable selection, focus and exact signed intents remain separate from the current materialization.

## Optional single native agent program

The shared workspace signer already exists but has NO automatic data rights on any page. Explicitly provision it separately for each page:

1. Copy its public key from `tendril status`. In an authorized browser's **Add another device → Prove an optional native/external device key**, create an account-bound challenge for that exact key.
2. `npm run sign-enrollment -- notes CHALLENGE.json`; copy the public signed proof back to the browser and record it. This signs with the opaque shared identity; no keys or signer bytes are exported.
3. `npm run provisioning-request -- notes`; review its recipient fingerprint in the owner browser, grant the deliberate crypto rights and create its encrypted package.
4. `npm run import-provisioning -- notes PACKAGE.json`. Only verified keys plus a reader grant create the page's `initialized.json` native-eligibility marker.
5. `npm run agent` starts the ONE optional hub/program. It opens initialized pages from their own cached stores with the shared signer. Missing/unprovisioned pages never block browser reads or Save.

```sh
npx tendril --page notes query notes null
npx tendril --page notes command putNote '{"noteId":"example","text":"hello"}' --operation original-id
npx tendril watch --events
npx tendril mcp-stdio
```

Attach calls name a page and never open a second signer; detaching does not stop the agent. Hub loss reopens bounded control streams with backoff, while existing local authoring and direct links remain independent. The hub carries no application operations. Native SQL needs its explicit matching native capability only when that optional page executes SQL.

Optional MCP is prepared with `npm run assistant:prepare -- notes [--events]`; exact query/command/event approval remains separate. No adapter, page residency or hub connection establishes future wake of an existing assistant conversation. Local media preview never shares or stores an image without explicit consent and a configured authorized provider.

## Verify facts and lifecycle

Default finality is `none`: stored, coherent/revisable materialization, named-peer retention, finalized inclusion and exclusion are different observations. No-finality waits fail as unsupported. A configured finalizer is not demonstrated availability; sealed time can exclude genuine unseen offline work. Inspect/retry the retained original—never silently change its timestamp, signer, bytes or operation ID.

Verify desktop and 320px fresh profiles, signed publication before the first browser key, offline graph save/CRUD/reload, explicit second-device key transfer, convergence, actual peer receipts, late earlier DDL/state, denied SQL rights, keyboard/focus/Back/deep links, long content, unavailable optional features and cancellation. Keep before/after screenshots. A static preview or installed adapter is not qualification. Stop all browsers/native processes and live synchronization stops; saved local work does not require them. Report actual process lifetimes and exact untested boundaries. Production rollout is separate.
