# Peer applications: replaceable peers and a quiet host

**Implementation status:** the hosted generation-control registry, lifecycle API
and portable authority verifier are implemented. Chronolog now supplies an
encrypted replica and public session with native/browser entries, framed network
transport, maintained RTC integration and a generation-specific Tendriller adapter.
The host's public HTTP controls, discovery, invitations and rendezvous run in
actual workerd tests. Independent packed native RTC scenarios cover lost replies,
selected-prefix recovery, fresh peers and returning branches. See the
[paired qualification record](https://github.com/werg/tendriller-contrib/blob/feat/chronolog-application-log/cookbooks/run-a-peer-application/notes/peer-generation-qualification.md) for exact archive/source identities
and the separate actual-host gate. Browser storage, deployed login, Internet
routes, relay cost and recovery freshness require their own measured evidence.
Generation sessions expose `applied()` for execution in the selected history and
`shared()` for retained-prefix coverage. Recovery can abandon a recent applied
suffix. `final()` belongs only to profiles that provide irreversible outcomes;
it is neither a synonym nor a planned rename for generation-scoped application.

## Ownership and trust

A peer application selects one authenticated Chronolog history profile. The
adopted target `peer-generation-v1` delegates ordering to a replaceable coordinating
peer. Browser, agent and optional native processes are ordinary participants.
The creator is not a permanent authority, and a long-running process gains no
administrative or finality rights merely by remaining online.

Chronolog owns original signed attempts, deterministic generation order,
execution, operation identity, replication, retained coverage, recovery and
coherent views. Authoring, sequencing, recovery and administration are separate
rights checked by one portable verifier. Signed original attempts remain bound
to their admission generation and permissions.

Tendriller projects signed Chronolog page-code publications to immutable hosted
assets. It owns account integration, enrollment bindings, bounded
routing hints, SDP introductions and a small durable generation/control registry.
It embeds Chronolog's portable verifier and closed participant transport policy.
One `peers/participant` exchange carries controls, signed code publication,
discovery and bounded connection invitations. The same policy rejects ordinary
database, content and live UI messages before client HTTP or server dispatch. The control trust root is retained
independently of any coordinating device or page publication. It never executes
application SQL or accepts commands in the generation registry.

The signed controls declare Tendriller's own participant as recovery and control
administration only. It has no data, authoring or coordination rights. An owner
can use this explicit role to recover after device-key loss; ordinary participant
grants come from Chronolog's shared policy helper. Data membership and data
administration remain independent of the coordinator role.

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

An explicit hibernatable invitation listener makes a peer reachable for later
joins without repeatedly opening empty rendezvous sessions. Chronolog owns its
availability lifecycle and coarse lease refreshes, independent of application
commands. Availability requests and handshake traffic have separate counters;
the host never subscribes to ordinary edits through this control role.

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
host operations remain available. `application.available` and `application.ready()` mean an
adapter is installed; actual session readiness and recovery remain separate.
The generation backend exposes `status` and `onStatus()` for actual ready,
waiting, recovering, awaiting-keys and closed phases, with coordinator/follower role, selected
generation and authenticated synchronized peer count. Observing status starts no
timer or host request.
`tendril.kind` distinguishes the peer and Cloudflare runtime surfaces. Peer pages
have no hosted `connected`, `presence`, data, outbox or notification members.
Explicit host calls live under `tendril.host`; application status comes from the
installed session, and the local device label carries no authority.

The generation backend contract uses `applied` and contains a selected generation and one
coherent revision for SQL, events and outcomes. It has no `finalRevision`.
Operations distinguish saved, applied and abandoned work. Recovery emits an
explicit coherent reset; stale event cursors cannot pretend an excluded history
is append-only. The public session supplies `query`, `readView` and `changes`.
`createPeerGenerationApplicationBackend` from `@chronolog/peer-session/tendriller`
binds an owned native or Worker session to this interface. Install it once with
`tendril.application.install(backend)` and install the session's live port
separately. See
[application backends](APPLICATION_BACKENDS.md).

Agents use their own Chronolog session for application description, coherent
query, command, operation wait, changes and recovery inspection. The host MCP
supplies publication and explicit lifecycle controls, with no application proxy
or second retry journal.

## Historical implementation and evidence

Existing chronological packages retain their authenticated guarantees and original
evidence. The selected-history profile makes recovery and possible suffix loss explicit.
Effects need recovery-aware journaling and reconciliation; protect their complete
prerequisites only when the application requires survival of that recovery.

Qualification records distinguish protocol models, loopback, actual
browser/native/workerd runs and deployed networks. Ordinary-command host traffic
must be measured as zero after establishment, including with the host blocked.
Recovery freshness, abandoned work, storage limits and route costs need their own
workloads. Loopback evidence does not establish Internet success or billed savings.
