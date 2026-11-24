# Requests, receipts, answers and listener presence

A page-to-agent request has two lifecycles: its **journal operation** and the
**consumer's work**. An accepted `applied` operation means the request is in the
selected application history. It does not mean an agent has read it. A peer
retention receipt (`shared()`) also does not acknowledge application-level work.

The first-app archive includes `helpers/agent-requests.mjs`, an importable,
application-owned pattern using public Chronolog commands and queries. It supplies
`agentRequest`, `agentReceipt`, `agentAnswer`, `agentHeartbeat` and `agentInbox`.
It does not add journal statuses, a hidden agent service, or a background wake
mechanism. An actual consumer process must stay running.

## Add the pattern to your application definition

Before initial configuration, compose it into your existing `domain.mjs`:

```js
import { defineApplication } from '@chronolog/peer-session';
import { agentRequestCommands, agentRequestQueries } from './helpers/agent-requests.mjs';

export const definition = defineApplication({
  id: 'my-application', version: '1',
  commands: { ...agentRequestCommands /*, your domain commands */ },
  queries: { ...agentRequestQueries /*, your domain queries */ },
});
```

For an existing application, adding commands changes its signed definition.
Follow the application's explicit definition/generation upgrade procedure; a UI
republish alone cannot change that definition. Install the same definition in
native and browser participants. The supplied Shared Notes definition stays
unchanged; this helper is an optional pattern to adapt for a new domain.

Requests address an enrolled participant's signing `deviceId` in `recipient`.
Use the application's configured native participant identity; do not pick an
arbitrary connected peer. Inputs identify a `consumerId` and a fresh `runId`, but
those are labels, not separate signing identities. Local attach clients share the
owner's signer. If consumers need separate authorization, enroll separate
participants and grant their actual capabilities. With an assistant binding,
grant only the commands/queries that consumer needs.

## Keep the whole request reference

A receipt or answer contains **both** `requestAuthor` and
`requestOperationId`, copied unchanged from the query/event. The schema permits
512 characters for an operation reference, matching the current public protocol
bound. Do not truncate, slice a suffix, split a namespace, or assume a 128-character
identifier. Different authors can use the same operation ID.

The query matches references against the request's full authenticated identity
and accepts receipts/answers only when their event author equals its `recipient`.
It ignores orphan references. The displayed consumer identity comes from the
signed event author, never from a caller-provided claim. This is a shared-app
pattern: requests and answers are visible to members of that application, not a
private mailbox. Adapt the domain's permissions and information model as needed.

## Send once, then show each state on the request

