# The application session contract

New application? Start with [Build an app](BUILD_AN_APP.md) and its [complete session bootstrap](SESSION_BOOTSTRAP.md). This reference explains the contract implemented by that session.

Every application uses the same owned Chronolog session and one Tendriller binding. `ApplicationSelection` contains only `{id}`. There is no execution-profile discriminator or host fallback.

## Installation

```js
import { createApplicationBackend } from '@chronolog/peer-session/tendriller';
const application = createApplicationBackend(session);
tendril.application.install(application);
const installed = await tendril.application.ready();
```

The ID must equal the session's pinned application ID. Installation is single-assignment. `available` and `ready()` describe whether the adapter is installed, not whether peers are reachable or operations are synchronized. `session.identity.publicKey` is the signing identity.

## Owned local storage and materialization

Passive package imports do not open a database. Explicitly opening a device and
calling `createApplicationSession` opens its owned local storage and cached
authority. Materialization warms independently of the first command or query;
received authenticated operations can also trigger replay. Do not rely on the
database remaining `idle` until the page asks for data.

Install the owning Worker's session when the page starts. Installing its backend
and awaiting `application.ready()` indicate adapter installation, not successful
materialization, peer connectivity or finality. Local signing and storage
prerequisites determine whether Save is available. A missing peer, failed view
query or unavailable finalizer must not disable independent local authoring.

The device owns its signing identity, exclusive storage lock, pinned record
backend and signed journal. Existing storage resumes with the same identity and
backend; a failure must not silently switch storage or create an empty replacement
history. Explicit new-device capability checks choose a supported backend before
initialization. There is no migration or in-memory durability fallback.

SQL engine selection is explicit: provide `createMaterializer` when opening the
session and import/create the engine within that factory. The `/sql` factory is
`createSqlMaterializationRuntime({ engine, path, rootPrincipal })`. Platform trust
initialization does not freeze application tables; ordinary authorized signed
transactions create and change schema.

`status.database` reports `idle`, `opening`, `ready`, `failed` or `closed`, separately
from protocol connectivity. Inspect `materializationError` for an operational
failure and keep retained original operations and drafts visible. Missing keys
require explicit provisioning, never replacement signing identities or keys.
A device never needs a coordinator to author or read its own operations.

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

Native agents use the session directly. Browser code owns its session in a Worker and uses the public Worker facade. Both expose the same operation, query and status model. The Tendriller adapter changes API composition, not application semantics.

## Mandatory behavior

| Surface | Meaning |
| --- | --- |
| `submit({program,operationId?,authorTimestampMs?})` | Sign and durably store one authored operation; success means stored locally, not executed or delivered |
| `operations.get(operationId)`, `.retry(operationId)` | Inspect or exactly retry the retained signed intent |
| `operations.subscribe({operationId})` | Observe stored, materialized, retained and finalized state changes |
| `readView()` | Capture one coherent materialized revision for query and event reads |
| `changes()` | Coalesced `materialized`, `finalized` and `dependency` invalidations with revised proposal IDs |
| `status`, `onStatus(...)` | Session phase, database state, pending dependencies, `canAuthor` and connected peers |
| `events.read(...)`, `events.publish(topic, payload)` | Read emitted facts from a captured view; publish through a declared event path |

The adapter derives SQL query availability from the session's materializer capabilities. `eventCommand` names an ordinary declared command accepting `{topic,payload}`; it enables `events.publish`. An unspecified event command does not create a hidden generic write path.

## Outcomes and reads

A `stored` operation retains its signed intent locally, with its operation ID, proposal ID and author timestamp. A `materialized` operation records an accepted or rejected outcome, rejection code and failing statement index at one revision. Rejected operations still keep their signed intent. A missing body, key or authority predecessor is a pending dependency, not a rejection. `retained()` reports signed peer availability evidence, and `finalized()` requires a configured finality policy (it rejects as unsupported under `none`). The facts are independent.

A read view captures a `local` (or, with finality, `final`) view and a revision `{digest, view, executionManifestDigest, policyDigest}`. Read query results and events from that view, then release it. Query results arrive as `{applicationId, revision, value}`. Coalesced change notifications tell a consumer to capture another view; they are not a replay log. An event cursor is consumer delivery progress bound to its revision and must be committed atomically with the consumer's own work.

A late operation with an earlier author time can revise outcomes that were previously reported, and a configured closed-time frontier can exclude a first-seen older operation (`inspect().excluded`). The operation keeps its original signed intent and evidence. Expose the revision change and rederive from a coherent snapshot. There is no reapplication API. If intent is still wanted, the person reviews and submits a new operation, and the old one is never silently retimestamped.

For a complete native `changes()` → `readView()` → `readEvents()` loop with `await view.release()` in `finally`, cancellation and handled checkpoints, see [native event-consumer lifetime](AGENT_RESTART.md#native-event-reads-and-captured-view-lifetime). Read events from the captured view, not `session.readEvents()`, and acquire a new view after invalidation; a captured view is not an updating subscription.

## Host authority connection

The host exposes signed authority metadata and publications through `tendril.host.peers` (see [Authority records and signed publications](AUTHORITY_AND_PUBLICATIONS.md)). A session verifies and retains that evidence with `session.mergeAuthority(bundle)`, and code release uses the independent publisher flow. Local authoring, materialization and peer replication continue while the host is unavailable. Host availability affects only fetching newer authority evidence, enrollment and publication.


## Owned participation

Call `participateApplication(session, {peers, openDirectConnection})` from `@tendriller/core/participation` once after local opening. It returns immediately with `status`, `onStatus`, `reconsiderConnections()`, `resume()` and `close()`. It owns connection attempts, direct/relay selection, reconnect and bounded retry budgets over the host's introductions. Applications do not implement a second policy loop, and there is no coordinator or recovery selection. It never blocks Save. See [peer participation](PEER_CONNECTIONS.md).
