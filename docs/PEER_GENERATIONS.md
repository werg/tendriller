# Peer-generation controls

**Implementation status:** Tendriller implements the hosted control registry and
its public SDK, runtime and MCP lifecycle calls. Chronolog supplies the portable
control verifier, encrypted replica and public `@chronolog/peer-session` preview,
including native/browser entries. The preserved packed native/events preview
uses an in-process link and dirty-source artifacts; it does not qualify a clean
release, actual HTTP control routes, browser/RTC or deployed networks. Configuring
host controls does not install or connect an application session. Supply a matching
session archive and qualify the selected composition explicitly. The separate
[chronological backend](APPLICATION_BACKENDS.md) retains `local` / `final` semantics.

The adopted target peer profile is Chronolog's authenticated `peer-generation-v1`
policy. Its preview session lets a replaceable peer order ordinary commands.
Tendriller retains the small monotonic
control history and atomically selects the next generation at creation, handover,
crash takeover, or a restrictive control change. It does not receive application
commands, execute SQL, sign batches, or require a hosted data copy.

The normative authority and recovery rules live in Chronolog's
[peer-generation ADR](https://github.com/werg/chronolog-db/blob/feat/portable-peer-core/docs/peer-generation-v1.md).
This host embeds the same portable verifier as the replica, with exact source and
module digests exposed in `@tendriller/engine/peer-generation-provenance`.

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

A member can be `{ publicKey, accountId?, administrator?, dataRole? }`. Chronolog's
`participantGrant` gives this ordinary participant read, write, coordinator and
recovery rights, with `dataRole: 'member'` and no control administration by default.
Set `administrator: true` only for a device that should change control policy.
Data administration is separate: `dataRole: 'admin'` manages the application's
shared data collective; becoming coordinator does not grant that role.

Use `{ grant, accountId? }` to specify every portable `PeerGrant` field explicitly:
reader, writer, coordinator, recovery, administrator and dataRole. Omitted
`accountId` binds to the authenticated owner's account; additional accounts must
already be admitted to the page. Grants are signed application authority; host
login alone does not confer peer data rights.

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
old-profile membership configuration cannot be installed on the same history.

## Lifecycle calls

`peers.application()` returns an `AuthorityBundle`: signed descriptor, monotonic
controls and selected generations. A session pins the descriptor and verifies
these records before using them. The transport client does not treat a received
signature or route as verified authority.

`peers.selectGeneration(request, { control? })` submits an exact signed
`SignedTransitionRequest` prepared by Chronolog. It names the expected current
generation, requester, candidate coordinator, exact adopted prefix, control
revision, transition identity and reason. The shared verifier separately checks
requester recovery rights, candidate sequencing eligibility, ancestry cutoffs and
protected recovery floors. The host also checks that the requester belongs to the
authenticated account, and repeats authorization after asynchronous preparation
immediately before durable commit.

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

The host appends its fixed control-only grant when callers provide application
device grants. Supplying that host grant with different rights is rejected. Old
device/account bindings remain enrollment provenance, so deactivating an account
does not prevent the owner from removing its application grant. Admission and
account activity are checked for new enrollments and every device retaining any
application or control rights, including dataRole.

### Owner recovery after device-key loss

`peers.administerGeneration(transition, { control? })` is an owner-account-only
operation. Its transition contains `{ transitionId, expectedGeneration,
coordinator, controlRevision, reason, base }`. The host pins application scope and
signs the request as its declared control participant. A real peer supplies the
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

## Session behavior and qualification boundaries

The session implements the command and recovery contract below. Its independent
packed preview exercises native/events behavior through the maintained in-process
link. HTTP control integration, physical RTC and actual browser/deployment behavior
need separate evidence. Discovery and host MCP calls do not themselves open or
connect a session.

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

Protected external actions and optional stronger finality/archival services remain
separate capabilities. An applied generation result is never a final receipt.
