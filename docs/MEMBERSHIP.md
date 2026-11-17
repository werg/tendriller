# Portable membership administration

An owned resident page with a peer application hosts its membership administrator
in the existing Tendril Durable Object. The engine bundles the public
`@chronolog/membership` artifact by default. The same portable administrator can
run on another host that supplies durable private bytes and a signed native
control-proof connection. It does not load a SQL engine or fetch application
descriptors or payloads.

The host account decides who may request or approve a device. Chronolog's signed
capabilities decide what that device may do in the group. Logging into Tendriller,
opening a guest link, or completing an introduction does not grant database access.

## Responsibilities and trust

| Participant | Stores and verifies | Authority |
| --- | --- | --- |
| Tendril membership administrator | Root signing key, epoch keys, account-to-device requests, durable decisions, complete control projection and its signed checkpoint | Approves reader/writer capabilities and rotates keys at proved author-time boundaries |
| Native finality authority | Receipt descriptors, cumulative control commitment, signed closure markers, prefix roots and signing key | Certifies inclusion, the complete control projection and the closed author-time frontier |
| Full browser/native replica | Signed encrypted application bodies, verified capabilities, epoch keys for its reader, local database | Derives author-time order and executes the selected deterministic application program |
| Schema administrator | Its own application signing key | Changes the application's SQL schema under the signed genesis policy |

Provisioning pins the native finality public key and the schema administrator's
public key explicitly. The membership root is generated and retained by the
host. Signed genesis names that root directly; it adds no administrator capability.
The root receives no implicit reader, writer, or schema grant. A native agent can
be both a full replica and the schema administrator; these are explicit grants
and keys, not consequences of running the finality endpoint.

Signed genesis selects `signed-inclusion-v2`. Each signed author-time closure
commits to a cumulative count and rolling root of every finalized control
descriptor. A projected entry binds its control index, original receipt bytes,
receipt position and first covering closure cutoff. Full replicas recompute
that projection while verifying the complete application ledger. Receipt
positions never determine application execution order.

The administrator verifies the signed closure, its immediately covering prefix
certificate and the complete control chain. It receives inline governance and
key-wrap descriptors plus the checkpoint, with no intervening application
descriptors or bodies. Filtering unproved ledger positions is not sufficient:
the signed count/root authenticates completeness, and changed bytes, order,
activation cutoff, group, regression or conflicting checkpoints fail closed.
Partial pages do not activate grants or become durable checkpoints.

The administrator's retained history and replay work therefore scale with
control changes. Explicit synchronization also receives a bounded signed
checkpoint when application history advances. A full replica still verifies the
entire original ledger and fetches encrypted bodies through its peer transport.
The host does not append a second application history to the Cloudflare log.

This is a bandwidth and execution boundary, not a claim that the root is unable
to access content. The administrator retains epoch keys for key delivery and can
authorize another reader, including one it controls. The host is therefore a
trusted membership and key administrator. Devices keep their own private signing
and reader keys; only their public keys and signed requests cross the host API.

## Provision a page and native authority

Select the peer application when creating the page. Claim it through the normal
owner flow, then make it resident. A configured administrator cannot return to
idle-expiring lifetime. A pending lifetime downgrade also blocks new provisioning,
including one already preparing its keys. Lifetime changes reserve that decision
before account-storage I/O; an interrupted update resumes on the next request or
alarm, including after restart. Explicit page/account deletion still applies;
resident storage is not an independent backup guarantee.

The public SDK exposes `agent.members`, and the authenticated browser runtime
exposes `tendril.members`. `@tendriller/core/members` also exports the small fetch
client. All byte fields in the host JSON API use canonical unpadded base64url.