Capture intent before dispatch, as in [uncertain submission](APP_PATTERNS.md#3-preserve-uncertain-intent-before-the-first-dispatch):

```js
const pendingKey = `ask:${session.applicationId}:${session.historyId}:${session.deviceId}`;
if (localStorage.getItem(pendingKey)) throw Error('Resolve the previous submission first.');
const pending = {
  operationId: crypto.randomUUID(), createdAtMs: Date.now(),
  command: 'agentRequest',
  input: { recipient: nativeDeviceId, topic: 'analysis', text: question.trim() },
};
localStorage.setItem(pendingKey, JSON.stringify(pending)); // Failure prevents dispatch.
const operation = await session.command(pending.command, pending.input, {
  operationId: pending.operationId,
});
const result = await operation.applied({ signal: AbortSignal.timeout(15_000) });
// Inspect result.outcome. Accepted application is not receipt or answer.
```

Keep this exact record after an uncertain reply/timeout. Inspect/retry the
original operation; do not generate another request. Reapplication after recovery
is a separate reviewed action with a new operation identity. Once the accepted
request appears in `agentInbox`, the durable query supplies it after any reload;
local storage is only for unresolved intent and per-device read/unread markers.

| Evidence | Request card copy |
| --- | --- |
| Local pending reference, no observed operation | Sending; outcome not yet known |
| Journal `saved` | Saved on this device; waiting to apply |
| Journal `applied`, rejected | Request rejected; show the domain reason |
| Query contains request, no receipt/answer | Sent at [time]; waiting for the listener to acknowledge |
| Query contains receipt | Seen by [named consumer] at [time]; waiting for an answer |
| Query contains answer | Answered at [time]; show the answer on this request |
| `abandoned` / `needsReapply` or recovery reset | History changed; review this request before reapplying |

Use `createLiveView(session, { query: 'agentInbox', input: null, ... })` for one
coherent snapshot. `requestDelivery(request)` returns `awaiting-receipt`, `seen`
or `answered`; a late receipt never changes an answered card back to seen.
Keep journal rejections, observation errors and recovery notices separate. On
recovery replace the displayed query result instead of merging excluded answers
back into it. Display an empty inbox, loading state and actionable error state.

Each request's `sentAtMs` and each receipt/answer's `atMs` come from
`view.readEvents(...).events[].authorTimestampMs`. This metadata **is available
inside a declared query**; it is a decimal string in the public event envelope.
The helper validates it before converting to a safe integer. It represents the
signer's clock, not a server-certified delivery time. Show unknown time when it
cannot be represented, and keep clock disagreement visible.

Render answers as named, readable cards or conversations, with expandable long
text and links labeled by their destination's meaning. Use answer `eventId`s for
per-device unread markers, scoped by application, history and browser profile; a page
reload must not recreate an answered request or mark every old answer unread.

## A consumer acknowledges actual work

The consumer first reads the request, submits `agentReceipt`, and awaits its
accepted application. It then performs the work and submits `agentAnswer` with
the same reference. Both use caller-owned stable operation IDs:

```js
import { createHash } from 'node:crypto';

const reference = request => ({
  requestAuthor: request.requestAuthor,
  requestOperationId: request.requestOperationId,
  consumerId, runId,
});
const workKey = request => createHash('sha256').update(JSON.stringify([
  session.applicationId, session.historyId, request.requestAuthor, request.requestOperationId, consumerId,
])).digest('hex');
async function accepted(name, input, operationId) {
  const operation = await session.command(name, input, { operationId });
  const result = await operation.applied({ signal: AbortSignal.timeout(15_000) });
  if (result.outcome !== 'accepted') throw Error(`Consumer command rejected: ${result.rejectionCode}`);
}

// Only consume rows addressed to session.deviceId and an implemented topic.
const ref = reference(request);
const key = workKey(request);
await accepted('agentReceipt', ref, `receipt:${key}:${runId}`);
// Application-owned worker: durably retain the exact result by key BEFORE sending.
// On restart it returns that retained result, rather than repeating side effects.
const text = await durableWorkResult(key, request);
// Retain the exact answer input (including runId) with that result too.
const answer = await retainAnswerInput(key, { ...ref, text });
await accepted('agentAnswer', answer, `answer:${key}`);
```

Here `durableWorkResult` and `retainAnswerInput` are the domain's durable work
store, not Tendriller APIs. The latter must return the original input on retry,
including its original run ID. Bound your run IDs (a UUID suffices) so these new
operation IDs stay within the protocol limit. A later run may add its own receipt,
but must not reuse an answer ID with changed text or metadata.

For a purely computed answer, caching the result before submission is enough.
For a file edit, payment, email or other external effect, use the target system's
idempotency support or a transactional work store and reconcile uncertain effects.
Neither an applied request nor a receipt gives exactly-once external execution.
Persist an event replay cursor **after** durable handling/checkpointing, never on
read alone. A crash before that checkpoint can redeliver a request; the work key
and exact answer input make that redelivery safe. After recovery, inspect the
selected history before continuing an old cursor or reapplying excluded work.

For an event-driven process use `tendril --session ./session.mjs --mode attach
watch --events --topics '["agent/request"]'` with the last committed cursor, or the public event forwarder. Plain `watch`
reports coalesced query invalidations and is not an event delivery log. See
[CLI supervision](tools/CLI.md) and [restart checklist](AGENT_RESTART.md).
Map each raw request event into the query's reference shape before using the
consumer code above:

```js
const request = { ...event.payload,
  requestAuthor: event.author, requestOperationId: event.operationId };
```

Use this mapping only for `agent/request` events from the intended history;
filter by recipient and implemented topic before accepting work.

## Listener presence survives a late page join

Peer connectivity only says an enrolled participant is reachable. It cannot tell
whether its agent loop is consuming `analysis` requests. Announce the consumer
with a declared durable command **after a successful inbox read**:

```js
const consumerId = 'analysis-worker'; // Stable logical role; one supervised loop.
const runId = crypto.randomUUID();   // New for this actual consumer process.
const startedAtMs = Date.now();
const heartbeat = {
  consumerId, runId, role: 'Analysis assistant', topics: ['analysis'],
  startedAtMs, state: 'listening',
};
await session.query('agentInbox', null); // The loop really can read its queue.
await accepted('agentHeartbeat', heartbeat, `heartbeat:${crypto.randomUUID()}`);
```

Renew every 30 seconds while that consumer successfully reads its queue and can
accept work. Give each pulse its own operation ID; after an uncertain pulse retry
its original input/ID before admitting another. Tie renewal to successful consumer
progress, not to the participant's independent keep-alive timer or the page being
open. Stop renewal on consumer failure, owner loss or shutdown. A graceful stop
can submit a final announcement with `state: 'stopped'`; a crash is handled by
expiry. The supervisor owns that loop and reports failures nonzero.

The example query retains the latest announcement per `(author, consumerId)`,
including `startedAtMs`, `runId`, topics and the signed `lastSeenAtMs`. A later
run replaces that role's announcement. Do not run two independent loops under
one consumer ID; give concurrent workers separate IDs. The data is retained in
the selected journal, so a late-joining page can query it without having received
the original live signal. An optional signal may accelerate rendering but is
never the only source of the last heartbeat.

```js
import { consumerPresence } from './helpers/agent-requests.mjs';
const listener = inbox.consumers.find(item => item.author === nativeDeviceId
  && item.consumerId === 'analysis-worker' && item.topics.includes('analysis'));
const presence = consumerPresence(listener, {
  now: Date.now(), staleAfterMs: 90_000,
  observationCurrent: connectionUsable && !queryError && !recovering,
});
```

Recompute this every second in the view and on visibility/resume, even without
new events; clear the timer on view teardown. `available` means a recent successful
check-in, not a guarantee that the next request will be handled. Show `stale` as
“Listener last checked in [time]; your request is saved and waiting.” It is not
proof the process is dead: a blocked or long-running job also misses check-ins.
Keep the existing receipt and answer state visible independently. For `unknown`,
show that current listener status could not be established; do not infer online
from a cached query while disconnected. A future/invalid author timestamp or
start time yields `clock-skew` instead of remaining green indefinitely.

This small event-backed specimen scans retained facts on each query. For a large
or high-frequency inbox, maintain an indexed SQL read model or a bounded public
Chronolog projection; apply retention deliberately and preserve outstanding
requests and idempotency records. Heartbeats add durable events, so select a
frequency and stale window appropriate to the application instead of signing
one per animation frame. See [events or SQL](STATE_MODELS.md).
