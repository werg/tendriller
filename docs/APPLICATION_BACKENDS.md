# Selected application backends

A page selects one application history at creation. Tendriller hosts the page,
account sessions, publication recovery, explicit blob facilities, connection hints
and short-lived WebRTC rendezvous. The selected backend owns application persistence, authored operations,
retry identity, execution, event replay, and finality.

The chronological deployment below records the existing adapter and its historical
contract. New work follows the selected-history target described under peer-generation
results; the current session preview still exports `applied()`. In the older
resident deployment, replicas, timers and effect workers run in the agent service. A finality
service can run there or on another configured participant; an agent is not
inherently a finality authority. The browser keeps its own replica. A Cloudflare JSON backend remains available for
applications that deliberately choose the hosted state authority.

```js
// POST /api/tendrils, alongside the ordinary owner/name/lifetime fields:
{
  owner: 'owner@example.com',
  mode: 'dashboard',
  lifetime: 'resident',
  application: { kind: 'peer', id: '<64 lowercase hex characters>' }
}
```

The selection is immutable. `id` is an application-owned stable identifier, not a
host token, decryption key, grant, or authority key. Omitting `application` selects
`{kind:'cloudflare', id:'cf:<page-id>'}`. Publication rollback changes code without
changing the selected history. An unavailable authority never triggers failover
to Cloudflare or to a different finality policy. Historical chronological replicas use
the same signed author-time execution order. A finality provider supplies
inclusion evidence and closes the author-time frontier; it does not choose that
execution order.

## Installation and readiness

`@tendriller/core/application` exports dependency-free application contracts; that
boundary imports no Chronolog, SQL or application UI code. The host's separate
generation-control service embeds Chronolog's portable verifier, not its replica
or SQL runtime. That control service does not implement a peer-generation session.

