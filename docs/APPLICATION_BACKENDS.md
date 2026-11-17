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
