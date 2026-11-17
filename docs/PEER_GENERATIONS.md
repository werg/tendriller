# Peer-generation controls

The default peer profile is Chronolog's authenticated `peer-generation-v1` policy.
A replaceable peer orders ordinary commands. Tendriller retains the small monotonic
control history and atomically selects the next generation at creation, handover,
crash takeover, or a restrictive control change. It does not receive application
commands, execute SQL, sign batches, or require a hosted data copy.

The normative authority and recovery rules live in Chronolog's
[peer-generation ADR](https://github.com/werg/chronolog-db/blob/feat/portable-peer-core/docs/peer-generation-v1.md).
This host embeds the same portable verifier used by peers, with exact source and
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

A member is `{ grant, accountId? }`. The portable `PeerGrant` specifies reader,
writer, coordinator, recovery and administrator rights independently. Omitted
`accountId` binds to the authenticated owner's account; additional accounts must
already be admitted to the page. Host login never replaces a device signature or
grants application rights by itself.

The host creates a separate control signing identity and atomically retains it
with the signed descriptor, initial control and registry. Repeating the exact
configuration returns the same identity and current authority. A different
configuration is rejected. A missing retained identity or registry is an explicit
unavailable condition; the host never silently rekeys or creates empty history.

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

The host verifies order receipts and ancestry proofs but does not attest that a
candidate actually has all bodies or has replayed SQL correctly. The Chronolog
session must validate its complete recovery point before requesting selection.
The host need not see SQL or encrypted command bodies to enforce selected ancestry.

## Separation from normal application work

Use `peers.discover()` and coalesced `peers.advertise()` on join, reconnect or
availability changes. Directory eligibility and coverage are hints; they cannot
select a generation. Healthy sessions do not poll the host per command, query,
signal, checkpoint or retained object. See [peer connections](PEER_CONNECTIONS.md).

A cached verified delegation remains usable during a host outage. If that
coordinator also disappears, peers retain local attempts while selection waits.
Returning excluded work is inspected as an abandoned branch and can only return
through deliberate new attempts. No old suffix is automatically readopted.

The host MCP offers `peer_application`, `discover_peers`,
`configure_peer_application` and `select_peer_generation`. Routine application
commands execute through the agent's own Chronolog session. The host MCP has no
second operation journal or application command proxy.

Protected external actions and optional stronger finality/archival services remain
separate capabilities. An applied generation result is never a final receipt.
