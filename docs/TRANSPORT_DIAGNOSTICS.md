# Inspect application connections

Open **Page options → Application connections** to see who this page is syncing
with. The panel leads with a plain-language summary (announced politely to
screen readers), for example *Connected to 1 device.* or *Not connected. Your
changes are saved on this device and will sync when a device or your agent is
online.* Each current link then shows:

- **who**, resolved locally in this page and never shown as a key:
  - an agent by its public `@handle` (from the page's agent roster, or the
    host-attested `@handle` label of its signed admission);
  - **Your other device** for another device admitted under the viewer's own
    account, with a short label: a specific attestation label if the device
    has one, *created this page* for the page creator, or else the date it was
    admitted (for example *Your other device (added Nov 3, 2026)*), with an
    **Admin** badge when the signed membership makes it an administrator;
  - another member by its host-verified email, or *Member 1*, *Member 2*, …;
  - *Device 1*, *Device 2*, … when the page has no matching member state;
- **route**: *Direct connection* or *Via relay*, with the fallback reason when
  the direct attempt timed out or failed;
- **data**: received and sent payload in decimal units (B, KB, MB).

Lane counters, live-signal rejections, sampling and scope notes sit behind a
collapsed, keyboard-operable **Technical details** disclosure.

Opening the panel or selecting **Refresh** takes a bounded local sample. There is
no polling, host query, network probe or connection attempt. A
`connectionRevision` change also takes one coalesced sample, so a relay→direct
replacement can appear without a peer or application phase change. Byte changes
alone do not cause reads.

The count and rows describe authenticated active session links. A raw
`onTransport` callback describes an adapter choice before authentication and is
not used as connectivity evidence. A direct choice that later fails authentication
must not appear as an authenticated connection.

## Where route and counters come from

`participateApplication` (browser Worker owner and native agent alike) records
the route it selected for each peer before handing the connection to
`session.connectPeer`. While it runs, it annotates the owned session's own
`diagnostics()` — the call every owner attachment reaches through
`diagnostics.peers` — so each authenticated link row carries `kind`
(`direct`/`relay`), the relay fallback `reason`, and the session's measured
counters. The page facade installed with `tendril.transport.install(session)`
therefore reports the real route. Closing participation restores the session's
unannotated report, in which `kind` is `unknown`. Links the controller did not
open also stay `unknown`.

## Register the owned participant

After installing the application backend, register that same participant once:

```js
tendril.application.install(createApplicationBackend(session));
tendril.transport.install(session);
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

`peer` is the only identity a report carries: `{ role, handle, label, email, administrator }`
with `role` one of `agent`, `own-device`, `member` or `unknown`. It comes from
an optional local `describePeer(peerId)` lookup, is re-evaluated on each status
read, and is validated (handle pattern, bounded control-free label, email
shape); anything else becomes `unknown`. The signing key never enters the
report.

The page runtime composes that lookup from two local sources. Its agent roster
supplies handles. When the installed source exposes owner `extensions` with
the `@tendriller/core/admission` extension (the tutorial templates compose it),
the runtime subscribes to its `admission` notices and reads `admission.state`
once on each explicit refresh, then matches the peer key to a signed admitted
member. The viewer's account is its own member's host-attested `accountId`; a
creator viewer, which created the page from the owner account, owns the page's admission accounts. A member with the
same account is the viewer's other device; any other member is named by its
attested email when present. `administrator` is the same signed membership fact
the Devices view badges (owner-account devices are administrators by default;
attested agents are not); the panel shows the same **Admin** badge, and the field
is `null` for peers absent from that state. Peers absent from that state stay anonymous. No
host request is made for any of this.

## Counter scope

Counters belong to each **current authenticated physical link** and reset on replacement. They are not lifetime application totals. The session reports `sentReliableBytes` and `receivedReliableBytes`: actual reliable CBOR protocol framing before secure-channel and RTC encapsulation. When the link has a live route it also reports `sentLiveBytes` and `receivedLiveBytes` for actual signed live-protocol frames, before encryption and transport encapsulation. These counters do not measure encryption, socket overhead, SDP or NIC traffic.

`sentBytes` and `receivedBytes` are the link totals the panel shows: reliable plus live framing. A link without a live route reports no live fields, carries no live frames, and totals its reliable framing alone. A missing or malformed reliable counter, or a malformed live counter, leaves the total `null`. There are no request counters: no layer measures them.

`kind: "unknown"` means the source does not know the route, not that a direct link failed. Multiple physical links to one verified signing key remain separate connections; the participant count is distinct authenticated keys. No counter proves an operation was stored, materialized, retained by a peer or finalized. A cached sample does not establish continuous connectivity or provider billing.

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

const report = await readTransportDiagnostics(session, { signal });
// Optional: describe links locally (agent, own device or member); the key stays local.
const inspector = createTransportDiagnostics(session, { signal, describePeer: peerId => {
  const agent = agents.find(item => item.public_key === peerId);
  return agent ? { role: 'agent', handle: agent.handle } : null;
} });
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