```js
const configured = await agent.members.configure({
  executionManifestDigest: profileDigest,
  schemaAdministratorPublicKey: schemaAdministratorPublicKey,
  nativeAuthority: {
    url: 'https://native.example/_chronolog/membership',
    historyId: nativeHistoryId,
    publicKey: nativeAuthorityPublicKey,
  },
  initialMembers: [{
    signingPublicKey: nativeReplicaSigningPublicKey,
    readerPublicKey: nativeReplicaReaderPublicKey,
    transportAuthor: nativeReplicaFeedId,
    writerProgram: { sql: true, topics: ['tasks/changed'], signals: [] },
  }],
});
```

Use exact topic names or `'*'` for all topics. A chat application can instead grant
`topics: ['chat/message']`.
`initialMembers` is optional and contains public keys only. Each initial member
receives a reader capability; `writerProgram` explicitly adds writer rights.

Configuration is immutable for the page. A retry with the same configuration
returns the original signed genesis. Provisioning stores the root and descriptor
without contacting the native endpoint. This makes the setup order explicit:

1. Reserve the native history identity and obtain its public authority key, the
   execution-profile digest and any initial replica public keys.
2. Configure the Tendril and obtain `{ genesis, groupRoute }` from its response.
3. Start the native authority and full replica with that exact signed descriptor.
4. Call `members.sync()`. The administrator publishes and certifies epoch zero,
   including wraps for the initial reader grants. A group with no readers has a
   valid empty wrap set; it does not manufacture a host reader.

The native endpoint is `POST /_chronolog/membership` using the portable bounded
CBOR protocol. Each request is root-signed and binds the exact group, history,
genesis/profile/authority configuration, expiry, nonce and operation contents.
The native endpoint accepts only inline governance descriptors for append and
returns compact control pages, a signed closure checkpoint and its certificate.
It does not certify a caller-supplied head. Production URLs use HTTPS; HTTP is accepted only for local
loopback qualification.

## Enroll a device

Call `members.info()` after authenticating to the page. Its identity includes the
account-bound `requestPrefix`, for example `account:<account-id>:`. Generate and
persist the device's signing/reader keys using Chronolog's public enrollment
helpers. Persist a signed enrollment request whose stable `requestId` starts with
that prefix and ends in a device-generated identity. The signature commits to
the account prefix, group descriptor, public keys, transport author and requested
rights.

Submit the encoded request with `members.requestEnrollment(signedRequest)`.
The host verifies the device signature and authenticated account binding, then
retains an immutable request identity. Repeating the same signed bytes returns
the same request. Another account cannot claim those bytes as its device.
Members see their own account's device requests; the owner sees the roster.

The owner or an authorized owner agent reviews and approves a concrete request:

```js
await agent.members.approve({
  operationId: 'approve-device-2026-11-16-1',
  requestId: request.id,
  roles: ['reader', 'writer'],
  grantFullHistory: true,
  writerProgram: { sql: true, topics: ['tasks/changed', 'chat/message'], signals: ['typing'] },
});
```

Every approval includes the reader role. Include `writerProgram` exactly when
granting the writer role, with explicit SQL, event-topic and signal-topic rights.
The decision may narrow the signed request's rights, but cannot expand them.
Missing rights, rights without a writer role and invalid role sets are rejected
before the host retains an administrative action, so an invalid review cannot
block later membership synchronization. There are no implicit publication rights:
`sql`, durable event `topics`, and ephemeral `signals` are separate grants.

The operation identity is retained with the original decision. Lost responses and
host eviction are recovered by retrying that identity and contents; changing the
decision under the same identity is rejected. The host's durable pending actions
contain membership decisions only. Routine application operations use the
selected Chronolog backend's own durable publication path.

An approval response includes the root-signed approval, capability identities,
required key epochs and a certified canonical target. It is not a substitute for
verifying and applying those records. A new device first downloads bounded pages
from `members.history({ after, limit })`. Decode the returned bytes with
`decodeMembershipLedgerResponse(bytes, 'read')`, then pass each page to the
governed replica's `ingestMembership(page)`. It verifies completeness and the
native checkpoint before applying the signed inline grant/key-wrap records.
Advance `after` using the last returned control's `index`, not its original
application receipt `entry.position`.
The endpoint requires an active approved reader for the account (or the owner).
It returns no raw epoch keys, application descriptors or application bodies.

