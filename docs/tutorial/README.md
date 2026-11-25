# First application: an agent workspace

This kit is a **workspace**: one maintenance agent with one credential and one
signing key, one install, and any number of pages under `pages/<slug>/`. A single
page is a workspace with one page. `tendril agent run` is the only long-running
local program: one hub connection to the host, one Chronolog session per
initialized page (each with its own device store and the shared signer), and one
local attach socket that terminal commands, MCP clients and helpers name a page on.

This is the complete source used by the selected service's
`/docs/BUILD_AN_APP.md`. Node 24 is the qualified first-app runtime (the kit
requires at least 24); core's separate minimum remains Node 22.15. Check that
service's `/api/readiness` before acquiring dependencies. Follow its build guide
to download and verify the immutable `tendriller-first-app-VERSION.tgz` release
kit in a new directory. The kit carries this source, `composition.json`, and its
exact SDK, tools and Chronolog events archives under `packages/`; install those
local archives once for the whole workspace after their hashes and the selected
host's build identity agree.

The host's `/downloads/tendriller-first-app.tgz` and this repository directory
contain source for inspection. They are not the complete qualified release kit;
do not combine them with same-version packages from another source checkpoint.

## Layout

```
tendriller.json          { schemaVersion, service, agent: { id, name }, pages: { <slug>: { id } } }
package.json             one install for every page
setup.mjs                page lifecycle: new, init, enroll, build, deploy, assistant, demo
shared/                  shared native composition, browser connection/pairing, helpers/, ui/, media/
templates/notes/         events-backed Shared Notes page source
templates/inventory/     guarded SQL inventory page source (needs the SQL Chronolog archives)
pages/<slug>/            one page's source (copied from a template) -> pages/<slug>/dist/
.tendriller/             private, gitignored
  agent/                 identity.sqlite (shared signer), credential.json, attach.json, owner/
  pages/<page-id>/       page.json, device.sqlite, descriptor and setup records
```

## Create, publish and run

After installing the packages:

```sh
npx tendril workspace init --service https://YOUR_HOST --owner owner@example.com
npm run page:new -- notes --template notes --name "Shared notes"
npm run init -- notes
npm run build -- notes
npm run agent            # tendril agent run: keep it running
npm run deploy -- notes  # publishes through the running agent program
# Now give the owner the page_url from page:new; they sign in to claim the
# agent and its pages. Do not wait for a claimed reply before publishing.
```

`workspace init` checks readiness, creates the shared signing key in
`.tendriller/agent/identity.sqlite` and registers an unclaimed agent for that
owner. The owner claims the agent by signing in to any page it created. On a
signed-in dashboard the owner can instead add an agent and paste its one-time
code: `npx tendril workspace join --service https://YOUR_HOST --code CODE`. With an
account-linked MCP connector, `npx tendril workspace key --service https://YOUR_HOST`
prints the `register_agent` arguments; save that tool's result privately and run
`npx tendril workspace adopt --service https://YOUR_HOST --credential FILE`.
Pages an agent creates are granted to it; an existing page needs the owner's
explicit grant (the per-agent checkbox on the dashboard or the page's **Add people
& devices → An agent**), after which `npx tendril page grant <slug> <page-id>`
registers it.

`page:new` refuses a non-empty `pages/<slug>/` folder: retained source or build
output belongs to an existing page. Choose another slug for an explicitly new
page. The page URL and application identity stay private in
`.tendriller/pages/<page-id>/page.json`; `tendriller.json` holds only slugs and ids.
For scripts that parse helper output, use `npm run --silent init -- notes` or
`node setup.mjs init notes`, read JSON from stdout and check the exit status.

`init` configures the page's application with the agent key as administrator and
publisher, saves the signed genesis request before its first send, selects it and
writes `initialized.json`. A running `tendril agent run` notices it and opens the
page without a restart. Setup records are write-once: a retry never generates
another identity or changes a signed transition.

Only `pages/<slug>/dist/` is publishable. `.tendriller/` holds the agent token,
the signer and every page's device and setup records; keep it out of Git and page
assets. The browser receives keys only through the authenticated session's
reader-to-reader key exchange.

## The agent program

```sh
npm run agent                               # one process for every page
npx tendril status                          # workspace, grants, registered pages
npx tendril --page notes self               # attach to the notes page owner
npx tendril --page notes query notes null
npx tendril --page notes command addNote '{"text":"hello"}' --operation note-1
npx tendril watch --events                  # every running page, with a cursor per page
npx tendril mcp-stdio                       # local MCP; every tool takes page
```

Session commands attach to the page owner inside the agent program; detaching
never stops it and an unavailable agent never opens a second signer. The agent
reconnects its hub connection with backoff. Losing the hub fails the page's
control streams (setup notices, discovery, invitations, rendezvous, assistant)
so each one reopens through its own retry, while local data, local writes and
direct peer links continue. Page sync data (WebRTC, relay) never uses the hub.

