# Authority records and signed publications (Chronolog v2)

Tendriller's Cloudflare Worker Durable Object acts as a **blind public-control participant** in Chronolog v2. It stores only:
- the canonical `GenesisBlock` (`v2_genesis`),
- verified public-control `SignedOperation` records (`v2_public_ops`, strictly `$*` topics),
- verified public CAS nodes (`v2_public_cas`, e.g. `$reducers` ES Module sources),
- verified finality checkpoints (`v2_checkpoints`), and
- short-lived host-signed admission attestations (`signHostAttestationV2`, evidence only).

It executes `TopicKernel({ blindHostMode: true })` over ONLY public-control operations to materialize `$permissions`, `$keys`, `$finality`, and `$publications` — bit-for-bit identical to every full replica, with zero epoch keys and zero encrypted application data.

## Host SDK operations (`@tendriller/core/authority`)

Canonical Chronolog v2 records (`GenesisBlock`, `SignedOperation`, `FinalityCheckpoint`, `SignedHostAttestationV2`) are transported as `{ record: "<lowercaseHex>" }` via `authorityRecord` / `authorityRecordBytes`.

| Method | Purpose |
| --- | --- |
| `application()` | Read selection, optional prepared config, stored `genesis` (`null` before init), blind-host `stateRoot`, `historyDigest`, `currentEpoch`, `closedThroughMs`, `hostAttestationKey`, and `admissionAccounts`. |
| `prepare(configuration)` | Optional pre-genesis metadata (`publisherKeys`, `executionProfile`, `tools`). |
| `challenge(publicKey)` / `enroll(proof, invite?)` | Signed-in browser proves its Ed25519 + X25519 keys at the exact page origin and receives a `signHostAttestationV2` attestation. |
| `enrollAgent()` | Granted agent receives a `signHostAttestationV2` attestation for its registered keys. |
| `initialize({ genesis, casNodes?, publicOps? })` | Store the creator's canonical `GenesisBlock` and public CAS nodes once; validated via blind-host `TopicKernel` before commit. |
| `syncControl({ publicOps?, casNodes?, checkpoints?, knownOpIds?, knownCasHashes? })` | Bidirectionally merge verified public-control operations, public CAS nodes, and finality checkpoints. Automatically prunes admitted pending attestations, closes revoked peer sockets, and reconciles active code releases. |
| `admissions()` | Read pending `signHostAttestationV2` records for keys not yet present in `$permissions.members`. |
| `publication(id?)` / `publish(op, assets)` | Read the current (or historical) `$publications` receipt, or submit a signed `$publications` public-control op plus canonical base64 asset bytes not already in R2. |
| `participant(record)` | Member-signed `control.sync` transport for peers. |

## Signed code releases (`$publications`) & late-revocation reconciliation

Publishing UI code is just an ordinary signed public-control operation targeting `$publications` (`chronolog/publications` standard reducer):
1. A member with `publisher: true` or `administrator: true` signs a public `$publications` op naming `entry` and the exact `{ path, hash, size, type }` file graph (with optional `expectedRevision`).
2. `publish(op, assets)` verifies the signature, checks every file path and SHA-256 hash, replays the candidate op through `TopicKernel({ blindHostMode: true })` to enforce `$permissions` and revision guards, uploads new immutable bytes to R2, and commits the DO version atomically.
3. **Provisional vs. finalized host serving rule:**
   - **When `$finality` has an active finalizing policy (`signed-frontier`, `fixed-validator`, `blockchain-anchor`):** the host only advances the served release (`current`) to releases present in the *finalized* `$publications` state!
   - **When `$finality` is `none` (default for offline-first apps):** the host serves `$publications.current` provisionally. If a late earlier revocation arrives via `syncControl` and invalidates a publisher before their release's authored timestamp, `TopicKernel` re-materializes `$publications` without that release, and `reconcileHostEffects` **immediately rolls back `current`** to the previous valid release (or unpublishes to `0`) and **closes WebSockets** for the revoked peer! (Already-downloaded browser bytes cannot be recalled retroactively, which is why high-assurance deployments enable an active `$finality` policy.)

## Live hot-swapping & URL-addressable facets

Every release is served immutably at `/_publications/<version>/` with per-file SHA-256 hashes in `_tendril/info`. When a page mounts slots (`tendril.publication.mountSlot`) or facets (`tendril.publication.mountFacets`) and a new version arrives whose changed files all belong to owned slots/facets, the runtime hot-swaps only those modules without reloading WebRTC calls or losing local state.
