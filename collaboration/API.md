# Public collaboration API (v1)

Optional import: `@tendriller/core/collaboration`. Consumers provide the matching
public `@chronolog/peer-session` package. The module never enters the host/kernel.

`createCollaborationDefinition({id, version, administrators: [signerIds], limits?})`
returns a SQL ApplicationDefinition. All objects below use closed tool schemas.
Requests are tasks: `taskId` is the original `interactionId`.

| Command | Input |
| --- | --- |
| `collab.request` | `{interactionId, kind, title, input: JSON-string, target: JSON-string, source: JSON-string, context: JSON-string, responsePolicy: 'one'|'allSlots'|'firstAccepted'|'manual', slots:[{slotId, eligibleSigners:[signerIds], label?, agentBindingId?}]}` |
| `collab.claim` | `{taskId, slotId, claimId, runId, endpointIncarnation, expectedEpoch, taskVersion:1}` |
| `collab.rebind` | Same shape as claim; requires an old-generation accepted claim owned by this signer |
| `collab.handoff` | `{taskId,slotId,actionId,expectedEpoch,assignee,reason}`; current claimant, task creator, or configured administrator |
| `collab.result` | `{taskId,slotId,resultId,claimEpoch,taskVersion:1,generation,runId,endpointIncarnation,outcome:'succeeded'|'failed',content: JSON-string}` |
| `collab.cancel` | `{taskId,actionId,expectedVersion,reason}`; durable request, does not erase dispatched effects |
| `collab.acknowledgeCancel` | `{taskId,slotId,actionId,claimEpoch,generation,runId,endpointIncarnation}` |
| `collab.finalize` | `{taskId,actionId,expectedVersion,resultIds:[ids],content:JSON-string,allowPartial:boolean}` |
| `collab.message` | `{threadId,messageId,text,source:JSON-string,inReplyTo?}`; observation does not execute work |

`collab.snapshot(null)` returns a bounded preview
`{tasks, claims, acceptedResults, results, messages, pages}`.
`collab.task({taskId})` and `collab.interaction({interactionId})` return
`{task, claims, acceptedResults, results, resultsPage}`. Query result wrappers are the ordinary session
`{value,revision,...}`. A task has `taskId,creator,title,kind,input,target,source,
context,responsePolicy,slots,version,taskVersion,generation,status,aggregate`.
A claim has `taskId,slotId,claimEpoch,claimant,runId,endpointIncarnation,generation,
status` (active, offered, needsReview, completed, cancelRequested, cancelled).
A result has `taskId,slotId,resultId,author,runId,claimEpoch,generation,outcome,
content,disposition` (accepted, superseded, cancelled, needsReview).

Every request, current claim, result, aggregate and message includes an `operation`
reference with `applicationId`, `historyId`, `author`, `operationId`, `attemptId`
and `generation`.
Cancellation and acknowledgement references are exposed through
`task.cancellation.operation` and `claim.acknowledgement`. These fields come from the
engine-authenticated transaction log and generation evidence joined to the row's
protected binary `attempt_id`; caller-provided JSON cannot supply or replace them.
`historyId` comes from the captured view's verified descriptor revision and its
application identity must match the authenticated transaction log.
For a late result, `result.generation` names its original claim fence while
`result.operation.generation` names the generation in which that result was recorded.
Use the full reference with `inspectOperation` to inspect the original signing
operation. The fresh schema requires raw writers to set
`attempt_id = chronolog_transaction_id()`.

`createCollaborationClient({session, endpoint?, runId?, store?})` provides:
`request`, `claim`, `handoff`, `result`, `cancel`, `acknowledgeCancel`, `finalize`,
`rebind`, `message` and `inspect(taskId)`/`snapshot()`/`waitForOutcome(taskId,{signal})`.
Named-query page helpers are `tasks(options?)`, `results(options?)`,
`messages(options?)`, and `thread({threadId,...options})`.
Each command accepts the equivalent camelCase object plus standard submit options
`{operationId,basedOn?}`. Request input/target/context and result/finalize content
are ordinary JSON in the client; it serializes them for the tool schema. Source,
run and endpoint context are filled by the client/owner. Each returned ordinary
operation handle also has a full `reference` with application/history/signer/operation.
`operationReference(session, operationId, savedState?)` obtains application and
history from the public session's verified descriptor getters, including on an
attached session. `inspectOperation(reference)` reads the original author scope
and checks any supplied attempt/generation against the inspected signed header.
`retry(reference)` additionally requires the original local signer and retained
attempt; it never chooses another signer with a matching local operation ID.
Both reject wrong or missing history with `OPERATION_SCOPE_MISMATCH`. Earlier
unmerged candidate references lacking history require explicit inspection of the
original owner before a full reference is reconstructed; they are never upgraded
using caller labels or by selecting the current history implicitly.

Every returned handle exposes immutable `identities` and `submission`. Identities
include `operationId`, `localOperationId` and the relevant `interactionId`/`taskId`, `claimId`,
`resultId`, `actionId`, or `messageId`, including values generated by the client.
A request's `identities.taskId` equals `identities.interactionId`, so callers can
immediately use `client.waitForOutcome(operation.identities.interactionId)`.
`submission` contains the exact `command`, serialized `input`, `source`, optional
`basedOn`, and `identities` that were retained before entering the session. Its
nested JSON is frozen, and the session receives that same immutable input copy.
These submitted identities/context describe the original intent; they do not
replace the signed attempt or upgrade caller source labels into authority.
`localOperationId` is the caller-supplied/generated ID before a native binding's
namespace is applied. The handle's `operationId`, `reference.operationId`, and
`identities.operationId` are the canonical ID in the signing journal. They are
equal to the local ID for a direct/browser session. Authenticated native
attachments expose readonly `session.scopeOperationId(localId)`; the reference
helper uses it before persistence or command submission. Passing a canonical ID
back is idempotent, while a sibling binding's canonical ID is rejected by the
supervisor independently. Credential rotation preserves this namespace.

Submission failures preserve their transport code and expose immutable
`operationReference`, `operationIdentities`, and `operationSubmission` metadata
(`CollaborationSubmissionFailure` in TypeScript). A frozen transport error is
wrapped with its original error as `cause`. If the attempt was already read,
the error reference keeps that attempt/generation even if local retention later
fails. Inspect/retry the retained original reference after uncertainty; calling
the command helper again with newly generated IDs creates a different intent.

`createViewStore({storage,applicationId,historyId?,profileId,viewId})` offers readDraft,
writeDraft, removeDraft, retainOperation, inspectOperation, removeOperation,
pending({allViews?}). It indexes separate operation references; it is never a
command queue. Only explicit copying transfers a draft between views.
Its local storage keys encode each application/profile/view/operation/draft
identity separately, including identifiers containing colons or slashes. The
`local:v2` namespace preserves older candidate records without importing them:
the former concatenated keys can be ambiguous, so applications must review any
such records explicitly before copying them into a selected view.
Every retained operation requires its original `historyId`, which is part of the
key. Supplying the store's `historyId` also isolates drafts and rejects operations
from another history. Omitting it permits drafts before attachment; it does not
infer a history for operation references or merge references from different histories.

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
the exact captured application/history/generation/revision, named query and
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
