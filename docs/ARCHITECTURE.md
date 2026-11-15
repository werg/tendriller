# Internal architecture

The public HTTP, WebSocket, MCP and browser contracts stay in `contract/`.
The internal boundaries below separate storage, permissions, live delivery and
machine collection without replacing the existing domain stores or protocols.

## Transactions and effects

`server/src/transactions.ts` is the single wrapper around the Durable Object's
SQLite `transactionSync`. Domain code uses `t.transaction(write)` and
`t.afterCommit(effect)` through the Tendril facade.

- A transaction callback is synchronous. Do hashing, request-body reads and
  external I/O before it, then revalidate any authority or state that may have
  changed while awaiting. Network work belongs outside the database transaction.
- Nested transactions are savepoints. Their effects join the parent's queue;
  nothing is emitted until the outer transaction succeeds.
- A failed savepoint discards its effects and clears the metadata cache, so the
  next read sees SQLite's rolled-back value. An outer transaction can catch an
  inner failure and continue with its own writes.
- Broadcasts, targeted sends, stream fanout, presence refresh, long-poll release
  and alarm scheduling use the shared effect boundary. Message payloads are
  captured when registered, rather than read from mutable caller objects later.
- An uncaught effect failure after commit is logged and does not turn a committed write
  into an apparent rollback or prevent later effects from running.

For example, a domain operation can compose existing helpers:

```ts
return t.transaction(() => {
  t.applyState(ops, by);
  return addEvent(t, { type: "event", data, by, wake: false });
});
```

Both writes share the outer transaction, and their live notifications wait for
it. Use this boundary for a real atomic domain operation, not for unrelated
requests or long-running work. Direct `ctx.storage.transactionSync` calls bypass
effect tracking and cache invalidation and should stay inside the wrapper.

Post-commit effects are **not a durable queue**. A crash can lose a live frame;
durable stream readers recover from retained history, and ephemeral readers have
no replay guarantee. Webhook, MCP and timer delivery already have persisted retry
jobs. Their intent must be written in the same transaction as the triggering
event, before scheduling delivery. This does not create an atomic transaction
across SQLite, D1, R2 or an external service, nor an exactly-once network guarantee.

## Identity, permission and activity

`server/src/access.ts` resolves typed agent, producer and page principals and
contains their permission rules. Credential lookup has no presence side effects.
Request boundaries explicitly record the kind of activity that occurred.

| Identity | Authority | Activity |
| --- | --- | --- |
| Agent | Administrative API and permitted stream reads/appends | Existing authenticated API, MCP and agent-socket requests explicitly check in |
| Producer | Append to named custom streams in its grant | Only an accepted append updates producer activity |
| Owner page | Owner controls and allowed streams | Device connection/activity follows existing page semantics |
| Guest page | Participant writes and page-readable streams | Same device activity rules, with approved guest membership |
| Display page | Read-only page access and page-readable streams | Connection activity; no participant or owner authority |

Page routes, the outer page-access check, socket handshakes, socket requests and
stream delivery share the link/session/account policy. A handshake rechecks access
after upgrade and before sending state. Asynchronous account lookups recheck local
session/link state afterward and retain newer socket attachment cursors. Legacy
socket recipient selection also rejects locally revoked or expired identities.
Stream replay/publication and live fanout freshly check account availability;
ordinary socket operations retain the existing short account-check cache.

Existence, activity and agent attention remain different facts. `expiresAt()`
uses lifecycle rules, while `presenceFacts()` and `presence()` describe delivery
and conversational availability. A producer can extend an ad-hoc dashboard's
activity but cannot claim ownership, clear an agent wake, or imply an attentive
conversation. Resident and unclaimed-page rules are unchanged.

## Stream core and adapters

`server/src/streams.ts` is a stable facade for callers and HTTP routes. It
coordinates accepted records with post-commit delivery. Implementation lives in:

| Module | Responsibility |
| --- | --- |
| `streams/store.ts` | Definitions, append admission, retention and durable custom history |
| `streams/history.ts` | Sequence cursors, lazy byte-bounded pagination and history gaps |
| `streams/adapters.ts` | Views over the original event, log and transcript stores |
| `streams/broker.ts` | Socket subscriptions, bounded fanout and slow-reader handling |
| `streams/producers.ts` | Producer grants and credential management |
| `streams/limits.ts` | Stream limits and input normalization |

Storage admission cannot send a socket frame. The broker does not append records
or create retry jobs. Custom durable records use their existing table; built-in
event/log/transcript streams retain original tables and sequence numbers.
State and presence streams signal changes to domain snapshots. They do not
replace snapshot or command APIs. Ephemeral payloads never enter a durable store.

`consumers.ts` shares the event history adapter and gap calculations. Consumer
leases still own their fencing, delivered ceiling, sticky gap acknowledgement and
explicit processing checkpoint. Reading or delivering a record never implicitly
acknowledges that an agent handled it.

## Browser transport

The browser keeps four separate delivery decisions:

1. **Connection:** `runtime/src/connection.ts` owns the socket, handshake timeout,
   heartbeat, reconnect backoff and stale-socket fencing.
2. **Operation policy:** `delivery.ts` names whether an operation uses IndexedDB,
   an in-memory queue or connected-only delivery, and what completion means.
3. **Requests and receipts:** `requests.ts` owns correlation, timeout cleanup and
   command receipt waiters. A correlated response alone never deletes an outbox
   entry; the domain acknowledgement handler decides that.
4. **Domain state:** `core.ts` retains state reconciliation, the durable outbox
   pump, command acknowledgements and capture behavior. Stream subscriptions keep
   their own replay/delivery cursors.

Known stream requests explicitly require a connection. New operation names do
not gain a delivery policy from a string prefix. Unknown raw/control operations
retain the existing memory-queue default. A browser command being queued or
accepted, a stream frame being delivered and a consumer completing work remain
distinct states. Server stream durability does not choose browser outbox policy.

## Collector sources

`cli/lib/stream-collector.mjs` coordinates source lifecycles, destination checks,
bounded batching, spool commit, upload and retry. It constructs adapters from
`cli/lib/stream-sources/` instead of branching on source type throughout the loop.

Each adapter exposes immutable capabilities for its mode, replay support and
checkpoint support. A file adapter owns complete-line parsing and resumable file
position. Host sampling and SSH output are live sources even when their accepted
records are destined for a durable stream. The SSH adapter owns one child
session, bounded line decoding and close/abort; the coordinator owns retry.

File checkpoints advance atomically with local spool acceptance. Destination
durability controls whether accepted records are spooled; it does not create
source replay that a remote command or host sampler cannot provide. Existing
configuration, CLI options, record IDs, spool format and credential scope remain
unchanged. See [Collector](COLLECTOR.md) for operational details and
[Streams](STREAMS.md) for the public API.

## Verification

`npm run check` exercises contracts, types, Worker behavior, runtime units,
collectors and the installed package. Focused Worker suites cover nested
rollback/effects, wake-intent atomicity, access revocation and lazy history reads.
`npm run test:browser` and the portable browser suites cover the shipping runtime
against its real transport and outbox. See [Development](DEVELOPMENT.md).
