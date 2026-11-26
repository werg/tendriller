# Session bootstrap and ownership

The runnable [first-app tutorial](BUILD_AN_APP.md) supplies the actual composition (`tutorial/setup.mjs`, `tutorial/shared/native-page.mjs`, `tutorial/templates/notes/worker.mjs`); this reference explains the boundaries when adapting those files. Use [Build an app](BUILD_AN_APP.md) and the complete event/SQL [state-model starters](STATE_MODELS.md) from its verified first-app release kit. There is no `deployment.mjs` import. Authored consumers import public package entrypoints only.

## Keep the identities distinct

| Identity/authority | What it permits |
| --- | --- |
| Agent token (`ta_`) and page URL | The agent's one account-level host credential (explicit per-page grants and scopes; not data decryption) and one hosted page's address |
| Workspace shared signer as publisher | The agent's one opaque signing key (shared by all its pages, not a per-page key) signs immutable UI/code under the prepared host publisher policy; the publisher right needs no reader/writer/root grant. As creator (`npm run init`) the same key is the page's root principal and first administrator; `initialized.json` marks that this page's data store exists |
| Workspace wrap key | The agent's one X25519 key-wrap key (`.tendriller/agent/wrap-key.json`, registered as `wrapKey`). Members wrap each page's epoch keys to it; its private half never leaves the workspace |
| Device wrap key | Each browser device's own X25519 key-wrap key, kept in its device store (`deviceWrapKey(store)`) |
| Host attestation key | The host's Ed25519 key. It signs short-lived account-bound `HostAttestation`s of device keys, which genesis pins as `admission.hostKey`; it never signs membership |
| Browser/native signing identity | Authorship of exact durable proposals, with authenticated crypto membership. All of one agent's pages share its one signing key, each with its own device store |
| `reader` / `writer` | Independent crypto/data-session eligibility; neither implies SQL object permissions |
| `administrator` / `publisher` / `finalizer` | Separate explicit rights; writing grants none of these implicitly |
| Application SQL grants | Ordinary authored namespace/object/row/column permission state, evaluated at chronological execution |
| Profile owner lock | One physical signer/store on one device, not a global application-order authority |
| View/agent binding | Bounded attachment and approved tool capability scope, independent from membership and caller labels |

Descriptor: `{applicationId,rootPrincipal,authorityPublicKey,executionManifestDigest,finalityPolicy}`. Public cryptographic identifiers are lowercase hex. The execution manifest establishes deterministic engine/platform semantics, **not immutable application schema**. Membership records carry revision, predecessor digest, signed activation floor, independent grants with each member's wrap key, epoch and epoch-key commitment, the admission policy `{mode,hostKey,accounts,grant}`, admitted-member evidence and signed invites. This metadata chain never supplies SQL operation order or overwrites projected permission tables.

## Fresh creation, in order

