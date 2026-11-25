# Owned peer participation

Chronolog owns authenticated connections and bounded reconnect. No participant is selected to order operations. Peers union signed operations and replay them in canonical author-time order. Tendriller supplies bounded discovery, direct connection introductions and an opaque WebSocket relay through one adapter. Applications install one participation controller.

## One shipping transport path

Use the maintained starter and its public participation helpers. Direct WebRTC is
part of normal setup, not an optional optimization to add later. Both native and
browser participants use `participateApplication` and the shared
`PEER_TRANSPORT_POLICY`. That policy owns the RTC attempt budget, STUN configuration
and automatic encrypted WebSocket fallback. Do not copy another direct/relay
selector into an application or replace the direct opener with a throwing stub.

Native owners use:

```js
import { participateNativeApplication } from '@tendriller/core/native-rtc';
const participation = participateNativeApplication(session, {
  peers: host.peers,
  onTransport: ({ peerId, kind }) => showTransport(peerId, kind),
});
```

The standard session package installs its native RTC dependency automatically.
There is no separate native-RTC archive or manual capability-install step.
Browser applications keep the supplied `serveBrowserOwner` / `openBrowserOwner`
composition. Its page-side bridge supplies RTC mechanics for the single shared
or elected owner; identity, authentication, stored operations and execution stay in that
owner. Both browser engines and events/SQL starters consume this same path.
Closing an RTC-serving page retires its transport; the existing session controller
handles reconnection with another attached page or the fallback. It does not
create a second identity, journal or application retry loop.

### What uses server bandwidth

