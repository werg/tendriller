# Account-bound setup and reviewed device pairing

Status: **both required capabilities are implemented in the repository** for
[core PR #68](https://github.com/werg/tendriller/pull/68). Focused SDK, worker and
starter tests are committed. The packed browser/native lifecycle has passed at
the exact source and composition recorded below. The remaining final-source and
deployed-client acceptance gates are recorded in the repair plan. All twenty
original acceptance tasks are retained. Source changes do not
deploy a service or authenticate a user's browser.

These implementations remove two avoidable interactions: asking for an owner's
email when the connected integration already knows the account, and copying a
browser public key into a native terminal. Human owner sign-in, device authority
and assistant permission review remain separate decisions. The existing
email-based creation and explicit signed enrollment APIs remain available.

## Implementation map

| Boundary | Implemented source | Preserved constraint |
| --- | --- | --- |
| Account setup | [account service](../server/src/account-setup.ts), [page initialization](../server/src/setup-page.ts), [credential policy](../server/src/setup-credential.ts) | The server derives the exact intended account and verified email; caller-supplied ownership is not accepted. |
| Setup clients | [public SDK](../contract/setup.mjs), [MCP gateway](../server/src/assistant-gateway.ts), [starter](tutorial/account-setup.mjs) | The private setup credential and operation are retained before the first network call. Only the commitment is sent. |
| Browser pairing | [pairing service and review](../server/src/device-pairing.ts), [public SDK](../contract/pairing.mjs) | Account sign-in and proof of a browser key do not grant application rights. |
| Pairing authority | [signed controls](../server/src/peer-generations.ts), [native consumer](tutorial/pairing-native.mjs) | An existing administrator/coordinator signs the exact reviewed control transition; the host never becomes a data peer. |
| Browser lifecycle | [pairing intent](tutorial/pairing-browser.mjs), [proof Worker](tutorial/pairing-worker.mjs), [page](tutorial/page.mjs) | The existing retained device is opened under its owner lock; private keys never enter page messages or published configuration. |

## Storage and release boundary

The account operation ledger is the explicit
[`0004_account_setup.sql` migration](../server/migrations/0004_account_setup.sql).
The additive [`0005_account_setup_recovery.sql` migration](../server/migrations/0005_account_setup_recovery.sql)
preserves retained allocation witnesses and advances the account-setup schema
marker to **3**. Both migrations and that exact marker are required; a missing
or incompatible ledger fails closed. Runtime request handling never applies a
migration or reinterprets existing rows.

The per-page [Durable Object schema](../server/src/db.ts) is revision **10**.
It adds the bounded `device_pairings` table and covers account-setup metadata.
This pre-release baseline requires a fresh matching namespace; revision 9 page
storage is not migrated or silently adopted. Apply the account migrations to
compatible account storage and provision the fresh Tendril/Admission resources
under the [operations procedure](OPERATIONS.md). Publish and deploy a matching
complete release composition separately.

## A. Prepare a page for the linked account

### Public API, MCP tools and SDK

| Operation | Public HTTP | Input and result |
| --- | --- | --- |
| `prepare_tendril_setup` | `POST /api/setup` | Original operation ID, name/mode, stable application ID and credential commitment. Returns the same allocated page/application reference and a bounded status. |
| `inspect_tendril_setup` | `GET /api/setup?operationId=...` | Inspects the original operation; creates no replacement page or secret. |
| `list_tendril_setups` | `GET /api/setup` | At most 100 retained setup references for this exact account/client. Inspect an individual operation to reconcile it. |

All three operations require the currently configured and granted
`tendrils:create` permission. Access-token issuer/audience validation and the
existing issued-token and grant records remain authoritative. The namespace is
`(serviceOrigin, accountId, clientId, operationId)`; another account or client
cannot inspect or reuse an operation. Existing OAuth tokens acquire no new
scope. The admitting grant is retained with the setup credential.

The service selects an email from the account's current `identity_emails`
records, preferring its display email only when that email is in the verified
set. Missing verified identity returns `owner_verification_required` before
allocation. Both the selected verified email and exact intended account are
retained. Owner claim requires that account and the existing verified-email
check; another account with the same email string cannot take the page.

The SDK exports `createSetupIntent`, `setupRequest`, `completeSetupIntent`,
`prepareTendrilSetup`, `inspectTendrilSetup` and `listTendrilSetups`. The
starter's `npm run setup:prepare` and `npm run setup:finish` support an
account-linked MCP client without printing or forwarding a local OAuth token.
Follow [Build an app](BUILD_AN_APP.md) for their actual argument forms.

### Retained credential and same-operation recovery

`createSetupIntent` generates a page-scoped setup credential, saves the complete
operation and private credential, then verifies readback before exposing the
public request. The host stores the SHA-256 commitment. A lost HTTP/MCP reply is
recovered by inspecting the same operation and combining its ready public receipt
with the original local credential. The public result never returns that secret.

The initial setup binding has only `host:read`, `participants:connect`,
`control:write`, `publication:write` and `assistant:manage`. It has a fixed
24-hour expiry and remains bound to its original OAuth grant. It does not grant
`host:manage`, `agents:delegate`, an account session, another page's authority,
device signing identity or assistant/data consent. Revocation and expiry must
remain effective during asynchronous host operations as well as at entry.

If local durable storage is unavailable, `setup_storage_required` stops setup
before networking. A lost private credential cannot be reconstructed from its
hash. The retained public reference remains useful for inspection and the actual
owner's separately reviewed delegation/adoption route; recovery never mints a
replacement secret or creates a second page automatically.

The active owner's `/dashboard/setups` lists up to 100 retained operations across
that account's clients without waking pages. `/dashboard/setups/:pageId`
inspects only the original page and offers its validated owner link when retained
evidence agrees. These read-only service-session views remain available after
connector revocation. They disclose neither a setup credential nor its
commitment, and cannot grant replacement authority. Missing or corrupt evidence
requires reconciliation without a guessed link or new page.

### Allocation, bounds and statuses

The D1 journal retains the canonical request digest, credential commitment,
admitting account/client/grant, allocated IDs, initialization progress and
outcome. Exact duplicate requests converge; changed input under the same ID is
`setup_operation_conflict`. Allocation precedes Admission reservation and page
initialization. Admission's per-page idempotency is reused. Per-page metadata,
the setup binding and initial owner link commit in one local transaction.

D1, Admission and Tendril remain separate storage boundaries. Lost responses
must reconcile their actual state under the original page ID, not compensate
an uncertain successful allocation or repeat it with a new ID. The account
schema bounds retained operations to 100 per account and 10,000 per service,
with 20 pending/account slots, existing account-page limits and the existing
daily creator-IP limit. IDs are not automatically pruned into reuse.

| State | Required client behavior |
| --- | --- |
| `prepared` / `provisioning` | Inspect or retry the same retained request and commitment. |
| `ready` | Reconstruct the same private handle, prepare the signed app and let the intended owner sign in. |
| `blocked` | Resolve the stated readiness/account/grant/capacity condition on this service. Keep the same operation. |
| `expired` | The credential is terminal and the operation ID remains reserved; use reviewed owner recovery or allow unclaimed cleanup. |
| `reconciliation_required` | Preserve the journal, page reference and local credential; inspect or obtain operator reconciliation. |

The setup tests are
[SDK](../contract/test/setup.test.mjs),
[worker](../server/test/account-setup.public.test.ts) and
[starter](../scripts/test/tutorial-account-setup.test.mjs). Their committed
scenarios include durable readback, exact concurrent preparation, public receipt
reconstruction, changed-body refusal, account/client isolation, verified-email
selection, wrong-account claim, paused-creation races, lost initialization
response, object eviction, expired/deleted/missing/corrupt state and actual MCP
tool dispatch. Allocation-fence tests cover a lost request before page dispatch,
failure before Admission, retained-state loss/corruption, alarm failure and
absolute expiry including late Admission reservation. The setup-authority
regressions cover retained scopes, metadata corruption, post-claim expiry,
original-grant revocation and cached adapter admission. The account setup suite
now passes 43 actual endpoint tests, including six direct D1 fault cases, plus
the separately verified authority and schema suites. Per-account retained
capacity and the last daily
IP slot are exercised; the 10,000-row global ceiling is enforced by the schema
but was not separately stress-tested to its maximum. Direct before-delivery and
after-commit reply loss is exercised for the D1
allocation insert, account-index/stage transaction and ready-result update. Each
case evicts the page and Admission objects and recovers one original page,
credential, reservation and quota charge. These checks also found and fixed
unread internal Admission responses in setup, expiry, claim and deletion callers.
Direct Admission reservation loss before delivery and after commitment, and a
discarded successful MCP response, also recover the same allocation and credential
after both objects restart.

### Implementation and acceptance tasks

- [x] Review the exact endpoint/tool schemas, canonical request digest, operation
  namespace, error states and credential commitment format; update SDK types and
  tool annotations only with the implemented behavior.
- [x] Reuse the existing readiness, IP and Admission checks with a dedicated
  idempotent authenticated initializer, preserving the anonymous route's email
  and authorization rules.
- [x] Require the existing configured and granted `tendrils:create` permission;
  test wrong issuer/audience, another account/client, missing scope, revocation,
  suspension, deletion and expired grants. Existing tokens acquire no new scope.
- [x] Resolve verified email server-side; test no verified email, stale display
  email, multiple verified identities and wrong-account claim. Persist and enforce
  the exact intended account without weakening the existing email route.
- [x] Implement the bounded durable ledger and atomic per-page initialization.
  Review the account/DO schema rollout explicitly under the storage policy; do
  not reinterpret existing rows or bypass a schema mismatch.
- [x] Persist the client credential and operation before networking; verify a lost
  HTTP/MCP response can reconstruct the same handle without a returned raw secret.
- [x] Inject failures before and after every allocation boundary: ledger write,
  admission reserve, account index, page initialization, result persistence and
  response delivery. Restart each object and recover one page, one credential
  binding and one quota charge.
- [x] Race exact duplicate calls and changed-body reuse. Exact calls converge;
  changed name, application ID or credential commitment is refused.
- [x] Define and test setup-binding scope, expiry, revocation and owner adoption.
  Preserve prepared code/authority at claim while keeping browser membership and
  assistant consent independent.
- [x] Exercise lost local secret, lost operation ID, expired operation, full ledger,
  missing/corrupt retained state and deleted page. Each offers inspection, reviewed
  recovery or a terminal explanation, never a silent replacement creation.
- [ ] Qualify the packed starter and real MCP client on the selected host; report
  account creation, owner sign-in and live browser evidence separately.

## B. Pair a browser through a bounded, reviewed request

### Implemented flow and API

The browser uses `pageBase + "_tendril/peers/pairing"`; the authorized native
participant uses `handle.api + "/peers/pairing"`. The public
`createDevicePairingClient` exposes the following operations:

| Operation | Request | Result |
| --- | --- | --- |
| `challenge` | POST `{action:"challenge",requestId,publicKey,rights:{reader:true,writer:boolean}}` | One retained challenge, pairing ID, expiry, status and service-origin review URL. |
| `prove` | POST `{action:"prove",pairingId,signature}` | The same request becomes `pending` after possession is verified. |
| `inspect` | GET `?pairingId=...` | Same-account browser status or authorized native inspection of the original request. |
| `pending` | Native GET without an ID | At most 20 pending, approved or uncertain retained attempts. Current-generation work is prioritized; uncertain attempts can report terminal observations. |
| `prepare` | Native POST `{action:"prepare",pairingId,request,control}` | Validate and retain the exact signed proposal without selecting it. Status stays `pending`; its `preparedDigest` becomes available for owner review. |
| `commit` | Native POST `{action:"commit",pairingId,request,control}` | The existing signed-control outcome; exact accepted retries return the original generation. |

The proof is Ed25519 over the SDK's fixed-position UTF-8 JSON array with domain
`tendriller-device-pairing-v1`. It binds version, pairing/request IDs, service
and page origins, application, authenticated account, public key, reader/writer
rights, expected generation, control revision, nonce and expiry. The public
Chronolog `PeerIdentity` stays inside retained device storage; signing never
exports its private key.

Run the existing native coordinator/administrator before owner review. Once the
browser proves possession, that native owner saves the intent and calls
`session.pauseOrdering(operationId)`. The durable pause drains prior ordering,
fixes the exact generation/prefix and blocks later local or remote ordering.
A generation ID alone cannot establish this boundary: more commands can append
within the same generation while the owner reviews.

The native owner preserves every existing grant, epoch/key digest and recovery
floor, adds only the proved account/key with the requested member reader/writer
rights, and saves the complete signed request and control before calling
`prepare`. Coordinator, recovery, administrator and publisher remain false for
the new browser. The fixed transition ID is `pair-` followed by the pairing ID.
The service runs normal signature, prefix and control admission without selecting
a generation at preparation time. Unprepared pending requests have no approval
controls.

The owner then opens `/pairings/:pageId/:pairingId` on the **service origin**.
The script-free review displays the exact fingerprint, account, application,
origins, rights, generation, retained prefix, full proposal digest and expiration.
The review digest binds both the challenge and the entire prepared request and
control/account payload. Its form uses a session-bound, one-use CSRF token.
Cross-origin submission, wrong-owner review, expiry and replay are refused;
embedding is blocked by frame policy. A signed transition alone does not bind
the complete grant update and is insufficient evidence of this review.

Approval remains separate from enrollment. The same native owner retains the
exact commit attempt before sending it. Pairing approval, current account access,
credential and normal authority checks are repeated inside the existing
serialized control selector. Status compares the selected signed transition and
retained full-payload fingerprint with the reviewed proposal. The helper must
verify that exact outcome before adopting it and releasing the ordering pause;
a `generation` field with `reconciliation_required` is not a committed review.

After commitment the browser connects through its normal peer session and key
exchange. The UI describes enrollment separately and reports connected only
after application work succeeds. An offline native participant leaves a bounded
pending/approved request with an explicit next action. The running starter's
pairing window lasts at most ten minutes and backs off idle checks up to 30
seconds. Single-pass `npm run pair` is available for deliberate inspection/retry
while the ordinary native owner is stopped. It does not wait for owner review or
the later independent receipt-verification pass. Restart the same retained native
participant to complete or reconcile a proposal that the pass prepares or submits.
The browser makes explicit status checks, or one bounded check on returning
from the review tab, without continuous polling or automatic request renewal.

### Bounds and recovery

| Bound | Implemented limit |
| --- | --- |
| Challenge/review lifetime | 10 minutes; polling does not extend it |
| Active requests | 20 per account/application |
| New challenges | 10 per minute per account/application |
| Proof failures | 5, then the request is denied |
| In-flight endpoint work | 8 per application |
| Browser request / native commitment | 4 KiB / 512 KiB |
| Retained journal | 1,024 records and 16 MiB per application; no automatic pruning |
| Account/key bindings | Existing 1,024-binding limit remains authoritative |
| Review form | At most 2 minutes and no later than the challenge expiry |

The browser retains the same request ID and device through reload or a missing
challenge/proof response. The native process retains the exact signed request
and control before submission; a restarted process resends those same bytes.
The host also records the attempt and reconciles it against the verified signed
generation chain after object eviction or a lost commitment response.

The native helper reads back `pairing-ID-intent.json`,
`pairing-ID-prepared.json`, `pairing-ID-commit.json` and
`pairing-ID-outcome.json` under its private project before advancing. The durable
ordering pause is in the same device store; closing a helper window or process
does not clear it. Reopen that same participant to reconcile the original
transition. Missing or conflicting outcomes keep ordering paused. Never delete
the evidence, copy a signer or select a replacement prefix to make writes resume.
A confirmed terminal request with no original committed transition can release
its exact pause. Resolve an existing receipt before rejecting newer generation
state so a committed exact retry remains recoverable after subsequent changes.

Statuses distinguish `challenge`, `pending`, `approved`, `committing`,
`committed`, `expired`, `denied`, `stale`, `revoked` and
`reconciliation_required`. A changed generation requires a newly reviewed
request; it never triggers silent prefix selection or replacement signing.
A previously accepted transition remains inspectable after expiry. Replaying it
after device revocation reports the original receipt and revoked state without
restoring a grant. A missing/corrupt journal fails closed and retains its
recovery boundary. Full ledgers refuse new requests rather than erase accepted
or uncertain evidence.

### Implementation and acceptance tasks

- [x] Review challenge and proof schemas, origin/account/application/key bindings,
  canonical digest, finite limits, privacy and exact cryptographic domain.
- [x] Implement authenticated request/status endpoints with bounded persistent
  state; unavailable or mismatched storage leaves pairing disabled.
- [x] Implement owner review displaying the exact fingerprint and rights, with
  same-origin/CSRF checks, expiry and explicit rejection; verify keyboard and
  narrow-screen use without exposing keys or credentials.
- [x] Integrate review consumption with the existing signed transition and
  immutable account-binding checks. Preserve all existing grants and the selected
  retained prefix; refuse stale or unauthorized changes.
- [x] Test wrong-account, wrong-app, wrong-origin, substituted-key and
  substituted-rights proofs; duplicate nonces; expired/replayed reviews; changed
  authority; and revoked or suspended accounts during asynchronous work.
- [x] Test offline coordinator, simultaneous approvals, lost replies, object
  eviction, browser reload and native-process restart. Exact retries converge on
  the same committed transition; they do not duplicate or restore a revoked grant.
- [x] Test generation changes before commitment: the original outcome remains
  inspectable and any replacement requires a newly reviewed exact proposal.
- [x] Test expiry, request/body/binding capacity and ledger-full behavior without
  evicting accepted or uncertain outcome evidence.
- [x] Qualify a real browser creating its own key, owner review, native enrollment,
  peer key exchange, a command observed on the other device and same-key reopen.
  A successful review screen alone does not satisfy this gate.

Focused evidence is in
[SDK proof/transport tests](../contract/test/pairing.test.mjs),
[worker lifecycle tests](../server/test/device-pairing.public.test.ts) and
[starter resume tests](../scripts/test/tutorial-pairing.test.mjs).
The pairing worker suite passes **17 tests**, including actual concurrent form
submission and two approved proposals targeting the same generation. One form
is consumed once; only the exact winning proposal commits, while the original
losing proposal remains inspectable as stale. Separate database, signed-control
and native-helper regressions cover authority and retained-pause recovery.
An account suspended during asynchronous commitment cannot acquire a signed
generation or device binding. Its exact reviewed evidence survives eviction;
only explicit account restoration permits the same transition to complete.
Revocation without a commit cannot hide a later server-confirmed expiry; the
helper still requires fresh verified authority before releasing that pause.
The real-browser route in
[the first-app runner](../scripts/test-first-app.mjs) exercises the actual review
form and native consumer. The [full hosted run at `1ee9d095`](https://github.com/werg/tendriller/actions/runs/44731655551/job/136272675480)
passed key creation, narrow-screen keyboard review, durable native pause/restart,
encrypted peer commands in both directions and same-key reopen. It also completed
owner-reviewed credential continuation after revoking the setup credential and
removing the original handle, with one original application and allocation.
This uses synthetic owner/provider sessions and a local encrypted WebSocket
relay; selected-host OAuth/MCP acceptance remains a separate gate. A local timer,
uncertain response or unresolved receipt never
substitutes for that authority check.

## Delivery boundary

These changes do not publish a release, deploy a Worker, enable paused creation,
refresh an installed plugin catalog, sign in the human owner or establish
automatic ChatGPT wake. Use the [onboarding acceptance procedure](AGENT_ONBOARDING_TEST.md)
and [repair plan](ONBOARDING_REPAIR_PLAN.md) to record the exact composition,
migrations, actual selected host and observed client/browser evidence.
