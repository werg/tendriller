# Use the agent workspace from a terminal

`tendril` drives one **agent workspace**: one account-level agent credential and
one signing key for many pages, one install, and `pages/<slug>/` source per page.
A single page is a workspace with one page. `tendril agent run` is the only
long-running local program, and it is optional: ordinary browser reads and durable
writes never depend on it, and the CLI does not install another signer, application
backend or retry queue. Every other command is a short invocation that either
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

Use the selected connector service origin for every step. Before package acquisition or creation, verify same-origin open readiness; pause, unavailable or unsupported responses stop new setup. Use the immutable kit's SDK/tools/**authority**/session composition and exact hashes/source identity. Creation never
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
by the agent program once `.tendriller/pages/<page-id>/initialized.json` exists. That file is written by the explicit native `sign-enrollment`, `provisioning-request` and `import-provisioning` steps, and only after the reader grant and current epoch key are verified; `init` alone does not create it.

## Browser-first publication

The starter's `npm run init -- <slug>` and `npm run deploy -- <slug>` prepare the host's publisher policy (the workspace's one opaque shared signer is the publisher; no per-page key) and sign the complete UI **before the first browser key exists**. They need no agent program, native data device, data root, fixed schema or finalizer. Give the owner the ready page URL; their real sign-in/key proof initializes local browser data keys. No claimed reply or second deployment is necessary. `init` creates no device, data root or key. The agent's shared key is a separate member of each page's application: it joins only through the explicit native `sign-enrollment`, `provisioning-request` and `import-provisioning` steps (an account-bound key proof, the owner's review of exact rights and recipient-bound epoch-key wrapping; see [session bootstrap](../SESSION_BOOTSTRAP.md)), never by a host token alone.

## Run the agent program

```sh
tendril agent run
```

It is optional for browser Save and live browser synchronization; it keeps one hub WebSocket to the host for setup notices, discovery, invitations,
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
error (`OWNER_UNREACHABLE`) rather than a reason to open a second signer. Exiting
detaches only this caller. `--mode independent --profile NAME` requires an
explicitly provisioned separate profile; one physical store owner and bounded
view/root lifetimes are local fencing, not an application ordering coordinator.

```sh
tendril --page notes self
tendril --page notes describe
tendril --page notes endpoints   # attached owner's endpoint diagnostics
tendril --page notes doctor      # bounded owner/session diagnostics, no secrets
tendril --page notes status
tendril --page notes query notes null
tendril --page notes command addNote '{"text":"review"}' --operation note-review-1
tendril --page notes operation note-review-1
tendril --page notes retry note-review-1
tendril --page notes command-batch '[{"command":"addNote","input":{"text":"a"},"operationId":"a-1"}]'
```

A command returns after the exact signed intent is **stored locally**, without waiting for peers, materialization, a current global read, an agent or finalizer. Operation IDs are required and remain stable across exact retries; attachments namespace a short caller ID by the application and the authenticated local binding. Inspection reports authenticated application/author/proposal identity and independent `stored`, `pending`, `materialized`, `retained`, `finalized`, and `excluded` facts. Retry calls only the original signer's retained journal; it never creates another core, nonce, time or ID.

Optional `--author-time MS` is an exact nonnegative int64 decimal string, converted to bigint and allocated once. Omit it for the authoring device's retained default. Canonical order is `(signed authorTimestampMs, signing key bytes, stable proposal-ID bytes)`, never receipt/delivery/host order.

Opt into a bounded observation explicitly:

```sh
tendril --page notes command addNote '{"text":"review"}' --operation note-review-2 --wait materialized
```

`--wait materialized` observes a **revisable** coherent local outcome. `--wait retained` requests authenticated peer storage evidence. `--wait finalized` requires configured verified finality and complete dependencies/replay; on `none`, finality is explicitly unsupported and never manufactures success. Interrupted waits preserve the original stored operation for inspection. `--timeout` is in **seconds** (default 30) and cancels observation, not a stored signed attempt; errors keep the timeout/action cause separate from local cleanup failures. `--pretty` formats JSON.

`command-batch` accepts 0..64 objects `{operationId,command,input,authorTimestampMs?}`; author timestamps, if supplied, are decimal strings. It validates all envelopes before dispatch, then stores individual commands in order of local invocation. This is not an atomic SQL program or global ordering mechanism. It stops on uncertainty with original IDs/facts and a next index; no hidden replay queue exists.

## Coherent reads and revision-aware watches

```sh
tendril --page notes query notes null
tendril --page notes events --topics '["note.put"]'
tendril watch --events
```

Named queries return `{value,revision}` from one captured coherent snapshot. Raw view SQL/event reads retain their captured revision and must be released. Materialized revisions are digests of effective authenticated operation/execution/policy inputs, not global sequence numbers.

Streaming `watch` records carry a `kind`. Plain `watch` first emits `{kind:"status", status, ...}` with the current session status, then emits session changes. `watch --events` instead starts with an initial captured snapshot even for a quiet retained owner, and emits:

| `kind` | Shape | Consumer action |
| --- | --- | --- |
| `snapshot` | `{revision, events, cursor, hasMore}` read from one captured coherent view | Apply by stable event identity; persist `cursor` only after processing it |
| `reset` | `{reason:"materialization-revised", revision, events:[], cursor:null, hasMore:true}` | An earlier operation, authority or schema change revised the effective history. Discard rows derived from earlier snapshots and rebuild from the snapshots that follow; the next cursor restarts from `null` |

