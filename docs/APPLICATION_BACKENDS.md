# The application session contract

Every application uses the same owned Chronolog session and one Tendriller binding. `ApplicationSelection` contains only `{id}`. There is no execution-profile discriminator or host fallback.

## Installation

```js
import { createApplicationBackend } from '@chronolog/peer-session/tendriller';
const application = createApplicationBackend({ id: session.applicationId, session });
tendril.application.install(application);
const installed = await tendril.application.ready();
```

The ID must equal the session's pinned application ID. Installation is single-assignment. `available` and `ready()` describe whether the adapter is installed, not whether peers are reachable or history is synchronized. `session.deviceId` owns the signing identity.

## Protocol first, durable data on demand

Install the normal Chronolog session when the page starts. Its authenticated peer
connections, live signals, membership/control updates and signed code publications
work while `status.database` is `idle`. Reading status or capabilities, installing
the backend, and awaiting `application.ready()` do not open an application database.

Chronolog initializes its one durable data component on the first command, query,
history read, durable content operation or other explicit data use. Concurrent
first operations share that initialization. A backend-agnostic exclusive Web Lock, the locally pinned record store,
replica, journal and materializer belong to that component. For a fresh browser
device Chronolog prefers OPFS when createWritable actually works, otherwise
uses an independently probed IndexedDB bytes store. An existing device's
backend never switches automatically after an error or browser upgrade.
The `/sql` entry accepts `createEngine({signal})`; import and create the SQL/WASM
engine inside that factory. A custom materializer uses `createMaterializer` with
the same on-demand lifecycle. The existing participant,
signing identity and peer connections continue through activation.

`status.database` reports `idle`, `opening`, `ready`, `failed` or `closed`; it is
separate from protocol connectivity. A first-use storage failure leaves the protocol
participant available and remains visible instead of silently retrying setup.
Connecting to a peer, receiving live signals or observing a database update hint
does not activate a cold follower. An authorized data request may activate the
selected coordinator that must serve it.

The browser stores only the device identity, immutable record-backend pin and
verified control/publication metadata in a small IndexedDB store before durable
data is used. It does not acquire OPFS or a database ownership lock for those
protocol responsibilities. The separate record database is OPFS or
`chronolog-data:<name>` IndexedDB, selected only on the first data use.
Existing OPFS stores (including possible pre-upgrade interrupted writes) are
retained as OPFS or fail explicitly; losing one storage surface cannot generate
an empty history with the old identity. This metadata is necessary for stable
identity and monotonic signed control; it is not a temporary journal to migrate
later. There is no unapproved record migration or in-memory durability fallback.

The owning Worker exposes `probeBrowserCapabilities()` from the Chronolog
`/worker` entry for an **explicit** scratch-only eligibility check. It separates
native Ed25519/X25519 and Web Locks from OPFS and IndexedDB record writability.
The returned `events.backend` is only a recommendation for a *new* store, not
a reading of an existing device's immutable pin. A diagnostic does not open or
mutate a Tendriller application device; it is not an implicit enrollment,
database activation, or a proof of synchronized peers.

**SQL/WASM is independent of the record backend.** The browser SQL specimen's
separate DoltLite engine and OPFS SAH-pool VFS still require their own assets,
capability checks and qualification. An IndexedDB event journal does not make
SQL available, and a SQL-required signed definition must fail explicitly rather
than silently run as events-only. Safari 17/iPadOS 17 events-only eligibility
does **not** establish SQL support or physical-device qualification. See
[browser qualification](E2E_TESTING.md#record-storage-and-browser-eligibility).

Native agents use the session directly. Browser code owns its session in a Worker and uses the public Worker facade. Both expose the same operations and recovery model. The Tendriller adapter changes API composition, not application semantics.

## Mandatory behavior

| Surface | Meaning |
| --- | --- |
| `submit({name,input},{operationId,basedOn?})` | Submit a declared command with caller-owned retry identity |
| `operations.get(operationId)` | Inspect the retained local attempt and current state |
| `operations.subscribe(...)` | Observe meaningful operation-state changes |
| `readView()` | Capture one coherent applied revision for query and event reads |
| `changes(...)` | Coalesced invalidations, including explicit recovery resets |
| `status`, `onStatus(...)` | Session phase, selected generation, coordinator and connected peers |
| `onRecovery(...)`, `inspectRecovery()` | Observe and inspect retained recovery evidence |
| `events.read/subscribe` | Read emitted facts from captured application history |

The adapter derives SQL query availability from the session's materializer capabilities. `eventCommand` names an ordinary declared command accepting `{topic,payload}`; it enables `events.publish`. An unspecified event command does not create a hidden generic write path.

## Outcomes and reads

A saved operation retains its signed attempt locally. An applied operation records generation, author, sequence, accepted/rejected outcome and rejection code. Rejected attempts still have an ordered application outcome. A separate shared wait on the session reports peer retention coverage.

A read view captures `view:'applied'`, revision and generation. Read query results and events from that view, then release it. Coalesced change notifications tell a consumer to capture another view; they are not a replay log. An event cursor is consumer delivery progress and must be committed atomically with the consumer's own work.

Recovery can abandon a suffix previously reported applied. An affected operation becomes `abandoned` or `needsReapply` and retains its previous evidence. The new selected generation and unknown-loss flag must remain visible. Reapplication creates a new signed attempt with current guards; it never silently admits old-branch intent.

## Host control connection

```js
const control = session.connectControlParticipant({
  exchange: (message, options) => tendril.host.peers.exchange(message, options),
});
```

This is the session's control participant over an authenticated HTTP transport. It verifies authority, public definition and signed publication ancestry. Ordinary application execution and peer replication continue independently while control is unavailable, as long as the selected coordinator remains reachable. Selecting a new generation requires control availability and explicit recovery rules.


## Owned participation

Call `session.participate({control,discovery,transport,...})` once to give the session its discovery and raw connection ports. `createPeerIntroductions` from `@tendriller/core/peers` supplies those two ports for this host. The controller owns connection attempts, reconnect grace, authenticated candidate evaluation, freshness budgets and recovery selection; applications do not implement a second policy loop. Observe its status and call `approveRecovery` only for the current displayed proposal when approval is required. See [peer participation](PEER_CONNECTIONS.md).

[WebKit documents native X25519 in Safari 18.4](https://webkit.org/blog/16574/webkit-features-in-safari-18-4/). Treat Safari/iPadOS 17 as unsupported for this native-crypto path unless an actual browser passes the required probe and device checks.
