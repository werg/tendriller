# Troubleshoot an application build

Locate the actual boundary. Do not respond to a late reply, missing key, stale query or absent agent by allocating a replacement app/device, changing an operation ID, clearing storage, inventing finality, or creating another backend. Use the exact selected service origin and [bootstrap contract](SESSION_BOOTSTRAP.md).

## MCP has no applications or the agent cannot find setup

Read the selected connector's `tendril_guide` (`start`, `build`, `capabilities`, `delivery`, `troubleshooting`) and public service/discovery/readiness. An empty list is not lack of creation capability. With account-linked creation, run `tendril workspace key --handle HANDLE`, call `register_agent` with its exact public `handle`, `bio` and `publicKey`, and retain the result with `tendril workspace adopt`; calling again with the same handle rotates the token and key. Without a linked account, use `tendril workspace init --owner EMAIL --handle HANDLE` or a dashboard join code (`tendril workspace join --handle HANDLE`). Missing catalog/scope/deployment support requires that exact update/owner approval; it does not authorize another client's credentials or service origin.

## Locate the missing checkpoint

| Symptom | Boundary and next action |
| --- | --- |
| Readiness missing/malformed/unavailable, paused or read-only | Stop package acquisition/new allocation; report same-origin `creation.nextAction`. No fallback host or guessed compatibility. |
| Immutable kit/manifest/hash/source differs | Operator must publish/qualify the matching SDK/tools/authority/session/runtime/host graph. Do not mix same-version archives. |
| Agent registered | `tendril status` shows the workspace agent and `GET /api/agent` accepts its token. | Create a page with `tendril page new <slug>` (or `npm run page:new`). Without a workspace, run `tendril workspace init`, `workspace join` or the MCP `register_agent` route. |
| Workspace `.tendriller/` unavailable | Restore the agent credential, shared signer and page device stores from their original verified checkpoint. A public result cannot recreate the secret or authorize a replacement agent or key. |
| Page created | `tendril page list` shows the slug with its page ID; `.tendriller/pages/<page-id>/page.json` holds `page_url` and `application.id`. Do not wait for a claimed reply. |
| Created page but no application authority | Expected before first browser enrollment. Prepare independent host config/publisher, publish, give the owner the ready page, then real sign-in/key proof. |
| First browser root initialization denied | Verify actual owner account session, exact page Origin, signed key proof and epoch commitment; creator Bearer credentials cannot impersonate the browser owner. |
| `AUTHORITY_CACHE_MISSING` on fresh device | Initial enrollment needs connectivity. Retained startup should reopen local verified metadata before background refresh. Preserve any original bootstrap key intent. |
| Bootstrap key missing/commitment mismatch | Restore the original local key/identity records. Never generate another data key for an existing epoch/root. |
| New browser key proved but Save unavailable | Explicit owner crypto grant and recipient-bound key provisioning are still required. Create/review its retained public request, wrap keys from an authorized donor, import only on that recipient. |
| `member_key_proof_required` / inactive recipient account | Recipient must prove its exact key in an authenticated admitted account; owner grants do not silently invent that binding. |
| `membership_head_changed` | Enrollment metadata changed. Inspect the exact original request and current head; obtain explicit new review if changed inputs are intended. This is not a data-order transition. |
| Publisher denied or first browser unknown | Use the separately prepared host publisher policy and the workspace's shared signer. Data membership/root/schema is not a prerequisite for pre-owner UI publication. |
| SQL engine/ABI/manifest unsupported | Install the matching qualified browser/native engine and public session composition. Do not replace with stock SQLite or bypass permissions. |
| SQL table/query missing | Ordinary schema may not exist or may have changed during replay. Label the retained last snapshot not current, preserve local drafts, inspect catalog/outcomes, and submit authorized ordinary DDL if intended. |
| SQL permission rejection | Crypto writer/administrator/finalizer is not namespace/object/row authority. The authorized signer must submit an explicit normal permission transaction. Existing column/tool approvals do not expand automatically. |
| Zero peers / discovery or RTC unavailable | Local Save still works after key/storage bootstrap. Inspect optional direct RTC/relay routing, account access and bounded budgets; do not require a native process or current global read. |
| Optional agent/provider offline | Only its tools/inference dispatch are unavailable. Ordinary browser data edits continue. Preserve provider idempotency and original operation references. |
| Finality unsupported | Policy `none` deliberately has no finality. Display local revisable materialization and independent retention, not fake finalized status. |
| Finalizer/quorum absent | Keep local authoring/provisional reads enabled. Configure/bring up actual authorized provider(s) and verified evidence; configuration alone is not availability. |
| Closed-time exclusion | Preserve the original signed intent and show exclusion. Genuine unseen offline work behind a sealed frontier can be excluded; never silently retimestamp/resubmit. |

