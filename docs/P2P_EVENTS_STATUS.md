# P2P application backend implementation checkpoint

This branch implements the Tendriller boundary in the 16 November 2026 P2P events follow-up. The current increment adds a genuinely bandwidth-thin membership administrator, hosted by default in the existing Durable Object through a pinned public portable artifact. This checkpoint distinguishes the earlier verified boundary from the new integration's qualification work.

Implemented in this checkpoint:

- One immutable selected application backend per page, a public installation/readiness boundary, opaque event continuations and revision-scoped read handles.
- A Cloudflare implementation of the same boundary with atomic state/event programs, retained accepted and rejected operation receipts, exact retry identity, scope/generation checks, and the existing durable browser outbox.
- Peer-selected pages disable Cloudflare application state, conversation, timer, and stream authority while retaining host facilities.
- A separate public binary peer connection/relay and bootstrap facility, bounded record/control/signal frames, receiver credit, and measured transport counters.
- Default portable membership administration on owned resident peer pages: durable root/key state, account-bound signed device requests, explicit owner decisions, certified bootstrap history, and recoverable revoke/rotate. Native ordering and SQL schema administration have separately pinned public keys. Application bodies remain detached and travel between full replicas.

Verified through the earlier transport-hardening checkpoint: TypeScript checks; 12 application/peer contract tests; five real Worker application tests and four actual paired relay tests; 64 runtime durability tests. Coverage includes receiver credits, readiness cancellation, revoked host credentials, exact retry after malformed receipts, retained rejected drafts, and revision/cursor reads. Its complete `npm run check` gate passed 776 tests (57 build/deployment, 67 contract, 167 runtime, 5 push, 346 Worker, 134 tools), plus TypeScript, package boundaries, builds, and a clean isolated consumer of the packed public SDK/runtime/engine. Those results predate the current membership increment.

The original browser gate also passes on the published commit `884c553` in [Public service run 43920156434](https://github.com/werg/tendriller/actions/runs/43920156434). Both Node 22 and Node 24 jobs passed; the Node 24 job ran `npm run test:browser`. Deployment jobs were skipped. This remote result supplies the browser evidence that the local sandbox could not produce because it denies Chromium's process-singleton socket.

Chronolog supplies the application adapter and framed peer bridge using only public exports. Its native integration covers durable event publication, SQL/event rollback, rejected receipts, exact retry after revocation/restart, and pinned revision views. The portable membership unit tests cover detached payload traffic, certificate gaps, signed configuration binding, exact retries and interrupted revoke/rotate recovery. The actual packed-engine/native/browser membership qualification is being completed with the new descriptor protocol; earlier browser evidence is not presented as proof of this new path.

The current default-host increment passes all TypeScript checks, artifact builds
and dependency boundaries; two SDK client tests; four real Worker tests for
provisioning, account-bound enrollment, revoked read authorization and forced
restart; and the strict isolated SDK/runtime/engine consumer. That consumer also
checks the exact embedded membership provenance and proves that no external
Chronolog runtime package or private checkout is needed. The broader `npm run
check` gate and end-to-end native/browser enrollment qualification are still in
progress for this checkpoint.

Direct public-agent, WebRTC, and Iroh measurements remain explicit follow-up experiments; the implementation claims no production NAT success rate or cost saving. Release artifacts identify rc.9/schema 8; deployment resources have not been advanced or deployed. [Membership documentation](MEMBERSHIP.md) records the API, bootstrap order, trust boundary, quotas and fresh storage requirement.
