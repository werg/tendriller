# Requests, receipts, answers and listener presence

A page-to-agent request has two lifecycles: its **journal operation** and the
**consumer's work**. An accepted `applied` operation means the request is in the
selected application history. It does not mean an agent has read it. A peer
retention receipt (`shared()`) also does not acknowledge application-level work.

The first-app archive includes `shared/helpers/agent-requests.mjs`, an importable,
application-owned pattern using public Chronolog commands and queries. It supplies
`agentRequest`, `agentReceipt`, `agentAnswer`, `agentHeartbeat` and `agentInbox`.
It does not add journal statuses, a hidden agent service, or a background wake
mechanism. An actual consumer process must stay running.

## Add the pattern to your application definition

Before initial configuration, compose it into your existing `domain.mjs`:

```js
import { defineApplication } from '@chronolog/peer-session';
import { agentRequestCommands, agentRequestQueries } from '../../shared/helpers/agent-requests.mjs';

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

For an event-driven process use `tendril --page notes watch --events
--topics '["agent/request"]'` with the last committed cursor, or the public event forwarder. Plain `watch`
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

## Live presence and streaming previews (preferred, zero durable writes)

Peer connectivity only says an enrolled participant is reachable. It does not say
whether its agent loop is actively handling requests or currently thinking.
**Do not write periodic durable `agentHeartbeat` records every 30 seconds**—that
adds ~120 signed journal entries per hour and burns through history quotas even
while idle.

Instead, use the ephemeral signal helpers in `shared/helpers/agent-requests.mjs`:

```js
// Native agent process: broadcasts presence ONLY while a peer is connected and
// responds immediately to on-demand pings. Writes zero durable Chronolog records.
import { announceAgentPresence, streamAgentReply } from '../../shared/helpers/agent-requests.mjs';

const presence = announceAgentPresence(session, {
  consumerId: 'ops-agent', role: 'Operations assistant', topics: ['chat'],
});
// While generating an answer, mark busy and stream live previews:
presence.setState('busy');
await streamAgentReply(session, {
  requestAuthor: req.requestAuthor, requestOperationId: req.requestOperationId,
  text: partialReply,
});
// Then commit the final durable agentAnswer and clear the stream:
await streamAgentReply(session, {
  requestAuthor: req.requestAuthor, requestOperationId: req.requestOperationId,
  text: '', done: true,
});
presence.setState('listening');
```

On the browser side, `watchAgentPresence(session, { peer, onChange })` subscribes
with `mode: 'latest', includeLatest: true` and sends an immediate ping on connect,
so late-joining pages see live availability (`available`, `busy`, `stale`, `stopped`)
right away without any durable writes. `watchAgentStream` feeds live thinking
previews directly into `mountAgentChat.setStreamingReply(...)`.

## Optional durable listener checkpoints

If an application specifically requires an auditable durable record of when a
consumer started or stopped (not a periodic timer), `agentHeartbeat` remains
available as an occasional lifecycle command (`state: 'listening'` on startup,
`state: 'stopped'` on shutdown). Avoid sub-minute polling intervals so the journal
stays lean; use `consumerPresence` with explicit wall-clock expiry when displaying
durable checkpoints.