## Agent credential, grants and the agent program

| Observation or code | Next action |
| --- | --- |
| `404` `not_found` ("No such granted page") from `/api/agent/pages/<id>/...` | The agent holds no grant for that page ID, or the page was deleted. Run `tendril status` and `tendril page list`. The owner grants an existing page from the dashboard card's **Add people & devices → An agent**, then `tendril page grant <slug> <page-id>`. Creating a page with the agent grants it automatically. |
| `401 unauthorized` ("Invalid or revoked agent token") | Check the workspace's `.tendriller/agent/credential.json` and service origin. A revoked agent stays revoked: the owner adds a new agent (**Dashboard → Your agents → Add agent**) and you run `tendril workspace join` in a fresh folder, or call `register_agent` again with the same handle to rotate the token and key, then `tendril workspace adopt`. Do not create another page to work around it. |
| `agent_credential_missing`, `agent_signer_missing` or `agent_signer_mismatch` | `.tendriller/agent/` is damaged or from another workspace. Restore the workspace from its checkpoint (`tendril checkpoint restore FILE` in an empty folder); a new key would not match the registered agent or its signed page grants, and a lost token is never reissued silently. |
| `workspace_retired_by_checkpoint` | `tendril checkpoint export` moved this workspace into a checkpoint file. Restore that file with `tendril checkpoint restore FILE` in an empty folder and work there; the retired copy never resumes. |
| `AGENT_PROGRAM_RUNNING` or `BYTES_STORE_IN_USE` from `checkpoint export` | Stop `tendril agent run` (and any script holding a page device) for this workspace, then export again. Nothing was written or retired. |
| `CHECKPOINT_TARGET_NOT_EMPTY`, `CHECKPOINT_DECRYPT_FAILED` or `CHECKPOINT_KEY_MISMATCH` from `checkpoint restore` | Restore into an empty folder (only the checkpoint file may be there). A decrypt failure means a wrong secret or a damaged file; a key mismatch means a 64-hex key was given for a passphrase file or the reverse. Nothing was restored. |
| `workspace_required`, `page_required` or `page_unknown` | Run the command inside the workspace (the nearest `tendriller.json`, `--workspace DIR` or `TENDRIL_WORKSPACE`), and add `--page <slug or id>` when it has more than one page. `tendril page list` shows the slugs. |
| `workspace_exists` or `workspace_not_empty` | The folder already is a workspace, or holds `pages/` without `tendriller.json`. Resume it; never register a second agent for the same folder. Restore a missing `tendriller.json` with `tendril checkpoint restore` in an empty folder. |
| `page_not_granted` from `page grant` | The agent does not hold that page yet. Ask the owner to check the agent for the page on the dashboard. |
| `invalid_code` from `workspace join` | The join code is unknown, used or expired (ten minutes). The owner makes a new one under **Dashboard → Your agents → Add agent**. A lost registration reply cannot be recovered: the owner can revoke the unclaimed agent and add another. |
| `agent_capacity` or `agent_name_in_use` | The account holds the maximum number of agents, an owner email has too many unclaimed agents, or the name already exists in the account. Revoke an unused agent or choose another `--name`. |
| `OWNER_UNREACHABLE` for a CLI attach | Start `tendril agent run` in the workspace and keep it running. A page opens only after the explicit native `sign-enrollment`, `provisioning-request` and `import-provisioning` steps verified its reader grant and current epoch key and wrote `initialized.json`; `npm run init -- <slug>` alone (publisher policy only) does not. A command never opens a second signer. Browser Save does not depend on this program. |
| `application_requires_resident` (HTTP 409) when changing a page's lifetime | A prepared application keeps its signed authority and publication retained until explicitly deleted; downgrading it to ad hoc is refused. This is not an application reset. Use an explicitly authorized lifecycle decision for deletion. A page that is not yet owned reports `account_required` for making it resident: have the owner open the page first. |
| Hub status `replaced` or `revoked` | `replaced`: a newer agent program for the same credential took the hub; stop the duplicate. `revoked`: the owner revoked the agent; its local page data is kept. |
| Sign-in is shown, `wrong_owner`, or `claimed` | Have the human open the returned owner `page_url` and sign in with the intended verified identity (that also claims the workspace agent). If another account owns the page, report that mismatch. Agent credentials cannot claim a page on the owner's behalf. |
| `peer_application_unconfigured` | Run `npm run init -- <slug>`: a created page alone has no application authority. Inspect authority after an uncertain response before repeating the exact preparation. Publishing HTML cannot configure the application. |

