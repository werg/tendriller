# Selected application backends

A page selects one application history at creation. Tendriller hosts the page,
account sessions, publication recovery, blobs, connection hints, and optional
relay. The selected backend owns application persistence, authored operations,
retry identity, execution, event replay, and finality.

For a resident native agent deployment, select a Chronolog peer backend. Run the
replica, authority, timers, and effect workers in the resident agent service. The
browser keeps its own replica. A Cloudflare JSON backend remains available for
applications that deliberately choose the hosted state authority.

```js
// POST /api/tendrils, alongside the ordinary owner/name/lifetime fields:
{
  owner: 'owner@example.com',
  mode: 'dashboard',
  lifetime: 'resident',
  application: { kind: 'peer', id: 'team-task-history' }
}
```

The selection is immutable. `id` is an application-owned stable identifier, not a
host token, decryption key, grant, or authority key. Omitting `application` selects
`{kind:'cloudflare', id:'cf:<page-id>'}`. Publication rollback changes code without
changing the selected history. An unavailable authority never triggers failover
to Cloudflare or to a different finality policy. Chronolog replicas always use
the same signed author-time execution order. A finality provider supplies
inclusion evidence and closes the author-time frontier; it does not choose that
execution order.

## Installation and readiness

`@tendriller/core/application` exports the dependency-free public contracts.
Tendriller does not import Chronolog, SQL, or application UI code.

```js
// The page's composition module imports its selected public adapter.
import { createChronologApplicationBackend } from '@chronolog/transport-tendriller';

const backend = createChronologApplicationBackend({
  id: tendril.application.selection.id,
  replica, // An independently opened ChronologNode or ChronologClient.
  sql: true,
});
tendril.application.install(backend);

// Page modules can start before composition completes; this is not host connectivity.
const application = await tendril.application.ready();
```

`application.backend` returns the installed backend or throws
`backend_unavailable`. Installing a different identity or a second backend fails.
Headless compositions can pass `{application: backend}` to
`startRuntime(configuration, options)`. A hosted page uses its existing
`window.tendril` and must not start another runtime.

Peer pages never open the Cloudflare application outbox. Host diagnostics and
blob transfers use a separate local host namespace. State, input, conversation,
timers, streams, scopes, trusted application workflows, data bundles, and remix
routes belonging to Cloudflare application authority return `application_backend`
on peer pages. Page publications, recovery, accounts, blobs, and peer connectivity
remain host facilities. The optional opaque retained record log is a separate
explicit storage choice, not an automatically provisioned authority.

## Small public contract

| Member | Meaning |
| --- | --- |
| `id`, `capabilities` | Stable selected identity and explicit program/query capabilities |
| `submit(program, {operationId})` | Author one atomic program through the selected backend |
| `events.publish(topic, payload, {operationId})` | Convenience authoring of one event-only program |
| `events.read({cursor?,topics?,limit?,signal?})` | Bounded whole-transaction final replay |
| `events.subscribe(options)` | At-least-once continuation with pull backpressure |
| `readView({view?:'local'|'final'})` | Captured revision with `query`, `readEvents`, and `release` |
| `operations.get(operationId)` | Recover the status of this author's durable operation |
| `operations.subscribe({operationId,signal?})` | Observe that operation, including finality-only changes |

Program and query types remain backend-specific. The generic contract does not
translate SQL into JSON state operations. Chronolog accepts its versioned
SQL/platform/emit `ChangeProgram`; the Cloudflare implementation advertises
`json-state`, `events`, `conversation`, and `revision-views`, and accepts the
program below. The adapter's `sql` option describes the execution profile; it does
not grant SQL permission or change acceptance rules.

An operation receipt identifies `operationId`, `proposalId`, and `status`:
`queued`, `provisional`, `final`, or `rejected`. A proposal that is locally rejected
but not final is still `provisional` with an outcome of `rejected`; replay can
replace that outcome. Final rejection preserves the original operation identity
and recoverable draft. A Cloudflare admission refusal can have an empty
`proposalId` and no `outcome`: the draft was refused before a retained proposal was
created. Only an exact-identity conflict or retained-history quota refusal is
classified this way. A lost, malformed, or timed-out response, or a host
authentication/routing failure, establishes no rejection: an earlier submission
may already have committed. Keep its original program queued for receipt recovery.

Allocate the operation ID before submitting and keep the reviewed inputs with it.
Retries use that same ID and original complete program. Concurrent callers waiting
for the same operation each receive its durable receipt; one caller's timeout
cannot cancel another caller's wait. Reusing an ID for different contents is a conflict. Do not rewrite an old operation's grant, scope, generation,
conditions, or message identity to make it pass after a reset.

## Events, views, and consumer checkpoints

