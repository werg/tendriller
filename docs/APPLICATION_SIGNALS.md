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
`createSignalBinding`, and the hosted socket adapter. The browser exposes the
binding as `tendril.signals`, independently of `tendril.application`. Hosted pages
receive the authenticated host adapter automatically; peer pages install their
chosen implementation. Merely creating the binding starts no connection.

```js
// Peer pages install the public client bound to their owning Worker.
// Hosted pages already have an implementation; skip this installation there.
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
The originating socket receives its envelope as the return value; subscription
fan-out goes to other sessions. Reflect the returned envelope locally when needed.

`subscribe({topics?, mode?, signal?})` returns an async iterable of envelopes:
`scope`, `authorId`, `sessionId`, `sequence`, `topic`, `payload`, `issuedAtMs`, and
`expiresAtMs`. Sequence/session fields support live duplicate detection; they
are not durable operation IDs or replay cursors. The implementation bounds
message size, TTL, duplicate tracking and pending delivery.
Aborting a subscription ends iteration normally. Loss of the owning RPC/host
transport and subscriber overflow remain visible failures, so callers can
distinguish disposal from a lost service connection. Losing one route from a
standalone or governed channel does not end its local subscriptions: another or
later authenticated route may still serve them, without replaying old messages.
Aborting a send stops waiting; it cannot recall bytes already dispatched.

Start iterating before initiating related live work. Creating an iterable is
not a subscription-readiness acknowledgement: standalone and RPC adapters may
attach on the first `next()`, and hosted subscriptions cross an asynchronous
authorization boundary. No adapter promises replay of traffic sent before its
live consumer is attached.

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
stale messages cannot accumulate while bootstrap runs. Install once; the transport
implementation owns connection lifetimes. A hosted subscription terminates on
disconnect; start a new subscription in a fresh session when the view still needs it. Custom browser bootstraps can instead pass
`{signals: client.signals}` to `startRuntime`. No database backend installation is
required by either form.
Start live subscriptions independently of application catch-up or finality. A
standard SQL-peer bootstrap still opens its replica before exposing its governed
port; use a standalone channel when no SQL engine is needed.

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

## Hosted pages and agents

A hosted page uses `tendril.signals.send` and `subscribe` after its dedicated
authenticated live connection opens. No stream creation, producer
credential, operation ID or application database is needed. An offline call fails
with `signal_disconnected`; nothing is saved or retried. Peer pages continue to
use their explicitly installed implementation and never open a host fallback automatically.

The hosted runtime starts its live session on mount. While connecting or offline,
calls fail immediately with `signal_disconnected`. After a live connection ends,
a fresh call can start a fresh connection, but that call is not saved or retried;
send a new current observation once the connection is live. Leaving the page
closes the live session; restoring it starts fresh. The ordinary page's
`tendril.connected` flag describes its durable connection, not this independent
live session. Preview mode requires an explicit injected Signals port and opens
no real live connection.

A resident process using the public Tendriller SDK opens an explicit live session:

```js
const live = await host.connectSignals({ signal: lifetime.signal });
try {
  for await (const message of live.subscribe({ topics: ['preview.requested'] })) {
    await live.send('progress', { preview: 'working' }, { ttlMs: 2000 });
  }
} finally {
  live.close();
}
```

The returned `connected` property reports this live connection. This session is separate from the conversational wake listener. It neither marks
an agent conversation as listening nor wakes an offline agent. Reconnect by
opening a new session; earlier sends and subscription contents are never replayed.

A peer-history page can explicitly choose a hosted live port independently of
its durable backend:

```js
const hostedLive = await connectHostedSignals({
  api: new URL('_tendril', tendril.identity.base).href,
  signal: lifetime.signal,
});
tendril.signals.install(hostedLive);
```

Import `connectHostedSignals` from `@tendriller/core/signals`, or supply the port
as `{signals: hostedLive}` to `startRuntime`. This choice uses hosted page
permissions and availability; it confers no Chronolog grants. Do not switch to
another transport because an installed one fails. The default peer runtime
opens no hosted live socket.

The live scope follows the page's current read/write permissions: owners, approved
guests and valid agents may send; authorized display links may receive. Topics
filter delivery but do not restrict the audience within this page. Use a separate
authorized channel for private data. Stream-producer credentials remain scoped to
their named streams. The host assigns the authenticated `authorId`, a distinct socket
`sessionId`, and that session's increasing `sequence`. The envelope's `scope` is
`hosted:<page-id>`. Authors use `page:<account-id>` or `agent:<name>`, matching
durable event origin identities. Payload fields cannot substitute for this metadata. Permission
is checked again during fan-out, so a revoked reader receives no later payloads.
This is host-authenticated identity; peer deployments use their own signature
and membership policy.
The `page:` prefix identifies an authenticated account, not an owner role.
Instruction authority requires an explicit policy for that identity.

Hosted limits are explicit: finite JSON payloads up to 32 KiB, a default TTL of
5 seconds and a maximum of 30 seconds, 16 local subscriptions, and at most 128
pending messages or 512 KiB per subscriber. JSON nesting is at most 32 levels
with 4096 values, and a socket may send at most 50 messages per second. `latest` replaces only a pending
message with the same author/session/topic. It retains up to 256 protected
author/session/topic sequence floors after consumption, so a delayed older value
cannot replace a newer short-lived one. Exhausting this bound or a FIFO queue fails that iterator
with `signal_subscription_overflow`. Expiry starts at the caller's original
dispatch time and is checked after authorization and before consumer delivery.
The host permits at most 5 seconds of future clock skew; clients need usable
wall clocks. Once a client has observed expiry, moving its wall clock backwards
does not make that value deliverable again. Dispatch replies and incoming signals
share a transport-credit window of at most 64 frames or 512 KiB per connection,
including senders that never subscribe. Transport receipt credit does not
acknowledge application processing.
At most 32 requests may await a host reply. Cancelling or timing out ends the
caller's wait while retaining its bounded transport slot until a reply or
disconnect, so an unresponsive connection cannot accumulate fresh sends forever.
Capacity errors use `signal_backpressure`; a sender-rate refusal before fan-out
uses `signal_route_backpressure` and keeps the connection alive. Validation,
expiry, disconnect, and subscription overflow use the same lowercase signal
error names as the peer implementation. The hosted `read_only` error reports
the service's existing write-availability policy.

Signal traffic creates no durable payloads, command receipts, application events,
device-activity updates, application rate rows or operation IDs. Opening and closing an
ordinary page still has its normal presence lifecycle. Small session, subscription and
rate/flow-control metadata lives with the current socket so hibernation cannot reset
its identity or transport bound. Releasing the connection releases that metadata.
Sending follows the service's existing write-availability policy; a read-only
service rejects new sends. Live reads require current page and account access,
and dispatch rechecks each recipient before disclosing its payload.

The browser and native SDK use dedicated live sockets. Queue or credit overflow
can close that live connection without interrupting the page's durable requests.
The ordinary page socket rejects live commands with `signal_connection_required`;
there is no shared-socket compatibility path. Custom page bootstraps can open the
cookie-authenticated endpoint without starting an agent wake listener, regardless
of which backend owns their durable application history.

[Named streams](STREAMS.md) remain useful for producer ingestion with explicit
audience and retention policy. Their ephemeral variant has no retained payloads,
but retains sequence/rate metadata and uses the stream API. It is not required
for application signals.

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
