# Multi-participant composition

This implementation keeps one Chronolog session and operation journal per retained
signing profile. Several browser views or local tool clients attach to that owner.
Independent agents use separately enrolled profiles when they need separate rights
or revocation. A local attachment is attribution within one signer trust boundary,
not a sandbox between hostile same-origin scripts.

The optional `@tendriller/core/collaboration` module supplies application policy;
the host and browser kernel do not import it. Its immutable SQL definition records
addressed interactions, frozen contribution slots, exclusive claims, results,
cancellation, and aggregation. Schema triggers enforce the same guards for raw
signed programs as for helper-generated commands. Verified execution identifies
the actual signer and generation. Display names and caller context confer no rights.

Live attachment identity is bound by the owner. In durable application history,
endpoint, publication and run labels are **signer assertions**: an authorized
writer can submit raw signed programs without the convenience facade. The public
queries therefore label historical source metadata `signer-asserted` and replace
its device ID with the verified execution author. They never promote a stored
`owner-bound` label into independently verified historical evidence.

Every request, current claim, result, message, cancellation and aggregate also
exposes an `operation` reference containing application ID, verified history ID, actual author,
operation ID, signed attempt ID and original generation. The schema captures
the engine's transaction identity; queries join the reserved signed execution
evidence. A writer cannot supply another attempt or overwrite that reference
with fields in JSON.

| Identity | Meaning |
| --- | --- |
| Application / page | Shared history / hosted publication handle |
| Principal / device profile | Approved human or agent / retained local signing configuration |
| Device | Actual cryptographic signer |
| Owner instance | Current process owning that profile |
| Endpoint / incarnation | Attached client / one live attachment lifetime |
| View / draft | Local editing scope, independent of signing authority |
| Agent binding / run | Independently approved gateway caller / execution attempt |
| Interaction / slot / claim epoch | Durable request / frozen contribution / current execution fence |
| Operation / attempt | Signer-scoped semantic command / original signed bytes |
| Consumer / cursor | Independent observation progress and its generation/filter scope |

## Responsibilities and guarantees

Observation may fan out. Execution requires an addressed request or an accepted
claim. One selected-history slot has at most one accepted claim; this cannot stop
CPU work or recall an external effect already dispatched by a disconnected worker.
Every generation change invalidates active old-generation fences, including claims
in an adopted prefix. Rebinding requires an explicit guarded operation.

Closing a view cancels that view's waits, streams, and captured reads. Saved work
remains in the owner's journal. Cancelling a wait, requesting task cancellation,
and accepting cancellation are separate operations. Exact retry preserves signer,
operation, payload, and attempt; reapplication creates explicit new lineage.

Results retain their original author, run, claim, and content. Late results remain
inspectable with a superseded, cancelled, or review disposition. Fan-in counts the
frozen slots, never tabs, sockets, or observed presence. All-slots, first-accepted,
and manual synthesis are explicit policies. Partial results are visible as partial.

External effects require a durable conditional journal outside recoverable history,
a stable provider idempotency key, fresh authorization, and reconciliation. A lost
receipt is outcome-unknown. No component promises exactly-once external effects.

Addressing and filtering do not restrict history readership. Private projections
need separate grants/keys or an explicitly approved sanitized export. Camera,
microphone, focus, navigation, and speech stay under the receiving view's control.

## Compose the public modules

Choose the owner route before opening the profile. Events applications can use
the default `openBrowserOwner` selection, which prefers SharedWorker and otherwise
elects a dedicated Worker using an exclusive Web Lock. The SQL/WASM engine's
synchronous OPFS storage requires a dedicated Worker in the qualified Chromium
build. Declare that requirement explicitly:

```js
import { openBrowserOwner } from '@tendriller/core/browser-owner';

const attachment = await openBrowserOwner({
  workerUrl, profileId, applicationId,
  definitionId: definition.id, definitionVersion: definition.version,
  requiresDedicatedWorker: true,
  context: { viewId, documentPath: location.pathname },
});
```

Automatic selection then uses the elected route even if SharedWorker exists.
Forcing `mode: 'shared'` with this requirement fails with
`OWNER_STORAGE_UNSUPPORTED` before opening a worker or signing store. This is an
engine capability choice; all views still attach to one fenced signer and journal.
The worker must call `serveBrowserOwner({ load: async ({ signal }) => ... })`
synchronously and perform asynchronous configuration inside `load`, so its root
message listeners exist before the first attachment arrives.

