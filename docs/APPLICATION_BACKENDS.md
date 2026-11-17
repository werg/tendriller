# Selected application backends

A page selects one application history at creation. Tendriller hosts the page,
account sessions, publication recovery, explicit blob facilities, connection hints
and short-lived WebRTC rendezvous. The selected backend owns application persistence, authored operations,
retry identity, execution, event replay, and finality.

For a resident native agent deployment, select a Chronolog peer backend. Run a
replica, timers and effect workers in the resident agent service. A finality
service can run there or on another configured participant; an agent is not
inherently a finality authority. The browser keeps its own replica. A Cloudflare JSON backend remains available for
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
Custom browser bootstraps can pass `{application: backend}` to
`startRuntime(configuration, options)`. A hosted page uses its existing
`window.tendril` and must not start another runtime.

Peer pages run a separate quiet runtime. They open no host socket or IndexedDB
outbox and send no background health reports, logs, heartbeats or sensor reports.
State, input, conversation, timers, streams, shared-file references, scopes, captures, hosted uploads and
retained-record APIs return `application_backend`. Application work and binary
payload exchange belong to the replica. Explicit HTTP requests, membership,
rendezvous, publication saving and existing blob URLs remain available.
`publication.saveOffline()` explicitly registers offline publication support.
Automatic hosted publication health is a hosted-runtime facility; peer readiness
belongs to the application backend. `tendril.connected` on a peer page indicates
that its selected backend is installed, not that any remote peer is reachable.

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

Presence, typing, token chunks, and replaceable progress use
[`tendril.signals`](APPLICATION_SIGNALS.md), installed independently with
`tendril.signals.install(client.signals)`. Use `send` and `subscribe`; choose
`mode:'latest'` only for replaceable values. Default FIFO preserves pending
discrete events within explicit bounds. Signals require no program, SQL engine,
outbox or finality service. End a generated response with a durable
result event. Only a consumer of accepted final intent dispatches external work;
reducers and SQL callbacks never send messages or perform tools during replay.

## Finality and authority

Keep three decisions separate: who may connect or author, how valid programs are
ordered and executed, and when an applied result becomes final. The signed
Chronolog configuration selects its finality policy and timing rules. Peers verify
the same author-time order; a receipt or an RTC send does not establish finality.
Finality closes an applied prefix. A provisional accepted **or rejected** result
can change when earlier work arrives and the suffix replays.

| Role | Responsibility | Does not grant |
| --- | --- | --- |
| Page host / introduction service | Assets, accounts, bounded connection setup | Database read/write permission |
| Membership administrator | Signed grants, revocations and reader key delivery | SQL row ownership or finality signing |
| Finality service / validator set | Inclusion evidence and a closed author-time frontier | Permission to author successful application changes |
| Schema administrator / row owner | DDL policy / rights over owned rows | Membership administration or transport admission |
| Resident agent / effect worker | Consume final intent and record outcomes | Any of the other roles merely by running a process |

Co-locating roles is a deployment choice; permissions come from explicit keys and
grants. A signal-only sender can have signal-topic rights without SQL or durable
event rights. Reader authorization and historical decryption keys are separate
from authoring rights.

An offline draft keeps its original signed time and identity. If first inclusion
arrives behind a closed frontier, Chronolog rejects that original proposal. Show
the retained draft and let the application deliberately author a new operation
after review. Do not silently retimestamp a retry. An exact retry of an already
included operation recovers its original outcome.

Internal rollback/redo replays the provisional suffix from a valid checkpoint;
it is not user Undo. User Undo or Redo is a new durable program with a new
operation ID and conditions against the state the person reviewed. Final history
is never rewritten to simulate Undo. Final effect consumers also need durable
processed checkpoints and provider idempotency/reconciliation: finality does not
make an external API call exactly once.

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