Each batch has `transactions`, `scannedThrough`, `hasMore`, and `revision`.
Transactions contain `proposalId` and complete matching event groups. Each event
has `id`, `proposalId`, `eventOrdinal`, `topic`, and `payload`. The event's stable
identity is derived from its proposal and ordinal. Topics filter a shared history;
they have no separate sequencer and do not provide confidentiality.

Cursors and revisions are opaque. Store and return them unchanged. A continuation
binds the history and normalized topic filter. Changing a filter requires a new
replay. Empty matching batches still carry scan progress over resolved rejections
and unrelated records. Calling the iterator's next method requests the next batch;
there is no background queue that drops or coalesces durable events.

Received progress is not processed progress. Commit a projection and its processed
cursor together in the consumer's local durable store. A transport credit or
successful read is not a checkpoint. Full history is retained with explicit quota
refusal; consumer checkpoints do not authorize deleting source history.

```js
const view = await application.readView({ view: 'final' });
try {
  const rows = await view.query('SELECT id, status FROM tasks'); // SQL capability
  const events = await view.readEvents({ topics: ['tasks', 'conversation'] });
  // Build every required projection at view.revision, then replace the combined UI.
  // Continue bounded event reads until hasMore is false before publishing that view.
} finally {
  await view.release();
}
```

A held view pins both queries and effective event reads. Native Chronolog holds a
bounded snapshot; remote clients hold a bounded lease that can expire and must be
recaptured. Independent widgets are not made atomic merely by labeling them with
the same token: publish their combined view when every required projection is
ready. Keep focus, scroll, selection, and unfinished typing local.

## Conversation and ephemeral traffic

`publishConversation(application.events, {messageId,text,inReplyTo?}, {operationId})`
emits the ordinary `conversation` event `message.posted` version 1. It does not
invoke the agent, perform speech, declare a human read receipt, or grant the author
permission to impersonate an owner or system role. Use recorded author/grant
provenance and application policy when presenting a message.

Presence, typing, token chunks, and replaceable progress use the separate
[peer signal domain](PEER_CONNECTIONS.md). End a generated response with a durable
result event. Only a consumer of accepted final intent dispatches external work;
reducers and SQL callbacks never send messages or perform tools during replay.

## Cloudflare implementation

```js
const application = await tendril.application.ready();
// 'tasks' is an explicit scope protecting these paths and the event operation.
const captured = tendril.scopes.capture('tasks');
await application.submit({
  version: 1,
  scope: 'tasks',
  expected_generations: captured.expected_generations,
  steps: [
    { kind: 'state',
      conditions: [{ path: ['tasks', taskId, 'status'], equals: 'open' }],
      ops: [{ op: 'set', path: ['tasks', taskId, 'status'], value: 'done' }] },
    { kind: 'emit', topic: 'tasks', payload: { type: 'task.completed', taskId } },
  ],
}, { operationId });
```

Capture all touched path and operation guards before authoring; an `emit` step
also targets the `event` operation. Supply the union of the captured generation
maps and any explicit scope. The convenience `events.publish` supplies an empty
map and therefore works only where no event guard applies. Protected events use
`submit` with captured guards. State conditions describe actual acceptance; an
event name alone cannot assert that a conditional business action succeeded.

The browser uses its existing durable outbox. The exact normalized program is
saved before HTTP delivery. A server transaction validates guards, executes every
step, collects events, and commits the outcome. Failure rolls back every state
step and publishes no effective events; the retained rejected receipt still
advances replay. Exact retries recover original accepted or rejected receipts
before checking newer generations. Receipt persistence precedes local cleanup;
failed drafts remain inspectable after reload.

Cloudflare `readView().query('state')` and `.query('scopes')` return captured JSON
snapshots, with no query parameters. This backend has immediate final outcomes
and does not advertise local provisional SQL. Native SDK users obtain it with
`await client.application()` and persist their original program and operation ID
before calling submit.

HTTP routes are relative to the agent API or the page's `_tendril/` prefix:
`GET application`, `POST application/changes`, `GET application/view`,
`GET application/events`, and `GET application/operations/<operationId>`.
Event reads accept `cursor`, JSON-encoded `topics`, `limit`, and an optional pinned
`revision`. Writes require the owner page or an authorized agent; display and
producer identities cannot use these routes. Host access is separate from any
Chronolog application grants.

Programs contain at most 256 steps, 128 events, and 256 KiB of normalized JSON.
An event payload is at most 64 KiB. Reads scan at most 128 history transactions
per batch, including nonmatches and rejections, and keep event groups whole.
The retained application history allows 100,000 transactions and 64 MiB of
accounted program/receipt/event bytes. Exhaustion is an explicit `history_quota`
refusal; earlier exact retries remain available.