```js
// The page's composition module imports its selected public adapter.
import { createPeerGenerationApplicationBackend } from '@chronolog/peer-session/tendriller';

const backend = createPeerGenerationApplicationBackend({
  id: tendril.application.selection.id,
  session, // An owned public native or browser Worker ApplicationSession.
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
`tendril.kind` is `peer` or `cloudflare`. A peer runtime omits hosted state,
input, conversation, timers, streams, records, scopes, uploads, captures,
notifications and connection fields. Application work belongs to its session.
Explicit HTTP, membership, discovery and rendezvous are grouped under
`tendril.host`; the native SDK's host client retains its `peers` and `members`
services. `publication.saveOffline()` explicitly saves the publication.

`application.available` and `application.ready()` describe adapter installation.
The generation backend's `status` and `onStatus()` expose actual synchronization,
coordinator reachability, missing keys and recovery. Local browser device labels
grant no application permissions. See the [runtime service split](BROWSER_API.md).

## Small public contract

Supported views, program shape and operation states belong to the selected
profile. The peer-generation adapter accepts named programs `{name,input}` and
exposes applied views; its [generation outcomes](#peer-generation-applied-results)
carry an attempt identity and selected generation. The chronological and hosted
profiles below keep their own finality contracts.

| Member | Meaning |
| --- | --- |
| `id`, `capabilities` | Stable selected identity and explicit program/query capabilities |
| `submit(program, {operationId})` | Author one atomic program through the selected backend |
| `events.publish(topic, payload, {operationId})` | Convenience authoring of one event-only program |
| `events.read({cursor?,topics?,limit?,signal?})` | Bounded whole-transaction replay in the supported view |
| `events.subscribe(options)` | At-least-once continuation with pull backpressure |
| `readView({view?:'applied'|'local'|'final'})` | Captured revision with `query`, `readEvents`, and `release` |
| `changes({view?:'applied'|'local'|'final',signal?})` | Current revision, then coalesced invalidations for that view |
| `operations.get(operationId)` | Recover the status of this author's durable operation |
| `operations.subscribe({operationId,signal?})` | Observe that operation, including finality-only changes |

Program and query types remain backend-specific. The generic contract does not
translate SQL into JSON state operations. A peer session invokes declared named
commands that produce its deterministic program. The chronological adapter
accepts a versioned SQL/platform/emit `ChangeProgram`; the Cloudflare implementation advertises
`json-state`, `events`, `conversation`, and `revision-views`, and accepts the
program below. The adapter's `sql` option describes the execution profile; it does
not grant SQL permission or change acceptance rules.

### Chronological and hosted operation results

For these profiles, a receipt separates lifecycle from acceptance. `status` is `queued`,
`provisional`, or `final`; `outcome` is `accepted` or `rejected` once execution has
produced a result. Both provisional outcomes can change during replay. Both final
outcomes are settled. In particular, `status:'final'` alone does **not** mean that
the operation succeeded: check `outcome:'accepted'` as well.

The TypeScript contract expresses this as a discriminated union: `queued` has no
outcome, and both executed states require one. The default public backend returns
an `ApplicationOperation` from `submit` and `events.publish`, so page code can
inspect it directly without guessing a backend-specific return type. Exact
retries can return the original final outcome immediately.

| Status | Outcome | Meaning |
| --- | --- | --- |
| `queued` | Absent | The original operation is saved or submitted; no execution result is established |
| `provisional` | `accepted` or `rejected` | A replaceable local result; earlier incoming work can change it |
| `final` | `accepted` | The accepted result is settled under the configured policy |
| `final` | `rejected` | The rejection is settled; preserve the reviewed draft for a deliberate new operation |

Receipts always identify `operationId` and `proposalId`. A Cloudflare admission
refusal has an empty `proposalId`, `status:'final'`, and `outcome:'rejected'`: the
draft was refused before a retained proposal was created. Only an exact-identity
conflict or retained-history quota refusal is classified this way. A lost,
malformed, or timed-out response, or a host
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
has `id`, `proposalId`, `eventOrdinal`, `topic`, `payload`, and `origin`. The event's stable
identity is derived from its proposal and ordinal. Topics filter a shared history;
they have no separate sequencer and do not provide confidentiality.

An event returned by the selected, validated backend carries authenticated
metadata in `origin`. An arbitrary object with an `origin` field proves nothing;
trust comes from that backend's authenticated publication and read path.
Every backend supplies `kind`,
`authorId`, and `operationId`; backend-specific fields describe how the author
was authorized. Hosted events retain their application identity and authenticated
`owner` or `agent` role. Chronolog retains the signed group, author, membership
revision, writer capability, and author timestamp. Retries and replay retain this
original provenance. Fields named `author`, `role`, or `origin` inside `payload`
remain application data. Check the trusted origin against application policy
before treating an event as an instruction. Being an accepted event does not by
itself authorize an agent to execute its text.
Chronolog `authorId` is lowercase hexadecimal; `groupId`, `membershipRevision`
and `writerCapability` use canonical base64url. Operation IDs are chosen by
callers and proposal IDs are opaque. Preserve identifiers unchanged.
`authorTimestampMs` is the signed integer timestamp encoded as a
decimal string. Static membership policies
use `writerCapability:null`; governed groups retain the exact signed grant.
This metadata describes the original publication. A current permission check,
tool credential, or approved external action remains an application policy
decision. A durable worker retains the origin with its intent through recovery.

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

A held view exposes its own `{view, revision, finalRevision}` and pins both
queries and effective event reads. These fields describe the captured data even
if the replica advances before rendering finishes. Native Chronolog holds a
bounded snapshot; remote clients hold a bounded lease that can expire and must be
recaptured. Independent widgets are not made atomic merely by labeling them with
the same token: publish their combined view when every required projection is
ready. Keep focus, scroll, selection, and unfinished typing local.

## Observe views separately from consuming history

Use `changes` to refresh UI projections, including SQL-only changes, remote
provisional work, rollback/redo, and finality-only progress. It first yields the
current `{view,revision,finalRevision}` and then coalesces invalidations while a
consumer is busy. Its default view is `final`; use `local` deliberately for an
optimistic UI. Revision strings are opaque observations, never durable consumer
cursors. A notification does not pin a snapshot; recapture `readView` and publish
all related projections from that captured view. Its `revision` and
`finalRevision` can be newer than the notification's tokens; use the captured
metadata when displaying the result. Hosted local and final reads identify the
same serially committed state while preserving the requested `view` label.

```js
const stop = new AbortController();
for await (const change of application.changes({ view: 'local', signal: stop.signal })) {
  const view = await application.readView({ view: change.view });
  try {
    const tasks = await view.query('SELECT id, status FROM tasks');
    // Read the other required projections through this same view.
    renderTasks(tasks, view.revision);
  } finally {
    await view.release();
  }
}
```

`events.subscribe` serves a different purpose: processing every accepted final
event and saving a durable processed cursor. It is not a view invalidation feed.
A state-only program can alter the UI without emitting an event. Slow UI readers
may skip obsolete revisions; durable event consumers must process their full
transaction batches. Hosted browser changes reuse the existing socket and
recheck on reconnect. Native hosted HTTP clients poll a small revision endpoint.
Peer clients use their replica's change stream and make no host requests.

## Conversation and ephemeral traffic

`publishConversation(application.events, {messageId,text,inReplyTo?}, {operationId})`
emits the ordinary `conversation` event `message.posted` version 1. It does not
invoke the agent, perform speech, declare a human read receipt, or grant the author
permission to impersonate an owner or system role. Use the event's authenticated
`origin` and application policy when presenting a message.

Presence, typing, token chunks, and replaceable progress use
[`tendril.signals`](APPLICATION_SIGNALS.md). Hosted owner pages already have the
live port; peer composition installs it independently with
`tendril.signals.install(client.signals)`. Use `send` and `subscribe`; choose
`mode:'latest'` only for replaceable values. Default FIFO preserves pending
discrete events within explicit bounds. Signals require no program, SQL engine,
outbox or finality service. End a generated response with a durable
result event. Only a consumer of accepted final intent dispatches external work;
reducers and SQL callbacks never send messages or perform tools during replay.

## Chronological finality and authority

The Chronolog adapter implements live collaboration by default. Signed proposals,
timestamp ordering and deterministic replay are reusable foundations; finality
belongs to this live interpretation. A future async branch/merge interpretation
would have no finality concept, frontier, operation states or final-intent worker
contract. It would define separate inclusion, merge and effect rules, and is not
implemented by this live backend API.

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
`GET application`, `POST application/changes`, `GET application/view`, `GET application/revision`,
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

## Peer-generation applied results

The public types below define Tendriller's generation-scoped backend contract.
Chronolog's encrypted replica and public session/native/browser entries are
implemented as a source-pinned preview, now including framed network transport
and maintained RTC integration. The preserved native/events package run uses an
in-process link; the newer packed RTC consumer and deployed integration require
separate qualification. The session exposes its own query/command/view APIs. Installing
it through this Tendriller contract requires a matching adapter; the existing
`createChronologApplicationBackend` remains the chronological `local` / `final`
adapter and does not convert a generation session.

`peer-generation-v1` uses a replaceable coordinating peer and explicit recovery to a complete retained prefix. Its public backend declares `profile: 'peer-generation-v1'`. It exposes `view: 'applied'`, an opaque coherent revision, and the selected generation. There is no `finalRevision` on that current preview view. Its public execution wait is `applied()`, and requests for an unsupported final view fail explicitly. The unified target uses `local()` for applied-here results and `final()` for committed/applied selected-history results; explicit recovery may still abandon a recent suffix, including previously final work. Those target method names are not aliases exported by the current preview.

The optional `basedOn` ordering barrier is profile-specific. The hosted JSON backend rejects it before HTTP delivery or durable outbox insertion; its explicit program state guards remain available. Event and conversation helpers preserve the barrier and receive the same rejection.

Operations use `operationId` for caller intent and `attemptId` for exact authenticated bytes. Their states are:

| State | Meaning |
| --- | --- |
| `saved` | The original signed attempt is durable locally. No rejection is inferred from a missing coordinator or lost reply. |
| `applied` | Accepted or rejected at a specific generation and sequence. The outcome remains stable while its position belongs to selected history. |
| `abandoned` / `needsReapply` | Recovery excluded the attempt. Original provenance and any previous applied outcome remain inspectable. |

`shared` is separate retained-prefix evidence; it does not promote an applied outcome to finality. A deliberate reapplication uses a new operation identity and current permissions and guards. Ordinary retry preserves original bytes and the admission generation.

A recovery notice identifies the adopted prefix, selected generation, known abandoned work, and whether additional loss is unknown. Applications receive a coherent recovery change and capture a fresh view. SQL, events and operation outcomes must not be combined across revisions. `PeerGenerationApplicationBackend.onRecovery()` and `inspectRecovery()` expose the same notice to UI and agent consumers.

The host binding's `available` property means that an application adapter is installed. `ready()` also concerns installation. Neither promises peer reachability or synchronized application state. In peer mode `tendril.connected` stays false because there is no hosted application connection; actual readiness and recovery belong to the Chronolog session. Host requests remain explicit and the host never adds another application outbox.

The older chronological packages and hosted JSON backend retain their original implementation guarantees and evidence. They are not a separate architecture mandate for new peer applications. No old signed history is silently reinterpreted, and no migration or compatibility layer is supplied for this prerelease refactor.
