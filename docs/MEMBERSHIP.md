# Membership and authority

Application device rights are signed Chronolog authority records. Tendriller hosts those records through the same participant transport used by the session. Account access determines who may reach host operations; it does not substitute for signed device authority. See [Authority records and signed publications](AUTHORITY_AND_PUBLICATIONS.md) for the host operations and [Session bootstrap](SESSION_BOOTSTRAP.md) for the setup order.

## Initial configuration

Before or after owner claim, an agent holding a page grant with `host:manage` (the creating agent has one) prepares the host with `prepare(configuration)`: `{executionManifestDigest, executionProfile, publisherKeys, requestedFinality?, tools?}`. Omit `requestedFinality` to choose `none`. Preparation persists no application schema, database definition, grants or keys, and creates no resident application process. Before claim, omitted bindings use a private page-scoped pending identity, not a fabricated OAuth account. The verified owner claim adopts those bindings to the real account without changing keys or signed records. After claim, omitted bindings use that owner account. Unclaimed preparation retains the normal quota and expiry.

Code publication can be signed and hosted before any browser exists. The page's **creator** then makes its keys: it signs the descriptor (`rootPrincipal` and `authorityPublicKey` are the creator's key), genesis membership revision 0 (the creator alone, reader + writer + administrator, with its wrap key) and the first epoch-key commitment, and retains the epoch key before sending the bundle with `initialize`. By default the creator is the agent (`npm run init -- <slug>`), so the page has keys before the owner signs in; `--browser-first` makes the owner's first browser the creator instead. The host accepts exactly one genesis, which must pin the host attestation key and the owner account (`email:<intended owner>` before claim). Clients pin the descriptor and verify records through Chronolog before execution.

## Independent rights

Membership grants are independent booleans: `reader`, `writer`, `administrator`, `publisher` and `finalizer`. A browser and a native process use the same rights model. Writing does not imply administration, publication or finalization. These cryptographic and publication rights are also independent of application data permissions. Collective membership, row ownership and SQL namespace/object DDL rights are ordinary authored transactions in the replayed operation set. The host does not overwrite them from its latest metadata head.

The host has a declared control-only role. It can verify and retain signed metadata and publications. It cannot receive database operations, submit ordinary commands, author code releases or hold epoch keys. Its transport accepts releases authorized by a publisher.

## Admission

Every device and agent joins a page through one mechanism. The genesis membership carries an admission policy `{mode, hostKey, accounts, grant}`: `mode` is `attested` or `strict`, `hostKey` is the host attestation public key, `accounts` lists the owner account (`<accountId>` or `email:<email>`) and `grant` is the default `{reader, writer}` for attested owner devices.

1. **Attestation.** A signed-in browser proves its device key and its X25519 wrap key to its page host (`challenge`, `enroll`). The host signs a short-lived `HostAttestation` binding the page, application, account, verified email, device key, wrap key and an optional invite ID, and keeps it in the page's pending list. An agent with a page grant obtains the same attestation (`enroll-agent`, issued automatically when the grant is created). The host never signs membership.
2. **Admission.** Any online member (a reader holding the current epoch key: the agent program or any earlier device) reads the pending list, verifies each attestation against signed state and appends eligible newcomers in one signed membership revision with the policy's grant. In `attested` mode an owner-account attestation is eligible; an invite attestation is eligible while its signed invite admits it. Chronolog accepts such a revision from any prior reader only when it adds attested or invited members with exactly the signed grant; every other change needs the creator or an administrator.
3. **Keys.** Members wrap the epoch keys to each reader's signed wrap key (`wrap`); the newcomer fetches its wraps (`wraps`) and installs them. A device that is a member but has no current key is `waiting-keys`.

**Strict mode** (`admission.mode('strict')`) makes no attestation eligible on its own: an administrator approves each pending device with chosen rights. Owner devices admitted by attestation are not administrators unless promoted (`admission.grant`); the creator is. Strict mode therefore needs an administrator online.

**Invites** are signed into membership as `{inviteId, role, binding, expiresAt, secretDigest, revoked}` with binding `email` (one verified address), `open` (one account) or `public` (up to `max` accounts). The link is the page URL plus `#invite=<id>.<secret>`; the secret travels only in the fragment, is presented once to the page's host and is stored only as its SHA-256 digest. The host checks the secret, expiry, revocation, email and its redemption count before attesting; members check the signed invite and redemption count again before admitting. Revoking an invite is a signed revision.

**Remove device** (`admission.remove`) signs a revision without that member and a new epoch whose key is wrapped only to the remaining members. A removed key is never auto-readmitted: its later attestation is held as `previously_removed` until an administrator approves it. Removing a device does not sign out its account; use strict mode to stop new devices of the owner account.

Membership revisions carry an exclusive author-time activation floor, so a late operation is checked against the membership that applied at its own time. A revision must extend the stored head by exactly one; concurrent members converge on the host-accepted head. Account access alone never reconstructs a data key, and plaintext already disclosed cannot be revoked.

**Security.** A compromised host can at most get an attested device admitted on an attested-mode page; that device is visible in every replica's device list and revocable. A host that double-redeems an invite is visible (the pending entry is `invite_already_redeemed`, redemption counts are signed) and the extra device is never admitted automatically.

Revoking host credentials stops subsequent host and introduction access. Removing a device changes what signed protocol actions are permitted. These are distinct decisions and both must be checked at the boundary they govern.

## Code publication

A device needs an explicit `publisher: true` grant, or a configured publisher key, to sign a code release. Neither an administrator nor an ordinary application writer receives this right implicitly. A complete explicit grant can give a device only publication rights, with no application keys or administrative rights.

The host also requires the submitting account to be authorized for that author. Publisher-only devices must still belong to active admitted accounts when their rights are retained. Exact old release retries remain historical evidence, and new releases require current authority. The session verifies publication signatures and ancestry before accepting a selected code head.
