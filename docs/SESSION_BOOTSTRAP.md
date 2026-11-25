# Session bootstrap and ownership

The runnable [first-app tutorial](BUILD_AN_APP.md) supplies the actual composition (`tutorial/setup.mjs`, `tutorial/shared/native-page.mjs`, `tutorial/templates/notes/worker.mjs`); this reference explains the boundaries when adapting those files. Use [Build an app](BUILD_AN_APP.md) and the complete event/SQL [state-model starters](STATE_MODELS.md) from its verified first-app release kit. There is no `deployment.mjs` import. Authored consumers import public package entrypoints only.

## Keep the identities distinct

| Identity/authority | What it permits |
| --- | --- |
| Agent token (`ta_`) and page URL | The agent's one account-level host credential (explicit per-page grants and scopes; not data decryption) and one hosted page's address |
| Workspace shared signer as publisher | The agent's one opaque signing key (shared by all its pages, not a per-page key) signs immutable UI/code under the prepared host publisher policy; the publisher right needs no reader/writer/root grant. It joins a page's data session only through explicit `sign-enrollment`, `provisioning-request` and `import-provisioning`, after which `initialized.json` records the verified reader grant and current epoch key |
| Browser/native signing identity | Authorship of exact durable proposals, with authenticated crypto membership. All of one agent's pages share its one signing key, each with its own device store |
| `reader` / `writer` | Independent crypto/data-session eligibility; neither implies SQL object permissions |
| `administrator` / `publisher` / `finalizer` | Separate explicit rights; writing grants none of these implicitly |
| Application SQL grants | Ordinary authored namespace/object/row/column permission state, evaluated at chronological execution |
| Profile owner lock | One physical signer/store on one device, not a global application-order authority |
| View/agent binding | Bounded attachment and approved tool capability scope, independent from membership and caller labels |

Descriptor: `{applicationId,rootPrincipal,authorityPublicKey,executionManifestDigest,finalityPolicy}`. Public cryptographic identifiers are lowercase hex. The execution manifest establishes deterministic engine/platform semantics, **not immutable application schema**. Membership records carry revision, predecessor digest, signed activation floor, independent grants, epoch and epoch-key commitment. This metadata chain never supplies SQL operation order or overwrites projected permission tables.

## Fresh creation, in order

1. Same-origin service/discovery/readiness and immutable kit verification.
2. Register the workspace agent once (`tendril workspace init|join|key|adopt`; one credential and one signing key) and create the page (`npm run page:new -- <slug>`; the creating agent is granted it automatically). Retain the private workspace.
3. `npm run init -- <slug>`: prepare `{executionManifestDigest,executionProfile,publisherKeys,requestedFinality?,tools?}`. Ordinary apps omit finality to choose `none`.
4. `npm run deploy -- <slug>`: build and sign the complete UI before the first browser key is known. Publisher authorization is independent from the data descriptor/database schema.
5. Give the person the ready page URL. Their own sign-in and device-key proof initialize the root and initial membership. The epoch key stays on the browser; only its commitment is signed and hosted.
6. Additional devices prove their key and receive explicit grants plus recipient-bound wrapped keys. Account access alone never reconstructs unavailable old data keys.

An account login is not a device grant. The agent token is not a device signer. A publisher grant is independent of data access and control administration. A page release does not initialize or replace an application session. The agent's grant lets it configure authority and publish within the common publication capacity and the unclaimed page's 24-hour expiry; the owner later signs in to open the ready page, adopting existing keys and publications without reset.

See `setup.mjs`, `publish.mjs`, `helpers/prepare-host.mjs`, and `helpers/browser-bootstrap.mjs` in the tutorial. Private intents/signing identities/epoch keys remain outside `page/`.

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

The starter explicitly creates only an empty first device profile. A retained binding with missing/damaged private identity fails closed. On cache absence, first enrollment fetches authenticated host metadata, durably stores its original bootstrap key before sending the epoch-bound signed proof, then pins the returned verified descriptor. On an established device, local reopening does not wait for host refresh, discovery, peers or a finalizer.

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
connection progress through its own `status` and `onStatus`. A browser with a fresh grant can authenticate
before acquiring history keys; `awaiting-keys` persists until an authorized
reader supplies them through explicit recipient-bound provisioning. No participant
needs to be reachable for local authoring.

## Provision keys without distributing secrets

The first owner browser initializes root, membership and its epoch key locally after real sign-in and key proof; the host stores only signed commitments. Every additional device, including the agent's shared signer for a page, proves its key and creates a retained recipient request. An authorized device reviews its exact independent rights, signs crypto membership, and wraps the epoch keys to that recipient; the recipient imports the package. No host token, account login or ordering pause substitutes for that review. The published code never receives the agent token, native signer or plaintext epoch key; the browser uses its page's same-origin cookie for host access and its own device identity for the signed session. Keep a current reader available for initial key acquisition. Guest devices additionally require admitted guest account access and that guest's verified account ID.

