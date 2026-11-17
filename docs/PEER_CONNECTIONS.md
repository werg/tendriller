# Peer rendezvous and explicit transports

Tendriller introduces authorized endpoints. Chronolog owns the authenticated
application connection, signed history, detached bodies, recovery and ephemeral
signals. The default peer composition uses WebRTC through
`@chronolog/transport-webrtc`; it does not send application frames to Cloudflare.
See [the ownership design](PEER_ARCHITECTURE.md).

For a cold connection to a reachable resident, the initial page configuration can
name that peer's HTTPS offer/answer endpoint. Chronolog owns that introduction
and the resulting WebRTC connection; Tendriller need not participate. The
short-lived host rendezvous below requires both endpoints to join together. It
does not discover or wake an offline resident, and applications must not use
repeated empty sessions as a background polling mechanism.
Use the hibernatable invitation listener below for available peers that must
accept later joins; its lifecycle is separate from an established RTC data path.

## Short-lived rendezvous

```js
// Browser page; native agents use client.peers.rendezvous with their agent token.
const signaling = tendril.host.peers.rendezvous(channelId, endpointId);
const { role, session } = await signaling.ready;

// The application composition owns this dependency, outside the Tendriller runtime.
const rtc = await negotiateWebRtc({ role, signaling, onDataChannels(channels) {
  // Transfer both immediately: the exclusive replica Worker owns their bytes.
  replicaWorker.postMessage({ type: 'peer-channels', channels },
    [channels.reliable, channels.live]);
} });
```

`negotiateWebRtc` comes from `@chronolog/transport-webrtc`. The Worker uses
`frameRtcPeerChannels(channels)` to keep ordered reliable history separate from
unordered, unretransmitted live messages. One peer session authenticates both
lanes and its Chronolog reader capabilities before attaching to the existing
replica. Live loss or congestion does not stall reliable history. Never put private keys
in the page's signaling messages. A host account, endpoint ID, session ID or
channel name is not a database grant.

`PeerRendezvous` exposes `ready`, `messages`, `send(description)`, `close()` and a
read-only `stats` snapshot. `ready` resolves to a fresh session ID and a server
assigned `offerer` or `answerer` role. `messages` has one active reader and yields
one remote `{type:'offer'|'answer',sdp}`. Each endpoint sends exactly one fully
gathered description for its role. After both descriptions have been delivered,
the host sends completion and closes both sockets. WebRTC and the replica remain
independent of that closure. There are no signaling heartbeats or application
frames. A connection failure requires a new rendezvous.

`rendezvous(channel,peerId,{signal?,timeoutMs?,socket?})` accepts cancellation and
an optional WebSocket factory for native hosts. IDs are 1–160 characters from
letters, numbers, underscore, dot, colon and hyphen. Use a new unpredictable
channel for each intended pair and share it through the participant composition.
A channel admits exactly two distinct endpoints; later reuse has a new session.
Old messages and close callbacks cannot affect the replacement pair.

The public route is `peers/rendezvous?channel=<id>&peerId=<id>` under the agent API
or the page's `_tendril/` prefix. Its subprotocol is `tendriller.rendezvous.v1`.
The SDK puts private agent tokens in the TLS-protected subprotocol header, never
in URLs. Page cookies and origin policy are enforced normally. Local credentials
and both accounts are checked again before description delivery, including after
asynchronous authorization. Host authorization is separate from Chronolog's
active reader/writer capability checks.

| Resource | Bound |
| --- | --- |
| Complete SDP description | 64 KiB of UTF-8 |
| JSON wire message | 128 KiB |
| Description sends per endpoint | One |
| Concurrent pending authorization per endpoint | One |
| Concurrent rendezvous endpoints per page | 32 |
| Rendezvous lifetime, including waiting for a partner | 60 seconds |
| Optional bootstrap endpoints | Eight |

The Durable Object alarm expires abandoned introductions, including clients
that never run a timeout. Completed sessions retain no SDP or application data.
`stats` counts actual encoded signaling bytes and description counts; it does not
measure RTC bytes, TLS overhead or provider billing. Binary application frames,
wrong roles, duplicate descriptions and stale sessions fail closed. There is no
hosted `peers/socket` relay or protocol compatibility alias.

## Bootstrap hints and transport ownership

`peers.setBootstrap({version:2,endpoints:[{url}]})` stores up to eight distinct
resident HTTPS introduction addresses. HTTPS is required except for loopback
HTTP development. Credentials, query strings, fragments, route claims and the
former WebSocket hint shape are rejected. Introduction addresses do not carry
application grants or keys and do not predict which ICE route will be selected.

The initial peer HTML embeds the current configuration. Read
`tendril.host.peers.initialBootstrap` to select a resident without another host
request; the snapshot and its endpoints are immutable. A running connection or
its recovery uses that snapshot and contacts the resident directly. Only the
owner or an agent may replace hints. Authorized nondisplay page identities may
explicitly call `peers.bootstrap()` to fetch a fresh snapshot. Display pages
receive no introduction configuration. Native clients without an injected
snapshot expose `initialBootstrap: null`.

