# Use the agent workspace from a terminal

`tendril` drives one **agent workspace**: one account-level agent credential and
one signing key for many pages, one install, and `pages/<slug>/` source per page.
A single page is a workspace with one page. `tendril agent run` is the only
long-running local program. Every other command is a short invocation that either
talks to the host with the agent credential or attaches to a page owner inside
the running agent program.

## Start with only a domain

These commands need no workspace and make no authenticated request:

```sh
tendril guide --server https://YOUR_HOST          # workflow and documentation links; no network
tendril readiness --server https://YOUR_HOST      # current creation availability
tendril service --server https://YOUR_HOST        # public contract and limits
tendril probe --server https://YOUR_HOST --check-network
```

Use the selected connector service origin for every step. Creation never
defaults to production; an origin with a path, query, fragment or credentials is
refused without echoing it.

## Create or join a workspace

```sh
mkdir my-pages && cd my-pages            # or the extracted first-app kit
tendril workspace init --service https://YOUR_HOST --owner owner@example.com [--name laptop]
# or, with a one-time code from Dashboard -> Your agents -> Add agent:
tendril workspace join --service https://YOUR_HOST --code CODE [--name laptop]
```

With an account-linked MCP connector, create the shared key first and register it
through the connector instead:

```sh
tendril workspace key --service https://YOUR_HOST [--name laptop]
# prints the public register_agent arguments {name, publicKey}; call the tool with exactly those,
# save its result privately, then retain it:
tendril workspace adopt --service https://YOUR_HOST --credential FILE
```

`adopt` verifies the returned token against `GET /api/agent` before saving it. The
host derives the owner from the linked account, so no email is needed.

`workspace init` checks readiness and the host contract, creates the shared
signing key in `.tendriller/agent/identity.sqlite`, registers an unclaimed agent
for that owner (`POST /api/agents`) and saves its `ta_` token in
`.tendriller/agent/credential.json` (mode 600). The owner claims the agent by
signing in to any page it created. `workspace join` registers the agent under the
inviting account instead. Both write `tendriller.json`:

```json
{ "schemaVersion": 1, "service": "https://YOUR_HOST", "agent": { "id": "ag_…", "name": "laptop" }, "pages": {} }
```

`tendriller.json` holds no secret and can be committed; `.tendriller/` is private
and gitignored. A second `workspace init` in the same folder is refused instead of
registering another agent. Losing `.tendriller/agent/` loses the agent: restore it
from a checkpoint rather than creating a new key.

Commands find the workspace from the nearest `tendriller.json` above the current
folder; `--workspace DIR` or `TENDRIL_WORKSPACE` selects one explicitly.

## Pages

```sh
tendril page new notes [--name "Shared notes"]   # create a page granted to this agent
tendril page grant garden PAGE_ID                # register a page the owner granted
tendril page list                                # granted and registered pages
tendril status                                   # workspace, agent, grants, agent program
```

`page new` creates the page with `POST /api/agent/pages`; the creating agent
receives a full grant. It records `{ slug: { id } }` in `tendriller.json`, keeps
the page URL and application identity private in
`.tendriller/pages/<page-id>/page.json`, and creates `pages/<slug>/`. Agents never
receive account-wide access implicitly: an existing page appears only after the
owner grants it, and `page grant` registers it under a slug.

A page's Node source must include `pages/<slug>/agent.mjs` exporting
`openPage(context)`. The first-app kit supplies templates, initialization and
builds (`npm run page:new -- <slug>`, `npm run init -- <slug>`). A page is opened
by the agent program once `.tendriller/pages/<page-id>/initialized.json` exists.

## Run the agent program

```sh
tendril agent run
```

It keeps one hub WebSocket to the host for setup notices, discovery, invitations,
WebRTC rendezvous and assistant adapter streams of every page; application sync
data (WebRTC data channels, relay lanes) keeps direct per-page connections. For
each granted, initialized page it opens one Chronolog session with its own device
store (`.tendriller/pages/<page-id>/device.sqlite`) signed by the shared key, and
serves all of them on one local attach socket (`.tendriller/agent/owner/`).

stdout is one JSON object per event: `{running}`, `{hub, retryInMs?}`,
`{page, slug, state}` (`running`, `awaiting_initialization`, `page_retry`,
`session_ended`, `closed`, `granted_unregistered`), `{page, slug, revision, change}`
and page integration reports such as `{page, setup}` and `{page, pairing}`.
The hub reconnects with backoff; losing it fails the page control streams closed
so each one reopens through its own retry while sessions, local writes and direct
peer links continue. A `grant` event registers nothing by itself (it reports
`granted_unregistered`); `revoked` and `page-deleted` close that page. A newer
agent program for the same agent replaces the older hub connection, which then
stops reconnecting. A page initialized while the program runs is opened without
a restart. SIGINT/SIGTERM closes every page owner, the hub and the socket, then
exits 0; a cleanup or flush failure exits nonzero.

