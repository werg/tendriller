# Peer-generation controls

**Implementation status:** Tendriller implements the hosted control registry,
public definition publication, bounded discovery/invitations, and SDK/runtime/MCP
lifecycle calls. Chronolog supplies the shared portable control verifier, encrypted
replica and public session composition with native/browser entries and maintained
RTC. The host suite exercises real workerd HTTP and socket boundaries; independent
packed native RTC runs cover selected-prefix recovery and blocked control access.
The [paired qualification record](https://github.com/werg/tendriller-contrib/blob/feat/chronolog-application-log/cookbooks/run-a-peer-application/notes/peer-generation-qualification.md) names exact artifacts, sources,
cleanliness and the distinct actual-host/browser/deployed gates. Configuration
alone does not install or connect a session.

The application session exposes `applied()` outcomes, `shared()` retained
coverage, coherent views and explicit recovery. An applied suffix may be
abandoned at an authorized recovery boundary. No alternative method name turns
that outcome into irreversible settlement.

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
| `definition` | Immutable portable description: id, version, schema, sorted command/query names and closed input schemas; the host derives its descriptor commitment |
| `schemaAdministrator` | Public identity authorized to sign the initial schema |
| `schema` | Signed initial schema envelope matching `definition.schema`; omitted or null for events-only applications; the host verifies it and derives its descriptor commitment |
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
with the signed descriptor, canonical public definition, initial control and registry.
Chronolog's portable verifier checks the bounded description and computes its
digest before any durable control or lifetime write. Unknown metadata, unsupported
schemas and mismatched signed schema bindings are rejected. The description contains public command
and query schemas, never executable command handlers or application history.
Repeating the exact
configuration returns the same identity and current authority. A different
configuration is rejected. A missing retained identity or registry is an explicit
unavailable condition; the host never silently rekeys or creates empty history.

`peers.definition()` returns `{ descriptor, definition, schema }`. Chronolog's
portable `applicationDescriptionDigest` validates the exact same public metadata
used by sessions and agent tools. The host derives the descriptor's
`definitionDigest` from that metadata and its `schemaDigest` from the complete
signed schema envelope using `peerDigest` (null for events-only applications).
Configuration accepts the definition and schema themselves, without separate
digest inputs. Clients check these digests against their pinned descriptor before
using the schemas. Object inputs are closed, command/query names are unique and
sorted, and metadata is limited to 256 KiB including the signed schema envelope.
The host verifies that
envelope with `verifyApplicationSchema`, checking its application identity,
definition, execution profile and declared schema administrator, and checks its
program against the published definition. It never executes the schema SQL.

The immutable metadata and retained assets survive page versions and creator
device loss. Reading the already signed metadata does not require the private
control signer, while selecting a new generation does. Missing control identity
therefore cannot cause the host to invent a new trust root or empty application.

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

`peers.definition()` reads `{ descriptor, definition, schema }` from the authenticated
`publication/definition` participant exchange. The host verifies the signed descriptor,
retained description digest and any genesis envelope, then rechecks account/page
access before responding.
Clients verify the descriptor against their pinned trust root and call Chronolog's
`applicationDescriptionDigest(definition)` before using its public schemas. This
transport call does not itself authenticate signatures or create a session. Missing
or corrupted retained metadata is an explicit failure; it is never replaced on read.
The MCP `peer_definition` tool exposes the same bounded metadata for local tools.
These reads share the control request admission limit and install no polling.

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

At most four control requests may be admitted at once, including bodies still
arriving and operations waiting to commit. Excess requests receive
`peer_participant_busy` before their bodies are read. A stalled body does not block
complete requests while capacity remains, and every completion or failure frees
its slot. The portable facet policy bounds control envelopes to 16 MiB, publication
envelopes to 12 MiB, directory messages to 256 KiB and ephemeral invitations to
64 KiB. Action payloads have their own tighter semantic limits. No polling is installed.

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
application or control rights, including dataRole. The host repeats those checks
after asynchronous preparation and rechecks local admission in the storage
transaction.

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
Both use `POST peers/participant`: `control/administer` signs the declared host
role, while `control/select` preserves the original device-signed transition.

The host verifies order receipts and ancestry proofs but does not attest that a
candidate actually has all bodies or has replayed SQL correctly. The Chronolog
session must validate its complete recovery point before requesting selection.
The host need not see SQL or encrypted command bodies to enforce selected ancestry.

## Session behavior and qualification boundaries

The session implements the command and recovery contract below. Its independent
packed preview exercises native/events behavior through the maintained in-process
link. Maintained network/RTC transport now exists; its packed consumer, HTTP
control integration and actual browser/deployment behavior need their own evidence. Discovery and host MCP calls do not themselves open or
connect a session.

Use `peers.discover()` and coalesced `peers.advertise()` on join, reconnect or
availability changes. Directory eligibility and coverage are hints; they cannot
select a generation. Healthy sessions do not poll the host per command, query,
signal, checkpoint or retained object. See [peer connections](PEER_CONNECTIONS.md).

A cached verified delegation remains usable during a host outage. If that
coordinator also disappears, peers retain local attempts while selection waits.
Returning excluded work is inspected as an abandoned branch and can only return
through deliberate new attempts. No old suffix is automatically readopted.

The host MCP offers `peer_application`, `peer_definition`, `discover_peers`,
`configure_peer_application`, `select_peer_generation` and
`administer_peer_generation`. Routine application
commands execute through the agent's own Chronolog session. The host MCP has no
second operation journal or application command proxy.

External actions need an explicit dispatch policy, recovery-aware journal and
reconciliation. Protect the complete prerequisite program when its business
conditions must survive recovery. An applied result does not promise
irreversibility. Generation sessions expose `applied()` and retained coverage
through `shared()`; `final()` is reserved for a separately selected profile that
can provide that stronger guarantee.

## One filtered participant transport

All lifecycle requests use `POST peers/participant` with Chronolog's portable
`chronolog-participant-v1` envelope: `applicationId`, `requestId`, `facet`,
`action` and `payload`. Responses bind the same scope, request and action. The
SDK exposes `peers.exchange()`; convenience methods use that same exchange.
Request identifiers correlate delivery. Signed transition and publication
operation identities preserve durable exact retries.

The same portable policy filters outgoing client messages before HTTP and
incoming host messages before dispatch. The host accepts these exact interests:

| Facet | Actions | Retained state |
| --- | --- | --- |
| `control` | `read`, `configure`, `select`, `administer` | Signed authority and monotonic controls |
| `publication` | `definition`, `read`, `publish` | Public schemas and signed page-code releases |
| `discovery` | `read`, `advertise`, `withdraw` | Bounded expiring route hints |
| `ephemeral` | `invite` | Bounded delivery hints only |

The host refuses database submissions, history/body replication, generic content
chunks and live UI signals. Those use peer transports. Socket invitations and
SDP introductions remain bounded transport mechanisms, not an application data
channel. Routing interests reduce traffic; authenticated grants separately decide
authority. No command is proxied to a hosted application executor.

Construction performs no I/O. Browser scope comes from its bootstrap;
`createClient` accepts an optional `applicationId`, or discovers the immutable
selection once when an explicit convenience call needs it. A raw exchange already
carries its scope. None of these operations install a polling loop.

## Signed page-code publication

A code release is a Chronolog `SignedPublication`. Its manifest binds the
application, history, execution and definition digests, publisher, control
revision, stable operation ID, monotonic release revision, predecessor ID,
HTML entry and sorted content-addressed files. Presentation code may evolve;
this mechanism cannot quietly replace descriptor-bound execution semantics.

The publisher must have a verified current administrative grant and belong to
the authenticated account. The host verifies the original signature and every
asset's hash and size, then atomically selects the served immutable page version
and retains its signed release/receipt. It checks account authorization again
after asynchronous uploads and immediately before selection.

`peers.publish(publication, assets)` sends `{ publication, assets }`, where each
asset is `{ hash, bytes }` and `bytes` is canonical base64. Only hashes referenced
by the signed manifest are accepted. Already retained content can be omitted.
A complete code graph has at most 128 files and 8 MiB of content; the signed
manifest is limited to 256 KiB. The release history is bounded to 256 revisions
and 16 MiB of signed metadata.

`peers.publication()` returns the current `{ publication, version }`, or null
before the first release. `peers.publication(id)` reads an exact retained release
for ancestry verification. `version` is the numeric immutable served asset
version. Exact publication retries return the original receipt after restart or
later code releases. Changed intent under an existing operation ID and competing
predecessors fail explicitly.

Code selection is independent of lossy application recovery. Health observations
cannot silently roll back signed code; restoring previous content requires a new
signed release at the current head. Unsigned publication mutation routes cannot
bypass a configured control authority. The host retains page assets for loading
without receiving application database bodies or adding an application outbox.