Snapshots after a `reset` replay the revised effective events from the start. Never treat provisional arrivals as an append-only UI database; consumers replace/rederive by stable event identities. A stored cursor from before a reset is never a valid resume point for the revised history, which reports an explicit stale-cursor revision error (`EVENT_CURSOR_STALE`); rescan from a fresh coherent view instead. With `--page` it watches one page. Without `--page` it is one combined stream over every initialized page, each row carrying `page`, and `--cursor` takes a JSON object of page id to cursor. A cursor from another projection reports an explicit revision error. Persist the **processed** cursor together with your own results; a stdout write is not a processing receipt and emitted progress is not proof of consumer processing or irreversible finality.

```sh
tendril watch --events --cursor '{"aaaaaaaaaaaa":"<processed cursor>"}'
tendril --page notes watch --events --cursor "$PROCESSED_CURSOR"
tendril --page notes signal progress '{"complete":3}' --ttl 2000
tendril --page notes logs [--latest]
```

Output is NDJSON with backpressure. An unexpected end, owner loss or read failure exits nonzero with a `watch` object on stderr (`mode`, `cursor` or `cursors`, `revision`); independent read/output/cleanup failure remains nonzero even if cancellation occurs later. A requested `--timeout` or SIGINT/SIGTERM stops normally and exits 0 with that summary: the in-flight event read is cancelled cooperatively, its captured view is released, and only then does the CLI detach from the owner (the owner and its stored work are never stopped). A release or output failure during that cleanup remains a nonzero failure. `logs`/`signal` consume disposable authorized live channels, not durable data order. Optional agents/media providers may be offline while ordinary browser data edits remain available.

## Optional author-time finality

```sh
tendril --page notes finality close --through 1700000000000
tendril --page notes finality vote --through 1700000000000
tendril --page notes finality submit '{"record":"<canonical proof record hex>"}'
```

Only explicitly configured eligible finalizers can act. On a policy of `none` every `finality` command is explicitly unsupported; the CLI never reports a fabricated "none" success or a finalized result. Closing author time can exclude genuine unseen offline work first included behind the frontier. Providers cannot allocate operation order, promise retention, or make external effects exactly once. A configured but unavailable provider does not block local submission. Do not claim browser/native/host finality qualification from configuration or source inspection alone.

Signed finality statements and proofs contain exact bigint author times, which JSON cannot carry. The CLI therefore never rewrites them as JSON numbers:

| Command | Output |
| --- | --- |
| `finality close --through MS` | `{ "closedThroughMs": "<decimal string>" \| null, "proofs": { "record": "<canonical encodeRecord bytes as hex>" } }` |
| `finality vote --through MS` | `{ "votes": { "record": "<canonical encodeRecord bytes as hex>" } }` |
| `finality submit '<{"record":HEX}>'` | Decodes that exact canonical record, including its bigint times internally, and submits it as proofs |

`--through` is an exact nonnegative int64 decimal string (converted to a bigint once); `closedThroughMs` is a decimal string for the same reason. Round-trip a certified frontier by passing `proofs` from `close` unchanged to `submit`, for example to hand them to another participant:

```sh
tendril --page notes finality close --through 1700000000000 > closed.json
# closed.json: {"closedThroughMs":"1700000000000","proofs":{"record":"a1..."}}
# The other workspace must be provisioned for this SAME page and application.
tendril --workspace /path/to/other-device --page notes finality submit "$(node -p "JSON.stringify(require('./closed.json').proofs)")"
```

Pass only a `proofs` record. A `votes` record is a validator's individual statement, not a proof: a fixed-validator quorum must combine the actual verified votes through the configured provider or the SDK (`session.finality`) into proofs before submission. Never submit raw votes as proofs. The session verifies submitted evidence against the application's configured finality policy. Storage acknowledgement is not certification: missing bodies, predecessor proofs or a full quorum can leave evidence pending. Inspect the original operation's finalized fact and a final read before claiming finality; malformed requests and actual error responses remain failures. Proofs for another application do not certify this one.

Provisional claims/receipts are revisable. Optional external-effect dispatch must use the selected finality policy plus its own durable provider idempotency/reconciliation journal and approved consumer scopes. Schema changes do not expand those approvals.

## Publish signed page code

`publication`, `publication-operation ID`, and `publish DIRECTORY --operation ID` inspect/retry an independent signed code release. Preserve the original graph, signer and ID after uncertain replies; verify the actual selected immutable publication and asset hashes. Code-revision concurrency and exact publication retries are unrelated to application data order. Publication can use the agent program's attach socket, but that is not a prerequisite for browser-first publishing with the workspace's shared signer as publisher.

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
(`.tendriller/agent/attach.json`) with ordinary application capabilities,
`finality` and `publish`, not `ownerAdmin`. The finality capability only exposes
the API: the configured policy and signer eligibility still authorize each act.
The binding is reused verbatim on restart and never broadened.
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
publishes one fresh private file and never replaces existing output. Never clear original stores or introduce an old-format reader as troubleshooting; see [troubleshooting](../TROUBLESHOOTING.md). A page device
uses the workspace's shared signer, so move the whole `.tendriller/agent/` folder
(identity and credential) with it, and run only one copy of that workspace.
