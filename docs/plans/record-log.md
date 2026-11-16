# Retained record log implementation plan

## Goal

Provide a small durable opaque record log for peer applications. Keep SQL, signed
membership, inclusion certificates, and database finality in the consuming application.
This is an unreleased architecture: change interfaces directly and avoid migration
or compatibility layers.

## Public contract

- One retained history per owned resident Tendril.
- Content-address exact bytes with SHA-256.
- Append atomically stores bytes, their original position, the deduplication index,
  and the rolling root. Retrying identical bytes returns the original entry.
- Optional `expectedHead: { position, root }` makes a new append conditional on
  that exact predecessor. A concurrent append returns `record_head_conflict`
  without writing anything; an exact retry still returns its original entry.
  Consumers use this primitive to retain a statement about a preceding prefix
  without racing another writer. The log does not interpret that statement.
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
- [x] Add public types, encoding, limits, and integrity test vectors.
- [x] Implement atomic retained storage and durable exact-byte deduplication.
- [x] Add authenticated append/range/head routes and owner/agent access checks.
- [x] Add public native/browser clients and headless runtime hint integration.
- [x] Exercise retries, process restart, concurrent appends, rollback, quota,
      catch-up, history identity, and authorization through public boundaries.
- [x] Package and verify public artifacts used by the optional Chronolog adapter.
- [x] Update documentation, integration recipe, and final verification results.

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

## Original retained-log checkpoint

The retained-log implementation and public consumer checks are complete. The
optional Chronolog adapter consumes the packed public SDK and engine; its tests
cover authenticated authority composition, lost append responses, recovery,
certificate separation, and replay of competing SQL proposals through the
portable history verifier. No Chronolog module enters Tendriller's core graph.

The final integration preserves the state, timer, sensor, and deployment work
merged independently through PR #34. The combined release uses artifact version
`0.3.0-rc.8` and fresh page storage revision `6`. Revision-5 namespaces are
rejected before mutation; no page-state translation or service deployment is part
of this change. The record format remains `record-log/v1` with the same public
encoding and integrity vectors.

Verification of the combined source: `npm run check` passes all 750 tests (57
build/deployment checks, 55 contract, 162 runtime, 5 push, 337 Worker, and 134
tools), plus TypeScript, dependency boundaries, and an isolated consumer of the
packed SDK, runtime, and engine with strict declarations. This check does not
claim a live deployment or replace the separate browser release gate.

## P2P events follow-up

The 16 November follow-up makes native Chronolog the preferred application
history and authority for a resident agent. The Cloudflare retained log remains
optional. The new public application and peer boundaries are documented in
[application backends](../APPLICATION_BACKENDS.md) and
[peer connections](../PEER_CONNECTIONS.md). Current verification and remaining
work are recorded in [the implementation checkpoint](../P2P_EVENTS_STATUS.md).
This increment uses rc.9 and fresh page schema 8, with no legacy migration. The
default portable [membership administrator](../MEMBERSHIP.md) verifies the small
native ledger while full replicas fetch detached application bodies.
