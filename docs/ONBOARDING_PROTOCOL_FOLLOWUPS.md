# Account-bound setup and reviewed device pairing

Status: **design and acceptance work, not implemented or deployed**. This review
was made on 20 November 2026 against the account, creation and enrollment code
under review with [core PR #68](https://github.com/werg/tendriller/pull/68).
Every task below remains open. Proposed interface names and limits require
review before they become a public contract.

The current repair fixes discovery, origin selection, early service readiness,
release composition, resumption from a saved handle and publication-outcome reporting. These
two follow-ups remove additional interaction steps: obtaining an owner's email
when the integration already knows the account, and copying a browser public key
to the native participant. They are separate product/protocol work. Human owner
sign-in, device authority and assistant consent remain deliberate boundaries.
The existing email-based creation and reviewed enrollment route remains usable
when its prerequisites are met.

## What the current code establishes

| Boundary | Verified implementation | Consequence |
| --- | --- | --- |
| OAuth creation permission | [OAuth scopes](../server/src/accounts/oauth-support.ts) include `tendrils:create`; [consent text](../server/src/accounts/oauth-authorization.ts) describes creating a page for the account's verified email. | A new authenticated creation route can require this existing scope. Configured clients and already-issued grants do not necessarily have it; do not expand either silently. |
| Linked account | [The MCP gateway](../server/src/assistant-gateway.ts) verifies the access token and constructs the principal from its subject, client, grant and scopes. `get_profile` returns a hash of issuer/account as its public ID. Its tool catalog has no create operation. | Resolve ownership on the server. Do not infer an email from the public profile ID or turn that identifier into a credential. |
| Verified email | [Provider sign-in](../server/src/accounts/auth.ts) records verified provider emails in `identity_emails`. [Page claim](../server/src/accounts/page.ts) joins those records to the account. | `accounts.email` alone is not the source of current verified-email evidence. Reuse the verified-identity join and active-account checks. |
| Anonymous creation | [The public route](../server/src/router.ts) rejects `Authorization`, accepts an owner email, checks creation mode and quotas, then allocates a new random page ID. [Tendril.create](../server/src/tendril.ts) returns the setup handle once. | Adding an MCP wrapper around this route would not make creation account-bound or safely resumable. The anonymous API must keep its existing authentication boundary. |
| Admission | [Admission](../server/src/admission.ts) stores `id`, `ts` and `released`; repeated reservation of the same page ID is idempotent. | This is a quota reservation, not an account/client operation journal. The public route generates another ID on another request. |
| Setup credential | `Tendril.addToken` stores the setup token's SHA-256 in the [page database](../server/src/db.ts); only the first result contains the raw token. | The host cannot reconstruct a lost raw setup credential from its stored hash. Returning the same page URL is insufficient recovery for an implementing agent. |
| Existing recovery | `Tendril.adopt` consumes an explicit code and can revoke previous tokens. [OAuth intents](../server/src/accounts/oauth-data.ts) are bounded, expiring, one-use browser form records. | Neither mechanism is a transparent creation-retry journal. Do not silently invoke adoption or reuse OAuth forms as a credential-recovery store. |
| Browser enrollment | [The first-app setup](tutorial/setup.mjs) accepts a copied public key, uses the authenticated `owner_account_id`, and selects an exact signed control transition. [Peer controls](../server/src/peer-generations.ts) enforce admitted accounts, immutable key/account binding and transition fingerprints. | A smoother pairing UI needs an authenticated key request and an exact reviewed control change. Account login alone does not grant a new device application rights. |

There is no existing durable store that binds an authenticated client's creation
operation to its allocated page, complete result and recoverable setup authority.
Per-application command journals start after an application and its participant
exist. A safe implementation needs new bounded setup state and a reviewed storage
change. This is why a create tool is not included as a small metadata-only fix.

## A. Prepare a page for the linked account

### Proposed public boundary

Keep access-token issuance, issuer/audience validation and `get_profile` privacy
unchanged. Add a creation-specific authenticated service operation and expose it
through MCP and the public SDK only after the retry contract is implemented.

Proposed operations:

| Operation | Input | Result |
| --- | --- | --- |
| `prepare_tendril_setup` | Caller-retained `operationId`, name, mode, optional stable application ID, and a commitment to a locally retained setup credential | Same-origin page/application metadata and a bounded setup status. The server derives the intended owner; there is no caller-supplied email or account ID. |
| `inspect_tendril_setup` | The original `operationId` | `prepared`, `provisioning`, `ready`, `blocked`, `expired` or `reconciliation_required`, with the original page ID when allocated and a concrete next action. Inspection creates nothing. |

Both operations require a current grant containing `tendrils:create` and bind
the operation namespace to the exact service origin, OAuth account and client.
Record the admitting grant for audit; token refresh does not create a different
operation. Reauthorization after expiry must verify the same account/client and
scope before exposing its prior setup. Different clients or accounts cannot
inspect or reuse each other's operation IDs.

The first implementation should derive one verified email from the account's
current `identity_emails` records, preferring the stored display email only if it
is also in that verified set. No verified email means a typed
`owner_verification_required` result before any page or quota is allocated. Do
not ask the model to supply an alternative identity or expose the email in public
discovery. Persist the exact intended account as well as the verified email used
for admission. Claim must require that same account and the existing verified
owner check; a removed or changed verified identity needs an explicit recovery
action, never automatic reassignment to another account with a matching string.

### Recover the setup without retaining raw credentials on the host

The preferred candidate is a client-generated setup credential: the SDK creates
it securely, saves it with the operation ID and complete request **before the
first call**, and sends only its hash/commitment. The host records that commitment
under a fixed, reviewed page-scoped setup binding. Returned metadata combines
with the already-retained credential to reconstruct the private handle after a
lost response. The public tool result never needs to return that secret again.

This requires a new internal creation form; it must not make arbitrary token
hash injection available on existing pages. Review the setup binding's exact
scopes, expiration, grant-revocation behavior and owner-adoption behavior before
implementation. It authorizes preparation of this new page only. It does not
confer an account session, another page's management rights, device signing keys,
or assistant/data permissions. Do not add delegation rights by default.

If the execution surface cannot durably retain the credential before the call,
report `setup_storage_required` and create no page. If that private state is
later lost, inspection can recover the public setup reference, but cannot recover
the secret from its hash. Offer the actual authenticated owner's separately
reviewed adoption/delegation route, or leave the unclaimed page to its documented
expiry. Do not mint a replacement secret, revoke another binding, or create a
replacement page as an automatic retry.

### Durable allocation and recovery

Add an operation ledger with a uniqueness constraint on
`(serviceOrigin, accountId, clientId, operationId)`. Retain the canonical input
digest, credential commitment, intended owner, allocated page/application IDs,
admission progress, status, timestamps and typed failure. A changed input or
commitment under the same ID is `setup_operation_conflict`.

Persist the operation and allocated page ID before reserving admission or sending
an internal create request. Reuse Admission's existing per-page reservation
semantics. Make the internal page initialization idempotent for the exact
operation/digest/credential commitment and able to report its committed result
after object eviction. Persist initialization atomically within its own storage
boundary; a partially created object must not be mistaken for a fresh request.
The account database, Admission object and page object are separate boundaries,
so recovery must reconcile their actual state rather than pretend they share one
transaction.

An interrupted request after page creation but before ledger completion must
inspect that same page. A missing response does not justify deleting its account
index, releasing an occupied reservation or allocating another page. Reconcile
creation/IP/account quotas exactly once under the retained operation. New setup
must still pass current service readiness and admission; inspecting a completed
setup must remain possible during a creation pause.

Use finite pending and retained-operation quotas. A full ledger refuses new work
with a useful next action instead of discarding uncertain results. Expiring an
operation must not make its ID reusable. Decide and test the tombstone/retirement
policy before enabling pruning; unresolved operations cannot be garbage-collected
into a second creation. An absent or corrupt journal for an already allocated
page produces `reconciliation_required`, with no guessed credential or new ID.
The authenticated owner needs a bounded pending-setup view so losing the local
operation reference does not leave an undiscoverable page.

### Implementation and acceptance tasks

- [ ] Review the exact endpoint/tool schemas, canonical request digest, operation
  namespace, error states and credential commitment format; update SDK types and
  tool annotations only with the implemented behavior.
- [ ] Extract the existing creation/admission work into a shared internal service
  while preserving the anonymous route's email and authorization rules.
- [ ] Require the existing configured and granted `tendrils:create` permission;
  test wrong issuer/audience, another account/client, missing scope, revocation,
  suspension, deletion and expired grants. Existing tokens acquire no new scope.
- [ ] Resolve verified email server-side; test no verified email, stale display
  email, multiple verified identities and wrong-account claim. Persist and enforce
  the exact intended account without weakening the existing email route.
- [ ] Implement the bounded durable ledger and atomic per-page initialization.
  Review the account/DO schema rollout explicitly under the storage policy; do
  not reinterpret existing rows or bypass a schema mismatch.
- [ ] Persist the client credential and operation before networking; verify a lost
  HTTP/MCP response can reconstruct the same handle without a returned raw secret.
- [ ] Inject failures before and after every allocation boundary: ledger write,
  admission reserve, account index, page initialization, result persistence and
  response delivery. Restart each object and recover one page, one credential
  binding and one quota charge.
- [ ] Race exact duplicate calls and changed-body reuse. Exact calls converge;
  changed name, application ID or credential commitment is refused.
- [ ] Define and test setup-binding scope, expiry, revocation and owner adoption.
  Preserve prepared code/authority at claim while keeping browser membership and
  assistant consent independent.
- [ ] Exercise lost local secret, lost operation ID, expired operation, full ledger,
  missing/corrupt retained state and deleted page. Each offers inspection, reviewed
  recovery or a terminal explanation, never a silent replacement creation.
- [ ] Qualify the packed starter and real MCP client on the selected host; report
  account creation, owner sign-in and live browser evidence separately.

## B. Pair a browser through a bounded, reviewed request

### Proposed flow

Keep the native application's current signed-control enrollment path. Add an
authenticated pairing request as a small lifecycle operation; it does not create
an alternate command queue or a host application-data replica.

1. The already signed-in browser creates or reopens its own retained device.
   It asks the exact page/service for a short-lived challenge. Bind that challenge
   to the service and page origins, application ID, current account, proposed
   public key, request ID, requested rights, and expiry.
2. The device proves possession of its private key using the public Chronolog
   signing/verification contract. The service verifies that proof and the current
   page/account session, then records a pending request. A pasted public key,
   display label or owner-like payload field is not proof of either identity.
3. The owner sees the device fingerprint, account, app, requested rights and
   expiration in an authenticated review. Approval binds an exact request digest
   and is protected against cross-origin submission and stale/replayed forms.
   The ordinary first-app request asks for only its necessary reader/writer
   rights; publishing, administration, coordination and recovery are separate.
4. The retained authorized coordinator/administrator consumes that exact approval
   and prepares the usual signed control transition. It preserves other grants,
   immutable account bindings, current generation and retained prefix. It must
   use current verified authority immediately before admission.
5. The host records the pairing's transition identity and observed outcome.
   The browser waits for a verified committed grant, then connects and receives
   keys through its ordinary peer session. Mark it connected only after the real
   application query/command succeeds.

A new owner-review UI cannot replace the authority checks in
[peer controls](../server/src/peer-generations.ts). Browser and native participant
availability are independent. If the coordinator is offline, retain a bounded
pending request and show the actual next step. Do not silently select an older
prefix, grant the host data access, copy another device's signer or turn owner
sign-in into automatic device approval.

### Bounds, retries and review changes

Review concrete finite limits before publishing this interface. A reasonable
initial candidate is a challenge/review lifetime of at most ten minutes, at most
twenty pending requests per account and application, a bounded request body,
bounded invalid-proof attempts and explicit rate limits. The existing maximum
device/account binding count still applies. Expiry rejects further approval;
there is no indefinitely renewed polling lease.

Keep request creation, review and control commitment separate. Before commitment,
revocation or expiry prevents admission. After commitment, cancelling the pairing
screen does not revoke the device: revocation is its own reviewed control change.
A lost approval or transition response resumes the original request and exact
signed transition. A later revoked grant stays revoked on replay. If the prepared
generation/prefix becomes obsolete, show the changed proposal and require renewed
review instead of silently signing a replacement.

Use one-use browser review tokens and an immutable proposal digest. The existing
OAuth form-intent pattern is useful for the UI's CSRF/lifetime discipline, but
its constrained `kind` values and delete-on-use storage are not the durable
pairing journal. New pairing state must preserve accepted transition receipts
and distinguish pending, expired, denied, committed, revoked and uncertain states.

### Implementation and acceptance tasks

- [ ] Review challenge and proof schemas, origin/account/application/key bindings,
  canonical digest, finite limits, privacy and exact cryptographic domain.
- [ ] Implement authenticated request/status endpoints with bounded persistent
  state; unavailable or mismatched storage leaves pairing disabled.
- [ ] Implement owner review displaying the exact fingerprint and rights, with
  same-origin/CSRF checks, expiry and explicit rejection; verify keyboard and
  narrow-screen use without exposing keys or credentials.
- [ ] Integrate review consumption with the existing signed transition and
  immutable account-binding checks. Preserve all existing grants and the selected
  retained prefix; refuse stale or unauthorized changes.
- [ ] Test wrong-account, wrong-app, wrong-origin, substituted-key and
  substituted-rights proofs; duplicate nonces; expired/replayed reviews; changed
  authority; and revoked or suspended accounts during asynchronous work.
- [ ] Test offline coordinator, simultaneous approvals, lost replies, object
  eviction, browser reload and native-process restart. Exact retries converge on
  the same committed transition; they do not duplicate or restore a revoked grant.
- [ ] Test generation changes before commitment: the original outcome remains
  inspectable and any replacement requires a newly reviewed exact proposal.
- [ ] Test expiry, request/body/binding capacity and ledger-full behavior without
  evicting accepted or uncertain outcome evidence.
- [ ] Qualify a real browser creating its own key, owner review, native enrollment,
  peer key exchange, a command observed on the other device and same-key reopen.
  A successful review screen alone does not satisfy this gate.

## Delivery boundary

Neither follow-up deploys a service, repairs a stale installed tool catalog,
enables paused creation or provides automatic ChatGPT wake. Keep those external
operator/client checks in the [onboarding acceptance procedure](AGENT_ONBOARDING_TEST.md).
After these protocol tasks are implemented, publish a new exact release
composition and rerun the actual cold-start journey. Until then, the current
guides must continue to describe the supported email and explicit enrollment
route rather than imply that these proposed tools exist.
