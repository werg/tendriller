# Application and host participation

The application has one owned Chronolog session API. Its coordinating peer, replicas and host control participant exchange protocol updates through transports with explicit roles and interests. A process being a server, browser or native agent does not select a different application implementation.

## Normal work

A current-generation coordinator orders commands. Connected peers replicate authenticated history, execute the same application definition and expose coherent applied views. Live signals use the session's ephemeral facet. These operations use peer connections and do not contact the Tendriller host by default.

The browser owns durable execution and replication in a Worker. A native agent owns a native session. Both use the same command/query/operation/status/recovery surface and signing device identity. Tendriller's browser adapter supplies that session to the page; it installs once and has no failover backend.

## Light host role

The host's common participant transport permits only signed control, public definition/code publication, bounded discovery and connection invitations. It rejects database submission/history, generic content chunks and live UI signals before dispatch. The SDK applies the same filter before HTTP.

The host stores signed metadata and immutable code, not ordinary application bodies. It keeps a persistent descriptor and public definition so the creator is not a special bootstrap dependency. Code publication uses signed monotonic ancestry independently from lossy application history.

## Availability and recovery

A resident page means control metadata and code remain hosted. It does not require a permanent native process or always-on coordinating peer. A reachable browser or native peer may coordinate according to its grant. Discovery records are expiring hints; verify peers and history through Chronolog.

No heartbeat or polling is needed for an idle healthy host connection. A hibernatable invitation listener receives only small on-demand connection requests. Bounded rendezvous exchanges one offer and one answer, then closes. Ordinary peer traffic cannot reuse it as a binary relay.

If the host disappears while a coordinator remains reachable, normal application work continues. If the coordinator also disappears, a session retains its signed attempts and waits for explicit recovery/control availability. Recovery adopts a complete authenticated prefix, makes the selected generation visible, and reports abandoned suffix or unknown loss. There is no automatic old-branch merge.

## Evidence

Core Worker tests exercise actual account authorization, policy rejection, signed control/code storage and restart. Runtime tests cover quiet construction, explicit bindings, sensor cancellation and immutable offline code. Contrib's independent qualification combines packed Chronolog sessions, actual RTC and the public workerd fixture. Distinguish those boundaries from deployment, Internet routing, physical devices and measured operating cost.
