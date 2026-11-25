# Public collaboration API (v1)

Optional import: `@tendriller/core/collaboration`. Consumers provide the matching
public `@chronolog/peer-session` package. The module never enters the host/kernel.

`createCollaborationDefinition({id, version, administrators: [signerIds], members: [signerIds], limits?})`
returns `{definition, initializationProgram}`. Enroll the root principal, then submit
`initializationProgram` as an ordinary root-authored transaction with a retained
operation ID. It creates the journal and grants the explicitly named `members`
table INSERT permission. Crypto enrollment alone does not grant SQL permissions.
Later DDL and grant/revoke programs use the same ordinary transaction path; there
is no special signed schema initializer. All tools use closed input schemas.
Requests are tasks: `taskId` is the original `interactionId`.

| Command | Input |
| --- | --- |
| `collab.request` | `{interactionId, kind, title, input: JSON-string, target: JSON-string, source: JSON-string, context: JSON-string, responsePolicy: 'one'|'allSlots'|'firstAccepted'|'manual', slots:[{slotId, eligibleSigners:[signerIds], label?, agentBindingId?}]}` |
| `collab.claim` | `{taskId, slotId, claimId, runId, endpointIncarnation, expectedEpoch, taskVersion:1}` |
| `collab.handoff` | `{taskId,slotId,actionId,expectedEpoch,assignee,reason}`; current claimant, task creator, or configured administrator |
| `collab.result` | `{taskId,slotId,resultId,claimEpoch,taskVersion:1,claimProposalId,runId,endpointIncarnation,outcome:'succeeded'|'failed',content: JSON-string}` |
| `collab.cancel` | `{taskId,actionId,expectedVersion,reason}`; durable request, does not erase dispatched effects |
| `collab.acknowledgeCancel` | `{taskId,slotId,actionId,claimEpoch,claimProposalId,runId,endpointIncarnation}` |
| `collab.finalize` | `{taskId,actionId,expectedVersion,resultIds:[ids],content:JSON-string,allowPartial:boolean}` |
| `collab.message` | `{threadId,messageId,text,source:JSON-string,inReplyTo?}`; observation does not execute work |

`collab.snapshot(null)` returns a bounded preview
`{tasks, claims, acceptedResults, results, messages, pages}`.
`collab.task({taskId})` and `collab.interaction({interactionId})` return
`{task, claims, acceptedResults, results, resultsPage}`. Query result wrappers are the ordinary session
`{value,revision,...}`. A task has `taskId,creator,title,kind,input,target,source,
context,responsePolicy,slots,version,taskVersion,revision,finality,status,aggregate`.
A claim has `taskId,slotId,claimEpoch,claimant,runId,endpointIncarnation,claimProposalId,revision,finality,
status` (active, offered, completed, cancelRequested, cancelled).
A result has `taskId,slotId,resultId,author,runId,claimEpoch,claimProposalId,outcome,
content,disposition` (accepted, superseded, cancelled).

Every request, current claim, result, aggregate and message includes an `operation`
reference with `applicationId`, `author`, `operationId` and stable `proposalId`.
Cancellation and acknowledgement references are exposed through
`task.cancellation.operation` and `claim.acknowledgement`. These fields join the
journal's protected binary `proposal_id = chronolog_transaction_id()` to the
engine-authenticated `chronolog_transactions` record, verifying its original
actor and accepted outcome. The captured read view supplies authenticated
application identity. Caller JSON cannot replace any of this provenance.

Claims and SQL guards describe **current provisional outcomes**, not globally
exclusive reservations. An earlier operation arriving later can change the winning
claim, remove a result or reject a previously accepted operation. Re-derive the
whole current view on revision invalidation. Task/claim `finality` is `pending`
in local views, or `finalized` in a verified final view. Domain `collab.finalize`
is aggregation, not cryptographic finality. No-finality applications cannot promise
irreversible-effect safety merely because a local guard succeeded.

`createCollaborationClient({session, endpoint?, runId?, store?})` provides:
`request`, `claim`, `handoff`, `result`, `cancel`, `acknowledgeCancel`, `finalize`,
`message` and `inspect(taskId)`/`snapshot()`/`waitForOutcome(taskId,{signal})`.
Named-query page helpers are `tasks`, `results`, `messages` and `thread`.
Command options are `{operationId?, authorTimestampMs?: bigint}`. The timestamp,
when supplied, is retained exactly; retries never choose a new timestamp or ID.
The client serializes ordinary JSON input and preserves immutable source context.
Each operation exposes `stored`, `proposalId`, `reference`, `inspect()`,
`materialized()`, `retained()` and `finalized()` independently. Submission completes
at local durable storage, before engine/network waits. Explicit finality waits
on a no-finality session fail as unsupported.

`inspectOperation(reference)` compares the original authenticated application,
actor, operation handle and stable proposal ID, never caller labels.
`retry(reference)` additionally requires the original local signer and retained
proposal. It retransmits that intent, never another signer's matching handle.
The same facade contract applies to native and browser participants.