Shared roots and elected BroadcastChannel routes have a document-owned lifetime
witness, an exclusive Web Lock with a unique name derived from the profile and
root or route UUID. The page acquires it before boot or elected hello and releases it on detach or attachment failure. Hidden and frozen documents
keep the lock without page timers or heartbeats. Document destruction releases it
in the browser, even when the page cannot send a detach message.

The owner queries witnesses with one coalesced worker-local sweep while roots or
elected routes are parked (`rootLimits.parkedSweepMs`, default 60000, range 100–120000 milliseconds),
and a fresh scan before admitting another root or elected route when parked
documents exist or capacity is full. Each transport admits at most one pending
arrival, bounded by `pendingTimeoutMs`; shared boot messages remain queued until
listeners are installed, and elected endpoints retry their original hello.
A successful query must show the original lock name and client ID. A missing or
changed witness retires only that attachment and its RTC route. Query errors,
timeouts and malformed snapshots cannot establish death. They preserve existing
roots; capacity can remain busy until browser evidence becomes available. No
scan takes the owner lock, replaces the signer, or generates host/model traffic.
Healthy hidden/frozen witnesses have no fixed expiry.

Browser caching has a separate limitation: Chrome 158 can evict a BFCache entry
when another context calls `navigator.locks.query()`, reporting
`WebLocksContention`, even when it never requests the witness lock. Consequently,
back navigation may reload the document. Normal bootstrap restores its retained
profile, session history and operation identities; permanent document/endpoint
identity in BFCache is not promised. Native-CDP controls verified BFCache restore
without inspection, eviction after a SharedWorker query, lock retention while
frozen, and automatic release after document destruction. This browser-managed
lifetime mechanism prioritizes accurate discarded-root reclamation and healthy
hidden/frozen retention over back-navigation caching. It uses no Service Worker.

Create a new SQL application with `createCollaborationDefinition` as its immutable
definition. Use the exact native/WASM engine manifest and normal signed authority
bootstrap described in [State models](STATE_MODELS.md). The definition's explicit
administrator signer list is immutable policy; a participant label or presence
message never supplies administration rights.

```js
import { createCollaborationDefinition, createCollaborationClient,
  createViewStore } from '@tendriller/core/collaboration';

const definition = createCollaborationDefinition({ administrators: [ownerSigner] });
// Configure the application with this definition and its signed SQL schema.
// session below is the actual enrolled native session or owner attachment.
const store = createViewStore({ storage: localStorage,
  applicationId: session.applicationId, profileId, viewId });
const work = createCollaborationClient({ session, store });
const request = await work.request({
  interactionId: 'review-proposal-42', kind: 'review', title: 'Review proposal 42',
  input: { proposal: immutableProposal },
  target: { kind: 'workerGroup', groupId: 'reviewers', mode: 'claimOne' },
  responsePolicy: 'allSlots',
  slots: [
    { slotId: 'feasibility', eligibleSigners: [feasibilitySigner] },
    { slotId: 'risks', eligibleSigners: [riskSigner] },
  ],
}, { operationId: 'request-proposal-42' });
const applied = await request.applied();
if (applied.outcome !== 'accepted') throw Error('Inspect the rejected request');
```

Each eligible worker uses its own client to `claim` its slot with an expected
epoch. It reads the accepted claim before executing work, and submits `result`
with that exact generation, epoch, run and endpoint incarnation. A successful
command receipt alone is not proof that a result was accepted: inspect its
domain `disposition`. After review, `finalize` supplies the exact parent version
and selected result IDs. Membership changes cannot silently alter the frozen
denominator. Handoff, cancellation acknowledgement and generation rebind each
have explicit commands and fences.

Use `inspect(interactionId)` after a lost response, `waitForOutcome` for a
cancellable observation, and the returned full `operation` for exact journal
inspection. Cancelling the waiter does not call task cancellation. A completed
provider receipt is retained by `createSqliteEffectJournal` outside application
history; `createEffectDispatcher` admits one original effect identity and requires
reconciliation for uncertain dispatch. The provider integration supplies fresh
authorization and its real idempotency/reconciliation behavior.

## Bounded reads

