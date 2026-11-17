# Live application signals

Use a signal when a message is useful only while participants are connected:
presence, typing, pointer movement, device readings, previews, progress, or
temporary response chunks. Signals require no transaction, operation ID, replay
cursor, SQL engine, persistent outbox, validator, or finality service.

Use a durable event when the application must recover the fact after a disconnect
or restart. Combine SQL and a durable event in one program when the event must
assert that a state change succeeded. See [application backends](APPLICATION_BACKENDS.md).

## One small interface

`@tendriller/core/signals` exports the dependency-free `Signals` contract and
`createSignalBinding`. The browser exposes that binding as `tendril.signals`.
It is independent of `tendril.application`. Hosted pages receive an implementation
over their existing authenticated page socket. Peer pages install their chosen
implementation explicitly; the binding itself starts no network connection.

```js
// Peer composition owns connections and authentication. The public Chronolog client
// talks to the replica's owning Worker; page code does not hold its private keys.
tendril.signals.install(client.signals); // Omit on hosted pages: already installed.

// No operation ID, transaction, or durable retry follows this call.
await tendril.signals.send('typing', { active: true }, { ttlMs: 1500 });

const stop = new AbortController();
try {
  for await (const message of tendril.signals.subscribe({
    topics: ['typing'], mode: 'latest', signal: stop.signal,
  })) {
    // Replace this sender's indication and expire it at expiresAtMs.
    // Keep distinct senders/sessions separate; one sender stopping must not
    // remove another sender's indication.
    showTyping(message.authorId, message.sessionId, message.payload, message.expiresAtMs);
  }
} finally {
  clearTypingIndicators();
}
// Call stop.abort() when this view is disposed.
```

`send(topic, payload, {ttlMs?, signal?})` dispatches a JSON value and returns its
authenticated envelope. Completion means dispatch on a live route, not remote
receipt or processing. A disconnected route, cancellation or overload is an
error; there is no offline retry. A failed typing update must not prevent a
separate durable chat message from being submitted.

`subscribe({topics?, mode?, signal?})` returns an async iterable of envelopes:
`scope`, `authorId`, `sessionId`, `sequence`, `topic`, `payload`, `issuedAtMs`, and
`expiresAtMs`. Sequence/session fields support live duplicate detection; they
are not durable operation IDs or replay cursors. The implementation bounds
message size, TTL, duplicate tracking and pending delivery.

| Mode | Pending delivery | Appropriate uses |
| --- | --- | --- |
| `all` (default) | Bounded FIFO; accepted pending messages are not silently coalesced | Discrete transient events, chunks, samples |
| `latest` | Replace pending values for the same sender/session/topic | Presence, pointers, current progress, typing |

Neither mode makes messages durable. Expired messages disappear and an overloaded
FIFO fails visibly. A chunk consumer must detect application sequence gaps or
replace its preview with the durable completed result. Use durable events if
every sample or chunk must be recoverable. Even a reliable transport cannot
deliver through a disconnected session indefinitely.

The binding's `available` flag means an implementation is installed, not that a
remote peer is reachable. It is already true on hosted pages. `ready()` explicitly
waits for installation on a peer page. Calling
`send` or `subscribe` before installation fails with `signal_unavailable`, so
stale messages cannot accumulate while bootstrap runs. Install once; the signal
implementation owns its connection lifetime. Custom browser bootstraps can instead pass
`{signals: client.signals}` to `startRuntime`. No database backend installation is
required by either form. Start live subscriptions independently of application
catch-up or finality. A standard SQL-peer bootstrap still opens its replica before
exposing its governed port; use a standalone channel when no SQL engine is needed.

## Standalone or governed peers

`@chronolog/signals` supplies `SignalChannel` as a standalone live-messaging
primitive. It takes a scope, signing identity, explicit authorization policy and
attached live routes. It has no ledger, schema, membership-revision, finality or
database dependency. Applications may choose their own authentication and
transport instead of opening a Chronolog database.

The standard Chronolog composition exposes the same interface as
`client.signals`, the browser peer's `signals`, and resident `context.signals`.
The group adapter authorizes current signal-topic rights; those rights do not
imply permission to run SQL or publish durable events. Governed peer sessions
also enforce their reader admission policy. A host account, an SDP introduction,
a topic name or an application payload cannot grant these rights.

