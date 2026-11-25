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

## Live presence belongs to the actual worker

Peer connectivity only says an enrolled participant is reachable. It does not say
whether its agent loop is actively handling requests or currently thinking.
When the native page owner, an event forwarder and the interactive request worker
are separate, **only the actual handler may advertise its implemented topics**.
An owner that fetches mail cannot advertise `chat` on behalf of a stopped
assistant. A one-shot waiter is not an active assistant either.

Use the ephemeral signal helpers in `shared/helpers/agent-requests.mjs`. They
write zero durable Chronolog records. Start them only after the worker has made
its first successful read, bind their signal to that worker's lifetime, and close
them in its `finally`. This wrapper illustrates the ownership boundary:

```js
import { announceAgentPresence } from '../../shared/helpers/agent-requests.mjs';

// Call inside the actual worker after its first successful inbox read.
// handleRequests runs that worker's real loop and implements every listed topic.
export async function whileHandlingRequests(session, { workerSignal, handleRequests }) {
  const presence = announceAgentPresence(session, {
    consumerId: 'ops-agent', role: 'Operations assistant', topics: ['chat'],
    signal: workerSignal,
  });
  try {
    await handleRequests({ signal: workerSignal, presence });
  } finally {
    await presence.close(); // Stop even if handling fails; leave the page owner alive.
  }
}
```

`handleRequests` above is the application's worker loop, not a Tendriller API.
For a runnable implementation with actual reads, durable checkpoints, receipts,
answers and automatic presence cleanup, use the worker below. It avoids placing
an availability timer in the long-running native owner or event exporter.

Several attached workers can share one authenticated signer. Select the intended
consumer and implemented request topic in the browser as well as its peer:

```js
import { watchAgentPresence } from '../../shared/helpers/agent-requests.mjs';

const observer = watchAgentPresence(session, {
  peer: nativeDeviceId, consumerId: 'ops-agent', requestTopic: 'chat',
  onChange: presence => renderAssistantAvailability(presence),
});
// Close the observer when this view is disposed.
```

The observer's `available`, `busy`, `stale` and `stopped` values are liveness
hints. They do not acknowledge a request or establish future conversation wake.
Keep a native transport indicator separate from the intended worker's indicator.
A graceful worker exit can publish stopped; a crash must age to stale while the
native peer remains connected. A fetch worker's signals must not refresh the
assistant's indicator. Test this split-process failure explicitly.

Inside an active handler, `presence.setState('busy')` and `streamAgentReply`
can show transient progress. `watchAgentStream` supplies previews to
`mountAgentChat.setStreamingReply(...)`. Commit the final durable `agentAnswer`
before clearing its preview, and return to listening only if the worker will
continue handling requests. Streaming and presence never replace durable answers.

## Run a supervised consumer with a handled checkpoint

The starter ships `consumers/request-worker.mjs` and
`shared/helpers/agent-consumer.mjs`. The worker attaches to the existing page
owner, handles the request pattern's declared commands and query, and scopes its
private checkpoint to the selected application/history, consumer and topics.
It never opens a second signer or modifies an existing application's definition.

In a workspace whose page already declares `agentRequest`, `agentReceipt`,
`agentAnswer` and `agentInbox`, keep `npm run agent` running, then run:

```sh
node consumers/request-worker.mjs --workspace /absolute/workspace \
  --page requests --consumer assistant --topics '["chat"]' \
  --checkpoint /private/assistant.json --echo
```

`--echo` is a harmless runnable example: a real addressed `chat` request receives
a durable receipt and an echo answer. It verifies consumption and restart, not
LLM execution or an existing conversation wake. For application work, replace
`--echo` with `--handler /absolute/handler.mjs`; that module exports
`handleRequest(request, { signal, idempotencyKey })` and returns a nonempty
answer string of at most 8,000 characters. Honor cancellation and use the retained
key and provider receipts to reconcile external effects. The worker persists a
`handling` marker before invoking the handler; a crash or failure there stops
with `AGENT_CONSUMER_REVIEW_REQUIRED` on resume rather than repeating a possibly
completed external effect.

Keep the checkpoint private and persistent. Exact prepared receipt/answer inputs
and work results survive restarts; the handled cursor advances after durable
handling. A crash before checkpointing can redeliver work without changing its
answer operation or input. Recovery and a checkpoint for a different scope stop
for review. Never edit a cursor merely to make pending work disappear. The
checkpoint has an exclusive `.lock`; after an abrupt kill, verify the previous
worker is gone and reconcile pending work before removing a stale lock. The
runner never steals a lock or starts a second checkpoint owner.

Startup, handler, recovery and owner-loss failures exit nonzero. SIGINT/SIGTERM
performs normal cleanup after attachment; the native page owner remains running.

Use a bounded supervisor such as an existing user service with
`Restart=on-failure`, `RestartSec=3`, `StartLimitIntervalSec=120` and
`StartLimitBurst=6`. Supervise the worker command, not a one-shot `events` reader.
Report exhausted retries and recovery/uncertain-effect stops; resolve their
cause before restarting. Retain the owner and worker process identities
separately. [Restart guidance](AGENT_RESTART.md) explains reattachment and
recovered-cursor review.

Verify a first request, stop only this worker with the native owner still
connected, and submit a second request. The worker indicator must become stopped
or stale; the second request remains awaiting acknowledgement. Restart with the
same checkpoint and confirm its receipt/answer. For conversation delivery, also
perform the [two-request host rehearsal](CONVERSATION_DELIVERY.md#two-request-same-conversation-rehearsal)
after successive conversation turns end.

## Optional durable listener checkpoints

If an application specifically requires an auditable durable record of when a
consumer started or stopped, `agentHeartbeat` remains available as an occasional
lifecycle command. The actual worker may record `state: 'listening'` after its
first successful read and `state: 'stopped'` on shutdown; a native owner must not
write those records on behalf of an absent worker.

Do not write periodic durable heartbeats. Use ephemeral presence for live
availability and `consumerPresence` with explicit wall-clock expiry when displaying
historical lifecycle checkpoints. A past startup record is not proof that the
worker is still running. Keep durable requests, receipts and answers separate
from these optional diagnostic records.
