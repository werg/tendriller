# Live application signals

Signals carry ephemeral observations through the application session. They have no durable operation identity or replay cursor. Use them for presence, cursor position, previews, progress and device observations that are useful only while fresh.

Install the session's signal port with `tendril.signals.install(session.signals)`, or pass `signals` when calling `startRuntime`. The binding can be installed independently from the durable application binding. An uninstalled port rejects immediately and queues nothing for later replay.

On the receiving participant, start observing before the producer sends:

```js
const abort = new AbortController();
for await (const signal of tendril.signals.subscribe({
  topics: ['typing'], mode: 'latest', signal: abort.signal,
})) {
  renderTyping(signal.authorId, signal.payload);
}
```

On the sending page, after installing its own session's signal port:

```js
await tendril.signals.send('typing', { active: true }, { ttlMs: 1000 });
```

Choose `latest` for replaceable state and `all` for bounded FIFO delivery. Respect cancellation, expiration and the authenticated sender context supplied by Chronolog. Application payloads cannot claim another sender's identity.

A subscription starts empty when iteration begins. `latest` coalesces newly
received values within that active subscription; it is not a current-value query,
a replay cursor or a cache of earlier sends. A late-joining agent should request a
fresh observation or status announcement through the same session. If a resident
receiver retains the last value for short-lived agent tools, bound that cache and
expire entries even when no later packet arrives. Report stale or disconnected
state separately from the previous value.

## Independent runs and endpoints

Use signed stream identity for simultaneous runs. Select streams **before** the
subscription coalesces values; filtering a merged payload afterward can lose a
sibling run's last update.

```js
await session.signals.send('work.progress', { percent: 40 }, {
  ttlMs: 2000,
  stream: { streamId: runId, target: taskId },
});
for await (const update of session.signals.subscribe({
  topics: ['work.progress'],
  streams: [{ authorId: workerSigner, streamId: runId, target: taskId }],
  mode: 'latest', signal: stopped.signal,
})) renderProgress(update.payload);
```

The owner supplies each attachment's endpoint ID and incarnation. Signed author,
signal-session incarnation, topic, endpoint, stream and target all participate in
the latest-value key. An expiring stream does not expire another run. Selectors
restrict observation; a target is not a read grant or an execution claim.

## Page observations and sensor readings

