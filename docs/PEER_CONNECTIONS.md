# Owned peer participation

Chronolog owns authenticated connections, reconnect grace, coordinator selection, freshness checks and recovery. Tendriller supplies bounded discovery, direct connection introductions and an opaque WebSocket relay through one adapter. Applications install one participation controller.

## Connect the host adapter

```js
import { createPeerIntroductions } from '@tendriller/core/peers';
import { openWebSocketConnection } from '@chronolog/peer-session/websocket';

const control = session.connectControlParticipant({
  exchange: (message, options) => host.peers.exchange(message, options),
});
const participation = await session.participate({
  control,
  ...createPeerIntroductions({
    peers: host.peers,
    identity: session.deviceId,
    openDirectConnection,
    openRelayConnection: ({ relay, signal }) => openWebSocketConnection(relay, { ready: relay.ready, signal }),
  }),
});
```

`openDirectConnection` is the environment's raw RTC opener. Native applications pass `openWebRtcConnection` from `@chronolog/peer-session/webrtc`, optionally wrapping it to supply their native `createPeerConnection` factory. Browser applications use `openWorkerWebRtcConnection` with the owned Worker endpoint; the page's `serveWorkerWebRtcConnections` bridge performs browser RTC mechanics while authentication and application state stay in the Worker. The WebSocket opener runs directly in the session's native process or Worker.

One open attempt tries direct RTC for up to `directTimeoutMs` (default five seconds), then opens the relay with the same invitation channel and expected signing identities. It closes the direct attempt before falling back; a platform opener that ignores cancellation remains charged to the session's bounded physical-opening budget until it settles. An owner cancellation never starts a relay. Chronolog authenticates the expected signing identity and encrypts the same reliable and live peer channels above either transport. No TURN service is required for this fallback.

The adapter creates no identity, heartbeat, election, recovery policy or reconnect loop. It translates host directory entries and invitations into connection hints and retires SDP signaling after the direct attempt. The session remains the only owner of retries and recovery. Cancellation closes pending introductions, listeners and late connections.

## Observe and approve recovery

The controller exposes `status`, `onStatus`, `signal`, `approveRecovery(proposalId)` and `close()`. Its status distinguishes connection work, following, coordination, recovery, unavailable peers and an approval request. The session closes its controller with its other resources.

The controller reads current signed grants and authenticated peer evidence. Advertisements cannot grant coordination or recovery rights. A reconnect grace period permits a healthy coordinator to return. Recovery outside the configured freshness budget, or without a known observation, requires the displayed proposal to be approved. Approval is tied to that exact proposal; changed authority invalidates it. Application code presents that decision and the resulting loss/reapply notices.

Ordinary commands, queries, content and live signals use peer connections. The controller consumes required discovery notifications. A healthy idle participant
does not renew advertisements, scan the host directory or synchronize on a timer.
An initial connection or reconnect advertises once; directory changes and actual
application/link changes trigger the relevant work. Chronolog owns bounded
unavailable-peer retries and the explicit recovery grace/freshness decisions.

## Host transport primitives

`host.peers.discover()`, `advertise(advertisement)` and `withdraw(peerId)` use the shared participant discovery facet. An advertisement contains exactly `{peerId,storageId,routes}`. These bounded routing hints exist only while their authenticated discovery
WebSocket is connected. They carry no execution profiles, eligibility claims,
recovery proofs, application commands or secrets. Independent retained coverage is verified after connection.

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

The relay bounds packet size, outstanding bytes/packets, admission per principal and host, and packet rate. Unpredictable recipient receipts release transport credit only after the recipient receives a packet. Reliable traffic has bounded control reserve; live traffic has a separate one-packet window, drops under pressure and is never retried. WebSocket uses TCP, so dispatched live packets can still wait for TCP retransmission; signal expiry remains enforced by Chronolog.

Local credentials are checked on every packet. Full host/account policy has a 30-second admission lifetime. Idle sockets do not renew it or schedule authorization alarms: the next packet or receipt starts one shared policy check before any further forwarding. Its lease starts before the query, and every asynchronous boundary rechecks local credentials, the owner, socket membership and transport deadlines. Other traffic waits in arrival order in a transient queue bounded to 132 events and 1,213,440 bytes per session. A five-second timeout, revocation, disconnect or overflow closes the session and discards queued traffic; a late policy result cannot reopen it. The underlying D1 query cannot be cancelled but its late result is ignored.

Pairing and stalled receipt deadlines are 30 seconds and a paired connection lasts at most one hour. These alarms remain even when account authorization is dormant. These are transport lifetimes; the session owns subsequent reconnects. The host does not decrypt, execute or durably store relayed application payloads, and the relay receives no application reader grant. WebSocket attachments contain only bounded transport metadata; an idle relay has no pending application promise or server timer.

The adapter supports invitation routes and already-open rendezvous channels. Raw discovery may also name HTTPS introduction endpoints for another explicitly supplied transport. `bootstrap()` reads host endpoint hints, `setBootstrap(value)` updates them, and an injected initial snapshot requires no HTTP read. Display links have no introduction permission.

## Qualification

The public `@tendriller/engine/testing` fixture supplies authenticated sockets through real workerd upgrades, including `relaySocket(channel,peerId,remotePeerId,lane)`. `hostTraffic` records HTTP requests/body bytes and separate SDP, invitation and relay upgrades/frame bytes. Snapshot it around ordinary application work to distinguish control requests from relayed ciphertext. Direct traffic continues when the host disappears; relayed traffic needs the relay and incurs host bandwidth. Independent native/browser scenarios must report their selected transport and source revisions. Local Workerd/socket tests do not establish real Internet reachability or operating cost.
