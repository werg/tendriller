# Membership and authority

Application device rights are signed Chronolog authority records. Tendriller hosts those records through the same participant transport used by the session. Account access determines who may reach host operations; it does not substitute for signed device authority. See [Authority records and signed publications](AUTHORITY_AND_PUBLICATIONS.md) for the host operations and [Session bootstrap](SESSION_BOOTSTRAP.md) for the setup order.

## Initial configuration

Before or after owner claim, an agent holding a page grant with `host:manage` (the creating agent has one) prepares the host with `prepare(configuration)`: `{executionManifestDigest, executionProfile, publisherKeys, requestedFinality?, tools?}`. Omit `requestedFinality` to choose `none`. Preparation persists no application schema, database definition, grants or keys, and creates no resident application process. Before claim, omitted bindings use a private page-scoped pending identity, not a fabricated OAuth account. The verified owner claim adopts those bindings to the real account without changing keys or signed records. After claim, omitted bindings use that owner account, and established device/account enrollments cannot be reassigned. Unclaimed preparation retains the normal quota and expiry.

Code publication can be signed and hosted before any browser exists. The owner then signs in, and that browser proves its own device key. The first authorized browser's enrollment establishes the root principal and initial membership, and its epoch key stays on that browser. Only the epoch-key commitment is signed and hosted. There is no signed generation selection or creator coordinator step. Clients pin the descriptor and verify records through Chronolog before execution.

For owner-device enrollment, authenticated `host.info()` includes `owner_account_id`, which is `null` before claim. This is the explicit account identifier for device account bindings. Confirm that the device belongs to the owner before enrolling it. Existing bindings cannot be reassigned, and this field grants neither application nor publication rights. The field is returned only by the authenticated agent metadata route, not public discovery or page configuration.

## Independent rights

Membership grants are independent booleans: `reader`, `writer`, `administrator`, `publisher` and `finalizer`. A browser and a native process use the same rights model. Writing does not imply administration, publication or finalization. These cryptographic and publication rights are also independent of application data permissions. Collective membership, row ownership and SQL namespace/object DDL rights are ordinary authored transactions in the replayed operation set. The host does not overwrite them from its latest metadata head.

The host has a declared control-only role. It can verify and retain signed metadata and publications. It cannot receive database operations, submit ordinary commands, author code releases or hold epoch keys. Its transport accepts releases authorized by a publisher.

## Changes and key access

An enrollment request is a signed proof from the browser's device key. The owner reviews it and `grant`s explicit rights with an expected membership head and an author-time activation floor. A signed membership revision applies to operations whose author time is after its floor, so a late operation is checked against the membership that applied at its own time. Stale predecessors conflict, and exact request-ID retries keep the original grant.

Key access is separate from the grant. An authorized reader provisions the enrolled recipient through a recipient-encrypted package validated against authenticated key commitments. Account access alone never reconstructs an unavailable data key, and an empty browser cannot invent missing private keys. Revoking a reader requires rotating the epoch key and commitment. Plaintext already disclosed cannot be revoked.

Revoking host credentials stops subsequent host and introduction access. Revoking a device grant changes what signed protocol actions are permitted. These are distinct decisions and both must be checked at the boundary they govern.

## Code publication

A device needs an explicit `publisher: true` grant, or a configured publisher key, to sign a code release. Neither an administrator nor an ordinary application writer receives this right implicitly. A complete explicit grant can give a device only publication rights, with no application keys or administrative rights.

The host also requires the submitting account to be authorized for that author. Publisher-only devices must still belong to active admitted accounts when their rights are retained. Exact old release retries remain historical evidence, and new releases require current authority. The session verifies publication signatures and ancestry before accepting a selected code head.