The group adapter may use already verified governance to authorize a sender;
each signal still travels outside the record log. It creates no proposal,
certificate, retained body or materialized event. Native peer composition attaches
and relays verified signals over live authenticated routes. Reconnecting attaches
a new route and does not replay old signals.

An authenticated signature proves the sender and message bytes. Confidentiality
comes from the selected encrypted transport and its admission policy. Application
policy decides whether that sender may issue instructions; receiving a message
on a topic named `instruction` is insufficient.

## Hosted application signals

The default hosted runtime supplies `tendril.signals` with no stream creation or
schema setup. Native agents explicitly open a live connection with the public SDK:

```js
const signals = await host.connectSignals({ signal: lifetime.signal });
try {
  await signals.send('run.progress', { runId, completed: 3 }, { ttlMs: 2000 });
  for await (const message of signals.subscribe({
    topics: ['attention'], mode: 'latest', signal: lifetime.signal,
  })) {
    // Check authenticated sender + application policy before acting on suggestions.
    observeAttention(message);
  }
} finally {
  signals.close();
}
```

The SDK socket uses the agent token in a WebSocket subprotocol header. It has no
automatic reconnect or retry. A fresh connection is a fresh live session. Browser
subscriptions follow the page's existing reconnect lifecycle, discard pending
messages at disconnect, and resume with new traffic only.

A peer-history page can explicitly choose this hosted channel too, using
`connectHostedSignals` or the native client's `connectSignals`. Install that port
in its signal binding when hosted live delivery is the intended route. The
default peer runtime waits for the chosen port and opens no host signal socket.
Hosted delivery uses page accounts and host credentials; those permissions do
not confer Chronolog reader or writer rights.

Owners, approved guests and agents may send. Display links may receive. Every
participant sees only its selected page's live scope, but topics do not restrict
the audience within that scope. Use a different authorized channel for private
messages. The host supplies the sender identity, session and sequence; payload
fields cannot impersonate an owner or authorize an agent instruction. Current
credentials and account access are checked during delivery.

Hosted limits are a 16 KiB frame, a 30 second maximum TTL (5 seconds by default),
32 pending sends, 64 subscriptions and 64 queued messages per subscription.
Each `latest` subscription tracks at most 256 author/session/topic identities.
It suppresses older sequence numbers even after the latest value was consumed,
until earlier frames can no longer be live. Exhausting that protected tracking
bound ends only the affected subscription with `signal_overflow`.
Senders may dispatch 50 messages per second. Dedicated SDK connections are bounded
to 32 per page. Overload is explicit and stale work is discarded. The host stores
session/rate metadata but no live payload, application receipt, event or replay
history. Live dispatch does not synchronize workflows or wake the agent.

On a shared page socket, excess live sends receive `signal_overflow`, and a
congested recipient can lose live deliveries. Neither condition closes that
socket or interrupts durable application requests. A dedicated signal socket
may close under sustained pressure; open a fresh session for subsequent traffic.

## Producer streams

For the Cloudflare application backend, [named ephemeral streams](STREAMS.md)
serve scoped collector ingestion with explicit stream readers and producer
permissions. Choose them when that stream administration is part of the task:

```js
// Create once with the agent SDK.
await host.streams.create({ name: 'pointer', durability: 'ephemeral', readers: 'page' });
// A connected owner page can then send without inventing a durable command ID.
await tendril.streams.publish('pointer', {
  records: [{ type: 'move', data: { x: 10, y: 20 } }],
});
```

Their payloads are not retained, they have no replay or latest snapshot, and they
do not wake the conversational agent. The host retains sequence/rate metadata
and applies its account and producer permissions. Durable streams still require
stable producer IDs. A peer page uses its installed signal port rather than
opening a hosted stream subscription.

## Durable completion and rollback

Transient progress can accompany a durable operation; it cannot establish that
the operation was accepted. Correlate a preview with an application operation
ID in its payload when useful, then replace it with the actual final result.
On cancellation, timeout or disconnect, expire the preview.

SQL and local projections may roll back and replay a provisional suffix. Their
reducers must be deterministic and free of network effects. Signals received
during that time remain independent transient observations; never replay signals
as part of rebuilding a projection. External actions that must survive recovery
start from final accepted durable intent and use idempotency or reconciliation.
