# Migrate rc.16 applications to the current rc.17 composition

Use this guide when updating an existing `0.3.0-rc.16` application to a host
running a later `0.3.0-rc.17` **source release**. It covers the host, public SDK,
Chronolog package and copied first-app helpers together. The
[changelog](https://github.com/werg/tendriller/blob/master/CHANGELOG.md) records
the source changes; [Build an app](BUILD_AN_APP.md) supplies the complete current
commands and source files.

The original `v0.3.0-rc.17` tag predates several changes below. Later immutable
`source-<full commit SHA>` releases still use the same package version. Check the
selected host's `/api/readiness`, `/api/service` and
`/.well-known/tendriller.json`; match `build.sourceCommit`, `build.compositionId`
and `runtimeId` to its advertised `firstApp.release` manifest and archive. Do not
substitute the version tag, another host's kit, or unrelated latest packages.

## Choose the right upgrade route

Stop the native participant cleanly before changing its packages. Retain its
complete private project, including device databases, keys, descriptor, signed
attempts, setup records and reviewed host credentials. Keep the browser's existing
profile and storage. Then inspect the application's authenticated `self` response
using its saved handle and current credential; do not expose the credential in
logs or chat.

| Observation | Action |
| --- | --- |
| The original application still exists | Upgrade the packages and adapted source below, rebuild and publish the UI, then reopen the same native and browser profiles. A transport/import upgrade alone does not require new device identities or clearing application data. |
| `404` with `error.code: "not_found"` and `No such tendril` | Confirm the original service origin and handle. After a confirmed host storage reset or deletion, follow [recreation](#recreate-after-a-host-storage-reset). A replacement host credential cannot restore a nonexistent application. |
| `401`/`403`, `unauthorized`, or `access_revoked` | The application may still exist. Inspect the credential and use [same-app owner delegation](BUILD_AN_APP.md#continue-the-same-app-after-setup-credential-expiry-or-loss) when appropriate. Do not recreate an application just to bypass access failure. |
| An uncertain response, outage, or an unrelated `404` | Preserve the original records and diagnose the endpoint. A failed readiness endpoint or asset lookup does not establish that the application was deleted. |

Before switching the live app, the [local release host](LOCAL_HOST.md) lets you
exercise the chosen release's create, init, publish, pair and connect flow with
a separate test application.

## Recreate after a host storage reset

[Commit 5691166](https://github.com/werg/tendriller/commit/56911663e1b5e274c45e7800b0bf37ecafbd15e3)
provisioned fresh schema11 Worker namespaces and account storage for staging and
production. Existing applications from the old storage are absent on the new
deployment. There is no automatic old-host-state migration. Their retained
handles can receive:

```json
{"error":{"code":"not_found","message":"No such tendril"}}
```

**Existing applications must be recreated: run `npm run create` and `npm run init`
again.** Do this in a new project directory containing the matching released kit,
not over the previous private project. The starter deliberately resumes an
existing `handle.json` and refuses replacement creation when other private
recovery records are present. Removing only the handle does not make that
directory a new application.

1. Stop the old participant and retain the entire old project privately. Preserve
   browser storage and any surviving device checkpoints; recreating the host page
   does not recover their data automatically.
2. Follow [artifact acquisition](BUILD_AN_APP.md#1-get-the-starter-and-matching-public-packages)
   in a separate directory, using the selected host's exact manifest and kit.
   Bring over authored application code after applying the migrations below;
   do not copy `.tendriller/` or old generated `page/` configuration into it.
3. Once open creation readiness and the new kit are verified, create and
   initialize the replacement application:

```sh
# In the new, installed app directory; keep the old project intact.
export TENDRILLER_ORIGIN=https://YOUR_SELECTED_HOST
npm run create -- "$TENDRILLER_ORIGIN" owner@example.com "My application"
npm run init
npm run build
npx tendril --session ./session.mjs --mode own publish ./page --operation initial-release-1
npm run peer
```

For account-linked creation, use `setup:prepare`, `prepare_tendril_setup` and
`setup:finish` in the **new** directory before `npm run init`, as described in
[Build an app](BUILD_AN_APP.md#2-create-the-application-for-the-intended-owner).
The old setup operation cannot recreate a lost application by changing its
arguments.

Give the owner the **new** page URL, complete owner sign-in and browser enrollment,
and verify a command and read across the native and browser participants. The new
handle identifies a new application and initially empty history. Restoring old
application data is a separate recovery/import task requiring surviving evidence;
the commands above do not migrate the old authority, publications or history.

With the setup-watch fix following rc.17, a failed setup connection whose `self`
response confirms this missing application reports `application_not_found` and a
recreation next action. It retries with exponential backoff (1, 2, 4 seconds,
capped at 60 seconds), so the process remains visibly unhealthy while waiting.
These retries never create a replacement page. Stop that participant and start
the replacement with its new handle after intentional recreation. Older builds
may misreport this same `404` as `access_revoked`; inspect the actual response.

## Upgrade the whole package composition

Install the SDK, tools and Chronolog session archives carried in the selected
host's immutable first-app kit using the exact local-file commands in
[Build an app](BUILD_AN_APP.md#1-get-the-starter-and-matching-public-packages).
Keep its `composition.json`, manifest, package hashes and resulting lockfile.
For an application that still exists, preserve its private records and application
definition while updating the packages and adapted starter code.

Upgrade native participants and the browser bundle together, then republish the
signed UI. Close old application tabs before reopening: an already running
SharedWorker retains its old code until its lifetime ends. Reuse the same
browser profile name on every page, pairing Worker and application Worker. The
current starter centralizes this in `helpers/browser-profile.mjs`; preserve the
existing value when adapting it for an existing application.
For example, the rc.16 Shared Notes starter used
`tendriller-notes-${applicationId}`; changing it to the current fresh-starter
default `tendriller-browser-${applicationId}` would select a different browser
store. Keep the old prefix in the shared helper for that retained application.

### Discovery advertisements no longer have leases

[Commit 1323030](https://github.com/werg/tendriller/commit/1323030350f0265a48ab89dc06bc5978a4b9430c)
changed discovery from periodic TTL renewal to authenticated socket presence.
An old participant can log `Unknown advertisement field` repeatedly because it
still sends `ttlMs`.

| Before | Current composition |
| --- | --- |
| Advertise request `{ advertisement, ttlMs }` | Advertise request `{ advertisement }` |
| Response/directory entry `{ advertisement, expiresAt, refreshAfter }` | Response/directory entry `{ advertisement }` |
| Renewal on a timer | Advertise after the discovery socket's `ready` notice; update on actual changes |
| Availability lasts until lease expiry | Availability lasts while the authenticated discovery socket remains connected |

The advertisement itself remains bounded routing metadata:
`{ peerId, storageId, routes }`. The matching participation helpers own the socket,
advertisement and reconnect behavior. Upgrade them rather than removing a field
from an old retry loop; the current host requires the presence subscription too.
See [peer connections](PEER_CONNECTIONS.md).

## Update SDK imports and participation

### Session ownership subpaths

These are replacement imports, not compatibility aliases:

| Before | After |
| --- | --- |
| `@tendriller/core/collaboration/native` | `@tendriller/core/native-owner` |
| `@tendriller/core/collaboration/worker` | `@tendriller/core/worker-owner` |
| `@tendriller/core/collaboration/browser` | `@tendriller/core/browser-owner` |

```js
// Before
import { createNativeSessionSupervisor } from '@tendriller/core/collaboration/native';
import { serveBrowserOwner } from '@tendriller/core/collaboration/worker';
import { openBrowserOwner } from '@tendriller/core/collaboration/browser';
```

```js
// After: put each import in its existing native, Worker or page entry point.
import { createNativeSessionSupervisor } from '@tendriller/core/native-owner';
import { serveBrowserOwner } from '@tendriller/core/worker-owner';
import { openBrowserOwner } from '@tendriller/core/browser-owner';
```

`@tendriller/core/collaboration` now describes the optional multi-participant
coordination schema/client. It is not the namespace for owning a session.

### One transport policy for native and browser participants

The old starter composed its own introductions and often supplied a direct opener
that threw, leaving relay as its only usable transport:

```js
// Before: inside an already opened application session.
import { createPeerIntroductions } from '@tendriller/core/peers';
import { openWebSocketConnection } from '@chronolog/peer-session/websocket';

await session.participate({ control, ...createPeerIntroductions({
  peers: host.peers,
  identity: session.deviceId,
  openDirectConnection: async () => { throw Error('TUTORIAL_NATIVE_RTC_NOT_CONFIGURED'); },
  openRelayConnection: ({ relay, signal }) => openWebSocketConnection(relay, { ready: relay.ready, signal }),
}) });
```

Use the current native entry point:

```js
import { participateNativeApplication } from '@tendriller/core/native-rtc';

const participation = participateNativeApplication(session, {
  peers: host.peers,
  control,
});
```

For a browser, keep `serveBrowserOwner` and accept its injected
`openDirectConnection` in the owner factory's existing `openSession` method:

```js
import { participateApplication } from '@tendriller/core/participation';

// Inside openSession({ signal, openDirectConnection }), after opening the
// real session, reading authority and connecting its control participant:
await participateApplication(session, { peers, control, openDirectConnection });
```

The complete native and browser factories are in the current starter's
`session.mjs` and `worker.mjs`; see [session bootstrap](SESSION_BOOTSTRAP.md).
Both helpers install the shared direct-first policy with bounded encrypted relay
fallback. Remove the previous participation call; each session gets one controller.
`session.participate` and `createPeerIntroductions` remain public lower-level
primitives for specialized adapters and qualification, rather than removed APIs.

## Update copied kit helpers

### Import the live view from Chronolog

```js
// Before
import { createLiveView } from './helpers/live-view.mjs';
```

```js
// After
import { createLiveView } from '@chronolog/peer-session/browser';

const view = createLiveView(session, {
  query: 'notes', input: null,
  onSnapshot: ({ value, revision }) => renderNotes(value, revision),
});
// On view teardown, keep the existing session and close only this observer:
view.close();
```

Remove the unused copied `helpers/live-view.mjs` after updating its consumers.
Some intermediate source checkpoints exported it from Tendriller's collaboration
module; those imports also move to `@chronolog/peer-session/browser`. Keep the
matching Chronolog package from the kit; an older session archive may lack the
export. See [application patterns](APP_PATTERNS.md#1-a-coherent-live-query) for the
complete view lifecycle, snapshots, errors and recovery callbacks.

### Replace pairing windows with the participant lifetime

`startPairingWindow` and `startReviewedPairingLoop` were removed from
`pairing-native.mjs`. Do not keep a separate polling window or terminate the
application when an optional assistant connection stops.

```js
// Before
import { startPairingWindow } from './pairing-native.mjs';
const pairing = startPairingWindow({ owned, signal, onStatus: report });
// The old startReviewedPairingLoop polled owned.processPairings separately.
```

```js
// After: use the updated starter's openSession() and retained participant.
import { openSession } from './session.mjs';
import { superviseParticipant } from './helpers/participant-lifecycle.mjs';

const owned = await openSession({ signal });
const lifecycle = superviseParticipant({
  owned, signal, watch: owned.watchSetup,
  report: status => console.log(JSON.stringify(status)),
});
try {
  await lifecycle.done;
} finally {
  await lifecycle.close();
  await owned.close();
}
```

In that updated bootstrap, `owned.watchSetup` is the following wrapper over the
public SDK, using the same selected host credential as the participant:

```js
import { watchApplicationSetup } from '@tendriller/core/setup';

const watchSetup = callbacks => watchApplicationSetup({
  api: handle.api, token: handle.token, ...callbacks,
});
```

Adapt `session.mjs`, `pairing-native.mjs`,
`helpers/participant-lifecycle.mjs` and `helpers/cli-lifetime.mjs` together from the
matching kit. The supervisor processes pairing work on setup notifications and
bounded active-review deadlines, with retries for failures and no healthy idle
polling. Each owner review still expires after ten minutes. Keep the native peer
running before opening the browser's review; preserve its exact signed proposal
and ordering pause through uncertain replies. The optional assistant remains a
separate lifetime within that participant.

## Migrate removed executables and re-arm consumers

The common-session tooling change removed `tendril-wait`, `tendril-events`,
`tendril-watch`, `codex-bridge`, `claude-channel`, `hermes-bridge`,
`openclaw-bridge` and `tendril-stream`. Current tools ship `tendril` and
`tendril-preview`. The [complete executable migration table](AGENT_RESTART.md#retired-bridge-binaries-rc8-to-rc17)
names each replacement route and the features without a drop-in equivalent.
Old host-socket listeners and numeric pending/ack checkpoints are not current
session event consumers.

After upgrading or restarting a participant, follow the [re-arm checklist](AGENT_RESTART.md).
An attach client does not survive owner replacement automatically. Retain its
profile and signed attempts, reconnect using the current binding, resume from
the handled event cursor, and verify an actual request/receipt/answer on the page.
The [agent request pattern](AGENT_REQUESTS.md) supplies durable listener check-ins
and request state for late-joining pages.

## Verify the upgraded application

Check the host/source/composition identities, then start the updated native
participant and open the newly signed browser publication with its retained
profile. Confirm a native command appears in a browser read, a browser command
appears in a native read, and reload/reopen retains the same data and operation
references. Verify actual connected behavior after owner review; a saved handle,
published HTML or a process reporting `running` is only an intermediate checkpoint.
Inspect setup/participation status for `application_not_found`, access failure and
transport errors. [Troubleshooting](TROUBLESHOOTING.md) maps each boundary to its
next action.
