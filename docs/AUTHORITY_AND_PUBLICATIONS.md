# Authority records and signed publications

Tendriller hosts portable Chronolog authority records and signed code releases. It never orders, executes or reads application operations. Application data is an authored operation set that peers union and replay in canonical signed author-time order (see `docs/CRDT_CONTRACT.md` in the Chronolog repository). Authority and publication records answer different questions: who may hold keys, finalize or release code. The host signs only short-lived admission attestations; it never signs descriptors or membership and never sees epoch keys.

All applications use the common owned session. A fixed internal record format versions authenticated records. Application callers do not select alternate runtime profiles.

## What the host stores

| Record | Meaning |
| --- | --- |
| Descriptor | `{applicationId, rootPrincipal, authorityPublicKey, executionManifestDigest, finalityPolicy}`. The execution manifest pins deterministic engine/platform semantics, not an application schema. |
| Membership chain | Creator- or member-signed revisions with a predecessor digest, an exclusive author-time activation floor, independent grants with each member's wrap key, the epoch key commitment, the admission policy, admitted-member evidence and signed invites. |
| Pending admissions | Host-signed `HostAttestation` records for keys that are not yet members (at most 64 per page, at most 60 minutes each). |
| Key wraps | Member-signed `KeyWrap` records sealing epoch keys to one reader's wrap key (at most 4 per recipient). |
| Publication chain | Signed monotonic UI/code releases and their immutable assets. |
| Finality proofs | Optional signed admission and closed-time evidence, only when the descriptor's policy is not `none`. |

The metadata chain is evidence for a session's verified authority cache. It does not supply SQL operation order and does not overwrite SQL membership, grants or schema. Those are ordinary authored transactions.

## Host SDK operations

The host's authority client encodes signed authority and finality records as canonical tagged-JSON bytes from `@chronolog/authority.encodeRecord`, transported as `{record: lowercaseHexBytes}` (not CBOR); JSON enrollment action envelopes carry these in their `proof`, `bundle`, `wrap` and `attestation` fields, while challenge, invite and recipient inputs remain ordinary JSON. It does not verify returned signed records. Publication is the exception: `publish(publication, assets)` sends the raw `SignedPublication` JSON with canonical base64 asset bytes, and `publication(id?)` returns a JSON `{publication, version}` receipt (see [protocol](PROTOCOL.md)). Callers verify signatures with `@chronolog/authority` before trusting a result.

| Method | Purpose |
| --- | --- |
| `application()` | Read selection, prepared configuration, publication authority, the current authority record (null before the creator initializes), `hostAttestationKey` and `admissionAccounts`. |
| `prepare(configuration)` | Private setup credential: `{executionManifestDigest, executionProfile, publisherKeys, requestedFinality?, tools?}`. Identical retries are accepted; changed immutable setup is rejected. |
| `challenge(publicKey)` / `enroll(proof, invite?)` | A signed-in account at the exact page origin obtains a challenge and proves its device key and wrap key. The answer carries the host attestation; an optional `{inviteId, secret}` redeems an invite. |
| `enrollAgent()` | A granted agent receives an attestation for its registered signing and wrap keys. |
| `initialize(bundle)` | Store the creator's genesis once. |
| `membership(bundle)` | Store a member-signed revision that extends the head by exactly one. |
| `admissions()` / `wrap(wrap)` / `wraps(recipient)` | Read pending attestations and wrap coverage; deliver and fetch member-signed key wraps. |
| `participant(record)` | A signed portable authority, publication or finality request. No application programs are accepted. |
| `publication(id?)` / `publish(publication, assets)` | Read the head or an exact historical receipt, and publish a signed release with its assets. |

[Session bootstrap](SESSION_BOOTSTRAP.md#admission-wire-contract) gives the exact wire contract and [membership](MEMBERSHIP.md#admission) the admission rules.

## Verified opening and retries

A session opens from its cached verified authority and keys. `session.mergeAuthority(bundle)` verifies and retains newer public evidence without waiting for the host. Competing membership changes against one predecessor cannot both win. Exact retries return the original signed result, and changed evidence under an old identity conflicts. Account and credential revocation is rechecked after asynchronous verification and before commit.

## Session outcomes

Operation identities, author times and signed bytes belong to the session. A `stored` operation is locally durable. A `materialized` outcome is a coherent accepted or rejected result at a revision that earlier operations can revise. `retained` evidence and optional `finalized` proofs are independent. No peer or host assigns operation order. See [state models](STATE_MODELS.md).

## Code chain

A publisher key signs `signPublicationManifest(...)` from `@chronolog/authority`. The manifest binds the application, publisher grant, execution manifest digest, author, operation ID, monotonic revision, predecessor, entry and file list. `publish(signed, assets)` verifies files and compare-and-set against the release head. The signed code chain lives outside application operations, and data operations never require a new release.

The signed digests describe authored files. Served HTML additionally carries deliberate runtime injection, so verify the signed manifest and authored asset hashes; the rendered document's digest is expected to differ.

The host retains signed publication records and their complete code graph. `publication()` returns the head, and `publication(id)` returns an exact historical receipt. Exact retries can return an older receipt without selecting it again. Restore is a new signed release. A stale tab or diagnostics cannot silently rewind the code head.