Use `client.tasks({ limit, cursor })` for current task cards, `client.results` for
full result evidence, and `client.thread({ threadId, limit, cursor })` for a selected
conversation. Task cards include current claims and complete accepted-result
summaries, so the visible result page never changes the contribution denominator.
The legacy `snapshot()` is a bounded preview with explicit continuation metadata.

A continuation belongs to its complete captured revision, history and query
filters. If participants continue writing while someone browses several pages,
use `const reader = await client.capture()` and issue those reads through the one
reader. Close it when the view leaves or refreshes. Changing scope requires an
explicit restart; `CURSOR_RESET_REQUIRED` never silently skips changed history.
Current task versions still count all admitted task facts, including records
outside the displayed page, and continue to guard cancellation and synthesis.

Captured readers require unrestricted SQL query authority. An attachment limited
to approved named queries uses `client.tasks`, `client.results`, or `client.thread`
within its allowlist. An events grant alone does not authorize SQL, and no paging
helper broadens the attachment's capabilities.

## Membership, observation and diagnostics

`await session.authority()` returns a cloned current public signed authority
bundle from the owner, without initializing the data engine or making a host
request. Verify it against the pinned descriptor to build the roster. This
accessor needs the attachment's diagnostics capability. Combine authenticated
membership with expiring presence for display; never derive grants from presence.
`participantModel`, `receiptModel` and `mountParticipantPanel` provide optional
presentation. Participant updates preserve focused controls and selection while
revocation disables requests. They do not activate cameras, speech or navigation.

Ordinary UI refresh uses coherent queries and `session.changes`. Pure derived
state uses Chronolog projections, whose reducers may replay and must have no
external effects. A durable background handler owns a separate consumer ID and
checkpoint; filter/generation/retention changes require an explicit reset. The
gateway's scoped subscriptions and outbox implement this delivery boundary.
Observation never acquires a task claim.

With `tendril agent run` running, use the public CLI diagnostics on one page:

```sh
npx tendril --page notes self
npx tendril --page notes endpoints
npx tendril --page notes doctor
npx tendril --page notes operation ORIGINAL_OPERATION_ID
```

The agent program's page owner assigns endpoint/incarnation and binds a trusted
native credential to its stable caller namespace. A new CLI process detaches
locally after its call. A different signing profile needs its own separately
enrolled device and workspace. Failure to attach (`OWNER_UNREACHABLE`) is an
error; it never silently creates another signer.

## Bounded supported composition

The default owner admits 32 attachments, with 16 requests, eight streams and
eight captured views per attachment, subject to owner totals of 512 requests,
256 streams and 128 views. The SQL definition defaults to 32 frozen slots,
eight active claims per signer, 64 results per slot and 4,096 requests. These
limits may be reduced; increasing the domain limits requires a new qualified
definition. Task lists and historical evidence use bounded pages; a snapshot
reports incomplete sections and their continuations explicitly.

The independent public consumer measures eight actual signers with 32 simultaneous
local attachments and records its exact topology, timing samples and memory use.
This is a local qualification profile, not an Internet latency promise. The
events browser suite separately exercises actual SharedWorker and elected-owner
modes. The SQL/WASM browser consumer qualifies dedicated elected ownership and
explicitly rejects unsupported SharedWorker storage.
Signal queues, encrypted fallback frames, native IPC and gateway deliveries have
independent bounds so a slow client cannot turn disposable progress into an
unbounded durable queue. Named agents share their human owner's admission
budget while retaining independently revocable routes.

## Version and release boundaries

Implementation started from core `14d809d2f172fb5ba4f4d42b96770758cb422a21`,
which had already merged the general-application MCP candidate in PR #62.
This composition extends that generic gateway's event export and inbox with
independent approved callers, explicit provider selection and scoped operation
references. It does not introduce a second application execution service or
merge the older divergent application stacks.

Facade ABI, immutable application definition, publication, selected generation,
and gateway/export schema are independent versions. Incompatible owners reject
attachments with an upgrade action. Applications adopting the SQL collaboration
schema are created with that definition; publishing a UI does not migrate old data.

The implementation branch records source and executable qualification separately.
Local protocol/browser tests cannot establish real mobile suspension, an Internet
latency budget, or the ability to wake an ended conversation on a provider. Those
claims require the corresponding actual environment and evidence.
