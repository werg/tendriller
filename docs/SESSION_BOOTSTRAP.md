# Session bootstrap and ownership

Use [Build an app](BUILD_AN_APP.md) and the complete event/SQL [state-model starters](STATE_MODELS.md) from its verified first-app release kit. There is no `deployment.mjs` import. Authored consumers import public package entrypoints only.

## Keep the identities distinct

| Identity/authority | What it permits |
| --- | --- |
| Private host credential | Its explicit account/page management scopes; not data decryption |
| Independent publisher key | Signed immutable UI/code under the prepared host publisher policy; no reader/writer/root key needed |
| Browser/native signing identity | Authorship of exact durable proposals, with authenticated crypto membership |
| `reader` / `writer` | Independent crypto/data-session eligibility; neither implies SQL object permissions |
| `administrator` / `publisher` / `finalizer` | Separate explicit rights; writing grants none of these implicitly |
| Application SQL grants | Ordinary authored namespace/object/row/column permission state, evaluated at chronological execution |
| Profile owner lock | One physical signer/store on one device, not a global application-order authority |
| View/agent binding | Bounded attachment and approved tool capability scope, independent from membership and caller labels |

Descriptor: `{applicationId,rootPrincipal,authorityPublicKey,executionManifestDigest,finalityPolicy}`. Public cryptographic identifiers are lowercase hex. The execution manifest establishes deterministic engine/platform semantics, **not immutable application schema**. Membership records carry revision, predecessor digest, signed activation floor, independent grants, epoch and epoch-key commitment. This metadata chain never supplies SQL operation order or overwrites projected permission tables.

## Fresh creation, in order

1. Same-origin service/discovery/readiness and immutable kit verification.
2. Retain original account-linked setup intent or private creation handle.
3. `npm run init`: prepare `{executionManifestDigest,executionProfile,publisherKeys,requestedFinality?,tools?}`. Ordinary apps omit finality to choose `none`.
4. `npm run deploy`: build and sign the complete UI before the first browser key is known. Publisher authorization is independent from the data descriptor/database schema.
5. Give the person the ready page URL. Their own sign-in and device-key proof initialize the root and initial membership. The epoch key stays on the browser; only its commitment is signed and hosted.
6. Additional devices prove their key and receive explicit grants plus recipient-bound wrapped keys. Account access alone never reconstructs unavailable old data keys.

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
