# Session bootstrap and ownership

The runnable [first-app tutorial](BUILD_AN_APP.md) supplies the actual composition
in [`tutorial/setup.mjs`](https://github.com/werg/tendriller/blob/master/docs/tutorial/setup.mjs),
[`tutorial/session.mjs`](https://github.com/werg/tendriller/blob/master/docs/tutorial/session.mjs) and
[`tutorial/worker.mjs`](https://github.com/werg/tendriller/blob/master/docs/tutorial/worker.mjs). This reference explains the
boundaries when adapting those files. It is not a replacement for the executable
path.

## Keep the identities distinct

| Value | Created or owned by | Used for |
| --- | --- | --- |
| Page handle, URL, agent token | Tendriller | Hosted page and account-authorized host operations |
| `application.id` | Page creation or an explicitly supplied existing application | Stable scope across native/browser participants and publications |
| Native/browser device signing identity | Chronolog's owned device store | Authenticated commands, peer channels, permitted transitions and code signatures |
| Account binding | Hosted signed control configuration | Relates an enrolled device to an active admitted account |
| Epoch encryption key | Initial creator, then authenticated reader-to-reader transfer | Reading the committed application history |
| Application definition and execution manifest | Application author and exact execution package | Immutable declared domain/schema and compatible execution |
| Selected generation | Signed control selection | Current coordinating peer and adopted complete history prefix |
| Publication ID/version | Signed publication selection | Immutable authored code graph, independent of data recovery history |

An account login is not a device grant. A host token is not a device signer. A
publisher grant is independent of data access and control administration. A
page release does not initialize or replace an application session.

## Fresh creation, in order

First create the hosted page and prepare its first signed release before claim.
The private setup credential can configure authority and publish within the
unclaimed page's limits and 24-hour expiry. The owner later signs in to open the
ready page; existing keys, controls and publications are adopted without reset.
Open an explicit new device with
`openNativeDevice({ path, create: true })`; retain its identity, a new epoch key
and the intended setup inputs before sending mutations.

From the public session package, use `describeApplication(definition)` and
`executionManifestArtifacts(await eventExecutionManifest())`. Configure the host
with the resulting description/digest, history identity, schema administrator,
epoch/key digest and initial grants. The event tutorial supplies `schema: null`.
SQL instead uses `prepareSqlApplication` and the exact native/WASM capability;
it is not an additional host backend.

`configureApplication` creates signed descriptor and control state but initially
has **no selected generation**. Verify and persist the descriptor, then save and
submit this initial transition through the public host SDK:

```js
const request = await signTransitionRequest({
  applicationId: descriptor.payload.applicationId,
  profile: descriptor.payload.profile,
  policy: descriptor.payload.policy,
  transitionId: savedTransitionId,
  expectedGeneration: null,
  coordinator: device.identity.publicKey,
  requester: device.identity.publicKey,
  controlRevision: 0,
  reason: 'create',
  base: null,
}, device.identity);
// Persist this exact signed request before its first send; setup.mjs does so.
await host.peers.selectGeneration(request);
const authority = await host.peers.application();
await verifyAuthorityBundle(authority, pinnedDescriptor);
const session = await openNativeApplication({
  device, definition, authority, epochKeys: new Map([[0, initialEpochKey]]),
});
```

Those variables are all supplied in the runnable tutorial. The initial native
query activates durable storage and saves the initial keyring. Normal opens use
the existing device and keyring without `create: true`. A missing signer,
inconsistent binding or missing retained store is an explicit failure.

## Attach control, then participation

Create a host client with the stable application ID. Its construction and control
attachment do not initiate ordinary application traffic:

```js
const host = createClient(handle, { applicationId: handle.application.id });
const control = session.connectControlParticipant({
  exchange: (message, options) => host.peers.exchange(message, options),
});
await session.participate({
  control,
  ...createPeerIntroductions({
    peers: host.peers,
    identity: session.deviceId,
    openDirectConnection,
    openRelayConnection: ({ relay, signal }) =>
      openWebSocketConnection(relay, { ready: relay.ready, signal }),
  }),
});
```

Use the maintained native RTC opener or the Worker opener for direct transport.
The starter explicitly has no native RTC capability and lets the same maintained
adapter fall back to WebSocket. It creates no alternate command queue, replica,
retry controller or election loop. [Peer connections](PEER_CONNECTIONS.md)
details transport composition and bounded behavior.

Read `session.status` for actual data/generation state and
`session.participation.status` for discovery, connections and recovery progress.
Observe their subscriptions. A browser with a fresh grant can authenticate
before acquiring history keys; `awaiting-keys` persists until an authorized
reader supplies them. A known coordinator need not currently be reachable.

## Enroll a browser without distributing secrets

The explicit browser setup action retains one public request and creates or
reopens that browser's own device under its exclusive profile lock. A short-lived
Worker signs a bounded service challenge with that identity; the key, account,
application, origins, rights, expected generation and expiry are fixed by the
proof. `pairing-browser.mjs` retains only public intent, and
`pairing-worker.mjs` keeps private key operations inside the device owner.

The existing native owner processes the request through `pairing-native.mjs`.
It retains its intent, calls the public durable `session.pauseOrdering(id)`, and
prepares the usual `reason: 'control-change'` transition with the exact drained
prefix, next control revision and proved account binding. All existing grants
and key commitments remain intact. The complete signed request and full control
update are saved and staged with `client.prepare` **before** the service-origin
owner review. The owner approves that fingerprint, narrow rights and exact
proposal digest. The normal serialized host selector rechecks current authority
and account access when committing it.

The native participant subscribes to authenticated setup notifications over a
hibernating WebSocket. Later devices can pair without restarting it. Idle setup
does not poll or send heartbeats. Each review request expires after ten minutes,
with one local expiry deadline while that request is active. A lost commit reply
or process close preserves both the exact request and durable ordering pause.
On reopen, verify the original signed transition and complete reviewed payload
before adopting it and resuming ordering. A mismatch or unavailable status stays
paused; never substitute a new prefix or signer. `npm run pair` performs one
bounded pass with the resident owner stopped; it does not wait for owner review
or later independent receipt verification. Restart the same native participant
to finish or reconcile a prepared/submitted proposal, and keep it running for
the complete pairing flow. The deliberate manual `enroll`
command still uses authenticated `info().owner_account_id` for a separately
verified owner device; it is not the ordinary browser pairing flow.

The published code never receives the agent token, native signer or plaintext
epoch key. On connect, the browser uses its page's authenticated same-origin
cookie for host access and its own device identity for the signed session.
Chronolog's maintained peer key exchange verifies current reader grants and
wraps committed keys for the authenticated recipient. Keep a current reader
online for initial key acquisition and synchronization.

The tutorial enrolls only another device of the **owner's account**. Guest
enrollment additionally requires admitted guest account access and that guest's
verified account ID; do not bind a guest device to the owner's ID to bypass that
step. A new account or device is not authorized merely because it can load HTML.

## Compose the browser facade

The Worker calls `serveBrowserOwner` from
`@tendriller/core/collaboration/worker`. The owner acquires an exclusive Web Lock
**before** its `openSession` callback opens the retained device, verifies signed
authority and opens `openBrowserApplication`. The callback returns its session
and control participant. Browser identity creation is a separate explicit action.

When configuration must be fetched, call `serveBrowserOwner({ load: async
({ signal }) => { /* fetch and return the configuration */ } })` synchronously
at module startup. This registers message and SharedWorker connection listeners
before awaiting network work, preserving the first attachment or identity request.
Do not await a top-level configuration fetch before installing the owner service.

The page calls `openBrowserOwner` from
`@tendriller/core/collaboration/browser`, supplying the worker URL, retained
profile, immutable application/definition identity and its view/document context.
Events applications use SharedWorker when available, with a fenced dedicated
Worker fallback. SQL/WASM applications pass `requiresDedicatedWorker: true` to
select the dedicated route required by their synchronous OPFS storage. See the
matching [SQL composition](STATE_MODELS.md); forcing an incompatible shared mode
fails before opening storage.
All attached views share the signing journal. The tutorial uses the encrypted
Worker-native relay so an owner's connectivity does not depend on a particular
page's RTC helper. Applications may deliberately compose a different qualified
transport without changing ownership. The page mounts the returned session:

```js
const backend = createApplicationBackend({ id: session.applicationId, session });
tendril.application.install(backend);
tendril.signals.install(session.signals);
```

The runtime's `application.available` and `application.ready()` describe backend
installation. They do not imply connected peers, decryption keys, a usable
selected generation or retained coverage. The starter exposes these separately.

Detach closes only the attachment. `suspend()` and `resume()` bound streams across
a suspended page lifetime; they do not revoke the signer or cancel durable work.
A crashed fallback owner releases its actual Web Lock; a waiting worker can then
reopen the same profile. Stale facades close and must reattach before inspecting
their original operation references. No timeout grants ownership or silently
reissues commands.

Publication URLs remain immutable. Compatible authored documents can deliberately
reuse one pinned `configuration.ownerWorkerUrl`. A new incompatible Worker cannot
steal a profile from a running old owner: close its clients and restart deliberately,
or use an explicitly enrolled separate profile. A UI publication does not migrate
the immutable application definition or its journal.

Device metadata opens immediately; actual durable data use opens the selected
browser record backend and its exclusive ownership lock. Do not infer that all
engines or browsers have the same storage capabilities. SQL/WASM has its own
qualified engine and VFS requirements. Preserve missing-storage and quota errors
instead of resetting the application.

## Publish and update

The CLI's `publish` action packs the full authored graph, then calls the
session-owned control participant's `preparePublication({ operationId, entry,
files })` followed by `publish(signed, assets)`. The first saves the exact signed
intent before upload. Keep the original operation ID and graph for uncertain
retries. New content, including a deliberate restoration of old code, requires a
new signed publication against the current selected predecessor.

The runtime and host verify bytes, identity, publisher grant, current controls,
immutable definition/engine bindings and the publication chain. Querying
`control.publication()` verifies the selected chain. Historical code remains
addressable at its immutable publication URL.

An application definition is immutable after configuration. Editing its UI is
ordinary code publication; changing the bound domain definition is not silently
authorized by publishing another HTML file. Plan a new application or a separately
implemented supported evolution path explicitly.

## Own shutdown and uncertain operations

For a native session returned by the tutorial's `openSession()`, await the
returned `owned.close()` before reopening its store. This closes the supervisor,
its attachment listener and ownership fence as well as the session; closing only
`owned.session` leaves supervisor resources behind. The inference launcher owns
the same supervisor and follows the same shutdown path.

Ordinary CLI commands use `--mode attach` against the running peer. Closing that
attachment detaches it without stopping the owner or sibling clients. Reserve
`--mode own` for deliberate standalone ownership while the peer is stopped; two
owners must not open the same device store concurrently.

An application that owns a bare session must await `session.close()` before
reopening its store or terminating a gracefully closing browser Worker. Close
its RTC helper as well. Abrupt browser termination is a separate durability case
to test, not a substitute for normal cleanup.

Canceling `operation.applied({ signal })` cancels the wait; it does not replace or
erase the saved signed attempt. Inspect the original operation, retry it, or
review a reapplication after explicit recovery. Keep page drafts and local
operation references separate from Chronolog's one durable operation journal.

Use the [first-app acceptance steps](BUILD_AN_APP.md#7-verify-completion-including-reopening)
before claiming a working integration, then qualify deployment/network/engine
boundaries relevant to the real task.