1. Same-origin service/discovery/readiness and immutable kit verification.
2. Register the workspace agent once (`tendril workspace init|join|key|adopt`; one credential and one signing key) and create the page (`npm run page:new -- <slug>`; the creating agent is granted it automatically). Retain the private workspace.
3. `npm run init -- <slug>`: prepare `{executionManifestDigest,executionProfile,publisherKeys,requestedFinality?,tools?}` (ordinary apps omit finality to choose `none`), then create the page data as its creator: `createPageGenesis` signs the descriptor, genesis membership and first epoch key with the shared signer and wrap key, `openPageAuthority` retains the exact bundle and key before `initialize`, and `initialized.json` is written. `--browser-first` (implied by `--browser-finalizer`) skips creation.
4. `npm run deploy -- <slug>`: build and sign the complete UI. Publisher authorization is independent from the data descriptor/database schema.
5. Give the person the ready page URL and keep `npm run agent` running. Their sign-in yields a host attestation of the browser's device key and wrap key; the agent admits that owner-account device and wraps the keys to it. On a browser-first page the first browser is the creator, and the agent is admitted from its signed host grant.
6. Additional devices, agents and invited people use the same admission (see [membership](MEMBERSHIP.md#admission)). Account access alone never reconstructs a data key.

An account login is not a device grant. The agent token is not a device signer. A publisher grant is independent of data access and control administration. A page release does not initialize or replace an application session. The agent's grant lets it create the page keys and publish within the common publication capacity and the unclaimed page's 24-hour expiry; the owner later signs in to open the ready page, with its devices admitted into the existing membership without reset.

See `setup.mjs`, `publish.mjs`, `helpers/prepare-host.mjs`, `helpers/page-data.mjs`, `helpers/browser-bootstrap.mjs` and `helpers/devices-view.mjs` in the tutorial. Private intents/signing identities/epoch keys remain outside `page/`.

## Local opening before network discovery

```js
import { createApplicationSession } from '@chronolog/peer-session';
import { openBrowserDevice } from '@chronolog/peer-session/worker';
import { createAuthorityProvider } from '@chronolog/authority';

const device = await openBrowserDevice({ name: retainedProfile });
const authority = await createAuthorityProvider({
  store: device.store, applicationId,
}); // verified cached metadata and keys; no host fetch
const session = await createApplicationSession({ device, definition, authority });
```

The starter explicitly creates only an empty first device profile. A retained binding with missing/damaged private identity fails closed. `openPageAuthority({store,identity,wrapKey,peers,applicationId,executionManifestDigest,create})` from `@tendriller/core/admission` opens the cached provider without the network. On cache absence it reads `GET application`: an uninitialized page is created by this device when `create` is set (the exact genesis and epoch key are stored before `initialize`; an uncertain reply resends the same bytes, and a lost race discards the unsent genesis), otherwise it fails `PAGE_UNINITIALIZED`; an initialized page is verified and pinned so the device can request admission. On an established device, local reopening does not wait for host refresh, discovery, peers or a finalizer.

`createApplicationSession({device,definition,authority?,applicationId?,epochKeys?,createMaterializer?})` is the sole public factory. Do not invent a parallel `{descriptor,identity,store,runtime}` constructor. SQL supplies a lazy callback:

```js
createMaterializer: async ({signal,rootPrincipal}) => {
  const {createSqlMaterializationRuntime} = await import('@chronolog/peer-session/sql');
  return createSqlMaterializationRuntime({engine,path:'/application.sqlite',rootPrincipal});
}
```

Use the matching `sql-browser`/`sql-native` engine loader. Creating tables, changing schema and permission/platform operations happen later through ordinary signed programs. Never pass a static signed-schema descriptor.

## Attach control, then participation

Create the page client (`createAgentClient({service, token}).page(pageId, {applicationId})`; its control streams share the agent's one hub WebSocket) using the stable application
ID, then keep the starter's platform owner helper. Native owners call
`participateNativeApplication`; browser owner factories use the injected RTC
opener with `participateApplication`. Both consume the same exported transport
policy and automatic fallback; see [the canonical peer connection guide](PEER_CONNECTIONS.md).

Direct RTC is the normal path, including the installed native capability and the
page-side browser provider. No native-RTC installation detour or application-owned
connection selector is required. Keep signing, state and peer authentication in
the existing owner, and never substitute an always-failing RTC opener. The session
owns retries and recovery. Verify actual direct application traffic and automatic
fallback, rather than treating a connected WebSocket as proof of P2P.

Read `session.status` for actual data state, including `connectedPeers` and
`connectionRevision`, and observe it with `session.onStatus`. The optional
participation controller you create with `participateApplication` (browser) or
`participateNativeApplication` (native) separately reports discovery and
connection progress through its own `status` and `onStatus`. The admission controller's
`state.phase` separately reports `waiting-admission`, `waiting-approval`,
`waiting-keys`, `admitted` or `removed`. No participant needs to be reachable for
local authoring on an admitted device.

## Admit devices without distributing secrets

`createAdmission(session,{peers,wrapKey,store,subject:'device'|'agent'})` is the one admission controller, used by the browser Worker (`admitBrowserSession`) and every native agent page. As a newcomer it obtains and renews its host attestation (presenting a stored invite when there is one), waits, and installs the epoch keys members wrap to it. As a member holding the current key it verifies pending attestations against signed state, admits eligible ones in one signed revision, and keeps every reader's keys wrapped. The published code never receives the agent token, native signer or plaintext epoch key; the browser uses its page's same-origin cookie for host access and its own device identity for the signed session.

The controller returns `{state,subscribe,refresh,extensions,call,close}`. Pass `extensions` to `createApplicationOwner(session,{extensions})` (the browser Worker's `openSession` returns `{session,extensions,close}`); views and the CLI call `session.extensions.call(name,args)`:

| Action | Effect |
| --- | --- |
| `admission.state` / `admission.refresh` | Current `AdmissionState` (phase, mode, members, pending, invites, notices) |
| `admission.approve(publicKey,{writer?,administrator?})` | Administrator: admit a pending device (strict mode, other accounts, previously removed keys) |
| `admission.remove(publicKey)` | Administrator: sign the member's revocation and a new epoch wrapped only to the remaining members |
| `admission.mode('attested'\|'strict')` | Administrator: auto-admit owner devices, or require approval |
| `admission.grant(publicKey,{writer?,administrator?})` | Administrator: change a member's rights |
| `admission.addKey(publicKey,wrapKey?,{writer?})` | Administrator: add a key no host attests, such as the hosted MCP identity an owner device creates (no wrap key means it never receives wrapped keys) |
| `admission.invite({binding,role,expiresInMs})` | Administrator: sign an invite; returns `{inviteId,fragment}` for the link `PAGE_URL#invite=<id>.<secret>` |
| `admission.revokeInvite(inviteId)` | Administrator: sign the invite revoked |
| `admission.redeem(fragment)` | Newcomer: present an invite from the link fragment |

Owner notices are `{topic:'admission',state}`; `state.notices` kinds are `new-device`, `pending` and `removed`. Pass `onNotification: () => admission.refresh()` to `participateApplication`/`participateNativeApplication` so host page notifications wake the controller.

## Compose the browser facade

The Worker calls `serveBrowserOwner` from
`@tendriller/core/worker-owner`. The owner acquires an exclusive Web Lock
**before** its `openSession` callback opens the retained device, verifies signed
authority, and creates the Chronolog session. Browser identity creation is a separate explicit action.

When configuration must be fetched, call `serveBrowserOwner({ load: async
({ signal }) => { /* fetch and return the configuration */ } })` synchronously
at module startup. This registers message listeners before awaiting network work,
preserving the first attachment or identity request. Do not await a top-level
configuration fetch before installing the owner service.

The page calls `openBrowserOwner` from
`@tendriller/core/browser-owner`, supplying the worker URL, retained
profile, immutable application identity, and optional takeover callbacks.
Every browser application (events, SQL/OPFS, and WebRTC media) uses one uniform
single-active-tab lock paired 1:1 with a dedicated Worker: the active tab owns
`RTCPeerConnection` and local media directly while the Worker owns device storage
and Chronolog execution. Opening the same page in a second tab rejects with
`code: 'TAB_ACTIVE_ELSEWHERE'` until the user explicitly chooses to take over
(`takeover: true`), which retires the previous tab via `onOwnerReplaced` without
losing stored operations or drafts. The page mounts the returned session as shown
in [Compose one browser owner](#compose-one-browser-owner).

## Compose one browser owner

`serveBrowserOwner` in `worker.mjs` uses the real public `createApplicationOwner`. `openBrowserOwner` in `page.mjs` acquires the single-active-tab lock and attaches to its 1:1 dedicated Worker, exposing `attachment.session` plus live WebRTC peer handles (`attachment.peers()`, `attachment.onPeer(listener)`) for mid-session RTP tracks and custom `app:*` DataChannels (see [WebRTC media](WEBRTC_MEDIA.md)). Keep the original browser profile, physical store and signed operation records; do not replace them on a timeout or hide/show transition.

```js
const attachment = await openBrowserOwner({
  workerUrl, profileId, applicationId, context: { viewId },
  takeover: false,
  onOwnerReplaced: () => showMovedToAnotherTabBanner(),
});
const session = attachment.session;
window.tendril.application.install(createApplicationBackend(session));
```

The runtime matches `backend.applicationId` to `selection.id`. It requires durable submission, coherent views/changes, independent operation inspection, exact retry and subscriptions—not ordering/recovery capabilities. Detach cleanly on `pagehide`; never erase pending operations. Preserve finite local RPC deadlines.

## Optional background participation

`participateApplication(session,{peers,openDirectConnection})` runs after local opening and returns immediately. It uses existing direct RTC, isolated reliable/live lanes, encrypted relay fallback, account-bound introductions and bounded retry budgets. Metadata refresh is signed evidence verified into the cached authority provider. It never blocks Save. `participateNativeApplication` supplies optional Node RTC mechanics for an admitted native device.

Open root locks before opening signer storage. Native tools attach to the existing private IPC supervisor or deliberately use a separately admitted profile; an unavailable supervisor never authorizes another signer. Report its actual process lifetime. Optional agent/tool-provider dispatch and idempotency are not application ordering.

## Admission wire contract

Use `@tendriller/core/authority` (`createAuthorityClient`) for transport and `@chronolog/authority` for canonical record encoding/signature verification. `{record:lowercaseHexCanonicalBytes}` preserves bigint timestamps and bytes without JSON narrowing. Agent routes (`/api/agent/pages/<page>/peers/…`) and the page origin (`_tendril/peers/…`) share one implementation.

- `GET application`: `{selection,configuration,publicationAuthority,authority,hostAttestationKey,admissionAccounts}`. `authority` is the canonical bundle record or null before the creator initializes. `admissionAccounts` is what genesis must pin: the owner account ID once claimed, else `email:<intended owner>`.
- `POST application`: `HostAppConfig`, authorized by host management scope. Identical preparation retries are accepted; changed immutable setup is rejected.

`POST peers/enrollment` actions (all run under the page's authority mutation lock):

| `action` | Caller | Input | Result |
| --- | --- | --- | --- |
| `challenge` | Signed-in browser account | `publicKey` | `{applicationId,publicKey,challenge,expiresAt}` |
| `enroll` | Same | `proof` (signed `EnrollmentRequest {applicationId,publicKey,wrapKey,challenge}`), optional `invite:{inviteId,secret}` | Metadata plus `attestation`. Works before the page has authority |
| `enroll-agent` | Agent with a page grant | none | Metadata plus an agent `attestation` (also issued automatically when the grant is created) |
| `initialize` | Agent whose registered key is the genesis root, or the owner's browser account | `bundle` | Stores the genesis once (`application_initialized` 409 otherwise; an identical retry returns metadata) |
| `membership` | Any principal that may read authority | `bundle` | Stores a chain extended by exactly one revision; `membership_head_changed` 409 when the stored head moved |
| `admissions` | Any page principal | none | `{pending: record[], wrapped: {<recipient>: <max epoch>}}` |
| `wrap` | Any page principal | `wrap` (signed `KeyWrap`) | Stores it when signer and recipient are reader members (at most 4 per recipient) |
| `wraps` | Any page principal | `recipient` hex | `{wraps: record[]}` |

`initialize` requires prepared configuration and checks: a verified bundle with exactly one membership; the selected `applicationId`; the configured `executionManifestDigest`; `authorityPublicKey == rootPrincipal`; the configured finality (`none` when omitted; `browser-signed-frontier` is a signed frontier whose signer is the root); `admission.hostKey` equal to the host attestation key; `admission.accounts` containing the owner principal; and a root member with reader, writer, administrator and a wrap key.

Record shapes (hex keys, bigint milliseconds):

- `HostAttestation {subject:'device'|'agent', pageId, applicationId, accountId, email (verified lowercase or null), publicKey, wrapKey, label (≤128), inviteId (32 hex or null), issuedAt, expiresAt (≤24 h window; devices get 60 min), nonce (64 hex)}`, signed by the host attestation key. An agent's attestation names the page owner account (or `pending:<pageId>` before claim) and its `@handle` label.
- `AdmissionPolicy {mode:'attested'|'strict', hostKey, accounts: ('<accountId>'|'email:<email>')[], grant:{reader,writer}}`.
- `MemberGrant {publicKey, wrapKey, reader, writer, administrator, publisher, finalizer}`; `MemberAdmission {publicKey, via:'attested'|'invited'|'approved', attestation}`.
- `PageInvite {inviteId, role:'reader'|'writer'|'admin', binding:{kind:'email',email}|{kind:'open'}|{kind:'public',max}, expiresAt, secretDigest (sha256 of the 32 secret bytes), revoked}`.
- `KeyWrap {applicationId, descriptorId, membershipId, recipient, wrapKey, epochs, authority, encrypted}`, signed by a member (`session.provisioning.wrapKeys(recipient)` / `.unwrapKeys(wrap, wrapPrivateKey)`).

`enroll` with an invite checks, in the page transaction, that the head holds that invite unrevoked and unexpired, the secret digest, the email binding against the account's verified email, and redemptions (`open`/`email`: one account, idempotent for it; `public`: up to `max` accounts). Errors are `invite_invalid` (malformed), `invite_unknown`, `invite_revoked`, `invite_expired`, `invite_secret_invalid`, `invite_email_mismatch`, `invite_redeemed` and `invite_exhausted`. Without a configured attestation key the enrollment actions fail 503 `attestation_unconfigured`.

- `POST peers/participant`: signed portable authority/publication/finality requests, canonically encoded as one bounded record. No application programs are accepted.
- `POST peers/publication`: independent signed publisher manifests and referenced immutable code assets. Code-revision concurrency is separate from data chronology.

`session.mergeAuthority(bundle)` verifies and retains public evidence without SQL membership overlays.

## Own shutdown and uncertain operations

`submit({program,operationId?,authorTimestampMs?})` acknowledges durable local storage, not network execution. Materialized success/rejection is revisable at a coherent snapshot. Retention and finality are independent. Preserve original identity, authored time and bytes after any uncertain reply; use `operations.get`, `inspect`, `operations.retry`, and subscriptions. No-finality final waits reject as unsupported. Excluded originals remain inspectable and are never silently rewritten.

A configured finality provider can close author-time inclusion, not sort operations. Browser/native/host placement needs actual authenticated signer authority and proof qualification. Unavailable providers do not block local authoring. Closing a frontier can exclude unseen offline work behind it. Keep this explicit in setup, UI and delivery.

For a page owner opened by `openPage(context)` in `pages/<slug>/agent.mjs`,
`tendril agent run` awaits the returned `owner.close()` when the page closes or
the program stops, before another process may reopen that page's store. Closing
only `owner.session` leaves supervisor resources behind. SIGINT/SIGTERM closes
every page owner, then the hub and the attach socket.

The `tendril agent run` process and the photo-inference launcher own their Node
process. After the application and all owned components finish cleanup,
they flush stdout/stderr and explicitly dispose that process: an Undici socket
can remain in `CLOSING` after owned shutdown has returned. This is process
disposal, not proof that every remote close handshake completed. Cleanup failure
after a signal stays nonzero and reports unverified cleanup; an output flush
failure or its bounded deadline also stays nonzero. The original device, inputs
and signed operation references remain the recovery source. No disposal timer
runs while the application or a cleanup promise is still active.

An imported `runInference` or page `openPage` never exits an embedding process.
The caller owns its other listeners and its final lifetime.
Tools `watch` and the preview HTTP server retain their explicit listener
lifetimes; this standalone tutorial policy does not terminate them.

Ordinary CLI commands attach to the running agent program with `--page <slug|id>`.
Closing that attachment detaches it without stopping the owner or sibling clients.
A command never opens a second signer; two owners must not open the same page
device store concurrently.

An application that owns a bare session must await `session.close()` before
reopening its store or terminating a gracefully closing browser Worker. Close
its RTC helper as well. Abrupt browser termination is a separate durability case
to test, not a substitute for normal cleanup.

Cancelling an operation wait or `session.operations.subscribe({signal})` cancels observation; it does not replace or erase the stored signed attempt. Inspect the original operation or retry it exactly. Keep page drafts and local operation references separate from Chronolog's one durable operation journal.

Use the [first-app acceptance steps](BUILD_AN_APP.md#6-verify-local-use-offline-readiness-and-another-device)
before claiming a working integration, then qualify deployment/network/engine
boundaries relevant to the real task.

### Network changes and local diagnostics

Keep the supplied browser owner: its authenticated RTC provider forwards actual
network/visible-resume events to the one participation controller. A usable relay
stays available while a direct-only replacement authenticates. Do not add a
transport retry interval or allocate another participant. Native hosts can forward
OS network notifications with `participation.reconsiderConnections()`; discovery
reconnection already supplies that event automatically. Events are coalesced and
rate-limited locally, with no idle probes.

Use `await session.diagnostics()` (or the participation controller's
`diagnostics()` where you hold it) to inspect authenticated routing and application
framing bytes without contacting the host. See [peer connections](PEER_CONNECTIONS.md)
for counter scope, cooldown and replacement behavior.