Authored assets retain immutable publication caching. Peer HTML is revalidated
on reload because its injected addresses may change independently of the
publication. There is no background configuration refresh or discovery poll.

Application framing belongs to the selected peer transport. Tendriller exports
no binary application connection, record/signal multiplexing, fragmentation or
relay protocol. Use Chronolog's native framing or
`@chronolog/transport-webrtc` directly. This keeps all application bounds,
reader authentication and reconnection behavior in one implementation.


## Runtime and route policy

A peer page starts no ordinary host application socket, outbox, log forwarding,
health reports or background polls. Membership and publication requests are
explicit. `publication.saveOffline()` explicitly installs offline publication
support. Application readiness belongs to the selected backend; it does not
assert that an Internet route or a finality provider is currently available.

Configure ICE servers at deployment. STUN assists establishment; TURN is an
explicit relay option whose traffic must be counted and reported as relayed.
There is no automatic Cloudflare application-frame fallback. Existing direct
WebSocket deployments and other transports can still attach to the same
Chronolog authenticated protocol without changing application ownership.

## Qualification

The host tests exercise actual workerd account authorization, bounded exchange,
role/session rejection, expiration, disconnection, and zero retained application
records. Runtime tests verify no implicit host activity. Chronolog/contrib own
real browser/native WebRTC and complete task/chat qualification, including work
performed after signaling is disabled and exact original operation retries.

Keep local fixture reports scoped to their exact sources and transport. Internet
NAT reachability, TURN usage, billed provider cost and reconnect performance need
measurements on the deployed networks. The former binary-relay reports remain
historical evidence for their original revisions.

## Ordinary-peer discovery

Peer applications can use `tendril.host.peers` (or the SDK's `peers`) without a permanently reachable resident introduction service. The host offers a bounded authenticated directory:

```js
const availability = await tendril.host.peers.advertise({
  peerId: device.peerId,
  storageId: device.storageId,
  profiles: ['peer-generation-v1'],
  routes: [{ kind: 'invitation', peerId: device.id }],
  coordinatorEligible: true,
});
const directory = await tendril.host.peers.discover();
// Pass hints to the Chronolog session. It authenticates peers and verifies authority.
await tendril.host.peers.withdraw(device.peerId);
```

An advertisement expires after two minutes by default (30 seconds to ten minutes is supported). `refreshAfter` identifies the coalescing boundary: identical early advertisements return the same lease without a storage write. Discovery is explicit on join or reconnect. Constructing the client starts no timer, polling, heartbeat, or host connection. Healthy peer sessions continue when the directory is unavailable.

Each application retains at most 64 active advertisements and each host principal at most eight. Withdrawal, credential revocation, or expiration removes the route from results. Two tabs advertising the same `storageId` are one storage owner for retention purposes. HTTPS introduction routes must not include credentials, query parameters, or fragments; rendezvous routes name bounded channels.

## Invitations for late joins

An available peer explicitly opens `peers.listenInvitations(peerId, { signal? })`
and advertises `{ kind: 'invitation', peerId }`. The returned listener has `ready`,
`closed`, `invitations`, `stats` and `close()`. It can hibernate with no heartbeat,
expiration alarm or idle HTTP requests. A new peer calls
`peers.invite(targetPeerId, { channel, requesterPeerId })` with a fresh random
channel. Both endpoints then join the existing bounded `rendezvous` protocol.
They authenticate the application peer independently; an invitation identity is
only a connection hint.

The host keeps at most 64 listeners per application and eight per host principal.
Each listener has at most eight unconsumed invitations and accepts at most 32 new
invitations per minute. Consuming a hint acknowledges its queue slot. Exact
invitation retries within the rate window are coalesced. Extra application fields,
binary frames and arbitrary messages are rejected. A replaced, revoked or closed
listener cannot receive later invitations prepared against its former identity.
Listeners use GET `peers/invitations` with the `tendriller.invitations.v1`
WebSocket subprotocol. Sending an invitation uses `ephemeral.invite` through
POST `peers/participant`.

Chronolog's maintained session owns listener reopening, bounded parallel
negotiations and coarse advertisement renewal at `refreshAfter`. A ten-minute
lease permits five-minute refreshes, independent of commands. Directory lookups
occur on join or reconnect. Account separately for this availability traffic,
new connection signaling and any relay bytes; ordinary commands, queries,
signals and replication do not call these endpoints.

Profile compatibility, `coordinatorEligible`, and optional retained-prefix coverage are **untrusted routing hints**. A page login, largest advertised sequence, or directory entry grants no authoring, recovery, or sequencing power. Chronolog verifies the signed application descriptor, selected generation, original author, and retained bytes independently. The directory contains no command, application body, SQL state, or per-object inventory. Applications should coalesce coverage updates with availability changes instead of advertising each edit.

The directory uses the `discovery.read`, `discovery.advertise` and `discovery.withdraw` actions through `POST peers/participant` on both authenticated page and agent routes. These requests carry the explicit 32-byte application identity; the SDK domain methods preserve this scope. Only the participant that owns an active advertisement may update or withdraw it. The host performs no fetch to an advertised route.
