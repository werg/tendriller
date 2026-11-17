# Peer rendezvous and explicit transports

Tendriller introduces authorized endpoints. Chronolog owns the authenticated
application connection, signed history, detached bodies, finality and ephemeral
signals. The default peer composition uses WebRTC through
`@chronolog/transport-webrtc`; it does not send application frames to Cloudflare.
See [the ownership design](PEER_ARCHITECTURE.md).

For a cold connection to a reachable resident, the initial page configuration can
name that peer's HTTPS offer/answer endpoint. Chronolog owns that introduction
and the resulting WebRTC connection; Tendriller need not participate. The
short-lived host rendezvous below requires both endpoints to join together. It
does not discover or wake an offline resident, and applications must not use
repeated empty sessions as a background polling mechanism.

## Short-lived rendezvous

```js
// Browser page; native agents use client.peers.rendezvous with their agent token.
const signaling = tendril.peers.rendezvous(channelId, endpointId);
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
`tendril.peers.initialBootstrap` to select a resident without another host
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
