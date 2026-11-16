# P2P application backend implementation checkpoint

This branch implements the Tendriller boundary in the 16 November 2026 P2P
events follow-up. The default Cloudflare Durable Object runs a portable,
bandwidth-thin membership administrator. The earlier complete public
workerd/native/browser qualification passed at the exact pins recorded below.
The subsequent review and dependency checkpoint is recorded separately.

## Implemented boundaries

- One immutable selected application backend per page, a public
  installation/readiness boundary, opaque event continuations and
  revision-scoped read handles.
- A Cloudflare implementation of that boundary with atomic state/event
  programs, retained accepted and rejected receipts, exact retry identity,
  scope/generation checks, and the existing durable browser outbox.
- Peer-selected pages disable Cloudflare application state, conversation,
  timer, and stream authority while retaining host facilities.
- A public binary peer connection/relay and bootstrap facility, bounded
  record/control/signal frames, receiver credit, and measured transport counters.
- Default membership administration on owned resident peer pages: durable
  root/key state, account-bound signed device requests, explicit owner
  decisions, certified bootstrap history, and recoverable revoke/rotate.
  Native ordering and SQL schema administration have separately pinned public
  keys. Application bodies remain detached and travel between full replicas.

There is one ordered ledger. Its application records contain small typed
hash descriptors; signed membership and key-delivery operations are inline.
The administrator follows and verifies those descriptors without fetching
application bodies or loading SQL. Devices keep their private signing and
reader keys. The administrator retains shared epoch keys to wrap for approved
public keys and remains trusted with those keys.

## Review and dependency checkpoint

The review adds exact application receipt recovery after host authorization
failures, repeated and concurrent exact-operation callers, ordered relay
forwarding across asynchronous authorization, retired pair isolation, stricter
public snapshot/hash contracts, and resumable resident-lifetime changes that
cannot race membership or retained-log provisioning into expiring storage.

The current embedded administrator comes from clean Chronolog source
`d3b97d0aaedbb95407e09de524fc37b2b30073bd`, with 56 audited portable inputs.
It includes the follow-up ledger, governance, peer-recovery and explicit
device-identity reopening corrections, plus atomic membership-page ingestion.
The upstream checkpoint also initializes browser feed storage before making keys
usable, fences uncertain feed writes until reopening, and refuses to restart a
native authority history beneath its retained configuration or certificate.
Connection-bound cleanup prevents a stale session from detaching a newer route.
An unchanged verified prefix performs no durable ledger write. A changed bounded
page validates and commits together; late invalid input or failed storage cannot
publish partial progress.

