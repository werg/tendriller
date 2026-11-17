# Peer introductions

Chronolog owns authenticated peer connections and application replication. Tendriller offers bounded introductions so participants can find and reach one another without a permanent broker carrying ordinary traffic.

## Bootstrap and discovery

`host.peers.bootstrap()` reads bounded HTTPS introduction endpoint hints; `setBootstrap(value)` updates them explicitly. The initial page configuration may carry an immutable bootstrap snapshot. Reading that snapshot performs no HTTP. Display links do not receive peer-introduction permission.

`discover()`, `advertise(advertisement)` and `withdraw(peerId)` use the shared participant discovery facet. Records are bounded and expiring. Advertisements name peer/storage identity, routing hints and optional authenticated-history claims to verify after connection. They contain no application commands, secrets or authority grants. Duplicate healthy advertisements are coalesced; no background polling loop is installed.

## Quiet invitations

`listenInvitations(peerId)` opens a hibernatable host socket. It sends no heartbeat and installs no expiry-refresh polling. `invite(peerId,{channel,requesterPeerId})` sends one small introduction request through the allowed `ephemeral/invite` action. Duplicate pending requests are coalesced and acknowledged when consumed. Bounded pending queues, cancellation and revoked credentials have explicit outcomes.

## SDP rendezvous

`rendezvous(channel,peerId)` pairs authorized participants. The first participant offers and the second answers. Each sends one complete bounded SDP description; the exchange then closes. It rejects binary frames, repeated descriptions, role confusion, foreign session IDs and expired pairs. This is a connection setup service, not a generic peer transport.

Pass the resulting descriptions to the session's maintained RTC transport. The session verifies peer authority and owns connection lifecycle, replication, flow control and application facets. The host never infers authority from a discovery hint or SDP exchange.

## Testing

The public `@tendriller/engine/testing` fixture provides authenticated agent, owner and participant rendezvous/invitation sockets through real workerd upgrades. `hostTraffic` measures HTTP requests/body bytes and separate SDP/invitation frames. Snapshot it around ordinary commands, queries, signals and replication to establish whether application work contacted the host. Independent native/browser RTC qualification belongs alongside this actual host fixture.