Direct application commands, queries, content, replication and signals travel
between participants. The host supplies login, signed authority, discovery and
bounded SDP introductions; it does not carry direct application payloads.
The default STUN endpoint discovers usable addresses and does not relay data.
Cloudflare documents that [its public STUN service is free and unlimited](https://developers.cloudflare.com/realtime/turn/faq/).
The shipping policy does not configure a paid TURN service.

If UDP, NAT, browser capabilities or network policy prevent a direct connection,
the same attempt closes its RTC/signaling resources and uses the hosted encrypted
WebSocket relay automatically. This fallback carries application bytes and costs
host bandwidth. An owner cancellation never starts a relay. Reconnect and retry
remain owned by Chronolog's one participation controller; a platform opener which
ignores cancellation retains its physical-opening slot until it settles.

`onTransport` reports a raw `direct` or `relay` selection, with a bounded fallback
reason. It is diagnostic metadata, not evidence that a peer authenticated or an
operation was retained or materialized. Do not report P2P solely because signaling or a data channel opened.
Verify actual application transfer and relay byte counters as described below.

### Improving an existing relay

The session's `reconsiderConnections()` accepts an actual network or RTC-provider
change. It tries a direct-only authenticated replacement while the existing relay
continues to serve the application. A blocked or cancelled candidate never opens
another relay and never changes the device identity, signed operation IDs,
author timestamps or authority. Successful authenticated replacements retire the
old link with a bounded drain of in-flight requests.

The maintained browser owner requests reconsideration when an authorized RTC
provider becomes available, the device comes online, its network interface changes
(where supported), or a visible page resumes. Native participation also responds
to discovery reconnection. A native host with its own operating-system network
notifications can call `await participation.reconsiderConnections()` from those
notifications. Applications must not schedule repeated probes.

Concurrent triggers share one attempt batch. Each peer has a minimum 30-second
cooldown between event-triggered attempts; expiration only permits a later event
and schedules no timer. Ordinary directory changes and application commands do
not trigger upgrades. A healthy direct link is never probed. Failed upgrades leave
the currently usable relay selected.

`await participation.diagnostics()` reads current authenticated links and local
counters, without discovery, synchronization, host HTTP or model dispatch. It
returns direct/relay/unknown routing and bounded fallback reasons with reliable
and live application framing byte counts. These exclude SDP, encryption and
WebSocket/UDP overhead and are not a Cloudflare billing estimate. `unknown` means
a custom transport did not describe its route; it must not be reported as P2P.
Read diagnostics when displaying the inspector or explicitly refreshing it;
do not turn the inspector into another polling loop.

The underlying `createPeerIntroductions` API remains the host adapter primitive
for transport qualification and specialized environments. The maintained native
and browser entry points above are the application setup path.

## Observe participation

The controller exposes `status` (`connected`, `disconnected` or `closed`, with connected and pending counts and an error), `onStatus`, `signal`, `closed`, `reconsiderConnections()`, `resume()` and `close()`. The session's `connectedPeers` is reported through its own status. The session closes its controller with its other resources.

The controller reads current signed grants and authenticated peer evidence. Advertisements cannot grant any right. Peers exchange signed operations, retention and finality evidence and authority bundles. Merging is idempotent, and every receiver re-verifies it. There is no recovery proposal, approval or loss notice. A late earlier operation arrives as an ordinary fact and the application rederives from a coherent snapshot. Connection loss never blocks local authoring or provisional reads.

Ordinary commands, queries, content and live signals use peer connections. The controller consumes required discovery notifications. A healthy idle participant
does not renew advertisements, scan the host directory or synchronize on a timer.
An initial connection or reconnect advertises once; directory changes and actual
application/link changes trigger the relevant work. Chronolog owns bounded
unavailable-peer retries.

## Host transport primitives

`host.peers.discover()`, `advertise(advertisement)` and `withdraw(peerId)` use the shared participant discovery facet. An advertisement contains exactly `{peerId,storageId,routes}`. These bounded routing hints exist only while their authenticated discovery
WebSocket is connected. They carry no execution profiles, eligibility claims,
authority proofs, application operations or secrets. Independent retained coverage is verified after connection.

`host.peers.watchDiscovery(peerId, {signal})` opens the receive-only hibernating
`peers/discovery/watch` channel using `tendriller.discovery.v1`. Its bounded
notifications are `{type:"ready"}` and `{type:"changed"}`. `ready` precedes
advertising and is repeated only after a real reconnect; `changed` invalidates
one directory read. The normal `createPeerIntroductions` adapter supplies this
channel as the session discovery port
`notifications({signal}): AsyncIterable<{type:"ready"|"changed"}>`.
Use that adapter rather than constructing another availability loop.

Advertisements contain no TTL and return `{advertisement}`; directory entries
have the same shape. An advertisement requires its existing same-principal
subscription. Closing, replacing or revoking that subscription removes its
availability. Reconnect re-advertises the same retained signing identity; it
does not create a device or change membership. Presence and small connection
attachments survive Durable Object hibernation without heartbeats, pending
HTTP requests or expiry alarms. Routing hints are retained in bounded SQLite
rows and checked against the current sockets on every read. Large routes never
enter the small WebSocket attachment.

`listenInvitations(peerId)` opens a hibernatable host socket without a heartbeat. `invite(peerId,{channel,requesterPeerId})` sends one small `ephemeral/invite` action. Pending requests are bounded, coalesced and acknowledged when consumed. Revoked credentials and cancellation close the listener.

`rendezvous(channel,peerId)` pairs authorized participants. Its `ready` result assigns offerer or answerer; callers must use that result. Each sends one complete bounded SDP description and the exchange closes. Binary frames, repeated descriptions, role confusion, foreign session IDs and expired pairs are rejected. `createPeerIntroductions` handles these details for the owned controller.

`relay(channel,peerId,{remotePeerId,signal})` opens separate reliable and disposable WebSocket lanes. It returns `{reliable,live,ready,signal,close}`. Attach `frameWebSocketPeerConnection` synchronously, then await its readiness: the facade strips relay admission and receipt controls and forwards binary packets without an application payload queue. The four sockets must match one reciprocal peer pair and session. Disconnect, malformed traffic or cancellation closes the entire pair.

The relay bounds packet size, outstanding bytes/packets, admission per principal and host, and packet rate. Unpredictable recipient receipts release transport credit only after the recipient receives a packet. Reliable traffic has bounded control reserve; live traffic has a separate window negotiated with `liveWindow` (bounded by the public `PEER_RELAY_LIMITS`) and a bounded ordered local queue (1 MiB), so a multi-piece signal is paced by receipts instead of refused piece by piece; it is never retried, and expired signals are still dropped by Chronolog. WebSocket uses TCP, so dispatched live packets can still wait for TCP retransmission; signal expiry remains enforced by Chronolog.

Local credentials are checked on every packet. Full host/account policy has a 30-second admission lifetime. Idle sockets do not renew it or schedule authorization alarms: the next packet or receipt starts one shared policy check before any further forwarding. Its lease starts before the query, and every asynchronous boundary rechecks local credentials, the owner, socket membership and transport deadlines. Other traffic waits in arrival order in a transient queue whose byte/event budgets are derived from both peers’ public reliable and live windows. A five-second timeout, revocation, disconnect or overflow closes the session and discards queued traffic; a late policy result cannot reopen it. The underlying D1 query cannot be cancelled but its late result is ignored.

Pairing and stalled receipt deadlines are 30 seconds and a paired connection lasts at most one hour. These alarms remain even when account authorization is dormant. These are transport lifetimes; the session owns subsequent reconnects. The host does not decrypt, execute or durably store relayed application payloads, and the relay receives no application reader grant. WebSocket attachments contain only bounded transport metadata; an idle relay has no pending application promise or server timer.

The adapter supports invitation routes and already-open rendezvous channels. Raw discovery may also name HTTPS introduction endpoints for another explicitly supplied transport. `bootstrap()` reads host endpoint hints, `setBootstrap(value)` updates them, and an injected initial snapshot requires no HTTP read. Display links have no introduction permission.

## Qualification

The public `@tendriller/engine/testing` fixture supplies authenticated sockets through real workerd upgrades, including `relaySocket(channel,peerId,remotePeerId,lane)`. `hostTraffic` records HTTP requests/body bytes and separate SDP, invitation and relay upgrades/frame bytes. Snapshot it around ordinary application work to distinguish control requests from relayed ciphertext. Direct traffic continues when the host disappears; relayed traffic needs the relay and incurs host bandwidth. Release qualification must exercise the default native/browser starter over real RTC, exchange an authored operation and its materialized read, content and live signals, and measure no relay application payload after connection. Also force RTC failure to verify automatic fallback, cancellation, page-provider loss and shared/elected owner reattachment. Independent native/browser scenarios must report their actual selected transport, relay payload byte deltas and source revisions. Local Workerd/socket tests do not establish real Internet reachability or operating cost.
