# Peer applications: a quiet host and an authenticated data plane

## Ownership

A peer page using the default live profile has one application owner: its
Chronolog replica. That profile owns signed operations, durable retry identity,
authenticated history, deterministic execution, inclusion finality, governance
and detached bodies. This document describes its Tendriller integration. The
separate finality-free generation runtime is described under
[generation results](APPLICATION_BACKENDS.md#generation-runtime-and-result-contract);
installing the live adapter does not install that runtime. Live application
signals use a separate `send`/`subscribe` port; the default Chronolog composition
authorizes them with current topic rights without submitting them to the log.
The standalone signal channel can also run without a database. Changing the
network route must not change the selected authorization or durability rules.

Tendriller serves immutable page assets, authenticates accounts, administers
participant changes and provides short-lived rendezvous. These responsibilities
do not require the host to relay application traffic or to keep an idle browser
connected to a Durable Object.

## Connection setup

A newly opened page can contact an explicitly configured HTTPS introduction
endpoint on a reachable resident Chronolog peer. That endpoint exchanges one
offer and answer, then the authenticated application connection uses WebRTC.
The page configuration supplies the address through the immutable
`tendril.peers.initialBootstrap` snapshot; no separate host discovery request is
needed. The resident does not poll
Cloudflare or keep reconnecting to an empty rendezvous to discover callers.

Tendriller's bounded rendezvous is an optional introduction path when the
application can arrange for both endpoints to participate at the same time:

1. Two authorized endpoints join a named rendezvous with distinct endpoint IDs.
2. The host assigns a fresh session and complementary offerer/answerer roles.
3. Each endpoint sends one bounded, fully gathered WebRTC description. The host
   validates its role, session, size and current host access before delivery.
4. After the offer and answer are delivered, rendezvous closes. It is not an
   application channel, an ICE heartbeat service or a persistent presence feed.
5. Chronolog mutually authenticates the resulting connection using active reader
   capabilities. Signed records, detached bodies and finality evidence use the
   reliable history lane. Authorized ephemeral signals use a separate lossy live
   lane with bounded queues; they do not wait behind retained-history traffic.

An endpoint ID or authenticated host session is not a database capability.
Chronolog remains responsible for peer authorization and rechecking governance.
New participants or a failed connection require a fresh introduction through
the configured provider; already connected peers continue without the host.
An unreachable native peer needs an explicit wake/rendezvous provider or an
existing reachable peer. A transient pairing endpoint alone is not a resident
discovery service. An offline proposal retains
its original identity and is synchronized by Chronolog when a route returns.

Chronolog owns connection supervision as well as individual negotiation. A
supervisor permits one attempt and one active session, fences late completions,
uses explicit bounded retry/backoff, and performs no polling while connected.
The browser composition ties each transferred channel to its owning Worker and
waits for authenticated attachment separately from transport establishment.
An established session remains independent of the introduction listener.

## Transport boundary

`@chronolog/transport-webrtc` owns negotiation, bounded reliable history framing
and a separate live lane. It
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

Membership administration, finality signing, schema administration, row ownership
and agent execution are independent roles. The resident process may compose some
of them, but no role implicitly receives the others' powers. See the
[role and finality contract](APPLICATION_BACKENDS.md#finality-and-authority).

The host administrator is activated by participant operations, not by each
application proposal or peer frame. It verifies a complete compact control
projection authenticated by a signed finality closure. The commitment binds
control count/order, original receipt bytes and activation cutoffs. Full replicas
recompute the projection while checking the entire ledger. The administrator
downloads no application descriptors or bodies and retains control history plus
its checkpoint. Participant synchronization therefore scales with governance
changes rather than all intervening application writes. See
[membership proofs and trust](MEMBERSHIP.md).

The live profile's inclusion/finality is a Chronolog policy. A resident finality peer may still be
needed for final results; removing Cloudflare from application traffic does not
make that policy unnecessary. Exact retries and deterministic author ordering
are unchanged by the choice of transport.

## Qualification

Qualification of this live integration must exercise real browser/native WebRTC, authenticated Chronolog
traffic and a disconnected signaling service. The evidence must
distinguish connection-setup bytes from subsequent peer bytes, demonstrate
continued progress after host disconnection and enforce bounded queues and
session isolation. Network reachability and provider cost remain measured
deployment properties; loopback evidence does not establish Internet success
rates or billed savings.

This is a breaking pre-release protocol. There is no migration or compatibility
alias for the former hosted peer relay.