Only one agent program runs per workspace: the attach socket's directory holds an
exclusive owner fence, and each page device store is exclusive.

## Inspect and submit domain work

Session commands attach to one page owner inside the running agent program.
`--page <slug|id>` selects the page; it may be omitted when the workspace has one
page. Detaching never stops the owner, and an unavailable agent program is an
error (`OWNER_UNREACHABLE`) rather than a reason to open a second signer.

```sh
tendril --page notes self
tendril --page notes describe
tendril --page notes status
tendril --page notes query notes null
tendril --page notes command addNote '{"text":"review"}' --operation note-review-1 [--based-on '<revision JSON>']
tendril --page notes operation note-review-1
tendril --page notes retry note-review-1
tendril --page notes command-batch '[{"command":"addNote","input":{"text":"a"},"operationId":"a-1"}]'
```

Operation IDs are required and remain stable across exact retries. Attachments
namespace a short caller ID by the application and the authenticated local
binding. Commands wait for applied execution by default. `--saved` returns after
the exact attempt is saved; `--shared` additionally waits for retained coverage.
A timeout leaves the original attempt available. Inspect it or retry that same
identity. Applied and shared observations can later be abandoned by an explicit
recovery selection.

`--timeout` is in **seconds** (default 30). Timeout cancels observation, not a
saved signed attempt. Errors keep the timeout/action cause separate from local
cleanup failures. `--pretty` formats JSON.

## Events, signals and recovery

`events` captures a coherent applied view and releases it after reading. Its
opaque cursor belongs to that history. `watch` streams session changes with
stdout backpressure; `watch --events` reads coherent applied event batches after
each change and prints `{revision, events, cursor, hasMore}` rows. With `--page`
it watches one page. Without `--page` it is one combined stream over every
initialized page, each row carrying `page`, and `--cursor` takes a JSON object
of page id to cursor:

```sh
tendril watch --events --topics '["note"]'
tendril watch --events --cursor '{"aaaaaaaaaaaa":"<processed cursor>"}'
tendril --page notes watch --events --cursor "$PROCESSED_CURSOR"
tendril --page notes signal progress '{"complete":3}' --ttl 2000
tendril --page notes logs [--latest]
tendril --page notes recovery inspect
tendril --page notes recovery takeover --transition recover-on-device-b
```

An unexpected end, owner loss or read failure exits nonzero with a `watch` object
on stderr (`mode`, `cursor` or `cursors`, `revision`). A requested `--timeout`
or SIGINT/SIGTERM stops normally and exits 0 with that summary. Persist the
**processed** cursor together with your own results; a stdout write is not a
processing receipt. Recovery that invalidates a cursor fails with the original
recovery error and retained cursor; it never silently resets to the beginning.

## Publish signed page code

```sh
tendril --page notes definition
tendril --page notes publication
tendril --page notes --timeout 120 publish ./pages/notes/dist --operation notes-release-1
```

The complete authored graph is hashed and passed to the page owner's
`preparePublication`; `publish` sends that saved signature and content-addressed
bytes through its control participant. Reusing the same operation recovers the
same signed intent; a changed graph under that identity is refused. Without
`--operation`, the identity is derived from the previous head and the graph.

### Publication capability and retained bindings

The agent program creates one local terminal binding
(`.tendriller/agent/attach.json`) with ordinary application capabilities and
`publish`, not `ownerAdmin`. It is reused verbatim on restart and never broadened.
The agent key's publisher grant in the page application remains a separate
requirement.

### Reconcile a publication after an uncertain response

Keep the agent program running and inspect through the same page:

```sh
tendril --page notes publication
tendril --page notes publication-operation notes-release-1
```

Compare the exact signed graph and retry only the original operation and bytes;
do not invent a new operation ID after a timeout. A retained host receipt and a
verified current head are separate observations.

## Page host commands

These use the agent credential on `/api/agent/pages/<id>/…` and carry no domain
commands:

```sh
tendril --page notes info [--show-url]
tendril --page notes meta '{"name":"Garden"}'
tendril --page notes release
tendril --page notes activity [--after N]
tendril --page notes link list | create '<json>' | rotate <id> | remove <id>
tendril --page notes notify --title "Ready" [--body TEXT] [--path REL] [--tag TAG] [--badge N]
tendril --page notes remove --yes
```