The [native cost review](https://github.com/werg/tendriller-contrib/blob/d6e27d660feac31175cf0dc34c9fce18494378d2/cookbooks/run-a-peer-application/notes/membership-cost-review-2026-11-16.md)
records the source-pinned `8e497555` to `c5edba7d` batching change: 104 to 65
administrator puts and 502,606 to 131,441 logical value bytes written, with the
same 35,812 retained value bytes.
These are native workload measurements, not provider billing. The full retained
history and recipient key-wrap costs remain explicit.
The earlier full CI numbers below describe their explicitly identified source
pins; current review validation is recorded in the PR description.

## Earlier verified implementation

Tendriller implementation head
[`43cac4e75b0bbe1e422f4879b7249d6db5988440`](https://github.com/werg/tendriller/commit/43cac4e75b0bbe1e422f4879b7249d6db5988440)
pins clean portable membership source `46b72ebc1c69f71b4cabab744ef19c6a4e50dfec`.
[Public service run 43938435186](https://github.com/werg/tendriller/actions/runs/43938435186)
passed on Node 22.15.0 and Node 24 with that final artifact. Both jobs passed
the complete 780-test `npm run check`: 57 build/deployment, 69 contract,
167 runtime, five push, 349 Worker and 133 tools tests. TypeScript, generated
contracts, dependency boundaries, builds and the independent packed
SDK/runtime/engine consumer passed. The Node 24 real-browser gate also passed.
[Pinned speech model run 43938435010](https://github.com/werg/tendriller/actions/runs/43938435010)
passed; deployment jobs were skipped.

The Worker tests exercise real durable storage, account-bound enrollment,
revoked read authorization during asynchronous work, exact retries, and forced
Durable Object restart. The strict independent consumer checks the exact
embedded membership provenance and requires no external Chronolog runtime
package or private checkout.

## Complete thin-administrator qualification

[Chronolog browser run 43940378818](https://github.com/werg/chronolog-db/actions/runs/43940378818)
passed at authored head `5cfa04440029c24d4313e7b8e88e593952180adb`, tested merge
`43efd510001c2608bc1e28ee4c7d100cb34c773b`. It uses the Tendriller and membership
pins above, public contrib source `a3797d528d3bbbc649cda637e1e465105ea86c1c`,
real workerd, a native ordering/application peer and fresh Chromium/OPFS devices.
Seven runtime assertions plus the independent build/import audit passed.

The scenario verifies reviewed account-bound enrollment, self-approval and
cross-account refusal, exact approval retry after a lost reply and forced host
restart, certified grant/key bootstrap before application readiness,
authenticated P2P body transfer, direct-path writer revocation, original
accepted/rejected identity after abrupt OPFS restart, and reader revocation
with future epoch keys withheld. Chromium reported no page errors.

| Controlled workload | Application envelope bytes | Candidate descriptor bytes |
| --- | ---: | ---: |
| Four 16-byte SQL payloads | 2,668 | 568 |
| Four 192 KiB SQL payloads | 789,092 | 576 |
| Eight 16-byte SQL payloads | 5,320 | 1,136 |

The administrator received **zero application envelope bytes**. Across the
complete scenario its signed native endpoint traffic was 21 requests, 13,115
request bytes and 26,251 response bytes. These are fixture measurements of
encoded protocol traffic, not provider billing or HTTP/TLS overhead. They
show dependence on operation count rather than application body size; control
records and recipient key wraps still contribute traffic.

The same workflow separately passed four native/WASM tests, seven SQL-free
browser checks, eight SQL/OPFS lifecycle checks, five public retained-log/peer
bridge checks and all eight checks of the two-layout application pilot. Those
layouts use pregranted devices; the fresh-device enrollment evidence comes
from the thin-administrator scenario. The application pilot recorded one
effect dispatch and zero host application writes.

[Artifact 14262634338](https://github.com/werg/chronolog-db/actions/runs/43940378818/artifacts/14262634338)
has SHA-256 `910ac51584c70818dcbf93c945a0766abc01ecaa16c168f80b7cf6810e2b877d`.
The [contrib evidence](https://github.com/werg/tendriller-contrib/blob/feat/chronolog-application-log/cookbooks/run-a-peer-application/notes/thin-membership-administration.md)
preserves the reports, package hashes and scenario limits.

## Deployment scope

Direct public-agent, WebRTC and Iroh route measurements, paired provider cost,
authority volume-loss/restore drills and deployed device/privacy qualification
remain in contrib issues
[#14](https://github.com/werg/tendriller-contrib/issues/14),
[#15](https://github.com/werg/tendriller-contrib/issues/15),
[#16](https://github.com/werg/tendriller-contrib/issues/16) and
[#17](https://github.com/werg/tendriller-contrib/issues/17).
The [deployment qualification handoff](https://github.com/werg/tendriller-contrib/blob/4dbd25cf2200f3a42cf82b5b1569d8fc1594bceb/cookbooks/run-a-peer-application/notes/deployment-qualification-handoff.md)
lists the required environments, commands, preserved evidence and completion
criteria for those remaining checks.
The implementation claims no production NAT success rate or cost saving.
Release artifacts identify rc.9/schema 8; deployment resources have not been
advanced or deployed. [Membership documentation](MEMBERSHIP.md) records the
API, bootstrap order, trust boundary, quotas and fresh storage requirement.
