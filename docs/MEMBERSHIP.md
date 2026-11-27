# Membership, permissions, and key distribution (Chronolog v2)

In Chronolog v2, cryptographic membership and epoch key distribution are ordinary public-control topics governed by audited standard ES Modules pinned in `$reducers`:
- **`$permissions`** (`chronolog/permissions` — `attestedMembers`): stores `members` (`publicKey`, optional X25519 `wrapKey`, independent boolean flags `reader`, `writer`, `administrator`, `publisher`, `finalizer`) and `admission` policy (`hostKey`, `mode`, `accounts`, `grant`, `invites`).
- **`$keys`** (`chronolog/keys` — `hpkeEpochs`): stores each epoch's `keyCommitment` and per-recipient **HPKE lockboxes** (`{ encapsulatedKey, ciphertext }`) sealed to each reader's X25519 `wrapKey`!

There is **no separate key-wrap mailbox on the host**. Because `$keys` lives directly in the public-control operation set, every replica and the blind host converge on the exact same membership and lockbox set automatically.

## Genesis & admission lifecycle

1. **Genesis (`createPageGenesis` / `openPageGenesis`):** The creator (the agent by default via `npm run init -- <slug>`, or the owner's first browser with `--browser-first`) creates the `LogGenesis` pinning `$reducers`, `$permissions` (creator as admin/publisher/finalizer + `admission.hostKey` + `admission.accounts`), `$keys`, `$finality`, and `$publications`, generates epoch 0 key locally, and submits genesis to the host once.
2. **Host attestation (`challenge` → `enroll`, or `enroll-agent`):** A newcomer proves its Ed25519 signing key and X25519 wrap key to the page host. The host signs a short-lived Ed25519 attestation (`signHostAttestationV2`) binding the account, email, device key, wrap key, and optional invite ID. The host never signs `$permissions` or sees epoch keys.
3. **Atomic admission (`session.admitMember`):** Any online administrator verifies the attestation against `$permissions.admission` and calls `session.admitMember(member, { attestation })`. In **one atomic public-control operation** updating both `$permissions` and `$keys`:
   - `chronolog/permissions` verifies the host's Ed25519 signature via `verifyEd25519` inside QuickJS-NG and adds the member, AND
   - `chronolog/keys` (`grantBoxes`) seals HPKE lockboxes for **all retained historical epochs (`0..N` or `checkpointEpoch..N`)** so a fresh device can immediately decrypt historical encrypted operations and rebuild full state!
4. **Unlocking (`session.unlockEpochsFromKeysTopic`):** The newcomer syncs public-control ops from the host or any peer, opens its HPKE lockboxes from `$keys` with its local X25519 private key, and immediately decrypts and materializes the full application state.

## Revocation, rotation & reconnect rewrapping

Removing a device calls `session.removeMember(publicKey, { rotate: true })`:
- Atomically removes the member from `$permissions` AND creates epoch `N+1` in `$keys` with HPKE lockboxes sealed *only* to the remaining readers.
- The Tendriller blind host immediately closes any open discovery, relay, or rendezvous WebSockets for the revoked peer upon syncing the public-control op.
- **Offline writes across rotation:** If a still-authorized writer authored an encrypted operation offline under epoch `N` after rotation to `N+1`, its replica automatically **rewraps** the exact original signed operation bytes (`SignedOperation` — same `authorTimestampMs`, `author`, `opId`, and signature!) into a fresh epoch `N+1` envelope when reconnecting. Envelopes reconcile by `encryptedEnvelopeDigest` (not just `opId`), so peers holding an unreadable old envelope cleanly fetch the decryptable rewrap.
- **Security note on `finality: none`:** Key disclosure to a recipient cannot be undone retroactively, and under `finality: none` a revoked reader who already possessed epoch `N` could decrypt any ciphertext distributed under epoch `N`. For strict post-revocation confidentiality on untrusted networks, rotate before distributing new ciphertexts or enable an active `$finality` policy.

## A-la-carte governance (`$permissions` reducers)

Every page chooses its `$permissions` reducer at genesis (`createPageGenesis({ authority })` or `npm run init -- <slug> --authority ...`):

| Mode | Reducer | `privateLog` | Best for | Security UX requirement |
| --- | --- | --- | --- | --- |
| **Private attested (default)** | `chronolog/permissions` (`attestedMembers`) | `true` (E2EE) | Personal & team pages with seamless OAuth sign-in and auto-admission. | Default user expectation; no warning banner needed. |
| **Zero-OAuth public read-only** | `chronolog/permissions` (`openMembers`, `openRead: true, openWrite: false`) | `false` | Public microsites, docs, live dashboards, embeds. Anyone syncs P2P without signing in; only listed writers/admins edit. | Show clear "Public · Read-only (unencrypted)" badge/banner (`mountGovernanceBanner` in `shared/helpers/governance.mjs`). |
| **Zero-OAuth public open-write** | `chronolog/permissions` (`openMembers`, `openRead: true, openWrite: true`) | `false` | Public guestbooks, polls, open community boards, collaborative demos (pair with `chronolog/rls` write predicates!). | Show explicit warning banner: unencrypted public log, anyone with the link can submit signed entries. |
| **M-of-N Multisig** | `chronolog/permissions` (`multisigMembers`) | `true` | High-trust team vaults, treasuries, or shared workspaces where membership changes require `M` of `N` signer approvals (`propose` / `approve` / `cancel`). | Show active `M-of-N` threshold and pending proposal count. |
| **Custom ES Module** | Any hash-pinned ES Module in `$reducers` | `true` or `false` | Custom reputation, token-gated, invite-tree, or time-bounded access policies. | Describe the custom policy clearly to visitors. |

On `openMembers` pages (`openRead: true`), anonymous visitors automatically connect with `openPublic` read access (never needing GitHub/Google sign-in), and `createAdmission` resolves immediately to `phase: 'admitted'` (`canWrite` reflects `openWrite` or explicit writer membership). Host management (`_tendril/manage`), Hosted MCP (`_tendril/mcp/*`), outbound OAuth (`_tendril/connections/*`), and org-groups (`_tendril/groups/*`) remain strictly `403` for anonymous `openPublic` callers.

CLI shortcuts:
- `npm run init -- <slug> --authority open --open-write false` (public read-only)
- `npm run init -- <slug> --authority open` (public read & write)
- `npm run init -- <slug> --authority multisig --signers <pk1,pk2> --threshold 2`
- `tendril permissions set-open '{"openRead":true,"openWrite":false}' --operation perm-1`
- `tendril permissions multisig-propose '{"kind":"setMember","member":{...}}' --operation ms-1`
- `tendril permissions multisig-approve <proposalId> --operation ms-2`

## Row-level application permissions (`chronolog/rls`)

Cryptographic membership (`reader`, `writer`, `administrator`, `publisher`, `finalizer`) is independent of fine-grained SQL permissions. Inside any `chronolog:sqlite` reducer, install expressive Postgres-style write RLS triggers with `applyRls(db, policies)` using `actor()`, `op_id()`, and `op_time()` — and optionally let non-admin writers create, index, alter, and drop their own tables via `ensureTableOwners` / `getOwnedTables` / `recordTableOwners`! See [State models](STATE_MODELS.md).
