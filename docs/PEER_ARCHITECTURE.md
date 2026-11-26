# Application and host participation

The application has one owned Chronolog session API. Browser Workers, native agents and the host's authority/publication participant exchange signed facts through transports with explicit roles and interests. Being a server, browser or native agent does not select a different application implementation.

## Normal work

Application state is an authored operation set. Each participant signs, durably stores and locally materializes its own operations without waiting for any other participant. Connected peers union authenticated operations and replay the same eligible set in signed author-time order (author timestamp, signing public key, stable proposal ID). Live signals use the session's ephemeral facet. Direct RTC and WebSocket relay connections carry the same authenticated encrypted peer channels. Direct traffic bypasses the host; relayed ciphertext consumes host bandwidth.

The browser owns durable execution and replication in a Worker. A native agent owns a native session. Both use the same operation/query/status surface and a signing device identity. Tendriller's browser adapter supplies that session to the page. It installs once and has no failover backend.

## Light host role

The host's common participant transport permits only signed authority and finality records, public code publication, bounded discovery and connection invitations. It rejects database operations and history, generic content chunks and live UI signals before dispatch. The SDK applies the same filter before HTTP.

The host stores signed metadata and immutable code. Its separate relay transport forwards bounded opaque ciphertext without retaining application payloads or acquiring a reader grant. It keeps a persistent descriptor and membership chain, so the creator is not a special bootstrap dependency once any other member is admitted. Code publication uses signed monotonic ancestry that is independent of application operations.

## Availability

A resident page means authority metadata and code remain hosted. It does not require a permanent native process, an always-on peer or a finalizer. An initialized browser or native device stores and materializes operations locally with the host, peers and agents all unreachable. A fresh browser still needs admission by an online member holding the keys. Discovery records are expiring hints. Verify peers and operations through Chronolog.

A hibernatable invitation listener receives only small on-demand connection requests without a heartbeat. Bounded trickle-ICE rendezvous (`tendriller.rendezvous.v2`) exchanges SDP descriptions and candidates, then closes on `connected`; subsequent media tracks, `app:*` binary DataChannels, and ICE restarts negotiate in-band over the authenticated WebRTC link via W3C Perfect Negotiation (see [WebRTC media](WEBRTC_MEDIA.md)). A failed direct attempt can open the dedicated relay, which pairs reliable and disposable lanes independently while honestly reporting media unavailable. Host transport receipts bound relay egress, and an alarm revalidates account admission at most every 30 seconds. The session owns reconnect for both transports.

If the host disappears, direct peer connections and local work continue. Relayed connections need the relay. With no peer reachable, a session retains its signed operations and delivers them on reconnect. Union is idempotent, so a late earlier operation revises provisional outcomes and nothing is merged from an old branch. Optional finality can delay closed-time evidence without blocking authoring or provisional reads. A closed frontier can exclude a first-seen older operation, and its original intent stays inspectable.

## Evidence

Core Worker tests exercise actual account authorization, policy rejection, signed authority and code storage, and restart. Runtime tests cover quiet construction, explicit bindings, sensor cancellation and immutable offline code. Contrib's independent qualification combines packed Chronolog sessions, actual RTC and the public workerd fixture. Distinguish those boundaries from deployment, Internet routing, physical devices and measured operating cost. This documentation edit adds no new qualification result.
