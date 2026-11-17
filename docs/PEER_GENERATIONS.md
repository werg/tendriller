# Peer-generation controls

**Implementation status:** Tendriller implements the hosted control registry and
its public SDK, runtime and MCP lifecycle calls. Chronolog supplies the portable
control verifier and a separate implemented `peer-generation-v1` replica and
application-session package. Configuring host controls does not install that
session or a Tendriller generation backend, and does not qualify browser/native
Internet behavior. The [default live application backend](APPLICATION_BACKENDS.md)
continues to expose chronological `local` / `final` views and operation outcomes.

`peer-generation-v1` is an explicitly selected optional profile with no finality.
Its session lets a replaceable peer issue inclusion receipts for ordinary commands.
Tendriller retains the small monotonic
control history and atomically selects the next generation at creation, handover,
crash takeover, or a restrictive control change. It does not receive application
commands, execute SQL, sign batches, or require a hosted data copy.

The normative authority and recovery rules live in Chronolog's
[peer-generation ADR](https://github.com/werg/chronolog-db/blob/feat/portable-peer-core/docs/peer-generation-v1.md).
This host embeds the same portable control verifier used by peer replicas, with exact source and
module digests exposed in `@tendriller/engine/peer-generation-provenance`.

Generation and receipt sequence identify selected inclusion ancestry, not a second
application order. Replicas execute by `(signed author timestamp, signing public
key, stable proposal ID)`. An applied result describes one observed revision and
can change when an earlier signed operation arrives or recovery selects different
history. This profile has no final operation state, closed author-time frontier,
`final()` wait or final-intent worker. It is not a general branch/merge runtime.

## Publication and enrollment

Create a peer application with a stable 32-byte lowercase hexadecimal identity.
After the owner claims the page, call `peers.configureApplication(configuration)`
from the SDK or page runtime. Configuration contains:

| Field | Meaning |
| --- | --- |
| `historyId` | Stable application history identity |
| `executionManifestDigest` | Exact deterministic execution profile |
| `definitionDigest` | Public application command/query definition |
| `schemaAdministrator`, `schemaDigest` | Authorized signed initial schema; null digest for events-only applications |
| `epoch`, `keyDigest` | Initial encryption policy; no application body is uploaded |
| `members` | Explicit device grants plus their authenticated account bindings |

`definitionDigest` binds the public schemas and explicit semantic version, not
JavaScript command/query callbacks. Definitions are shared application DX; they
are not authorization and cannot give a command private-tool rights. An authorized
writer can still author a raw program under the pinned execution policy.

A member is `{ grant, accountId? }`. The portable `PeerGrant` specifies reader,
writer, coordinator, recovery and administrator rights independently. Omitted
`accountId` binds to the authenticated owner's account; additional accounts must
already be admitted to the page. Grants are signed application authority; host
login alone does not confer peer data rights.
Every grant supplies those booleans and its data role explicitly. There is no
`{ publicKey }` member shortcut that implicitly grants recovery or coordination.

The grant also requires `dataRole: 'member' | 'admin' | null` for membership of the
application's data collective. This is independent of coordinator or control
administrator rights. A null role grants no data-collective membership; retain
that distinction when revoking participants or configuring a control-only device.

The host creates a separate control signing identity and atomically retains it
with the signed descriptor, initial control and registry. Repeating the exact
configuration returns the same identity and current authority. A different
configuration is rejected. A missing retained identity or registry is an explicit
unavailable condition; the host never silently rekeys or creates empty history.

The initial signed control includes a visible hosted participant created by
Chronolog's `controlParticipantGrant`: recovery and control administration only,
with reader, writer and coordinator false and dataRole null. That grant and its
owner-account binding stay fixed for this hosted policy. The service cannot
become an application coordinator or issue application commands as this key.

Configuration retains the owned page's lifetime as `resident` and prevents an
expiration downgrade while signed control state exists. This is an owned durable
publication and control record, with no permanent native peer or process. Existing
live-profile membership configuration cannot be installed on the same history.

## Lifecycle calls

`peers.application()` returns an `AuthorityBundle`: signed descriptor, monotonic
controls and selected generations. A session pins the descriptor and verifies
these records before using them. The transport client does not treat a received
signature or route as verified authority.

`peers.selectGeneration(request, { control? })` submits an exact signed
`SignedTransitionRequest` prepared by Chronolog. It names the expected current
generation, requester, candidate coordinator, exact adopted prefix, control
revision, transition identity and reason. Every request also carries
`controlIntentDigest`, computed by Chronolog over the exact unsigned referenced
`ControlRevision`, including its grants, key commitment and recovery floor. This
applies to unchanged controls as well as new revisions. The shared verifier separately checks
requester recovery rights, candidate sequencing eligibility, ancestry cutoffs and
protected recovery floors. The host also checks that the requester belongs to the
authenticated account, and repeats authorization after asynchronous preparation
immediately before durable commit.

The request's `contextDigest` binds any supplied host account additions. Use
`peerAccountBindingsContext(accounts)` from the public peer SDK to validate and
sort exact `{ publicKey, accountId }` entries, then hash the non-null result with
Chronolog's `peerDigest`. Omitted or empty additions require null. This commitment
prevents substitution on first submission; the stored exact-request fingerprint
also protects retries after a successful commit.

Two competing successors cannot both replace the same selected generation. A
lost reply is recovered by resubmitting the exact request. Changing its controls
or account bindings under the same transition identity is rejected. The host
retains a bounded control registry, not an application log. Its 16 MiB retained
registry value bound is explicit; reaching it requires an operator decision and
does not discard control history.

A `control` update supplies `{ epoch, keyDigest, grants, recoveryFloor, accounts? }`.
It activates together with a generation boundary. Reader revocation requires key
rotation. New account bindings are enrolled explicitly; a public key retains its
original enrollment account. Grants decide current rights, so retained enrollment
provenance does not restore revoked permissions. The selected controls, generation,
new enrollments and exact transition fingerprint commit atomically.

Initial configuration and owner-created transitions include the fixed
control-only grant before the host signs its own intent. A device-signed control
change supplies the complete grant list, including that exact pinned host grant;
the host does not append or reorder authority after checking the signature.
Supplying that host grant with different rights is rejected. Old
device/account bindings remain enrollment provenance, so deactivating an account
does not prevent the owner from removing its application grant. Admission and
account activity are checked for new enrollments and every device retaining any
application or control rights, including dataRole. Guest admission requires a
currently valid approved guest link. It is checked again after asynchronous
account checks and at the synchronous commit boundary.

### Owner recovery after device-key loss

`peers.administerGeneration(transition, { control? })` is an owner-account-only
operation. Its transition contains `{ transitionId, expectedGeneration,
coordinator, controlRevision, reason, base }`. The host pins application scope and
derives both intent commitments and signs the request as its declared control
participant after normalizing the fixed host grant. A real peer supplies the
candidate key and a complete retained-prefix proof. The same portable verifier
checks candidate eligibility, exact ancestry and recovery floors.

This path lets an owner rotate devices or recover coordination after losing the
creator's private key. It preserves the original trust root and does not require
a surviving device administrator signature. It cannot impersonate a coordinator
handover, choose the host as coordinator, or bypass a protected recovery floor.
Exact retries retain the original transition identity, including after a restart.
The HTTP endpoint is `POST peers/administration`; the signed-device endpoint
remains `POST peers/generations`.

The host verifies order receipts and ancestry proofs but does not attest that a
candidate actually has all bodies or has replayed SQL correctly. The Chronolog
session must validate its complete recovery point before requesting selection.
The host need not see SQL or encrypted command bodies to enforce selected ancestry.

## Session behavior and implemented host boundaries

The standalone `@chronolog/peer-session` package owns durable signed attempts,
captured applied views, operation inspection and explicit recovery. Its
`connectApplications` connector runs in process; `connectApplicationTransport`
attaches authenticated framed connections with a separate live lane. RTC wrappers
are also implemented. The discovery and host MCP calls below provide control and
routing facilities; they do not themselves qualify a deployed browser/native
network or install a Tendriller application adapter.

Use `peers.discover()` and coalesced `peers.advertise()` on join, reconnect or
availability changes. Directory eligibility and coverage are hints; they cannot
select a generation. Healthy sessions do not poll the host per command, query,
signal, checkpoint or retained object. See [peer connections](PEER_CONNECTIONS.md).

A cached verified delegation remains usable during a host outage. If that
coordinator also disappears, peers retain local attempts while selection waits.
Returning excluded work is inspected as an abandoned branch and can only return
through deliberate new attempts. No old suffix is automatically readopted.

The host MCP offers `peer_application`, `discover_peers`,
`configure_peer_application`, `select_peer_generation` and
`administer_peer_generation`. Routine application
commands execute through the agent's own Chronolog session. The host MCP has no
second operation journal or application command proxy.

Held views stay at their captured revision. Applied event cursors must be rebuilt
when that revision changes. `observedRevision` is an ancestry observation, not
compare-and-swap or a substitute for business preconditions in the program.
Ordinary retries keep the original signed bytes; a retained operation's outcome
can still change after replay. Reapplication is deliberately new signed intent.

Applications using generation recovery choose their own policy for external
actions, idempotency and reconciliation. An applied result is never a final
receipt and cannot feed an automatic final-intent worker. Archival retention is
independent evidence about stored bytes, not a new settlement state.

## Qualification scope

Host tests exercise durable control identity and restart, exact transition retry,
racing successor selection, independent recovery/coordinator rights, account
bindings, atomic restrictive controls and reader key rotation. Chronolog's
separate replica/session tests cover deterministic replay and native/in-process
recovery. Neither set alone establishes end-to-end host-plus-browser/native
generation behavior, Internet reachability or a guaranteed loss window. Evidence
for the live profile does not automatically qualify this separate profile.
