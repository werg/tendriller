# Inspect application connections

Open **Page options → Application connections** to inspect the page's registered
application participant. Opening the panel or selecting **Refresh connection
details** takes a bounded local sample. There is no polling, host query, network
probe or connection attempt. A `connectionRevision` change also takes one
coalesced sample, so a relay→direct replacement can appear without a peer or
application phase change. Byte changes alone do not cause reads.

The count and rows describe authenticated active session links. A raw
`onTransport` callback describes an adapter choice before authentication and is
not used as connectivity evidence. A direct choice that later fails authentication
must not appear as an authenticated connection.

## Register the owned participant

After installing the application backend, register that same participant once:

```js
tendril.application.install(createApplicationBackend({ id: session.applicationId, session }));
tendril.transport.install(session.participation);
```

This creates no signer, session or transport. Registering the same source again
is harmless; replacing it with a different source in the same page is rejected.
The first-app tutorial already registers its participants.

```js
const off = tendril.transport.onChange(report => renderConnectionSummary(report));
const cached = tendril.transport.status();
const sampled = await tendril.transport.refresh(); // explicit, local read
// Remove this UI observer when its component is removed.
off();
```

Without a source or a diagnostics-capable participant, details remain
**unavailable**. Missing counters are `null`, never fabricated zeros. Reports use
anonymous link numbers and omit peer identities, addresses, SDP, credentials,
application payloads and arbitrary exception messages. The report is capped at
64 links and uses closed-vocabulary error categories. `sampled: false` means the
current connection set has not been sampled successfully.

## Counter scope

Counters belong to each **current authenticated link** and reset when that link
is replaced. They are not lifetime application totals. `sentBytes` and
`receivedBytes` total the reliable and live lanes; the report also exposes
`sentReliableBytes`, `receivedReliableBytes`, `sentLiveBytes` and
`receivedLiveBytes`, plus `sentRequests` and `receivedRequests`.

Reliable counters include the kernel's reliable framing. Live counters count
accepted frames. They exclude encryption/socket overhead and SDP. They are not
Cloudflare billing, Internet interface totals, or proof that a command was saved,
applied, retained by a peer or preserved across recovery. An old sample does not
establish continuous connectivity.

## Live-signal rejection counters

Each current authenticated link may expose a `signalRejections` object with
exactly these payload-free counters:

| Field | Meaning |
| --- | --- |
| `total` | All live signals rejected by this link's gate |
| `clockSkew` | Signed, authorized signals rejected for exceeding clock tolerance |
| `expired` | Signed, authorized signals whose lifetime has elapsed |
| `unauthorized` | Signals rejected by the gate's signal authorization checks |
| `duplicate` | Already-seen signals rejected by the gate |
| `capacity` | Signals rejected by bounded gate capacity |

The whole field is `null` when the source package does not expose these
diagnostics. Missing or malformed individual counters remain `null`; neither
case is reported as zero. These counters belong to the current link and reset
when it is replaced. They contain no topic, payload, sender identity or
unbounded error text, and are sampled through the existing explicit refresh.

A valid signed and authorized signal with excessive clock skew or an expired
lifetime is dropped without closing the authenticated link. Invalid signatures
and malformed protocol input still fail the link. A drop does not append durable
history or create an automatic retry. Reliable commands keep their existing
journal and outcome semantics.

A local signal callback or send/echo is not a remote acknowledgement. Establish
remote observation through the receiving participant when a workflow requires
it; do not interpret zero rejection counters, an active link or local echo as
delivery proof.

## Native and SDK consumers

Keep `tendril agent run` running. These commands attach to a page's owner inside
it, read once, detach, flush output and exit; they do not open the signing store or
stop the owner:

```sh
tendril --page notes status
# doctor also includes the sanitized transport report:
tendril --page notes doctor
```

For another native or browser consumer, use the same public SDK helper:

```js
import { createTransportDiagnostics, readTransportDiagnostics }
  from '@tendriller/core/transport-diagnostics';

const report = await readTransportDiagnostics(session.participation, { signal });
const inspector = createTransportDiagnostics(session.participation, { signal });
const off = inspector.onChange(renderConnectionSummary);
await inspector.refresh();
off();
inspector.close(); // closes only this observer, never the participant or its links
```

Each local read has a fixed five-second default deadline, configurable through
`timeoutMs` up to 30 seconds. Concurrent refreshes coalesce. A timed-out physical
read stays charged until it settles, so repeated clicks cannot accumulate owner
calls. Later refreshes return current cached status while that physical read is
still unresolved; they do not return the old timed-out snapshot. Closing or cancelling the observer fences late samples. Connection-revision
bursts queue at most one follow-up read; there is no retry timer or idle loop.
