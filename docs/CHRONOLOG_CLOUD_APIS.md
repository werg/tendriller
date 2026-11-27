# Chronolog-managed cloud APIs

**Design proposal; not an implemented API or deployment service.** This refines
the [Cloud Computation package](CLOUD_ACTIONS.md). Source findings refer to the
clean Chronolog commit pinned by this repository,
[`9df55f0358482a71308cf3b1f235429d66b39a3b`](https://github.com/werg/chronolog/commit/9df55f0358482a71308cf3b1f235429d66b39a3b).

## Ownership

Chronolog owns the API definition, access roles and grants, executable code
versions, and the policy selecting which versions may run. Cloudflare Workers
are deployments of that state. A controller consumes verified Chronolog state,
reconciles deployments, and records signed receipts. It does not maintain a
second editable database of page permissions or code.

Tendriller retains infrastructure responsibilities: authenticating the transport,
mapping it to a signed Chronolog actor, provisioning resources already delegated
to the page, enforcing account entitlement and spending limits, and operating
credential brokers. A page cannot create a platform entitlement or access a
different owner's credential merely by writing an API role into its own log.
The resource owner must first delegate that bounded capability to the log.
Provisioning pins the trusted log identity and its initial governance; a caller
cannot substitute a new self-authorizing log. Recovery of that trust anchor is
an explicit infrastructure procedure, outside ordinary application permissions.

Keep reading data, editing code, approving activation, invoking an API, and using
an external connection as distinct permissions. A signed code update proves
provenance, not safe behavior. Give each executable only its approved inputs and
capabilities, even when the trusted participant supervising it can read more.

## Two server participation profiles

| Profile | State available to the server | Intended use |
| --- | --- | --- |
| Policy consumer | Verified public authorization state, its reducer/control dependencies, and deliberately supplied deployment artifacts; no private application keys. | Authenticate an API invocation or use a narrowly delegated integration. |
| Admitted application participant | A normal Chronolog session with explicitly granted read/write rights and keys, potentially the complete application state. | Stateful APIs, durable agents, background work, queries, and recovery while other devices are offline. |

The fully participating server is a first-class supported design target. It
uses the same reducers, canonical replay, and signed operations as other peers;
it does not become the source of operation order. Give it its own identity and
only the write rights it needs. Retain the original caller's signed intent when
the service performs a delegated action; do not impersonate that caller.

These profiles are independent of Workers for Platforms versus Dynamic Workers.
A trusted admitted participant can maintain state and orchestrate restricted
dynamic tasks. A customer agent can also receive its own intentionally granted
participant identity, subject to the same disclosure and delegation rules.

Full participation deliberately gives the executor access to the admitted data.
Read-only membership prevents writes but does not limit decryption to permission
metadata. Normal admission can share historical page epoch keys, and future key
rotation includes readers. A topic filter does not reduce that cryptographic
authority. A compartment-only participant needs separately qualified admission,
rotation, persistence, and revocation semantics.
Revocation prevents subsequent authorized access; it cannot erase plaintext or
keys a previously admitted participant has already obtained.

## Public and private state today

Chronolog supports public logs, private logs, named encrypted topic compartments,
and public/private content blobs. Public data remains signed and governed by
write permissions; public content does not automatically acquire an anonymous
HTTP endpoint or permanent storage.

For a private log, the current protocol recognizes exactly six public control
topics: `$reducers`, `$permissions`, `$keys`, `$finality`, `$publications`, and
`$signal_policy`. Other application operations are encrypted. A new `$` prefix
does not register a public control topic. There is no general per-SQL-row public
visibility toggle. Genesis and reducer code are public control material; private
initial data belongs in encrypted application operations, not plaintext genesis.
See the [control-topic definition](https://github.com/werg/chronolog/blob/9df55f0358482a71308cf3b1f235429d66b39a3b/packages/protocol/src/v2.ts)
and [session implementation](https://github.com/werg/chronolog/blob/9df55f0358482a71308cf3b1f235429d66b39a3b/packages/peer-session/src/session.ts).

An API-access topic can be an ordinary application topic today when the executor
is admitted to read it. Its reducer owns the API's roles and grants and consults
the page's root governance before accepting changes. Its policy can be expressed
with a reusable vanilla Chronolog module, with custom governance still possible.
API definitions refer to that policy contract rather than hard-coding one role
layout in the Tendriller server.

For a policy-only consumer of a private page, initially extend the existing
public `$permissions` policy or use a separate public policy log with an explicit
binding to the application. A first-class independently public API-access topic
requires a deliberate Chronolog protocol/runtime extension. Any generalized
visibility model must preserve dependency closure: a public policy cannot read
private application state, and filtering must not silently change its result.

## Code and API versions are Chronolog state

Define an immutable release manifest through signed operations. The following
are conceptual fields, not a new exported SDK schema:

- Stable API identity and immutable release/content identity.
- Source module graph, dependency lock, and exact deployable bundle references.
- Runtime/build compatibility settings and provenance of any derived bundle.
- Exported operations, request/response schemas, and required API-access roles.
- Connection/resource handles, requested capabilities, and resource ceilings.
- State-schema compatibility or an explicit migration/cutover plan.

Keep large source and bundle bytes in content-addressed blobs. Their hashes and
manifests are governed by Chronolog; they are not editable out-of-band deployment
settings. A recoverable release requires retention of the complete referenced
blob graph, not just its manifest. Raw external credentials remain in their
approved secret storage; the log contains opaque connection handles and grants.

Separate authored desired state from observed deployment receipts. An authorized
operation publishes or activates a release. The controller verifies the complete
artifact graph, prepares the Cloudflare deployment, checks readiness, and records
the observed release hash and result using its service identity. It reconciles
interruptions and uncertain provider responses with stable operation identities.
Reducer replay itself never deploys a Worker or calls a provider.

Publishing a release does not automatically activate it. A failed deployment
cannot appear as successfully active merely because its intended version exists
in the log. Retrying must preserve the source, bundle, policy basis, and operation
identity; it must never silently substitute a newer release.

Model activation explicitly: proposed, artifact-verified, approved, preparing or
draining, active, and retired. A transition may remain pending or fail without
changing the last working activation. Observed readiness is tied to the exact
manifest and execution targets; it is not inferred from a mutable version label.

## Historical availability and ordered cutover

Version retention, invocation availability, and cutover ordering are separate
policy choices, all governed by Chronolog:

| Choice | Meaning |
| --- | --- |
| Historical releases callable | Requests may name an explicitly allowed immutable release; an active/default alias can coexist with that allowlist. |
| Current release only | Only the active release accepts new work. Retained old code remains available for inspection or an explicit rollback, without remaining callable. |
| Admission cutover | Once activation is acknowledged, new work uses the new release; work already admitted under the old release may finish under the declared policy. |
| Strict effect cutover | Stop new old-version admissions, drain or reconcile old in-flight effects, then activate the next release and reject stale execution authority. |

Historical execution always uses **current authorization**. An old code version
must not restore an old membership list, expired connection grant, or revoked
role. Enforce authorization in the current trusted gateway/broker outside the
historical handler. Pin the exact release and policy/revision basis in each
invocation receipt and idempotency record. Retrying a completed operation may
return its existing receipt only after checking current receipt-access rights.
Code selection, permission, and activation identity come from one coherent
verified view. Recheck protected result delivery if the policy requires revoked
callers to lose access to results computed before revocation.

Historical availability also requires a compatible state contract: a maintained
adapter, a compatible current projection, or an explicitly selected historical
snapshot for permitted reads. Retaining old code does not make it compatible
with a later schema. Rolling back code does not undo migrations or external
effects; activation must reject an unsupported state contract.

For ordered transitions, each activation names the preceding activation and the
target immutable release. Chronolog's reducer/governance selects the effective
activation; the controller applies it. Use a stable activation identity as an
execution fence. A counter derived from provisional state can rewind after late
operations, so it is insufficient for a strict monotonic cutover guarantee.
Strict cutover requires a finalized activation whose identity and selected
manifest cannot be retroactively replaced by late operations under the chosen
finality policy. Activation order is explicit; semantic version labels are not
authority to decide which release supersedes another.
An explicit rollback is a new authorized activation of retained old code, not a
reuse of an old execution fence or revival of old permissions.
An application may instead choose a forward-only policy that forbids selecting
an earlier release even through rollback. Version retention does not override
that rule; recovery then needs a new approved release.

Fence every execution path: HTTP calls, scheduled jobs, webhook delivery, queue
consumers, retries, alarms, and broker effects. Reject stale authority at the
effect boundary, not only when a request is queued. Cancelling a request does
not prove an external provider stopped processing it. A strict cutover must wait
for such effects to settle or remain blocked on an uncertain outcome; it cannot
undo an effect already issued. Raw credentials in arbitrary customer code and
unmediated outbound paths cannot offer the same broker-enforced fencing guarantee.

Distinguish rejection by the broker from observation at an external provider.
An atomic broker check can stop newly admitted effects after cutover, but an old
HTTP request can still complete later. Guaranteeing that no old-version effect
becomes observable after a new one requires downstream conditional/fencing
support or a complete drain and reconciliation of outstanding effects.

If total ordering is intended for **all invocations across releases**, require
ordered committed execution intents and serialize their execution under an
explicit finality/coordination policy. Merely selecting one active version does
not serialize calls. This stronger mode trades concurrency and partition-time
availability for a defined effect order. It does not give a host or finalizer
authority to assign Chronolog's canonical operation order.
Choose the ordering scope explicitly: one API, one resource, or the whole
application. Ordered invocation admission alone does not order asynchronous
external completion. Finalized intents still need durable effect identities and
provider idempotency/reconciliation; they do not make arbitrary APIs exactly-once.

## Thin authorization and propagation

Tendriller already runs `TopicKernel({ blindHostMode: true })` over signed public
control operations in [authority.ts](../server/src/authority.ts). It materializes
the page's `$permissions` reducer without application epoch keys. The existing
projection exposes standard roles; it is not yet a generic cloud-API authorizer.

Peers already synchronize public control facts. Host changes produce an
authenticated `changed` notification over discovery WebSockets, after which
consumers pull and verify missing facts. See [admission](../session/admission.mjs),
[participation](../session/participation.mjs), and [discovery](../server/src/discovery.ts).
A webhook or queue is another delivery adapter for this pattern. A notification
invalidates a projection; it does not independently establish permission.

Chronolog also already exports
[`forwardSessionEvents`](https://github.com/werg/chronolog/blob/9df55f0358482a71308cf3b1f235429d66b39a3b/packages/peer-session/src/event-forwarder.ts):
topic filters, coherent local/final views, a durable outbox written before
delivery, stable event identities, and upserts/retractions for revised outcomes.
Reuse it where an event sink is useful. It is not a cryptographic proof that an
arbitrary topic subset is sufficient to replay policy, and it does not provide
exactly-once external effects. Start a verifying consumer with the complete
public control dependency set; fail closed on missing dependencies.

For each invocation, verify a signed actor/request binding covering the log/API,
release, operation, body digest, audience, expiry, and retained operation ID.
Evaluate the API's policy in a coherent Chronolog read view at trusted request
time. Require a strict allow result and retain its revision/finality basis.
Recheck on execution and privileged broker calls, including long-running jobs.
Combine that decision with the delegated resource ceiling and platform budget.

## Existing policy support and required hardening

Vanilla Chronolog supports custom `$permissions` reducers and a built-in query
`{check: 'scope', actor, scope, atMs}`. The current two-argument
`session.checkPermission(capability, actor)` does not forward scope/context/time;
cached role lists also do not enforce live expiry. A generic strict decision API
should use explicit trusted evaluation time and a coherent revision, and deny
when policy evaluation or required synchronization fails.

Before using built-in scoped membership for privileged external APIs, qualify
and harden admission and governance consistently. At the pinned version, the
attested-admission comparison does not constrain incoming scopes/expiry, while
multisig member storage/query paths do not preserve the same scope/expiry
semantics. These belong in the vanilla permission-policy contract and tests,
not in a second Tendriller ACL. A properly governed custom API-access reducer is
another valid path. See [standard policies](https://github.com/werg/chronolog/blob/9df55f0358482a71308cf3b1f235429d66b39a3b/packages/materializer/src/std-modules.ts)
and [permission queries](https://github.com/werg/chronolog/blob/9df55f0358482a71308cf3b1f235429d66b39a3b/packages/peer-session/src/session.ts).

## Persistence, freshness, and finality

An admitted server can recover from retained encrypted operations, snapshots,
and blobs, then materialize the same state as other peers. The required recovery
bundle includes genesis, signed facts or a qualified checkpoint path, reducer
code, the complete referenced CAS/blob graph, and the right keys. The current
blind mailbox and hosted-MCP snapshot are bounded caches; they are not a complete
general-purpose recovery service. See [hosted MCP](../server/src/mcp-participant.ts).

A snapshot hash proves content identity, not that its claimed permission state
was correctly derived or that no revocation is missing. Current materialized
cache restoration checks consistency with supplied facts but is not an
independent proof of a peer-uploaded reducer result. Verify authority through
signed facts and qualified replay/checkpoints; do not trust a cache's own claimed
root. A host public-control checkpoint does not certify private application state.

Define recovery as complete **as of a named verified revision**, with a durable
retention acknowledgment and explicit garbage-collection rules. An online server
cannot discover an operation still confined to an offline device. Consequently,
authorization uses the latest verified state known to its consumer under a stated
freshness contract, not an asserted globally latest state.

Late operations can revise provisional outcomes. For immediate revocation, define
effectiveness at the executing service's acknowledgment and fence subsequent
work; leases bound exposure during disconnection. For strict monotonic deployment
or irreversible ordered effects, choose a stable finalized activation/intent
policy and refuse execution when its freshness cannot be established. Finality
stabilizes the selected history under its trust model; it does not discover
offline operations. The host's current standard permission summary is not a
finalized permission view.

## Implementation sequence

1. Define and test a reusable vanilla Chronolog API definition/access/release
   model, with explicit actor, resource, time, revision, and finality semantics.
   Harden scoped admission and governance before relying on the built-in scopes.
2. Build an admitted participant/controller over ordinary application topics,
   retaining code and state completely enough to recover while peers are offline.
   Support current-only and explicitly allowed historical releases.
3. Add staged deployment, readiness receipts, idempotent reconciliation, and
   invocation/effect fencing; test concurrent promotions, rollback, stale workers,
   delayed revocations, and uncertain provider outcomes without weakening gates.
4. Expose the same model through a policy-only consumer using public policy facts.
   Generalize public topic/compartment subscriptions in Chronolog only with their
   dependency, confidentiality, and recovery invariants explicitly tested.

The present administration PR still implements only service-wide operator grants
and aggregate analytics. Its bootstrap operator credential delegates no page
membership or private-data access. A future admin tendril uses Chronolog policy
to control who may invoke its deliberately provisioned admin adapter.
