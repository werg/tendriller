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
It is independent of `tendril.application` and starts no network connection.

```js
// Composition owns connections and authentication. The public Chronolog client
// talks to the replica's owning Worker; page code does not hold its private keys.
tendril.signals.install(client.signals);

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
remote peer is reachable. `ready()` explicitly waits for installation. Calling
`send` or `subscribe` before installation fails with `signal_unavailable`, so
stale messages cannot accumulate while bootstrap runs. Install once; the signal
implementation owns reconnects. Custom browser bootstraps can instead pass
`{signals: client.signals}` to `startRuntime`. No database backend installation is
required by either form.

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

## Hosted streams

For the Cloudflare application backend, [named ephemeral streams](STREAMS.md)
remain a hosted live distribution facility:

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
