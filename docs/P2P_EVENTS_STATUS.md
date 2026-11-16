# P2P application backend implementation checkpoint

This branch implements the 16 November 2026 P2P events follow-up. Work remains in progress; this checkpoint is intended to make the PR resumable.

Implemented in this checkpoint:

- One immutable selected application backend per page, a public installation/readiness boundary, opaque event continuations and revision-scoped read handles.
- A Cloudflare implementation of the same boundary with atomic state/event programs, retained accepted and rejected operation receipts, exact retry identity, scope/generation checks, and the existing durable browser outbox.
- Peer-selected pages disable Cloudflare application state, conversation, timer, and stream authority while retaining host facilities.
- A separate public binary peer connection/relay and bootstrap facility, bounded record/control/signal frames, receiver credit, and measured transport counters.

Verified through the transport-hardening checkpoint: TypeScript checks; 12 application/peer contract tests; five real Worker application tests and four actual paired relay tests; 64 runtime durability tests. Coverage includes receiver credits, readiness cancellation, revoked host credentials, exact retry after malformed receipts, retained rejected drafts, and revision/cursor reads. The complete `npm run check` gate passes: 776 tests (57 build/deployment, 67 contract, 167 runtime, 5 push, 346 Worker, 134 tools), plus TypeScript, package boundaries, builds, and a clean isolated consumer of the packed public SDK/runtime/engine. Public API and deployment documentation are current.

Remaining before completion: Chronolog adapter implementation and cross-repository integration, browser qualification. The complete core gate is passed. Direct public-agent, WebRTC, and Iroh measurements remain explicit follow-up experiments; the implementation claims no production NAT success rate or cost saving. Release artifacts now identify rc.9/schema 7; deployment resources have not been advanced or deployed.
