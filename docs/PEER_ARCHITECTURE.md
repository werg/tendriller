# Peer applications: replaceable peers and a quiet host

**Implementation status:** the hosted generation-control registry, lifecycle API
and portable authority verifier are implemented. The generation-scoped replica,
command data path and browser/native session described below remain target
architecture. Their recovery and host-outage guarantees are not yet qualified by
a shipped session. The [current application backends](APPLICATION_BACKENDS.md)
retain their chronological `local` / `final` contract; adding host controls does
not change those histories or install a peer-generation runtime.

## Ownership and trust

A peer application selects one authenticated Chronolog history profile. The
proposed default `peer-generation-v1` delegates ordering to a replaceable coordinating
peer. Browser, agent and optional native processes are ordinary participants.
The creator is not a permanent authority, and a long-running process gains no
administrative or finality rights merely by remaining online.

Chronolog owns original signed attempts, deterministic generation order,
execution, operation identity, replication, retained coverage, recovery and
coherent views. Authoring, sequencing, recovery and administration are separate
rights checked by one portable verifier. Signed original attempts remain bound
to their admission generation and permissions.

Tendriller owns publication, account integration, enrollment bindings, bounded
routing hints, SDP introductions and a small durable generation/control registry.
It embeds Chronolog's portable verifier. The control trust root is retained
independently of any coordinating device or page publication. It never executes
application SQL or accepts commands in the generation registry.

See [peer generation controls](PEER_GENERATIONS.md) and the normative
[Chronolog ADR](https://github.com/werg/chronolog-db/blob/feat/portable-peer-core/docs/peer-generation-v1.md).

## Ordinary command path

The author durably retains its exact signed attempt and submits it to the selected
coordinating peer. That peer verifies authorship and permissions, persists the
ordered record and required bytes, and replies with a generation-scoped receipt.
Peers verify receipts and independently apply the same sequence. Original author
timestamps remain provenance; the generation sequence determines execution order.

Background peer replication improves recovery freshness. A second retained copy
is a resilience target and does not block a single available peer's ordinary
commands. Sharing evidence is separate from an applied result and does not make
it irreversible.

Commands, reads, signals and replication in an established generation require no
host request, hosted append, hosted body copy or finality certificate. There is no
periodic control lease renewal. A healthy current generation continues while all
host endpoints are unavailable.

## Recovery and controls

At creation, clean handover, crash takeover or restrictive policy activation,
Chronolog submits a signed transition to the host. The host atomically selects
one successor using expected-generation compare-and-swap. Exact retries recover
the original selection after lost replies or restart. It verifies requester
recovery rights separately from candidate coordination rights and account login.

A successor may adopt an earlier **complete prefix of selected history**. Missing
recent work is exposed as abandoned, with its original evidence retained for
inspection. Once a generation excludes a suffix, later successors cannot
readopt it merely because an old peer returns with valid signatures. Deliberate
reapplication creates a new attempt with current guards and permissions.

The session validates complete retained data and execution before offering a
recovery point. The host verifies ancestry and policy, not unseen SQL execution.
An unusable head requires an earlier complete source or an explicit unavailable
result. No surviving state means no silent empty replacement.

Control revisions remain monotonic even when an application tail is abandoned.
Revocation and key rotation activate at generation boundaries. Protected floors
prevent recovery below required administrative or stronger-action state. Applied
application events do not automatically authorize irreversible external effects.

Cached control permits a partitioned old coordinator to keep producing an old
branch until it learns of selection. That branch is quarantined on reunion. If
both coordinator and host are unavailable, peers retain local work while a new
authoritative selection waits. This profile trusts the control authority and
coordinator within their declared roles; it is not Byzantine consensus.

## Discovery and transport

Ordinary peers advertise bounded expiring route/profile/coverage hints through
`peers.advertise()`. Join and reconnect use explicit `peers.discover()` calls.
Identical refreshes are coalesced; no directory timer is installed by the client,
and directory expiry creates no host wakeup. Account authentication protects
advertisement ownership, while Chronolog independently verifies actual peer
identity, authority and retained bytes.

`@chronolog/transport-webrtc` owns reliable history framing and independent live
signals. Existing bounded pairwise rendezvous exchanges one complete offer and
answer, then closes the host sockets. Optional HTTPS introduction endpoints are
replaceable routes. STUN/TURN are explicit deployment inputs; relay traffic and
cost must be reported separately. An RTC handshake is not proof of a direct route
or synchronized application state.

Chronolog owns bounded connection supervision, late-completion fencing,
reconnection, storage ownership and session cleanup. The application author
supplies domain commands, guards, permissions and UI rather than protocol queues.
Application data never falls back to the hosted JSON backend implicitly.

## Browser and agent interfaces

Peer pages start no hosted application socket, application outbox, heartbeat,
console forwarding, automatic health report or background host polling. Explicit
host operations remain available. `application.available` and `ready()` mean an
adapter is installed; actual session readiness and recovery remain separate.
`tendril.connected` describes the hosted application connection and stays false
in peer mode.

The proposed generation session's default view is `applied` and contains a selected generation and one
coherent revision for SQL, events and outcomes. It has no `finalRevision`.
Operations distinguish saved, applied and abandoned work. Recovery emits an
explicit coherent reset; stale event cursors cannot pretend an excluded history
is append-only. See [application backends](APPLICATION_BACKENDS.md).

Agents use their own Chronolog session for application description, coherent
query, command, operation wait, changes and recovery inspection. The host MCP
supplies publication and explicit lifecycle controls, with no application proxy
or second retry journal.

## Optional profiles and evidence

Existing chronological/finality profiles retain their authenticated guarantees
and portable membership administration. Stronger settlement, hosted archival,
protected effects and optional native services are separately selected
capabilities. They are not prerequisites for generation-scoped collaboration.

Qualification records distinguish protocol models, loopback, actual
browser/native/workerd runs and deployed networks. Ordinary-command host traffic
must be measured as zero after establishment, including with the host blocked.
Recovery freshness, abandoned work, storage limits and route costs need their own
workloads. Loopback evidence does not establish Internet success or billed savings.