This bootstrap resolves the reader-handshake dependency: the device learns and
verifies its reader grant before opening the ordinary reader-authenticated peer
connection. Control bootstrap does not claim any applied application history.
The replica then fetches retained application descriptors and bodies, unwraps its own keys and
materializes the captured target. The application may report full readiness only
after Chronolog's enrollment readiness checks confirm all of those conditions.

## Revocation and recovery

Revoke explicit capability identities with one stable operation identity:

```js
await agent.members.revoke({
  operationId: 'remove-device-2026-11-16-1',
  capabilityIds: request.capabilityIds,
});
```

The administrator retains the revoke/rotate intent before publishing. Recovery
finishes an interrupted key rotation with the original identity and bytes. The
new epoch has wraps only for remaining readers, including a valid zero-reader
epoch when the last reader is removed. Historical data already decrypted by a
device is not erased. Previously final accepted operations keep their original
outcomes.

A logged-in account session can remain active after a device's group writer or
reader grant is revoked. Full replicas enforce canonical group capability state
independently of that session. Host access removal and group capability removal
are separate explicit decisions. The host cannot turn a local roster status into
an unverified membership boundary.

`members.sync()` resumes up to 16 retained pending host decisions and catches up
to a captured certified control checkpoint. Native unavailability, cancellation, and uncertain
append replies leave decisions pending. They are not reported as final domain
rejection. Retry the original operation after recovery. A stopped Cloudflare
membership host prevents new administrative decisions and first enrollment;
existing authenticated replicas continue ordinary application writes without a
membership-host round trip, subject to their own transport and native-authority
availability.

## HTTP routes, quotas and artifacts

These paths are relative to the agent API or the page's `_tendril/` prefix.
Page mutation routes use the existing same-origin session checks.

| Method and path | Permission | Result |
| --- | --- | --- |
| `PUT members` | Owner or owner agent, resident peer page | Immutable configuration and public signed descriptor |
| `GET members` | Authenticated page account or owner agent | Descriptor, own/all roster, known verified progress |
| `POST members/requests` | Authenticated page account | Stable signed device request |
| `GET members/requests/<id>` | Request account or owner | Original request/approval status |
| `POST members/approve` | Owner or owner agent | Original root-signed approval and capability identities |
| `POST members/revoke` | Owner or owner agent | Revoke/rotate result and canonical target |
| `POST members/sync` | Authenticated page account or owner agent | Resumed decisions and verified progress |
| `GET members/history?after=&limit=` | Approved reader account or owner | Bounded CBOR control proof, signed checkpoint and certificate |

`progress.verifiedThrough` and `progress.root` refer to the verified control
count/root. `receiptThrough` separately identifies the application receipt range
covered by the closure, `checkpointThrough` its committed marker position, and
`closedThroughMs` the author-time cutoff as a decimal string.

History pages contain at most 128 controls and approximately 1 MiB of descriptor
payload; the entire encoded response is bounded to 2 MiB. The private byte store
allows 16 MiB per value and 64 MiB total. The host retains at most 2,048 device
requests and 4,096 administrative decisions. Quota exhaustion fails explicitly;
it does not erase a retained decision or silently prune verified history.
JSON request bodies have a 30-second total read deadline and are read before
entering the shared administrator queue. Access is rechecked after the read.
A stalled client cannot block another participant's roster or administrative
operation.

The SDK contains the HTTP client and types. The engine embeds the pinned public
portable administrator artifact; it needs no Chronolog checkout, database engine,
native transport, or runtime package installation. The artifact's provenance
records its source commit, exact runtime inputs and output digests. Build checks
reject private source imports and SQL/native dependencies. This implementation
uses fresh page schema 8; existing page storage is not migrated. See
[operations](OPERATIONS.md) for deployment guards and fresh-resource requirements.