The page's owner handles browser pairing with its existing session and signer.
After the browser proves possession of its own key, the owner retains the pairing
intent, durably pauses command ordering and saves the exact signed member-only
proposal. The host verifies it against the proved key, account and current
authority and approves it automatically for the signed-in owner or an admitted
guest; there is no approval screen. The proposal binds the key, account,
application, origins, narrow reader/writer rights, selected generation and
retained prefix. Each request expires after ten minutes; idle setup has no
polling or heartbeat, and setup notices for every page arrive over the agent
program's one hub connection.

Private pairing records are `pairing-ID-intent.json`, `pairing-ID-prepared.json`,
`pairing-ID-commit.json` and `pairing-ID-outcome.json` under the page's private
folder. A lost response leaves uncertain work paused; keep the agent program and
records and let it reconcile the original signed transition. Never delete the
records, copy the signer or sign a replacement prefix to resume writes.
`npm run enroll -- notes PUBLIC_KEY` remains a deliberate manual administration
route; stop the agent program first, because it owns the page device while running.

Before claim, `awaiting_owner_claim` means the owner should open the published
page and sign in. `awaiting_assistant_consent` is a separate optional review.

The browser can read/write notes but cannot administer, publish, coordinate or
recover. Keep the agent program running for applied writes from the agent and for
live synchronization; local browser saves never wait for it.

If publishing times out, keep `dist/`, `.tendriller/` and the original operation.
Inspect `npx tendril --page notes publication` and
`npx tendril --page notes publication-operation OPERATION`, compare the exact
signed graph and retry only the original operation and bytes.

Ctrl-C/SIGTERM on the agent program closes every page owner, then the hub and the
attach socket. A failed cleanup or flush is nonzero.

## Adapt a page

Keep device identity independent of titles: the page, pairing Worker and
application Worker all import `shared/helpers/browser-profile.mjs`. Keep
`configuration.page_url` from the page record; the service origin and the
published page origin serve different roles.

Adapt `pages/<slug>/domain.mjs`, the views and handlers in `page.mjs`, the display
name/HTML, and the assistant selection in `assistant.mjs`. The build derives the
definition ID/version into public configuration and refuses a definition that
differs from the retained initialized descriptor. Restore that definition for
existing history, or create a new page for a different domain.

| Source | Purpose |
| --- | --- |
| `setup.mjs` | Page lifecycle across the workspace |
| `shared/local.mjs` | Page context from the workspace (`@tendriller/tools/workspace`) and the empty-folder check |
| `shared/native-page.mjs` | One page's owner in the agent program: authority, control, participation, setup notices, pairing, assistant |
| `shared/pairing-native.mjs` | Durable ordering pause and exact signed transition recovery |
| `shared/participant-lifecycle.mjs` | Setup notices, pairing passes and the optional adapter on one owner |
| `shared/connection.mjs`, `shared/connect-view.mjs` | Browser connection state and its card |
| `shared/pairing-browser.mjs`, `shared/pairing-worker.mjs` | Browser pairing request and proof with its own fenced device |
| `shared/helpers/`, `shared/ui/` | Importable coherent views, operation observations and reviewed input |
| `shared/media/` | Camera/file and runtime voice controls; opt-in native inference participant |
| `templates/notes/` | `domain.mjs`, `agent.mjs` (openPage), `setup.mjs`, `build.mjs`, `assistant.mjs`, `page.mjs`, `worker.mjs`, `index.html` |
| `templates/inventory/` | Guarded SQL inventory: engine check, setup, agent, build, demo |

[Application patterns](https://tendriller.dev/docs/APP_PATTERNS.md) explains the
helper interfaces and their ownership boundaries. The page's **Review a photo**
controls work with manual review immediately. The optional **Analyze photo** path
needs `node shared/media/inference-peer.mjs --page notes ...`, which attaches to the
running agent program (see [Reviewed AI input](https://tendriller.dev/docs/AI_INPUT.md)).

For stock deductions or other guarded relational changes, follow
[State models](https://tendriller.dev/docs/STATE_MODELS.md) and
[the inventory template](templates/inventory/README.md). It needs the matching
SQL-native and SQL-browser Chronolog archives; the events-only archive cannot run it.

## Optional MCP access

Run `npm run assistant:prepare -- notes` before owner sign-in and retain its
returned review URL; give the owner the ready page and review URL together. The
running agent program connects the adapter after the owner approves the
permission review, through the page's setup notices. The default selection is the notes query and add-note command.
`npm run assistant:prepare -- notes --events` also forwards `note.added` events from
a retained private cursor (`assistant-event-cursor.json`). Forwarding does not
create an MCP subscription, run a future model turn, or extend any process
lifetime. Missing consent, adapter failure, revocation and replacement leave the
page owner running. If forwarding reports `adapter_activity_failed`, keep the
exact cursor and review the recovery history before restarting the agent program.
