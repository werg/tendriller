# Owned peer participation

Chronolog owns authenticated connections, reconnect grace, coordinator selection, freshness checks and recovery. Tendriller supplies bounded discovery and connection introductions through a thin adapter. Applications install one participation controller instead of assembling those mechanisms themselves.

## Connect the host adapter

```js
import { createPeerIntroductions } from '@tendriller/core/peers';

const control = session.connectControlParticipant({
  exchange: (message, options) => host.peers.exchange(message, options),
});
const participation = await session.participate({
  control,
  ...createPeerIntroductions({
    peers: host.peers,
    identity: session.deviceId,
    openConnection,
  }),
});
```

`openConnection` is the environment's raw RTC opener. Native applications pass `openWebRtcConnection` from `@chronolog/peer-session/webrtc`, optionally wrapping it to supply their native `createPeerConnection` factory. Browser applications use `openWorkerWebRtcConnection` with the owned Worker endpoint; the page's `serveWorkerWebRtcConnections` bridge performs browser RTC mechanics while authentication and application state stay in the Worker.

The adapter creates no identity, retry timer, heartbeat, election or recovery policy. It translates host directory entries and invitations into connection hints, pairs SDP through the host, and closes signaling after opening a raw connection. Chronolog then authenticates the expected signing identity and owns the resulting connection. Cancellation closes pending introductions, listeners and late connections.

## Observe and approve recovery

The controller exposes `status`, `onStatus`, `signal`, `approveRecovery(proposalId)` and `close()`. Its status distinguishes connection work, following, coordination, recovery, unavailable peers and an approval request. The session closes its controller with its other resources.

The controller reads current signed grants and authenticated peer evidence. Advertisements cannot grant coordination or recovery rights. A reconnect grace period permits a healthy coordinator to return. Recovery outside the configured freshness budget, or without a known observation, requires the displayed proposal to be approved. Approval is tied to that exact proposal; changed authority invalidates it. Application code presents that decision and the resulting loss/reapply notices.

Ordinary commands, queries, content and live signals use peer connections. The controller may renew a coarse discovery lease; it does not turn each application update into a host request. Its availability and recovery timers are owned centrally by Chronolog.

## Host transport primitives

`host.peers.discover()`, `advertise(advertisement)` and `withdraw(peerId)` use the shared participant discovery facet. An advertisement contains exactly `{peerId,storageId,routes}`. These bounded, expiring routing hints carry no execution profiles, eligibility claims, recovery proofs, application commands or secrets. Independent retained coverage is verified after connection.

`listenInvitations(peerId)` opens a hibernatable host socket without a heartbeat. `invite(peerId,{channel,requesterPeerId})` sends one small `ephemeral/invite` action. Pending requests are bounded, coalesced and acknowledged when consumed. Revoked credentials and cancellation close the listener.

`rendezvous(channel,peerId)` pairs authorized participants. Its `ready` result assigns offerer or answerer; callers must use that result. Each sends one complete bounded SDP description and the exchange closes. Binary frames, repeated descriptions, role confusion, foreign session IDs and expired pairs are rejected. `createPeerIntroductions` handles these details for the owned controller.

The adapter supports invitation routes and already-open rendezvous channels. Raw discovery may also name HTTPS introduction endpoints for another explicitly supplied transport. `bootstrap()` reads host endpoint hints, `setBootstrap(value)` updates them, and an injected initial snapshot requires no HTTP read. Display links have no introduction permission.

## Qualification

The public `@tendriller/engine/testing` fixture supplies authenticated sockets through real workerd upgrades. `hostTraffic` records HTTP requests/body bytes and separate SDP/invitation frames. Snapshot it around ordinary application work to distinguish data-plane traffic from explicit lifecycle work. Independent native/browser RTC scenarios qualify the real host, session controller, recovery and signed page code together.
