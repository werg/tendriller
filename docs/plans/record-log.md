# Retained record log implementation plan

## Goal

Provide a small durable opaque record log for peer applications. Keep SQL, signed
membership, order certificates, and database finality in the consuming application.
This is an unreleased architecture: change interfaces directly and avoid migration
or compatibility layers.

## Public contract

- One retained history per owned resident Tendril.
- Content-address exact bytes with SHA-256.
- Append atomically stores bytes, their original position, the deduplication index,
  and the rolling root. Retrying identical bytes returns the original entry.
- The root commits to the history identity, contiguous sequence, previous root,
  and content digest using a documented domain-separated canonical encoding.
- Bounded reads include the descriptor and committed head. Wrong histories,
  missing ranges, oversized records, and exhausted quotas fail explicitly.
- Watch delivers wake-up hints over existing connections; retained reads provide
  recovery. Delivery cursors never represent application progress.
- Retain all entries for the Tendril lifetime. Publishing a page version does
  not reset the history. Provisioning requires owned resident lifetime.

## Implementation checkpoints

- [x] Record the plan and open a draft PR before implementation.
- [ ] Add public types, encoding, limits, and integrity test vectors.
- [ ] Implement atomic retained storage and durable exact-byte deduplication.
- [ ] Add authenticated append/range/head routes and owner/agent access checks.
- [ ] Add public native/browser clients and headless runtime hint integration.
- [ ] Exercise retries, process restart, concurrent appends, rollback, quota,
      catch-up, history identity, and authorization through public boundaries.
- [ ] Package and verify public artifacts used by the optional Chronolog adapter.
- [ ] Update documentation, integration recipe, and final verification results.

## Collaboration and verification

Commit and publish small coherent increments throughout the implementation.
Update the paired PRs as checkpoints complete. Use the current default branch
as the base; preserve independent concurrent work.

Run contract generation/checks, TypeScript checks, runtime tests, actual Worker
storage/access tests, public package consumer tests, and dependency-boundary
checks. Cross-repository integration must consume packaged public exports.

## Explicit boundaries

The optional authority handler belongs to Chronolog and composes around the public
engine handler. Tendriller core must not import Chronolog or store authority keys,
database grants, SQL state, or certificate interpretations. No per-append signing
queue, snapshot service, compaction, automatic failover, or cross-account host
administration is part of this change.

## Status

Planning scaffold. Implementation and verification are tracked above; unchecked
items are not claimed as complete.
