# Application and host participation

The application has one owned Chronolog session API. Its coordinating peer, replicas and host control participant exchange protocol updates through transports with explicit roles and interests. A process being a server, browser or native agent does not select a different application implementation.

## Normal work

A current-generation coordinator orders commands. Connected peers replicate authenticated history, execute the same application definition and expose coherent applied views. Live signals use the session's ephemeral facet. Direct RTC and WebSocket relay connections carry the same authenticated encrypted peer channels and application protocol. Direct traffic bypasses the host; relayed ciphertext consumes host bandwidth.

The browser owns durable execution and replication in a Worker. A native agent owns a native session. Both use the same command/query/operation/status/recovery surface and signing device identity. Tendriller's browser adapter supplies that session to the page; it installs once and has no failover backend.

## Light host role

The host's common participant transport permits only signed control, public definition/code publication, bounded discovery and connection invitations. It rejects database submission/history, generic content chunks and live UI signals before dispatch. The SDK applies the same filter before HTTP.

The host stores signed metadata and immutable code. Its separate relay transport forwards bounded opaque ciphertext without retaining application payloads or acquiring a reader grant. It keeps a persistent descriptor and public definition so the creator is not a special bootstrap dependency. Code publication uses signed monotonic ancestry independently from lossy application history.

## Availability and recovery

A resident page means control metadata and code remain hosted. It does not require a permanent native process or always-on coordinating peer. A reachable browser or native peer may coordinate according to its grant. Discovery records are expiring hints; verify peers and history through Chronolog.

A hibernatable invitation listener receives only small on-demand connection requests without a heartbeat. Bounded rendezvous exchanges one offer and one answer, then closes. A failed direct attempt can open the dedicated relay, which pairs reliable and disposable lanes independently. Host transport receipts bound relay egress; an alarm revalidates account admission at most every 30 seconds. The session owns reconnect and recovery for both transports.

If the host disappears while a coordinator remains reachable over a direct connection, normal application work continues. Relayed connections require the relay to remain available. If no coordinator is reachable, a session retains its signed attempts and waits for explicit recovery/control availability. Recovery adopts a complete authenticated prefix, makes the selected generation visible, and reports abandoned suffix or unknown loss. There is no automatic old-branch merge.

## Evidence

Core Worker tests exercise actual account authorization, policy rejection, signed control/code storage and restart. Runtime tests cover quiet construction, explicit bindings, sensor cancellation and immutable offline code. Contrib's independent qualification combines packed Chronolog sessions, actual RTC and the public workerd fixture. Distinguish those boundaries from deployment, Internet routing, physical devices and measured operating cost.
