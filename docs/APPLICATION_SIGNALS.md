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
It is independent of `tendril.application`.

A hosted Cloudflare page already has its live implementation installed. It uses
the page's existing authenticated connection and bypasses its command outbox.
A peer page installs its selected live implementation explicitly:

```js
// Peer composition only. A hosted Cloudflare page already has its signal port.
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
implementation owns its connection lifecycle. The hosted page port registers one
server subscription while local readers exist, unregisters it when the last
reader ends, and restores that registration on the page's existing reconnects.
It discards pending delivery at disconnect and sends no previous messages on the
new connection. A new subscription starts with future traffic; it has no catch-up.
Custom browser bootstraps can instead pass
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

## Hosted owner and agent sessions

The SDK opens an explicit live connection. Constructing the host client does not
connect, poll, register a wake listener, or start an agent conversation:

```js
const host = createClient(pageHandle);
const signals = await host.connectSignals({ signal: stop.signal });
try {
  const input = signals.subscribe({ topics: ['preview/control'] });
  await signals.send('progress', { completed: 3, total: 10 }, { ttlMs: 5000 });
  for await (const message of input) {
    // Enforce application policy using authenticated authorId, never payload.role.
    inspectPreviewControl(message.authorId, message.payload);
  }
} finally {
  signals.close();
}
```

`connectSignals` resolves after the host establishes the session. The returned
object implements `send` and `subscribe`, exposes current `connected`, and has
an idempotent `close()`. A disconnect ends this explicit agent session. Open a new
session when desired; the SDK has no automatic reconnect or replay loop. The
connection abort signal closes it and releases pending reads and sends.

A peer-history page can explicitly select this hosted live route too, using
`connectHostedSignals` or the native client's `connectSignals`, then installing
the returned port in its signal binding. The default peer runtime opens no host
socket and never falls back to hosted signals while peer services initialize.
This explicit transport choice uses host accounts and agent credentials; it
confers no Chronolog reader, SQL, publication or signal grant.

Hosted signals are private to currently authorized **owners and agent tokens**.
Guests, display links, producer tokens and unauthenticated connections cannot
publish or receive them. This is the built-in hosted authorization policy. The
common `Signals` interface and standalone signed signals support other audiences
through an explicitly selected implementation and authorization policy. Choose
such a policy when building guest collaboration or public display updates.

The host authenticates the original sender and supplies
`account:<account-id>` or `agent:<token-name>` as `authorId`, a fresh connection
session, a sequence and application scope. Clients cannot choose these fields.
The sender chooses the bounded lifetime; the host checks it before dispatch and
after asynchronous authorization without renewing it.
Confidentiality and origin trust come from the authenticated TLS session; these
envelopes are not independently signed peer proofs. Topic names are filtering,
not additional permissions or a reason to obey received text.

The host checks sender and recipient credentials again during asynchronous
delivery. Revoking a token or owner session stops its participation. A signal
socket does not register a browser device, update conversation presence, append
an application/event/stream record, or wake a conversational agent. Only bounded
per-connection sequence, subscription and rate metadata accompany the live
socket; payloads are not retained in storage. Selecting this route does not
enable hosted durable application operations on a peer-history page.

| Hosted bound | Limit |
| --- | ---: |
| JSON payload / wire frame | 16 KiB / 20 KiB |
| TTL | 1–30,000 ms; default 5,000 ms; maximum future clock skew 2,000 ms |
| Outstanding sends / subscriptions | 32 / 16 |
| Queue per subscription | 64 messages and 256 KiB |
| Protected latest-value identities per subscription | 256 author/session/topic keys |
| Dedicated live connections / subscribed recipient routes | 64 / 64 |
| Publication rate per connection | 50 messages/second |
| Authorization work | One send per connection, eight sends per hosted application |
| Request deadline | Earlier of message TTL and 10 seconds; controls use 10 seconds |

Expiry starts at the sender's attempt and is checked again at host dispatch.
Both machines need a usable wall clock. Delayed work expires instead of receiving
a fresh lifetime. Cancellation, timeout and pressure never schedule a retry;
some recipients may already have received a message whose send reports an
error. An invalid message or ordinary live pressure does not close a hosted
page's durable application connection. `signal_backpressure` rejects excess
local sends; busy recipient routes may drop a dispatch. The host retains no
authorization backlog. A send that succeeds may have no listening recipients.
The subscription's `all` overflow is an explicit gap; `latest` retains a bounded
per-sender sequence high-water mark after consumption and reconnect until all
earlier frames must have expired, so an older value with a longer TTL cannot
replace a newer one. Both modes fail that subscription visibly
when its byte or sender bounds are exceeded.

SDK connections close when their owner aborts or calls `close()`. Shared page
subscriptions attempt one bounded unsubscribe when a subscribe acknowledgement
is uncertain; they do not retry indefinitely. Cancelling a send releases its
pending request but cannot retract bytes already dispatched. Custom transports
used with `createHostedSignalPort` must respect the supplied request abort signal
and report connect/disconnect transitions; uncooperative requests continue to
occupy their work budget until they settle.
An actual transport send failure may close a dedicated signal socket. Live
delivery never closes a shared page socket, and ordinary congestion closes
neither kind of connection.

## Named producer streams

For the Cloudflare application backend, [named ephemeral streams](STREAMS.md)
remain a separate hosted ingestion facility with explicit audience, producer
and retention policy. They are useful when those stream features are needed;
creating a named stream is not required for ordinary application signals:

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
