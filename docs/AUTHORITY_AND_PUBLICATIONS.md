# Authority records and signed publications

Tendriller hosts portable Chronolog authority records and signed code releases. It never orders, executes or reads application operations. Application data is an authored operation set that peers union and replay in canonical signed author-time order (see `docs/CRDT_CONTRACT.md` in the Chronolog repository). Authority and publication records answer different questions: who may hold keys, finalize or release code.

All applications use the common owned session. A fixed internal record format versions authenticated records. Application callers do not select alternate runtime profiles.

## What the host stores

| Record | Meaning |
| --- | --- |
| Descriptor | `{applicationId, rootPrincipal, authorityPublicKey, executionManifestDigest, finalityPolicy}`. The execution manifest pins deterministic engine/platform semantics, not an application schema. |
| Membership chain | Signed revisions with a predecessor digest, an exclusive author-time activation floor, independent grants and the epoch key commitment. |
| Publication chain | Signed monotonic UI/code releases and their immutable assets. |
| Finality proofs | Optional signed admission and closed-time evidence, only when the descriptor's policy is not `none`. |

The metadata chain is evidence for a session's verified authority cache. It does not supply SQL operation order and does not overwrite SQL membership, grants or schema. Those are ordinary authored transactions.

## Host SDK operations

The host's authority client encodes signed authority and finality records as canonical tagged-JSON bytes from `@chronolog/authority.encodeRecord`, transported as `{record: lowercaseHexBytes}` (not CBOR); JSON enrollment action envelopes carry these in their signed `proof` or `bundle` fields, while challenge and grant inputs remain ordinary JSON. It does not verify returned signed records. Publication is the exception: `publish(publication, assets)` sends the raw `SignedPublication` JSON with canonical base64 asset bytes, and `publication(id?)` returns a JSON `{publication, version}` receipt (see [protocol](PROTOCOL.md)). Callers verify signatures with `@chronolog/authority` before trusting a result.

| Method | Purpose |
| --- | --- |
| `application()` | Read selection, prepared configuration, publication authority and the current authority record (null before data initialization). |
| `prepare(configuration)` | Private setup credential: `{executionManifestDigest, executionProfile, publisherKeys, requestedFinality?, tools?}`. Identical retries are accepted; changed immutable setup is rejected. |
| `challenge(publicKey)` / `enroll(proof)` | Authenticated account and exact page origin obtain a challenge. The browser's signed enrollment proof binds application, key, challenge, epoch and epoch-key digest. No plaintext key is accepted. |
| `grant({requestId, expectedMembershipId, authorTimeAfterMs, grant})` | Explicit owner review of independent `reader`, `writer`, `administrator`, `publisher` and `finalizer` rights. The expected head is enrollment concurrency control, never a data-order input. Exact request-ID retries keep the original grant. |
| `membership(bundle)` | An independently signed administrator extension, verified against the pinned descriptor and chain. |
| `participant(record)` | A signed portable authority, publication or finality request. No application programs are accepted. |
| `publication(id?)` / `publish(publication, assets)` | Read the head or an exact historical receipt, and publish a signed release with its assets. |

[Session bootstrap](SESSION_BOOTSTRAP.md) gives the setup order and the starter's helper files.

## Verified opening and retries

A session opens from its cached verified authority and keys. `session.mergeAuthority(bundle)` verifies and retains newer public evidence without waiting for the host. Competing membership changes against one predecessor cannot both win. Exact retries return the original signed result, and changed evidence under an old identity conflicts. Account and credential revocation is rechecked after asynchronous verification and before commit.

## Session outcomes

Operation identities, author times and signed bytes belong to the session. A `stored` operation is locally durable. A `materialized` outcome is a coherent accepted or rejected result at a revision that earlier operations can revise. `retained` evidence and optional `finalized` proofs are independent. No peer or host assigns operation order. See [state models](STATE_MODELS.md).

## Code chain

A publisher key signs `signPublicationManifest(...)` from `@chronolog/authority`. The manifest binds the application, publisher grant, execution manifest digest, author, operation ID, monotonic revision, predecessor, entry and file list. `publish(signed, assets)` verifies files and compare-and-set against the release head. The signed code chain lives outside application operations, and data operations never require a new release.

The signed digests describe authored files. Served HTML additionally carries deliberate runtime injection, so verify the signed manifest and authored asset hashes; the rendered document's digest is expected to differ.

The host retains signed publication records and their complete code graph. `publication()` returns the head, and `publication(id)` returns an exact historical receipt. Exact retries can return an older receipt without selecting it again. Restore is a new signed release. A stale tab or diagnostics cannot silently rewind the code head.
