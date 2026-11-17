# Generation control and signed publications

The fixed signed wire identifier is `peer-generation-v1`. It versions authenticated records; application callers do not select alternate runtime profiles. All applications use the common owned session contract.

## Public control operations

The host SDK's methods use the shared participant envelope:

| Method | Payload |
| --- | --- |
| `configureApplication(configuration)` | Immutable application definition/schema commitments and initial device grants |
| `application()` | Empty read request; returns descriptor, controls and selected generations |
| `definition()` | Empty read request; returns descriptor, public definition and optional signed schema |
| `selectGeneration(request,{control?})` | Exact signed transition and optional next membership revision |
| `administerGeneration(transition,{control?})` | Explicit owner recovery using a real peer coordinator/prefix |

Direct host SDK results are transport evidence. The session's `connectControlParticipant({exchange})` verifies and persists authority through its own replica. Pass that verified control participant to `session.participate(...)`. The owned controller evaluates candidates, reconnect grace and freshness before selecting recovery; applications present exact approval proposals rather than assembling their own selection loops.

## Selection and retries

A transition binds application/history identity, requester, candidate coordinator, control revision, expected generation, transition ID, reason and adopted prefix. Candidate eligibility, requester recovery rights and the authenticated account binding are independent checks. Restrictive membership changes also bind epoch/key digest, grants, recovery floor and explicit enrollments.

The selected coordinator must be a real eligible peer. The host's role is control-only. Competing selections against the same predecessor cannot both win. Retained exact transition retries return the same signed result; changed evidence under an old operation identity conflicts. Revocation is rechecked after asynchronous verification and before commit.

## Session outcomes

Command identities and signed attempts belong to the session. Saved work is locally durable. Applied work has an ordered accepted/rejected result in the selected generation. Shared coverage is separate. A recovery may abandon an applied suffix; clients keep the original evidence and require deliberate reapplication with current guards.

## Code chain

The session control participant supplies `preparePublication({operationId,entry,files})`, `publish(signed,assets)` and `publication()`. Preparation persists exact signed intent. Publication verifies files and release-head CAS. The selected code chain is durably remembered outside recoverable application history.

The host retains signed publication records and their complete code graph. `publication/read` accepts `{}` for the head or `{id}` for an exact historical receipt. Exact retries can return an older receipt without selecting it again. Restore is a new signed release. Application recovery, stale tabs and diagnostics cannot silently rewind the code head.