Every returned handle exposes immutable `identities` and `submission`. Identities
include `operationId`, `localOperationId` and the relevant `interactionId`/`taskId`, `claimId`,
`resultId`, `actionId`, or `messageId`, including values generated by the client.
A request's `identities.taskId` equals `identities.interactionId`, so callers can
immediately use `client.waitForOutcome(operation.identities.interactionId)`.
`submission` contains the exact `command`, serialized `input`, `source`, optional
`authorTimestampMs`, and `identities` that were retained before entering the session. Its
nested JSON is frozen, and the session receives that same immutable input copy.
These submitted identities/context describe the original intent; they do not
replace the signed proposal or upgrade caller source labels into authority.
`localOperationId`, the handle's `operationId` and `reference.operationId` preserve
the same caller-generated handle. Optional hosted MCP dispatch has its own explicit
consumer namespace and original-provider binding; it never orders browser data.

Submission failures preserve their transport code and expose immutable
`operationReference`, `operationIdentities`, and `operationSubmission` metadata
(`CollaborationSubmissionFailure` in TypeScript). A frozen transport error is
wrapped with its original error as `cause`. If the proposal was already inspected,
the error reference keeps that proposal identity even if local retention later
fails. Inspect/retry the retained original reference after uncertainty; calling
the command helper again with newly generated IDs creates a different intent.

`createViewStore({storage,applicationId,profileId,viewId})` offers per-view drafts
and retained proposal references. The client stores its exact submission as a
local draft before the uncertain owner boundary, then retains the authenticated
proposal reference after local storage succeeds. This is not an application queue
or replicated state. Preserve drafts separately from derived shared snapshots.

`createEffectDispatcher({journal, session, authorize, dispatch, reconcile?})` uses a
separate durable provider-idempotency journal. By default, the fence's
`claimProposalId` must inspect as accepted and finalized in the real session before
new irreversible dispatch. `authorize` checks permissions; its return value cannot
assert finality. Missing finality yields `EFFECT_FINALITY_PENDING` without dispatch.
`allowProvisionalEffects: true` is an explicit risk policy, never a global exclusion
guarantee. Existing uncertain effects reconcile under their original effect ID;
replay, new projection revisions and local callbacks never establish exactly-once
external effects or permission to redispatch.

## Bounded current state and retained evidence

| Named query / client method | Filters and limits | Value |
| --- | --- | --- |
| `collab.tasks` / `tasks` | `creator?`, `eligibleSigner?`, `state?: 'all'\|'open'\|'closed'`, `limit?:1..32` (default 8), `cursor?` | `{tasks,claims,acceptedResults,page}` |
| `collab.results` / `results` | `taskId?`, `slotId?`, `disposition?`, `limit?:1..64` (default 16), `cursor?` | `{results,page}` |
| `collab.messages` / `messages` | `threadId?`, `limit?:1..64` (default 20), `cursor?` | `{messages,page}` |
| `collab.thread` / `thread` | Required `threadId`, `limit?:1..64` (default 20), `cursor?` | `{messages,page}` |

The task-page `state` filter describes claim admission. `closed` includes a
durable cancellation request or finalization; `task.status` still distinguishes
pending cancellation acknowledgements, completed cancellation and finalization.
`open` can include accepted contributions awaiting parent finalization.

Task cards include current claims and accepted-result summaries with their full
verified reference and claim fence. Those summaries omit result content; full
accepted and historical result evidence is available through `results`. Retained
messages and superseded claims do not enlarge the current task projection. The
snapshot preview exposes separate continuations in `pages.tasks`, `pages.results`
and `pages.messages`; it never claims its first pages are the complete history.
The single-task read includes the first result page and `resultsPage` for the rest.

Each `page` has `{nextCursor,hasMore,total,returned,limit,revision}`. Cursors bind
the exact captured application and projection revision, named query and
filters. Reusing one after a different revision or filter yields
`CURSOR_RESET_REQUIRED`; restarting a query is explicit. Pages also obey byte
budgets: current task cards fit within 384 KiB and result/message evidence within
128 KiB, so `returned` can be smaller than the requested limit when `hasMore` is
true. A single record that exceeds the budget produces `PAGE_ITEM_TOO_LARGE`
instead of truncating its evidence.

`captureCollaborationReader(session,{signal?})`, also available as
`client.capture({signal?})`, holds one public read view so callers can traverse
multiple pages coherently while new writes arrive. It exposes `revision`,
`tasks`, `results`, `messages`, `thread`, `inspect`, `snapshot`, and `close`.
Always close the reader when the user refreshes or leaves the view; caller or
session cancellation also releases it. Closing a reader never closes the
application owner. One reader admits at most eight simultaneous reads.

The captured reader requires unrestricted public SQL query capability and probes
that capability before returning. A named-query-only or events-only attachment
cannot obtain raw access through this helper; failed admission releases the
reserved read view. Such attachments continue using their approved named page
queries through the client. Their cursor must be explicitly restarted if a live
write changes the revision between page requests.

`participantModel(entries,{selfEndpoint,now})`, `receiptModel(evidence)`, and
`mountParticipantPanel({container,participants,selfEndpoint,onSelect})` are optional
headless/accessibility helpers. Membership authority and live observations are
separate fields. No camera/speech/focus action is inferred from shared activity.
Panel updates retain controls by signer/binding/endpoint incarnation, preserving
the existing recipient's focus during presence updates and reorder. An explicit
incarnation change replaces the stale control; revocation disables selection.
Repeated advertisements of the same endpoint do not increase participant counts.
Verified reader membership (`canRead: true` with `authorized: false`) is displayed
as read-only and cannot be selected to execute a request. Expiring presence cannot
restore revoked rights or turn an unenrolled participant into a reader.
