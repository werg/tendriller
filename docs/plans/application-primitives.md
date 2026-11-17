# Application primitives: architecture refactor

This is the implementation plan for the prerelease review spanning Tendriller
PR #35, Chronolog PR #1 and contrib PR #13. It describes the target contract;
the checked items below distinguish implemented work from decisions.

## Requirements

- Live messages work without a database, durable operation ID, transaction,
  finality service, or reconnect outbox. Presence, samples, previews, chunks,
  and live control have the same small `send` / `subscribe` interface.
- An offline durable intent retains its exact authored identity. Age alone
  must not reject it; current authorization and explicit application conditions
  determine whether the intent can succeed when included.
- Every replica has one immutable final prefix and one replaceable local suffix.
  Rollback and redo rebuild local state; they never repeat network effects.
- The host, membership administrator, finality signers, schema administrator,
  row owners, and effect workers have explicit independent powers.
- Transport choice changes reachability, not authority, durability or identity.
  Bulk catch-up must not put expiring live traffic behind large history bodies.
- Current guides describe one system. Removed prerelease protocols need neither
  aliases nor migration machinery.

## Durable history

Chronolog will finalize a chain of exact batches. Each batch binds its number,
predecessor and included records. Peers concatenate finalized batches and use
the protocol's deterministic ordering within each batch. The signed author time
is retained metadata and a deterministic tie-breaker, never an admission deadline.
A late offline proposal enters a later batch without being re-signed or renamed.

Application work in batch N uses the finalized governance snapshot after N-1.
Signed controls in N follow their causal revision chains and activate for N+1.
An already included exact retry returns its original outcome. Newly included
work with a revoked grant or stale application generation fails explicitly.
Missing proof, bodies or keys mean pending progress, not invented rejection.

One batch certification protocol serves both one signer and a fixed set of
signers. The proposer retains its proposed batch; each required signer durably
locks one successor per predecessor before signing. A certificate contains all
configured signatures. With at least one honest signer, two conflicting batches
cannot both finalize. Finality requires every configured signer to be available;
there is no automatic failover, leader election or threshold-consensus claim.
P2P replication and provisional application work can continue while finality
is unavailable.

The old author-time closure, future-time admission, independent watermark
finality and receipt-order special cases are removed from the active model.
Certified inclusion is distinct from successful deterministic execution.

## Live messages

`Signals` is an application port with `send(topic, payload, options)` and
`subscribe(options)`. FIFO is bounded and fails visibly on subscriber overflow;
`latest` explicitly permits replacement by sender/session/topic. Messages expire,
are never replayed on reconnect, and never become evidence of durable acceptance.

The standalone Chronolog channel owns signed live envelopes and bounded routing.
Its group adapter adds current topic permissions. The hosted Tendriller adapter
uses authenticated host sessions. Both satisfy the same application contract.
Named producer streams remain a separate ingestion facility with explicit
audience and retention policy, rather than a prerequisite for live application
messages. Live P2P frames have a transport lane independent of bulk replication.

## Effects and user actions

Only final accepted intent starts an effect that requires a durable decision.
Effect workers retain processed progress and use provider idempotency or
reconciliation. Finality cannot make an external API call exactly once.
User Undo and Redo author new conditional programs; they do not rewrite history.
Live previews may accompany those operations but cannot establish their outcome.

## Implementation checkpoints

- [x] Review actual offline, agent, live-message and authority requirements.
- [x] Agree on sealed batches and explicit role boundaries across repositories.
- [ ] Replace Chronolog's active finality and governance pipelines.
- [ ] Give peer live messages an independent bounded transport lane.
- [ ] Supply the common hosted live-message adapter and author guidance.
- [ ] Exercise offline inclusion, revocation, replay, restart, final effects,
  and live messages during bulk synchronization through public interfaces.
- [ ] Refresh portable artifacts and cross-repository qualification.

Source-pinned historical qualification remains evidence for its recorded
revision. It is not evidence for the new protocol.
