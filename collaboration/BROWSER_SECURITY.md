# Browser attachment transport

SharedWorker attachments use private MessagePorts. When SharedWorker is unavailable
or storage requires a dedicated Worker, the elected dedicated Worker holds the same exclusive profile Web Lock and exposes
private attachment ports through the maintained BroadcastChannel transport.
The maintained bootstrap and fallback protocol is `tendriller/browser-owner/v3`.
Version 1 plaintext routes and version 2 routes without the root/release lifecycle
are incompatible. Upgrade owner and client code together, close old attachments,
and explicitly reattach with the same retained profile. The unchanged exclusive
profile Web Lock fences old and new protocol versions; an upgrade never creates a
replacement signer or treats an observation timeout as permission to steal a lock.

Set `requiresDedicatedWorker: true` when the storage engine depends on APIs such
as synchronous OPFS that are qualified only in a dedicated Worker. With `mode:
'auto'`, this selects the maintained elected route before any worker or store opens.
A forced `mode: 'shared'` request fails with `OWNER_STORAGE_UNSUPPORTED` and an
actionable next step. Events-only applications continue to prefer SharedWorker.

## What a route authenticates

The owner creates an ephemeral P-256 ECDH key for its process lifetime. A new page
pins that public key together with the owner instance, creates its own ephemeral
key and random nonce, and requests a route. The owner proves possession of its
private key by encrypting a fresh random challenge using their ECDH shared secret.
HKDF-SHA-256 derives a separate final AES-256-GCM key using that challenge.

The first encrypted frame contains the application/definition handshake and page
context. The owner then allocates the Chronolog endpoint/incarnation behind one
private port. Subsequent requests and responses use the same authenticated route.
Associated data binds protocol, profile, owner instance, route, both public keys,
client nonce, direction and sequence. Distinct directional IV prefixes and strictly
increasing safe-integer sequences prevent reflection and replay. A fresh server
challenge prevents a recorded hello and old ciphertext from resurrecting a detached
endpoint, without retaining an unbounded replay ledger.

The encrypted attachment also installs a random 256-bit, one-use release capability.
The page keeps it only in memory. On a non-persisted `pagehide`, the helper
synchronously posts that capability with its owner and route identifiers. The
owner verifies it against that exact route and immediately retires the route.
No asynchronous cryptography or RPC completion is required during document teardown.
The capability permits only retirement; it cannot issue a command, resume a route,
replace an owner, or affect a sibling. It becomes observable only when disclosed
for retirement. Replays cannot affect a replacement route or a fresh challenge.

Application frames, command arguments, results, page context, binary content and
the facade handshake are encrypted. The final release capability contains no
application content and discloses only the authority to retire its already departing route. Observing a route UUID, public key, nonce or
ciphertext gives another page no authority to send as that endpoint. Plaintext
`ready`, `retired`, `failure`, and legacy `frame` messages cannot replace an already
pinned route. Authentication failures are discarded without disconnecting a sibling.

## The initial discovery trust boundary

Initial discovery still trusts the application's same-origin code and bootstrap.
Web Locks do not provide a browser attestation binding a lock holder to its script,
and this protocol does not manufacture one. An active malicious script with the
same origin can impersonate an owner during a new discovery, request its own
ordinary attachment, interfere with availability, or access origin-owned storage
where browser permissions allow it. Encrypting routes does not turn same-origin
scripts into independently authorized principals.

Use reviewed immutable owner/publication code and separate origins or independently
enrolled signing profiles when code or agents require separate authority. Owner-bound
port identity does not independently verify caller-supplied document, publication,
run, or historical JSON source claims. The Chronolog definition handshake validates
the application and immutable definition before granting a facade; the owner applies
its per-attachment command/capability policy.

## Lifetime, bounds and recovery

SharedWorker roots are bounded independently of application facades: at most 64
ports by default, including pending bootstrap roots, and at most eight concurrent
bootstrap requests per root. `rootLimits` on `serveBrowserOwner` can lower or raise
the cap up to 128 and configure pending/idle deadlines between 100 and 120,000 ms.
Pending roots expire after 30 seconds; active roots without reachability traffic
expire after 60 seconds. Explicit suspension pauses the active root deadline.

A private root lease checks reachability without changing signing ownership. A
normal wrapper detach, a direct facade `detach()`/`close()`, or a non-persisted page
navigation releases the bootstrap listener, owner attachment listener, root port
and its timer. Closing one root affects only its own facades. Repeated attach/detach
cycles therefore do not exhaust a long-lived SharedWorker. A vanished page whose
release cannot be delivered is eventually reclaimed by its bounded root/route lease.
A browser process crash can require explicit recovery; no timeout proves a safe
navigation or permits a live copied tab to take over another tab's draft.

In the elected route, explicit detach retires the page's ownership candidate. A
queued candidate cancels its lock wait without opening storage. An active owner
continues serving its authenticated sibling routes, including pending handshakes,
until the last route ends, then closes its resources and releases its lock. Physical
owner-page or worker death may still end those facades; callers reattach and inspect
the original operation reference. Direct facade close follows the same retirement
path. A true underlying session close also closes the outer owner and releases its
Web Lock only after session and composition resources finish closing.

The elected transport admits at most 32 routes by default, including pending handshakes.
Pending proofs expire after 30 seconds. Logical frames are bounded to 1 MiB, encrypted
wire frames to 2 MiB, and each directional route queue to 32 frames and 4 MiB. Existing Chronolog
request/stream/view limits still apply. Keys are non-exportable WebCrypto keys and
are never persisted with application state.

Authenticated heartbeats check only attachment reachability. The page fails its
facade closed after 15 seconds without an authenticated response by default;
`livenessTimeoutMs` configures that observation deadline between 100 and 120,000 ms.
This never releases or steals a Web Lock, elects a replacement by elapsed time,
replays a command, or creates a replacement signing profile. A crashed owner requires
an explicit reattachment and fresh discovery after the real lock has been released.
The old operation reference remains the way to inspect uncertain durable work.

Calling `suspend()` pauses the page's observation deadline and marks the surviving
attachment suspended. `resume()` checks the original binding; an invalid binding
requires reattachment. The owner reclaims an active abandoned route after 60 seconds
without authenticated traffic, preserving saved application operations. Suspended
routes retain their bounded place until they resume, explicitly detach, or the owner
ends. Neither timeout is a task cancellation or a change in signing ownership.

The Node transport tests cover sibling forgery, cross-route and cross-direction
replay, unauthenticated replacement announcements, retired-handshake replay, encoded
binary/integer fidelity, scoped release forgery/replay, owner death, suspension and
handshake timeout. Root lifecycle tests cover repeated direct detaches, bounded
pending roots, expiration, suspend/resume, underlying session cleanup and elected
candidate retirement without sibling disruption. The separate
Chromium fixture qualifies SharedWorker and elected-owner composition with actual
browser storage. Those tests do not establish mobile suspension, Internet RTC, or
external-provider behavior.
