# Host participant protocol

Tendriller is a light Chronolog participant over authenticated HTTP. The application session and host use the same request/response envelope. Transport policy and participant rights define what the host receives.

## Envelope and routes

Agent credentials use `POST /api/agent/pages/<page>/peers/<route>`. The corresponding page route is `<page_url>_tendril/peers/<route>`, authenticated by the page's account session. Both dispatch the same implementation. The routes are `application` (read and prepare), `peers/enrollment` (`challenge`, `enroll`, `enroll-agent`, `initialize`, `membership`, `admissions`, `wrap`, `wraps`), `peers/participant`, `peers/publication` (`read`, `publish`) and the relay.

Two wire encodings are in use and must not be confused. The `peers/participant` route carries a bounded signed authority/finality request as `{record: lowercaseHexBytes}`, containing canonical tagged-JSON bytes from `@chronolog/authority.encodeRecord` (not CBOR). Enrollment uses JSON action envelopes: challenge, invite and recipient inputs are JSON fields, while signed `proof`, `bundle` and `wrap` fields use the canonical record wrapper. Enrollment metadata replies are JSON containing wrapped signed authority records. The `peers/publication` route is plain JSON: `{action:"read", id?}` or `{action:"publish", publication, assets}`, where `publication` is the raw `SignedPublication` JSON value exactly as `@chronolog/authority` produced it and each asset is `{hash, bytes}` with canonical base64 `bytes`. A publication request wrapped as `{record: hex}` is not accepted, and the response is a JSON `{publication, version}` receipt. The host verifies it against the pinned descriptor and its retained authority. Application programs, ciphertext and epoch keys are never accepted. Participant replies use canonical records; publication receipts and enrollment metadata retain the JSON shapes above. Transport failures remain typed errors, and the SDK rejects unsupported requests before network I/O while the host independently enforces the same role policy. See [Authority records and signed publications](AUTHORITY_AND_PUBLICATIONS.md).

| Surface | Allowed actions | Content |
| --- | --- | --- |
| Authority (`application`, enrollment, participant) | read, prepare, challenge, enroll, enroll-agent, initialize, membership, admissions, wrap, wraps, signed participant requests | Signed descriptors, membership chain, host attestations, member-signed key wraps, optional finality proofs |
| Publication | `read`, `publish` | Immutable signed page-code release chain and assets |
| Discovery | `read`, `advertise`, `withdraw` | Bounded expiring routing hints |
| Invitations | `invite` | Small on-demand connection introduction |

Database operations, operation histories, generic content chunks and live application signals are refused. They are not retained in host tables. The host has no alternate ordinary command endpoint or application extension registry.

## Identity and authorization

The page records one independent application ID at creation. Before authority configuration it returns explicit unconfigured control state. A descriptor binds the application, root principal, authority key, execution manifest and finality policy. It does not freeze an application schema. Chronolog verifies signed authority against the pinned descriptor.

Host account access and membership grants are independent. The host attests a signed-in account's device key and wrap key (an attestation, never a membership grant); page members admit attested devices into signed membership according to its admission policy (see [session bootstrap](SESSION_BOOTSTRAP.md#admission-wire-contract)). Signed device identities author application operations and, with a publisher grant, sign code releases according to their grants. An account login alone does not become a signing device. Every mutation rechecks local account/credential revocation after asynchronous work before committing.

## Authority and ordering

A creator- or member-signed membership revision records device rights and wrap keys, an author-time activation floor, the key epoch commitment, the admission policy and invites. The host never signs one. Exact retries return retained evidence, and competing predecessors conflict. The host's declared control-only role cannot read, write, coordinate or order application operations.

Ordinary work requires no host request. Peers order operations themselves by signed author time, signing public key and stable proposal ID. Direct connections bypass the host. Fallback WebSocket connections use its opaque relay transport and consume host bandwidth. Discovery advertisements are hints, not membership or retention evidence. Clients retain signed local operations while peers are unreachable and deliver them on reconnect, so a late earlier operation can revise provisional results.

## Opaque peer relay

`GET .../peers/relay?channel=...&peerId=...&remotePeerId=...&lane=reliable|live` upgrades with `tendriller.relay.v1` after account or agent authentication. Agent credentials remain in the TLS-protected subprotocol header. Four sockets form exactly one reciprocal peer pair with separate reliable and disposable lanes. Public identity hints route the connection; Chronolog independently proves the signing identities and encrypts every post-handshake channel above the transport.

The relay parses bounded admission, sequence and recipient-receipt metadata only. It forwards application ciphertext unchanged and stores no payloads durably. Unpredictable per-packet recipient receipts bound outstanding egress; live pressure drops packets while reliable overflow closes the session. Local credential revocation is checked per packet. Account admission is valid for 30 seconds from the start of its policy read; after expiry, the next traffic triggers a shared reauthorization before forwarding. A bounded transient queue holds that traffic for at most five seconds; failure, disconnect, revocation or overflow discards it and closes the session. Idle sockets do not renew admission. Alarms still expire incomplete pairs, stalled receipts and old sessions. The filtered HTTP control participant retains its existing facet policy and never executes relayed commands.

## Signed code release

The publication manifest binds the application, publisher grant, execution manifest digest, publisher author, operation ID, monotonically increasing revision, previous release ID, HTML entry and sorted complete file graph. Assets are referenced by digest and size, with canonical media types.

The host verifies the signature and current publisher grant, checks predecessor CAS, bounds the manifest and release history, verifies all supplied bytes, and rechecks account access around storage effects. Publication rights are independent of administration, finalization and application data rights; the host's control-only identity receives no publisher grant. A single database transaction selects the immutable code version and signed publication head. A failure leaves the previous head selected.

An exact retained operation retry returns its original `{publication,version}` receipt. Changed intent under the same operation ID fails. A missing byte or stale predecessor fails explicitly. `publication/read` with `{}` returns the head; `{id}` returns that exact retained release or null. The session verifies the chain and persists the selected head separately from application operations.

The manifest's file digests cover the **authored** bytes. The host deliberately injects runtime tags (`<base>`, runtime configuration and entry) into served HTML at request time, so a browser-rendered document or a hash of the served response differs from the authored entry's signed digest by design. Verify publication by the signed manifest, publisher grant, selected receipt and authored asset hashes, never by hashing the rendered page.

Old code remains at its immutable publication URL. The host never selects old code because of health diagnostics, static review or an unsigned management action. Restore requires a new signed release. The code chain and application operations are independent.

## Storage and lifecycle

Fresh host storage contains account access, signed authority records, code versions/assets and bounded host audit metadata. It has no ordinary application state, event log, command receipts, operation history or delivery queue. File storage is content-addressed; release references retain bytes. A configured peer application retains its resident lifetime and owner account; generic claim release is rejected. Page/account deletion deliberately removes their hosted control/code resources.

One pre-release schema is supported. A mismatched existing schema is rejected before mutation; provision fresh resources. No migration, compatibility routing or alternate application pipeline is provided.
