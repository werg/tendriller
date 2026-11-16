# Peer applications: a quiet host and an authenticated data plane

## Ownership

A peer page has one application owner: its Chronolog replica. Chronolog owns
signed operations, durable retry identity, authenticated history, deterministic
execution, inclusion finality, governance, detached bodies and ephemeral
application signals. Changing the network route must not change those rules.

Tendriller serves immutable page assets, authenticates accounts, administers
participant changes and provides short-lived rendezvous. These responsibilities
do not require the host to relay application traffic or to keep an idle browser
connected to a Durable Object.

## Connection setup

A newly opened page can contact an explicitly configured HTTPS introduction
endpoint on a reachable resident Chronolog peer. That endpoint exchanges one
offer and answer, then the authenticated application connection uses WebRTC.
The page configuration supplies the address; the resident does not poll
Cloudflare or keep reconnecting to an empty rendezvous to discover callers.

Tendriller's bounded rendezvous is an optional introduction path when the
application can arrange for both endpoints to participate at the same time:

1. Two authorized endpoints join a named rendezvous with distinct endpoint IDs.
2. The host assigns a fresh session and complementary offerer/answerer roles.
3. Each endpoint sends one bounded, fully gathered WebRTC description. The host
   validates its role, session, size and current host access before delivery.
4. After the offer and answer are delivered, rendezvous closes. It is not an
   application channel, an ICE heartbeat service or a persistent presence feed.
5. Chronolog mutually authenticates the resulting reliable data channel using
   active reader capabilities, then exchanges its existing signed records,
   detached bodies, finality evidence and authorized ephemeral signals.

An endpoint ID or authenticated host session is not a database capability.
Chronolog remains responsible for peer authorization and rechecking governance.
New participants or a failed connection require a fresh introduction through
the configured provider; already connected peers continue without the host.
An unreachable native peer needs an explicit wake/rendezvous provider or an
existing reachable peer. A transient pairing endpoint alone is not a resident
discovery service. An offline proposal retains
its original identity and is synchronized by Chronolog when a route returns.

## Transport boundary

`@chronolog/transport-webrtc` owns negotiation and bounded reliable framing. It
accepts a signaling port and a peer-connection implementation, so it does not
import Tendriller or Cloudflare. Browser and native peers use the same framed
Chronolog protocol. Keys, storage and materialization remain with the owning
replica, including the browser's exclusive storage Worker.

STUN and TURN are deployment configuration. A TURN relay must be reported as a
relay; a successful WebRTC handshake alone is not evidence of a direct route.
An explicitly configured native WebSocket remains a transport option. There is
no automatic Cloudflare application-frame fallback.

## Browser host runtime

A peer page must not start the hosted application socket, heartbeats, diagnostic
outbox, log forwarding, automatic health reports or background host polling.
Application readiness and progress come from the selected replica. Explicit
membership and publication requests remain host operations. Hosted pages retain
their separate hosted runtime and its existing behavior.

## Membership and finality

The host administrator is activated by participant operations, not by each
application proposal or peer frame. Its existing certified-history verifier
still checks the descriptors needed to establish governance when it is invoked;
this is not yet a sparse control-proof protocol. It never downloads detached
application bodies. Removing that scan would require a separately authenticated
control proof, not skipping validation of the shared ledger.

Inclusion/finality is a Chronolog policy. A resident finality peer may still be
needed for final results; removing Cloudflare from application traffic does not
make that policy unnecessary. Exact retries and deterministic author ordering
are unchanged by the choice of transport.

## Qualification

Qualification must exercise real browser/native WebRTC, authenticated Chronolog
traffic and a disconnected signaling service. The evidence must
distinguish connection-setup bytes from subsequent peer bytes, demonstrate
continued progress after host disconnection and enforce bounded queues and
session isolation. Network reachability and provider cost remain measured
deployment properties; loopback evidence does not establish Internet success
rates or billed savings.

This is a breaking pre-release protocol. There is no migration or compatibility
alias for the former hosted peer relay.