## Compose the browser facade

The Worker calls `serveBrowserOwner` from
`@tendriller/core/worker-owner`. The owner acquires an exclusive Web Lock
**before** its `openSession` callback opens the retained device, verifies signed
authority and opens `openBrowserApplication`. The callback returns its session
and control participant. Browser identity creation is a separate explicit action.

When configuration must be fetched, call `serveBrowserOwner({ load: async
({ signal }) => { /* fetch and return the configuration */ } })` synchronously
at module startup. This registers message and SharedWorker connection listeners
before awaiting network work, preserving the first attachment or identity request.
Do not await a top-level configuration fetch before installing the owner service.

The page calls `openBrowserOwner` from
`@tendriller/core/browser-owner`, supplying the worker URL, retained
profile, immutable application/definition identity and its view/document context.
Events applications use SharedWorker when available, with a fenced dedicated
Worker fallback. SQL/WASM applications pass `requiresDedicatedWorker: true` to
select the dedicated route required by their synchronous OPFS storage. See the
matching [SQL composition](STATE_MODELS.md); forcing an incompatible shared mode
fails before opening storage.
All attached views share the signing journal. The tutorial uses the encrypted
Worker-native relay so an owner's connectivity does not depend on a particular
page's RTC helper. Applications may deliberately compose a different qualified
transport without changing ownership. The page mounts the returned session as shown in [Compose one browser owner](#compose-one-browser-owner).

## Compose one browser owner

`serveBrowserOwner` in `worker.mjs` uses the real public `createApplicationOwner`. `openBrowserOwner` in `page.mjs` attaches through SharedWorker or a fenced elected dedicated Worker. SQL declares `requiresDedicatedWorker:true` when its VFS needs that route. Keep the original browser profile, root-lifetime lock, physical store and signed operation records. Do not replace them on a timeout or hide/show transition.

```js
const attachment = await openBrowserOwner({workerUrl,profileId,applicationId,context:{viewId}});
const session = attachment.session;
window.tendril.application.install(createApplicationBackend(session));
```

The runtime matches `backend.applicationId` to `selection.id`. It requires durable submission, coherent views/changes, independent operation inspection, exact retry and subscriptions—not ordering/recovery capabilities. Detach only a view on navigation; do not close the shared owner or erase pending operations. Preserve suspend/resume nonce proofs and finite local RPC deadlines.

## Optional background participation

`participateApplication(session,{peers,openDirectConnection})` runs after local opening and returns immediately. It uses existing direct RTC, isolated reliable/live lanes, encrypted relay fallback, account-bound introductions and bounded retry budgets. Metadata refresh is signed evidence verified into the cached authority provider. It never blocks Save. `participateNativeApplication` supplies optional Node RTC mechanics for an explicitly provisioned native device.

Open root locks before opening signer storage. Native tools attach to the existing private IPC supervisor or deliberately use a separately enrolled profile; an unavailable supervisor never authorizes another signer. Report its actual process lifetime. Optional agent/tool-provider dispatch and idempotency are not application ordering.

## Enrollment and control DTOs

Use `@tendriller/core/authority` for transport and `@chronolog/authority` for canonical record encoding/signature verification. `{record:lowercaseHexCanonicalBytes}` preserves bigint timestamps and bytes without JSON narrowing.

- `GET application`: `{selection,configuration,publicationAuthority,authority}`; authority is a canonical record or null before data initialization.
- `POST application`: `HostAppConfig`, authorized by host management scope. Identical preparation retries are accepted; changed immutable setup is rejected.
- `POST peers/enrollment {action:'challenge',publicKey}`: authenticated browser account and exact page origin.
- `{action:'enroll',proof}`: a signed `EnrollmentRequest` containing application/key/challenge/**epoch and epochKeyDigest**. No plaintext keys are accepted.
- `{action:'grant',requestId,expectedMembershipId,authorTimeAfterMs,grant}`: explicit owner browser review, proved recipient account binding, active account, exact independent boolean rights. The expected signed metadata head is enrollment concurrency control, never a data-order input. Exact request-ID retries retain the original grant.
- `{action:'membership',bundle}`: independently signed admin extension, verified against the pinned descriptor and existing chain/account proofs.
- `POST peers/participant`: signed portable authority/publication/finality requests, canonically encoded as one bounded record. No application programs are accepted.
- `POST peers/publication`: independent signed publisher manifests and referenced immutable code assets. Code-revision concurrency is separate from data chronology.

After an explicit grant, `session.mergeAuthority(bundle)` verifies and retains public evidence without SQL membership overlays. Recipient keys use `session.provisioning.createProvisioningRequest()`, `.exportProvisioning(request)`, and `.importProvisioning(package)`. Agreement secrets stay in the original owning store. Review full recipient fingerprints before exporting.

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
