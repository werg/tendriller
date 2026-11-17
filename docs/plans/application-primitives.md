# Application primitives: architecture refactor

This is the architecture review plan spanning Tendriller
PR #35, Chronolog PR #1 and contrib PR #13. It describes the target contract;
the checked items below distinguish implemented work from decisions. Global
signed-author timestamp ordering is the shared ordering rule.

## Requirements

- Live messages work without a database, durable operation ID, transaction,
  finality service, or reconnect outbox. Presence, samples, previews, chunks,
  and live control have the same small `send` / `subscribe` interface.
- An offline durable intent retains its exact authored identity and reviewed
  guards. Queued does not mean accepted. A first inclusion behind closed author
  time is a visible rejection; a new attempt requires deliberate review and a
  new identity. An exact retry of included work recovers its original result.
- Every live collaboration replica has one immutable final prefix and one replaceable local suffix.
  Rollback and redo rebuild local state; they never repeat network effects.
- The host, membership administrator, finality signers, schema administrator,
  row owners, and effect workers have explicit independent powers.
- Transport choice changes reachability, not authority, durability or identity.
  Bulk catch-up must not put expiring live traffic behind large history bodies.
- Current guides describe one system. Removed prerelease protocols need neither
  aliases nor migration machinery.

## Durable history

Live collaboration is the default Tendriller interpretation. A future async
branch/merge interpretation has no finality at all: no final frontier, final view,
final/provisional outcomes or final-intent consumer. Signed operations, timestamp
ordering and deterministic replay are shared primitives; finality belongs only
to the live policy. This refactor does not implement a speculative branch API.

Chronolog orders accepted proposals by signed author time, signing key and stable
proposal identity. Arrival order and relay choice do not change that order.
Finality closes an immutable chronological prefix; later admissible work can
reorder only the provisional suffix.

Strict original-timestamp ordering, an immutable final prefix, and unconditional
admission of arbitrarily late old proposals cannot all be promised together.
Keep the first two explicit. Separate retry from newly authored intent, and keep
observation time as application data when a new attempt must refer to older work.

The architectural target is one execution/replay pipeline fed by verified
admission decisions, closed author time, governance activation and completeness
dependencies. Validator and signed-inclusion proof mechanisms have different
trust and availability assumptions; their adapters own those differences.
The shared interface must not expose one provider's receipt layout as if it
were universal. Closing time must account for potentially completable partial
validator votes as well as missing records and wholly new proposals.

Signed controls follow causal revision chains with authenticated timestamp
activation boundaries. An exact retry preserves its original decision through
later revocation. Missing proof, bodies or keys mean pending progress, not
invented rejection. Certified inclusion remains distinct from successful
deterministic execution. Finality service, membership and application execution
are independent roles even when deployed in one process.

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
- [x] Preserve timestamp ordering as the architectural review baseline.
- [ ] Unify timestamp finality inputs and execution/replay boundaries.
- [x] Give peer live messages an independent bounded transport lane.
- [x] Supply the common hosted live-message adapter and author guidance.
- [ ] Exercise offline inclusion, revocation, replay, restart, final effects,
  and live messages during bulk synchronization through public interfaces.
- [ ] Refresh portable artifacts and cross-repository qualification.

Source-pinned historical qualification remains evidence for its recorded
revision. Changes need new evidence at their actual source revision.
