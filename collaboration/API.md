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

`collab.snapshot(null)` returns `{tasks, claims, results, messages}`.
`collab.task({taskId})` and `collab.interaction({interactionId})` return
`{task, claims, results}`. Query result wrappers are the ordinary session
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
include `operationId` and the relevant `interactionId`/`taskId`, `claimId`,
`resultId`, `actionId`, or `messageId`, including values generated by the client.
A request's `identities.taskId` equals `identities.interactionId`, so callers can
immediately use `client.waitForOutcome(operation.identities.interactionId)`.
`submission` contains the exact `command`, serialized `input`, `source`, optional
`basedOn`, and `identities` that were retained before entering the session. Its
nested JSON is frozen, and the session receives that same immutable input copy.
These submitted identities/context describe the original intent; they do not
replace the signed attempt or upgrade caller source labels into authority.

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