Page code acquires observations with standard browser APIs or an application
controller, then sends them through its existing session. Sensor acquisition and
local user controls remain separate from transport; the signal port does not
request browser permission or start a device. See
[sensor tracking and voice](BROWSER_API.md#sensors-and-voice) and the supplied
[media controllers](AI_INPUT.md).

| Observation | Session path |
| --- | --- |
| Small replaceable readings, location previews or derived detections | JSON signals with an explicit stream and expiry |
| Bounded image, audio or other binary evidence | `session.content`; send the resulting small reference when needed |
| Measurements or reviewed evidence that the application intends to retain | A declared command and its emitted events |

A signal's complete signed frame is bounded to 16 KiB, including its envelope.
Browser objects such as `Blob`, `MediaStream` and sensor event objects are not
signal JSON. Extract the needed fields; use content for media bytes.

Document each payload's units, capture time and any accuracy or quality fields.
Transport issue time is assigned when `send()` is called, so a newly sent packet
can still contain an old measurement. Enforce the application's maximum sample
age as well as signal expiry, with explicit clock assumptions across devices.
Use the verified author, endpoint and stream context to identify the source;
a payload label is not proof of device identity.

Rate-limit and coalesce replaceable samples at the source **before** sending.
Receiver-side `latest` coalescing does not reduce capture or network traffic.
Await each send, and discard or replace unsent samples on backpressure according
to the application's freshness policy. When a route or subscription ends, show
that state and obtain fresh observations on reconnection. Do not build a durable
retry queue of old sensor readings. Use the bounded request/reply helper below
for on-demand answers; expired samples still need to be discarded.

## Reach, local echo and limits

Opening the session explicitly chooses `signals.delivery`: `neighbors` sends on
currently attached peer routes; `application` enables bounded forwarding with
deduplication. Inspect `session.signals.delivery` rather than assuming a sparse
graph is a broadcast network. Neither mode acknowledges every participant, stores
offline notifications or guarantees future delivery after a partition.

Use `signals.localEcho: true` when several local views should observe the owner's
verified sends without a remote round trip. Transport-only attachment and signal
use do not initialize the application data engine. Subscription and queue quotas
remain bounded per attachment and owner; quota errors affect that client and do
not convert dropped live progress into durable work. Save final results through
the application's guarded command path.

A resolved `send` means the signal was accepted by a route (or echoed to local
views with `localEcho`), not that a particular peer received it. Right after
connecting, the answering peer may not be connected yet; a request sent then is
only echoed locally. For on-demand answers use the starter's
`shared/helpers/signal-request.mjs`: it waits until `session.status.connectedPeers` reports
a connection (a count; the authenticated reply from the named peer is what proves the
answerer), re-sends the same request ID until the
complete reply arrives, and splits and reassembles bounded replies larger than one
16 KiB signal. While new pieces arrive, retries wait. Subscribe to reply pieces with `mode: 'all'`; `'latest'` keeps only
the newest value per stream and suits state snapshots.

The starter helper has explicit limits; it does not support replies of arbitrary
size or infinite answers:

| Boundary | Limit |
| --- | --- |
| Generated request/reply JSON payload, including helper envelope and escaping | 12 KiB, reserving 4 KiB for the kernel's signed 16 KiB frame |
| One serialized reply | 4 MiB of UTF-8 JSON and at most 512 parts; both limits apply |
| Outstanding requests per browser helper | 16 |
| Native reply cache | 32 entries |
| Actually unsettled native handlers, including timed-out handlers | 32 |
| Browser assemblies per request | 32 generations sharing one 4 MiB total fragment byte budget |
| Cached encoded reply payloads | 8 MiB, with space reserved for bounded error replies |

Oversized answers return `REQUEST_REPLY_TOO_LARGE` before sending answer pieces.
Use the session's content facilities or bounded application queries for larger
data instead of increasing signal queues. The default caller deadline is 30
seconds; each send batch has one fixed 30-second lifetime, including backpressure
retries, rather than a fresh lifetime for every piece. Closing the helper or
aborting its session cancels connectivity waits, pending requests and send work.
Observe the promise returned by `serveSignalRequests`: terminal delivery failures
reject it. When a route cannot deliver even an error, a caller can still reach
its deadline; retrying does not guarantee delivery.

Cache entries are scoped to authenticated request author and ID. A repeat uses
the original question/input while that entry is retained, and concurrent repeats
share one active send. Entries expire after 60 seconds by default and may be
evicted earlier to keep the cache bounded. Recomputed answers carry a new
generation; the browser retains independent bounded assemblies and never combines
pieces from different computations. Every success and error fragment is bound to
the authenticated requesting device; clients ignore fragments addressed to other
members before changing assembly state.
This is disposable deduplication, not durable operation idempotency. Signal
topics are visible to authorized application members; an author-scoped cache
does not create a private reply channel. Handlers must cooperate with their abort
signal. A timed-out handler keeps its execution slot until its underlying promise
settles. Shutdown cancels send work without waiting for uncooperative providers;
their late results cannot send replies.

Multi-piece messages are paced by the transport. Send each piece after the
previous `send` resolves. The relay keeps a window of packets in flight and an
ordered bounded local queue for the rest. The browser fallback route is bounded to 4 MiB / 1,024 frames, the starter's
subscription queues to 8 MiB / 1,024 signals, and the relay's pending queue to
1 MiB / 64 entries. Those separate bounds do not
promise room for every reply or concurrent sender. `SIGNAL_BACKPRESSURE` means a
full queue or sequence budget; the helper retries it only within its fixed send
lifetime.

A live preview and its durable completion are separate operations. For example, drag previews may be replaced or lost; the final location is submitted as an ordinary application command with an operation ID. Stopping or disconnecting a signal source must not enqueue its expired previews into durable history.

Tendriller's control transport refuses `ephemeral/signal`. The host's allowed ephemeral action is the small connection invitation, which contains routing intent only. Live application signals travel through the session's authenticated peer transport. There is no built-in hosted signal channel or automatic role-based alternative.

## Worker presence when transport and handling are separate

The [agent request helpers](AGENT_REQUESTS.md) use ephemeral signals for live
availability. Bind the publisher to the actual request worker's lifetime and
implemented topics. A long-running native page owner or event forwarder may
remain connected after that worker exits; it must not keep advertising the
assistant as available. Filter by authenticated peer, `consumerId` and request
topic when workers share a signing identity. Graceful shutdown reports stopped;
abrupt failure ages to stale. Requests, receipts and final answers remain durable,
and no presence signal establishes future conversation wake.
