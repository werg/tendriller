# Browser attachment transport

SharedWorker attachments use private MessagePorts. When SharedWorker is unavailable,
the elected dedicated Worker holds the same exclusive profile Web Lock and exposes
private attachment ports through the maintained BroadcastChannel transport.
The fallback protocol is `tendriller/browser-owner/v2`. Version 1 plaintext routes
are incompatible and are not accepted by version 2 owners.

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

Application frames, command arguments, results, page context, binary content and
the facade handshake are encrypted. Observing a route UUID, public key, nonce or
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

The transport admits at most 32 routes by default, including pending handshakes.
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
binary/integer fidelity, owner death, suspension and handshake timeout. The separate
Chromium fixture qualifies SharedWorker and elected-owner composition with actual
browser storage. Those tests do not establish mobile suspension, Internet RTC, or
external-provider behavior.
