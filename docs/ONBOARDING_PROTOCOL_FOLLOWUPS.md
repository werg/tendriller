# Account-bound setup and reviewed device pairing

Status: **both required capabilities are implemented in the repository** for
[core PR #68](https://github.com/werg/tendriller/pull/68). Focused SDK, worker and
starter tests are committed. The remaining integrated, packed-browser and
deployed-client acceptance gates are recorded below; source changes do not
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
Its account-setup schema revision **2** and allocation fences are checked by the service; a missing
or incompatible ledger fails closed. Runtime request handling never creates the
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
original-grant revocation and cached adapter admission. The committed focused
checkpoints passed 21 setup worker tests plus 6 authority tests, with 44 related
Admission/alarm/lifetime tests. Per-account retained capacity and the last daily
IP slot are exercised; the 10,000-row global ceiling is enforced by the schema
but was not separately stress-tested to its maximum.

### Implementation and acceptance tasks

- [x] Implement exact HTTP/tool schemas, canonical digest, namespace, typed
  states and public SDK types without caller-supplied ownership.
- [x] Add internal idempotent page initialization while preserving the anonymous
  email route's authorization boundary.
- [x] Complete the retained-credential freshness matrix: configured scope,
  issuer/audience, account/client, grant revocation, expiry, suspension/deletion,
  and revocation during asynchronous control/publication work.
- [x] Resolve verified email server-side and require the original account at claim.
- [x] Implement bounded durable journals and atomic per-page initialization with
  explicit account migration and fresh DO schema revision 10.
- [x] Retain the client credential before networking and reconstruct one handle
  from the original public receipt after a lost response.
- [x] Exercise allocation-boundary failures and retained recovery, including
  pre-admission reservation, D1 index, initialization dispatch and orphan cleanup.
- [x] Race exact duplicate requests and refuse changed name/application/commitment.
- [x] Test scope/expiry/revocation/adoption for the retained setup binding;
  preserve prepared authority and independent browser/assistant consent.
- [x] Test capacity and missing-journal retirement cases without evicting
  uncertain allocation evidence or allocating a replacement page.
- [ ] Qualify the final packed starter and actual account-linked MCP/browser
  journey on the selected deployed host; distinguish local and live evidence.

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
| `pending` | Native GET without an ID | At most 20 reviewed/retained attempts. Current-generation work is prioritized; uncertain attempts can report terminal observations. |
| `commit` | Native POST `{action:"commit",pairingId,request,control}` | The existing signed-control outcome; exact accepted retries return the original generation. |

The proof is Ed25519 over the SDK's fixed-position UTF-8 JSON array with domain
`tendriller-device-pairing-v1`. It binds version, pairing/request IDs, service
and page origins, application, authenticated account, public key, reader/writer
rights, expected generation, control revision, nonce and expiry. The public
Chronolog `PeerIdentity` stays inside retained device storage; signing never
exports its private key.

The owner opens `/pairings/:pageId/:pairingId` on the **service origin**.
The script-free review displays the exact fingerprint, account, application,
origins, rights and expiration. Its form uses a session-bound, one-use CSRF token
and the immutable proposal digest. Cross-origin submission, wrong-owner review,
expired forms and replay are refused; embedding is blocked by frame policy.

Approval remains separate from enrollment. The existing native coordinator and
administrator preserves current control metadata and every existing grant,
adds only the requested member reader/writer grant and immutable account binding,
and retains the signed attempt before sending it. The fixed transition ID is
`pair-` followed by the pairing ID. Existing signature, prefix and control
checks run before the host reserves the attempt. The pairing approval and target
account admission are checked again inside the existing atomic registry write.

After commitment the browser connects through its normal peer session and key
exchange. The UI describes enrollment separately and reports connected only
after application work succeeds. An offline native participant leaves a bounded
pending/approved request with an explicit next action. The running starter backs
off idle native polling up to 30 seconds; one-shot `npm run pair` remains available
while the ordinary native owner is stopped.

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

- [x] Implement exact challenge/proof schemas, domain separation, bindings,
  privacy boundaries and finite limits.
- [x] Implement authenticated request/status endpoints and bounded durable state;
  missing or incompatible storage disables pairing.
- [x] Implement service-origin owner review, exact fingerprint/rights display,
  same-origin session-bound CSRF, expiry and explicit rejection.
- [x] Integrate the reviewed proposal with existing signed transition and immutable
  account-binding checks; preserve other grants and the selected retained prefix.
- [x] Test substituted proof fields, wrong key/account/origin, extra rights,
  expired/replayed review, invalid signatures and target admission revoked during
  asynchronous commitment.
- [x] Test exact duplicate challenge/restart, offline pending approval,
  lost commitment reply/object eviction, retained browser intent and native
  restart, without duplicate enrollment or resurrection after revocation.
- [x] Test changed generations: stale requests remain inspectable and a
  replacement needs explicit new review.
- [x] Test expiry, oversized request, proof/rate/ledger/binding limits and missing
  or corrupt retained state without discarding accepted outcomes.
- [ ] Qualify the final packed real-browser path: retained browser key, keyboard
  and narrow-screen owner review, native enrollment, peer key exchange,
  cross-participant command, same-key reopen and deployed-client acceptance.

Focused evidence is in
[SDK proof/transport tests](../contract/test/pairing.test.mjs),
[worker lifecycle tests](../server/test/device-pairing.public.test.ts) and
[starter resume tests](../scripts/test/tutorial-pairing.test.mjs).
The pairing worker tests plus existing database and signed-control regressions
passed **43 tests** at the focused checkpoint. The real-browser route in
[the first-app runner](../scripts/test-first-app.mjs) exercises the actual review
form and native consumer; its final integrated result belongs to the separate
acceptance record.

## Delivery boundary

These changes do not publish a release, deploy a Worker, enable paused creation,
refresh an installed plugin catalog, sign in the human owner or establish
automatic ChatGPT wake. Use the [onboarding acceptance procedure](AGENT_ONBOARDING_TEST.md)
and [repair plan](ONBOARDING_REPAIR_PLAN.md) to record the exact composition,
migrations, actual selected host and observed client/browser evidence.