Unclaimed pages expire after 24 hours. Creating another page is a new application setup decision, not a recovery mechanism for an existing claimed application. A deleted page is absent; its private folder under `.tendriller/pages/` stays as evidence for the old identity, and the agent program reports `closed` for it while it keeps running the others. The agent credential does not expire when the owner claims. Hosted MCP connections are opted in per page and OAuth grant on `/connections` (`_tendril/mcp/connect`). See [membership](MEMBERSHIP.md).

## Browser readiness, storage and peer connections

A usable signing identity, verified membership and required keys plus durable local storage permit submission. Neither `connectedPeers`, a successful initial query nor finalizer readiness belongs in the ordinary Save condition. SQL activation/query errors are separate from local durable submission.

`OWNER_BUSY` means attach to the existing retained profile owner, not steal its store. `OWNER_STORAGE_UNSUPPORTED` requires the engine's supported Worker mode with the same profile. A lost/stale attachment needs a fresh bounded local owner proof and inspection of original work. Preserve Web Locks/root lifetimes, physical storage fencing and exact signed operation bytes through hide/show, restart and uncertain calls.

Offline readiness requires the actual complete signed application/engine/runtime graph to be cached and acknowledged by `tendril.publication.saveOffline()`. A loaded tab, installed service worker or cached HTML alone is insufficient. Browser storage loss/eviction must be reported; page residency does not guarantee persistence or future execution.

## Lost replies and revisable operation outcomes

Submission resolves after local durable storage. A timeout is not proof of rejection or absence. Inspect `operations.get(id)` and `operation.inspect()`, retaining its authenticated application/author/proposal identity. `operations.retry(id)` keeps the original signer/time/core/bytes; repeat preparation only with the exact original command/input/ID when no signed record exists. Do not clear a draft before durable acknowledgment.

Materialized acceptance/rejection can change after an earlier operation, missing dependency, authority evidence, schema or finality update. Inspect the latest coherent revision. Retention evidence concerns named peer storage, not execution or finality. Operational engine failure and missing keys/bodies/proof predecessors are dependencies, not fabricated SQL rejection.

## Signed publication

Verify the signed manifest, publisher policy, authored asset hashes, immutable publication ID and selected release receipt. Served HTML contains deliberate runtime injection, so its full response digest is expected to differ from the authored entry's signed digest; verify the authored bytes and expected injection separately rather than treating that difference alone as tampering. Non-HTML assets retain their authored byte digests. Publication is raw `SignedPublication` JSON over HTTP (signed authority and finality records use `{record: hex}` around the canonical tagged-JSON codec bytes); a `{record}` wrapper for a publication is a client bug. Code publication revisions/concurrency are independent from application operation order and schema. Retry the original retained publication operation after an uncertain reply; never sign a replacement against a guessed head. Publish only the dedicated authored output, not private handles, identities, native journals or key material.

## Report the actual boundary

State which agent program or integration actually consumes application work and how long it remains available. Name the exact prerequisite, observed code/status, retained identity/operation, and next authorized action without exposing secrets. Report exact checks and untested boundaries under [delivery](AGENT_DELIVERY.md). An installed adapter, source change, static preview or old successful release is not a verified live replacement. No troubleshooting step authorizes an unrequested production deployment, storage wipe, compatibility stack or migration reader.

Ordinary application commands, queries and live signals travel through peers. With a direct connection, the host can remain idle during those edits. Relay connections carry encrypted peer traffic through the host and consume bandwidth; coarse discovery renewal and explicit control/publication calls also use it. Do not interpret zero host application writes as a failed save, or claim zero host traffic for a relay-backed session.

The ordinary host MCP endpoint administers host controls; it does not run domain
commands or wake an agent conversation. For application tools, subscribed events,
mounted UI handoff and the optional Workspace Agent route, use the separate
[ChatGPT setup and recovery guide](CHATGPT_INTEGRATION.md#troubleshoot-setup).

## A connected page does not get an assistant reply

Read [same-conversation delivery](CONVERSATION_DELIVERY.md) and identify the exact
blocked stage: worker absent, host admission unavailable, reauthentication,
subscription/callback failure, admitted turn without receipt, or receipt without
answer. `get_application_delivery` reports forwarded delivery outcomes; the
application's declared inbox reports actual acknowledgement and answers.

Keep the last handled cursor, request references and uncertain operation inputs.
Do not resubmit a request, switch to the latest thread or create a replacement
application to hide the failure. Stop only the worker while leaving its native
owner connected to check that the assistant indicator becomes stopped or stale.
After repairing/rearming the selected route, verify active-turn injection for
Codex and repeat the idle two-request rehearsal in the same existing conversation.
If notices wait until a busy turn completes, inspect whether the configured
receiver is using `turn/steer`; plain `codex queue` intentionally waits and cannot
satisfy active delivery. Preserve explicit interruption and uncertain admissions
rather than starting a competing turn or silently repeating the notice.
