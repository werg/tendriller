# P2P application backend implementation checkpoint

This branch implements the 16 November 2026 P2P events follow-up. Work remains in progress; this checkpoint is intended to make the PR resumable.

Implemented in this checkpoint:

- One immutable selected application backend per page, a public installation/readiness boundary, opaque event continuations and revision-scoped read handles.
- A Cloudflare implementation of the same boundary with atomic state/event programs, retained accepted and rejected operation receipts, exact retry identity, scope/generation checks, and the existing durable browser outbox.
- Peer-selected pages disable Cloudflare application state, conversation, timer, and stream authority while retaining host facilities.
- A separate public binary peer connection/relay and bootstrap facility, bounded record/control/signal frames, receiver credit, and measured transport counters.

Verified before this checkpoint: TypeScript checks; eight contract unit tests; five real Worker application tests; 63 existing runtime durability/capability tests. New runtime coverage and the full release gate will run in the next increment.

Remaining before completion: relay integration hardening and tests, public package consumer coverage and API documentation, Chronolog adapter implementation and integration, and the full release gate. Release artifacts now identify rc.9/schema 7; deployment resources have not been advanced or deployed.