`info` redacts the page URL unless `--show-url` is given. `remove --yes` deletes
hosted state and unregisters the slug; the page's private folder is kept for
recovery.

### Set a favicon

```sh
tendril --page garden meta '{"icon":"🌱"}'
```

The host converts a single emoji (including compound emoji) to an SVG. An HTTPS
image URL is also accepted; `meta '{"icon":null}'` restores the default. Authored
icon tags or manifests take precedence; see [page branding](../BROWSER_API.md#favicons-and-page-branding).

## Local MCP and ordered command batches

A local MCP client launches `tendril mcp-stdio` from the workspace (start
`tendril agent run` first). The newline-delimited stdio server exposes
`pages_list`, `app_discover`, `state_query`, `command_submit`,
`command_submit_batch`, `operation_inspect`, `signal_send` and `notify_user`.
Every tool except `pages_list` takes a required `page` (slug or id) and attaches
to that page only. Tool calls have a fixed 30-second deadline and support
cancellation; saved work survives a cancelled waiter. This supplies local tools;
it does not imply that the client supports background conversation wake.

`command-batch` accepts up to 64 ordered entries and the MCP batch up to 32. These
are ordered individual commands, not one atomic transaction. Malformed envelopes
fail before the first submission; results keep the original operation IDs and
report incomplete batches with `nextIndex`.

## Retain irreversible provider effects separately

`createEffectDispatcher` requires a durable journal outside the application's
recoverable history. The native export supplies
`createSqliteEffectJournal({path, applicationId, providerId})`:

```js
import { createEffectDispatcher } from '@tendriller/core/collaboration';
import { createSqliteEffectJournal } from '@tendriller/core/native-owner';

const journal = await createSqliteEffectJournal({
  path: '/private/my-pages/.tendriller/pages/PAGE_ID/effects.sqlite',
  applicationId, providerId: 'mail-provider',
});
const effects = createEffectDispatcher({ journal,
  authorize: verifyCurrentClaimFence,
  dispatch: ({ idempotencyKey, input }) => provider.send({ idempotencyKey, ...input }),
  reconcile: (_effectId, record) => provider.findReceipt(record.idempotencyKey),
});
await effects.execute({ effectId, fence: reviewedClaimFence, input });
```

The journal commits `dispatching` before calling the provider. A timeout, process
loss or missing receipt remains uncertain; reopening first reconciles the original
provider identity and never dispatches it again automatically.

## Share source without device state

`tendril handoff source handoff.tgz --project ./my-pages` exports code,
documentation, static assets and package manifests. It excludes hidden files,
`.tendriller/`, environment files, device/checkpoint bytes and state directories,
and rejects recognized credentials (including `ta_` agent tokens) embedded in
source. The recipient sets up its own workspace; the archive transfers no authority.

## Move a stopped retained device

Stop `tendril agent run`, load `TENDRILLER_CHECKPOINT_SECRET` from private storage
(a 64-hex key or a passphrase of at least 12 characters), then:

```sh
tendril checkpoint export ./move.clcp --project ./my-pages --device ./my-pages/.tendriller/pages/PAGE_ID/device.sqlite
tendril checkpoint restore ./move.clcp --project ./my-pages --device /new/my-pages/.tendriller/pages/PAGE_ID/device.sqlite
```

The encrypted file is durably written before the source store is retired; restore
publishes one fresh private file and never replaces existing output. A page device
uses the workspace's shared signer, so move the whole `.tendriller/agent/` folder
(identity and credential) with it, and run only one copy of that workspace.

## Request workers and existing conversations

`watch --events` reports retained observations; its stdout cursor does not
acknowledge application work or start a Codex/ChatGPT turn. The first-app kit
ships `consumers/request-worker.mjs` for actual declared request handling and
`consumers/codex-queue.mjs` for admitting reference-only notices from several
pages to one exact existing Codex thread: it inspects thread state, steers a
running turn and uses queue/resume while idle or unloaded. Plain `codex queue`
waits for a running turn to finish and does not provide active injection. Both
consumers attach to the running workspace owner and retain private, scoped state. Use the
[runnable worker](../AGENT_REQUESTS.md#run-a-supervised-consumer-with-a-handled-checkpoint)
and [conversation guide](../CONVERSATION_DELIVERY.md) for exact commands,
uncertain-result recovery and live active/idle qualification. A steer or queue
receipt is not a durable application receipt/answer or evidence of model execution.
