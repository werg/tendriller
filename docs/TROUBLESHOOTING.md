# Troubleshoot an application build

Locate the actual boundary. Do not respond to a late reply, missing key, stale query or absent agent by allocating a replacement app/device, changing an operation ID, clearing storage, inventing finality, or creating another backend. Use the exact selected service origin and [bootstrap contract](SESSION_BOOTSTRAP.md).

## MCP has no applications or the agent cannot find setup

Read the selected connector's `tendril_guide` (`start`, `build`, `capabilities`, `delivery`, `troubleshooting`) and public service/discovery/readiness. An empty list is not lack of creation capability. With `tendrils:create`, retain `setup:prepare`'s original private intent, call `prepare_tendril_setup` using its public arguments, and pass the exact ready result to `setup:finish`. If the reply is lost, `inspect_tendril_setup` inspects that same operation. Missing catalog/scope/deployment support requires that exact update/owner approval; it does not authorize another client's credentials or service origin.

## Locate the missing checkpoint

| Symptom | Boundary and next action |
| --- | --- |
| Readiness missing/malformed/unavailable, paused or read-only | Stop package acquisition/new allocation; report same-origin `creation.nextAction`. No fallback host or guessed compatibility. |
| Immutable kit/manifest/hash/source differs | Operator must publish/qualify the matching SDK/tools/authority/session/runtime/host graph. Do not mix same-version archives. |
| Private setup intent/handle unavailable | Restore its original verified private checkpoint. A public setup inspection cannot recreate the secret or authorize replacement allocation. |
| Created page but no application authority | Expected before first browser enrollment. Prepare independent host config/publisher, publish, give the owner the ready page, then real sign-in/key proof. |
| First browser root initialization denied | Verify actual owner account session, exact page Origin, signed key proof and epoch commitment; creator Bearer credentials cannot impersonate the browser owner. |
| `AUTHORITY_CACHE_MISSING` on fresh device | Initial enrollment needs connectivity. Retained startup should reopen local verified metadata before background refresh. Preserve any original bootstrap key intent. |
| Bootstrap key missing/commitment mismatch | Restore the original local key/identity records. Never generate another data key for an existing epoch/root. |
| New browser key proved but Save unavailable | Explicit owner crypto grant and recipient-bound key provisioning are still required. Create/review its retained public request, wrap keys from an authorized donor, import only on that recipient. |
| `member_key_proof_required` / inactive recipient account | Recipient must prove its exact key in an authenticated admitted account; owner grants do not silently invent that binding. |
| `membership_head_changed` | Enrollment metadata changed. Inspect the exact original request and current head; obtain explicit new review if changed inputs are intended. This is not a data-order transition. |
| Publisher denied or first browser unknown | Use the separately prepared host publisher key/policy. Data membership/root/schema is not a prerequisite for pre-owner UI publication. |
| SQL engine/ABI/manifest unsupported | Install the matching qualified browser/native engine and public session composition. Do not replace with stock SQLite or bypass permissions. |
| SQL table/query missing | Ordinary schema may not exist or may have changed during replay. Label the retained last snapshot not current, preserve local drafts, inspect catalog/outcomes, and submit authorized ordinary DDL if intended. |
| SQL permission rejection | Crypto writer/administrator/finalizer is not namespace/object/row authority. The authorized signer must submit an explicit normal permission transaction. Existing column/tool approvals do not expand automatically. |
| Zero peers / discovery or RTC unavailable | Local Save still works after key/storage bootstrap. Inspect optional direct RTC/relay routing, account access and bounded budgets; do not require a native process or current global read. |
| Optional agent/provider offline | Only its tools/inference dispatch are unavailable. Ordinary browser data edits continue. Preserve provider idempotency and original operation references. |
| Finality unsupported | Policy `none` deliberately has no finality. Display local revisable materialization and independent retention, not fake finalized status. |
| Finalizer/quorum absent | Keep local authoring/provisional reads enabled. Configure/bring up actual authorized provider(s) and verified evidence; configuration alone is not availability. |
| Closed-time exclusion | Preserve the original signed intent and show exclusion. Genuine unseen offline work behind a sealed frontier can be excluded; never silently retimestamp/resubmit. |

## Browser readiness, storage and peer connections

A usable signing identity, verified membership and required keys plus durable local storage permit submission. Neither `connectedPeers`, a successful initial query nor finalizer readiness belongs in the ordinary Save condition. SQL activation/query errors are separate from local durable submission.

`OWNER_BUSY` means attach to the existing retained profile owner, not steal its store. `OWNER_STORAGE_UNSUPPORTED` requires the engine's supported Worker mode with the same profile. A lost/stale attachment needs a fresh bounded local owner proof and inspection of original work. Preserve Web Locks/root lifetimes, physical storage fencing and exact signed operation bytes through hide/show, restart and uncertain calls.

Offline readiness requires the actual complete signed application/engine/runtime graph to be cached and acknowledged by `tendril.publication.saveOffline()`. A loaded tab, installed service worker or cached HTML alone is insufficient. Browser storage loss/eviction must be reported; page residency does not guarantee persistence or future execution.

## Lost replies and revisable operation outcomes

Submission resolves after local durable storage. A timeout is not proof of rejection or absence. Inspect `operations.get(id)` and `operation.inspect()`, retaining its authenticated application/author/proposal identity. `operations.retry(id)` keeps the original signer/time/core/bytes; repeat preparation only with the exact original command/input/ID when no signed record exists. Do not clear a draft before durable acknowledgment.

Materialized acceptance/rejection can change after an earlier operation, missing dependency, authority evidence, schema or finality update. Inspect the latest coherent revision. Retention evidence concerns named peer storage, not execution or finality. Operational engine failure and missing keys/bodies/proof predecessors are dependencies, not fabricated SQL rejection.

## Signed publication

Verify the signed manifest, publisher policy, asset hashes, immutable publication ID and selected release receipt. Code publication revisions/concurrency are independent from application operation order and schema. Retry the original retained publication operation after an uncertain reply; never sign a replacement against a guessed head. Publish only the dedicated authored output, not private handles, identities, native journals or key material.

## Report the actual boundary

Name the exact prerequisite, observed code/status, retained identity/operation, and next authorized action without exposing secrets. Report exact checks and untested boundaries under [delivery](AGENT_DELIVERY.md). An installed adapter, source change, static preview or old successful release is not a verified live replacement. No troubleshooting step authorizes an unrequested production deployment, storage wipe, compatibility stack or migration reader.
