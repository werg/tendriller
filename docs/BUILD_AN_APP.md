# Build your first Tendriller application

**Start here when a user gives you a Tendriller domain and asks for an app.**
If you entered through MCP, `tendril_guide` returns this document with
`topic: "build"`; use `topic: "start"` for the
[MCP route](MCP_AGENT_GUIDE.md). An empty application list does not prevent using
the HTTP creation route. First check that your environment can run the supplied
Node 24 participant and retain its private store; name a missing runtime
explicitly rather than delivering an unconnected preview.
The result is its live hosted page and connected participant. Provisioning,
owner claim, enrollment and signed publication are part of the task; the starter
download is an implementation input. Follow the
[delivery checklist](AGENT_DELIVERY.md), and consult the compact
[capability map](CAPABILITIES.md) before choosing application plumbing.
Tendriller provides authenticated page hosting and the application control plane.
Chronolog provides the application's retained state, commands, queries, operation
journal and peer synchronization. Build the UI with ordinary HTML and JavaScript,
then install its owned Chronolog session into the page runtime.

This guide includes a complete small **Shared Notes** application: a native
creator/publisher peer, a browser Worker, a declared command and query, device
enrollment, signed publication, reopen and exact retry. The source is in
[`docs/tutorial/`](https://github.com/werg/tendriller/tree/master/docs/tutorial), and the running host serves the
[first-app source archive](/downloads/tendriller-first-app.tgz).
There is no missing `deployment.mjs` to invent.

When adapting this starter to a checklist or another application, first verify its
unchanged connected loop, then change the domain and UI. Keep device identity
independent of titles: the page, pairing Worker and application Worker all import
`helpers/browser-profile.mjs`. Do not rename the profile in just one entry point
or replace a retained browser store. Keep `configuration.page_url` from the page
handle; the service origin and the published page origin serve different roles.

## The route and its checkpoints

| Step | Do this | Evidence that it worked |
| --- | --- | --- |
| Discover | Read the host's `/api/service`, this guide and the supplied starter | Host contract, release and limits are known |
| Create | Create the page privately and retain the setup handle; keep preparing | A page handle and stable application ID |
| Define state | Declare `addNote` and `notes`; configure authority and select the first generation | The native session opens and reads a coherent empty notes view |
| Build the UI | Bundle the page and owning Worker | `page/` contains the complete authored graph and public configuration |
| Publish | Use the creator session's saved signed publication | A receipt and selected immutable release ready for the owner’s first signed-in visit |
| Owner sign-in | Give the person the already-published page and any prepared permission-review URL | Existing authority, keys and code retained; no new publication needed |
| Connect the browser | Request access with its own device, let the native peer stage an exact proposal, review it, then connect | The reviewed signed grant is committed; the session acquires keys and reads real application state |
| Verify | Submit, reload, read, inspect and retry | Retained notes and the same device/operation identities survive reopening |

The owner sign-in and enrollment decision are real authority boundaries. Prepare
the code and exact commands before asking for those actions. A missing grant or
package is a setup issue to diagnose; it is not a reason to silently substitute
another persistence service.

## Check the selected host before installing

Use the MCP connection's `serviceOrigin`, or the exact origin the user supplied.
Read its advertised `interfaces.readiness` at `/api/readiness` before downloading
packages, installing dependencies or asking for the owner's email. MCP guide,
profile and application-list responses include the same live `readiness` data.

```sh
TENDRILLER_ORIGIN=https://tendriller.dev
curl --fail --show-error --silent "$TENDRILLER_ORIGIN/api/readiness"
```

Continue only after an HTTP 200 response with `schemaVersion: 1`, the matching
`serviceOrigin`, `mode: "open"` and `creation.available: true`. A successful HTTP
read can still report `creation_paused` or `read_only`; stop new-app setup and
report `creation.nextAction`. Missing preflight (404) requires a host update;
network errors, 503 and malformed responses leave readiness unverified. Do not
silently fall back to creating on this or another host. The result is advisory:
creation still checks current service state, rate limits and admission.

The response identifies the environment by its canonical origin, with an optional
operator label, and reports the core release and immutable runtime ID. A missing
`build.sourceCommit` is explicit; a runtime hash alone does not identify every
Worker source change. The separate `/api/service` contract remains unchanged.

## 1. Get the starter and matching public packages

Use **Node 24**, npm, curl, tar and a SHA-256 checker. The released first-app
archive contains the maintained starter and its exact public SDK, tools and
Chronolog events packages. Ordinary setup does not need a second repository
checkout or a Chronolog build. SQL, native RTC and WASM engines are separate
optional capabilities. For relational guards and multi-entity transactions, use
the concrete [SQL alternative](STATE_MODELS.md) before configuring authority.

Set the origin to the domain supplied by the user or selected connector. Keep it
for readiness, package matching, creation, owner sign-in and assistant setup.
Read both host descriptors **before downloading or installing packages**:

```sh
: "${TENDRILLER_ORIGIN:?Set the selected service origin before continuing}"
export TENDRILLER_ORIGIN
mkdir shared-notes
cd shared-notes
curl --fail --show-error --silent "$TENDRILLER_ORIGIN/api/readiness" -o readiness.json
curl --fail --show-error --silent "$TENDRILLER_ORIGIN/api/service" -o service.json
curl --fail --show-error --silent "$TENDRILLER_ORIGIN/.well-known/tendriller.json" -o onboarding.json
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const readiness = JSON.parse(readFileSync('readiness.json'));
const service = JSON.parse(readFileSync('service.json'));
const origin = process.env.TENDRILLER_ORIGIN;
assert.equal(new URL(origin).origin, origin, 'Use the exact selected service origin.');
assert.equal(readiness.schemaVersion, 1, 'Upgrade the selected host readiness endpoint.');
assert.equal(readiness.serviceOrigin, origin, 'Do not cross service origins.');
assert.equal(readiness.mode, 'open', readiness.creation?.nextAction || 'Creation is unavailable.');
assert.equal(readiness.creation?.available, true, 'Creation is unavailable at this host.');
assert.equal(service.contract, 3, 'This starter requires core contract 3.');
assert.equal(service.core_release, readiness.build?.coreRelease, 'Host descriptors disagree.');
assert.match(service.core_release, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
assert.match(readiness.build?.runtimeId, /^[a-f0-9]{64}$/);
assert.match(readiness.build?.sourceCommit, /^[a-f0-9]{40}$/);
assert.match(readiness.build?.compositionId, /^[a-f0-9]{64}$/);
const onboarding = JSON.parse(readFileSync('onboarding.json'));
const releaseUrl = 'https://github.com/werg/tendriller/releases/download/source-' + readiness.build.sourceCommit;
assert.equal(onboarding.firstApp?.release?.manifest, releaseUrl + '/manifest.json');
assert.equal(onboarding.firstApp.release.archive, releaseUrl + '/tendriller-first-app-' + service.core_release + '.tgz');
JS
```

These requests do not follow redirects. A missing endpoint, paused creation,
unavailable service or different origin stops setup here. Report the returned
reason and operator action; do not switch deployments or start source builds.
Creation checks readiness again immediately before provisioning because service
state can change after this preflight.

Download the first-app archive from the host's advertised immutable release:

```sh
TENDRILLER_RELEASE=$(node -p "JSON.parse(require('fs').readFileSync('service.json','utf8')).core_release")
TENDRILLER_RELEASE_URL=$(node -p "JSON.parse(require('fs').readFileSync('onboarding.json','utf8')).firstApp.release.manifest.slice(0, -'/manifest.json'.length)")
mkdir artifacts
for artifact in "tendriller-first-app-$TENDRILLER_RELEASE.tgz" SHA256SUMS manifest.json
do
  curl --fail --show-error --location "$TENDRILLER_RELEASE_URL/$artifact" -o "artifacts/$artifact"
done
(cd artifacts && sha256sum --ignore-missing --check SHA256SUMS)
tar -xzf "artifacts/tendriller-first-app-$TENDRILLER_RELEASE.tgz"
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const composition = JSON.parse(readFileSync('composition.json'));
const release = JSON.parse(readFileSync('artifacts/manifest.json'));
const readiness = JSON.parse(readFileSync('readiness.json'));
const {id, ...body} = composition;
const kit = release.artifacts.find(item => item.file === release.first_app.file);
assert.equal(createHash('sha256').update(readFileSync('artifacts/' + kit.file)).digest('hex'), kit.sha256);
assert.equal(createHash('sha256').update(JSON.stringify(body)).digest('hex'), id);
assert.equal(id, release.composition.id, 'The starter belongs to another release composition.');
assert.equal(composition.version, readiness.build.coreRelease, 'Core release mismatch.');
assert.equal(composition.runtime, readiness.build.runtimeId, 'Host runtime mismatch.');
assert.equal(composition.core.dirty, false);
assert.equal(composition.core.source, release.source_commit);
assert.equal(composition.core.source, readiness.build.sourceCommit, 'Host source checkpoint mismatch.');
assert.equal(id, readiness.build.compositionId, 'Host release composition mismatch.');
JS
(cd packages && sha256sum --check SHA256SUMS)
TENDRILLER_SESSION_ARCHIVE=$(node -p "JSON.parse(require('fs').readFileSync('composition.json','utf8')).components.find(x=>x.role==='session').file")
npm install --ignore-scripts --save-exact \
  "./packages/tendriller-sdk-$TENDRILLER_RELEASE.tgz" \
  "./packages/tendriller-tools-$TENDRILLER_RELEASE.tgz" \
  "./packages/$TENDRILLER_SESSION_ARCHIVE"
npm install --save-dev --save-exact esbuild@0.28.2
```

Keep `composition.json`, the release manifest, archive hashes and the generated
`package-lock.json`. The composition binds the complete SDK/runtime/engine/tools
set, the source starter, the pinned Chronolog session and embedded generation
control provenance. The first-app archive carries the three packages this app
installs; the manifest also identifies the runtime and engine used by the host.
A runtime ID describes browser assets, not every host Worker byte. Automated
deployments report both their source checkpoint and complete composition ID.
When either identity is absent, the host's full deployed identity still needs the
operator's [release composition evidence](RELEASE_COMPOSITION.md).

If the versioned archive is unavailable or these checks fail, the operator must
publish and qualify the matching release. Do not mix a mutable hosted starter
with packages from another same-version source tree. The separate
[first-app source archive](/downloads/tendriller-first-app.tgz) remains useful for
inspection, but it is not the complete release composition.

As soon as installation finishes, create the real page in step 2 and continue
through initialization, building and publication before asking for sign-in.
Then give the owner the ready page URL. Never stop to request a "claimed" reply.
Once `page/` exists, `npx tendril-preview ./page` checks layout immediately;
[static versus real-session preview](tools/PREVIEW.md) explains what it establishes.
Keep the published page as the verification target for the actual account,
device enrollment and session. Enrollment requires `owner_account_id` in the
host's authenticated agent `info()` response; absence is a host upgrade boundary.

For unreleased core development, commit a clean matching checkout, run `npm ci`,
`npm run build:artifacts` and `npm run release:artifacts`, then qualify its exact
first-app archive with `npm run test:first-app -- --first-app-archive
/absolute/tendriller-first-app-VERSION.tgz`. This creates local candidate artifacts;
it does not publish a release or qualify a deployed host. Never import core's
private server/test modules or Chronolog's source internals into the app.

## 2. Create the application for the intended owner

### From an account-linked MCP connection

Use the connector's linked account with its granted `tendrils:create` permission.
The host resolves the verified owner; no owner email or OAuth access token needs
to enter the local project. First retain one private setup intent:

```sh
npm run setup:prepare -- "$TENDRILLER_ORIGIN" "Shared notes"
```

This local command atomically saves `.tendriller/account-setup.json` before
printing `prepare` and `inspect` tool arguments. The file contains the original
operation ID, request digest, application ID and private setup credential. The
printed `prepare.arguments` contains only the public name, mode, operation and
application identities, and credential commitment. Do not print or copy the
private intent into chat or the page.

Call `prepare_tendril_setup` through the **same selected account-linked
connector** with those exact `prepare.arguments`. The server checks current
readiness, the existing creation permission and the account's verified identity.
Save its public result object from `structuredContent` as
`.tendriller/account-setup-result.json`. When its `state` is `ready`, complete
the local handle:

```sh
npm run setup:finish -- .tendriller/account-setup-result.json
```

`setup:finish` verifies the exact origin, operation, digest, commitment,
application and page metadata before combining the result with the already
saved credential. It writes `.tendriller/handle.json` without replacing an
existing handle. Its `handle_saved` output means preparation can continue;
`connected` remains false until actual application connections are verified.

If a tool response is lost or its state is `prepared`, `provisioning` or
`reconciliation_required`, call `inspect_tendril_setup` using the printed
`inspect.arguments`. Retry preparation only with the original public request
when the reported next action permits it. Rerunning `setup:prepare` in the same
directory resumes its saved intent; changed names, origins or operation IDs
are rejected. Never create another intent just because the response was late.
If the private file is lost, restore its verified checkpoint. Neither inspection
nor `list_tendril_setups` can reconstruct its secret; they do not authorize a
replacement credential or page.

A missing tool or creation scope is an explicit catalog/deployment/consent
prerequisite. Keep this origin and original intent while resolving it; do not
extract another client's OAuth credentials or silently switch account routes.

### From a domain without account-linked creation

The existing anonymous route remains available with the actual owner's verified
login email. It checks readiness and the host contract, creates a page and saves
the returned private handle:

```sh
npm run create -- "$TENDRILLER_ORIGIN" owner@example.com "Shared notes"
```

Unlike the account-linked operation, a lost anonymous-create response cannot be
reconstructed from a locally retained setup intent. Inspect host/account state
before issuing another create. Do not repeat anonymous creation to work around
an uncertain account-linked operation.

Both routes print the page URL and next step. Keep preparing: initialize, build,
publish and start the participant before
asking the owner to open the ready URL and sign in. Agent
credentials cannot claim the page for them. An unclaimed page expires after
24 hours; report a blocked claim explicitly.
This is a real provisioning step to attempt now, rather than a prerequisite to
defer until after delivering a local artifact. If it fails, retain the actual
response and name its missing permission or capability.

The handle has two distinct identities: the hosted page's ID/URL and
`application.id`, which identifies the application independently of its page
address. The handle's agent token is a host credential. It is not the device
signing key or an application data key.

The supplied `.gitignore` excludes `.tendriller/`, `node_modules/` and `page/`.
Keep the private directory out of commits and published files. Creation is a
separate action from initialization; neither a saved handle nor an accepted
setup result establishes device enrollment, assistant approval or an online
participant.

### Continue the same app after setup credential expiry or loss

The account-linked setup credential expires 24 hours after preparation, including
after the owner claims the page. Revoking its admitting OAuth grant also stops
that credential. Claim preserves the application, its signed authority, data and
publication; continued native access needs an independently reviewed host
binding. The owner can approve that binding before expiry. An unclaimed page
that has already expired cannot be recovered through delegation.

1. Stop the running native peer or assistant cleanly and retain its complete
   private checkpoint. Keep `.tendriller/account-setup.json`, `handle.json`,
   `descriptor.json`, `device.sqlite` and all signed operation records intact.
2. Have the owner open the existing `page_url` and append `_tendril/manage` to
   its trailing slash, for example `https://PAGE_HOST/s/OWNER_KEY/_tendril/manage`.
   They sign in as the same owner and choose **Agent connection → Add agent**.
   Use a recognizable name such as `native-continuation`. For the complete
   first-app workflow select **Read host status**, **Connect enrolled
   participants**, **Update signed application control**, **Publish signed
   code** and **Propose assistant access**. Omit publication or assistant access
   when that participant does not need it. These host permissions preserve the
   separately signed application grants. The setup name is reserved.
3. Save the returned ten-minute, one-use code in
   `.tendriller/delegation-code.txt` using a private local editor. Keep the file
   accessible only to the project owner. Supply the file path to the command;
   keep the code itself out of chat, shell arguments, logs and page assets:

   ```sh
   npm run host:adopt -- "$TENDRILLER_ORIGIN" .tendriller/delegation-code.txt
   ```

4. The helper checks the selected host's explicit delegation support, then binds
   the request to the retained service, page and application,
   requires a non-replacing delegation code, and retains its submission before
   sending. It saves the private response before selecting the credential in
   `.tendriller/host-credential.json`. The original handle, setup intent, native
   signer and operation records remain unchanged. A later explicit **Add agent**
   approval can select another credential atomically while retaining both
   adoption histories. A retained older attempt cannot roll back that newer
   selection. Before selection, the helper verifies the credential through the
   same host's authenticated `GET /api/t/PAGE_ID/self`; a revoked credential or
   unavailable verification stays unselected. With the peer still stopped,
   inspect the same identity and retained data:

   ```sh
   npx tendril --session ./session.mjs --mode own self
   npx tendril --session ./session.mjs --mode own query notes null
   npm run peer
   ```

   Verify the original application/device IDs and existing notes, then reconnect
   the same browser profile. A saved host credential does not prove a live
   session. If assistant access used the old setup credential, stop the peer,
   run `npm run assistant:prepare`, have the owner review its new proposal for
   this same app, then run `npm run assistant`. Retain the existing assistant
   key and event cursor. Host delegation does not approve assistant permissions.

Use **Add agent** for this continuation. The separate **Replace all agent
credentials for recovery** action revokes every existing host token when its
code is used; the starter rejects that code. Neither route grants a new device
signing key or changes signed membership.

If the setup secret or original handle is lost, first restore its verified
private checkpoint. When the native device and signed descriptor survive but
the host credential cannot be restored, use the same account-linked connector
to `inspect_tendril_setup` with the original operation ID. If that ID was also
lost, `list_tendril_setups` provides the bounded retained allocations; identify
the original page and application, then inspect that operation. Save the exact
public inspection result, including an `expired` result, as
`.tendriller/account-setup-result.json`. The helper can validate this result
against the retained descriptor and redeem the owner's reviewed delegation for
that same app. A missing or conflicting identity record stops continuation.

After reviewed delegation is saved, `host-credential.json` together with the
retained descriptor can identify that same application even if `handle.json`
is missing. `npm run create` recognizes this state and returns `resumed: true`
with the existing page URL; it does not preflight or allocate another page.
Conflicting service, page or application evidence stops the command. If only
incomplete setup, signer or recovery files remain, `setup_recovery_required`
requires restoration or continuation of that original project. Keep these
records; use a separate empty directory only for an explicitly new application.
A local resumed result still needs the authority and data checks above.

When the connector is disconnected too, the owner can sign in directly at
`SERVICE_ORIGIN/dashboard/setups`, inspect the original setup, and copy its
**Open existing page** link into the private file
`.tendriller/owner-page-url.txt`. Keep `.tendriller/descriptor.json` and the native
device checkpoint. The same `host:adopt` command can use that exact owner link
and pinned application identity without a connector token, a reconstructed
setup secret or a new operation. This read-only dashboard shows at most 100
retained records and never claims, recreates or reconfigures the page.

If the native signer or application keys are also missing, host delegation
cannot recreate them: restore the device checkpoint or use the application's
explicit signed recovery procedure with surviving authorized devices.

An `adoption_outcome_unknown` means the code may have been consumed and its
credential reply was not durably retained. The helper will not send that code
again. The owner must inspect the named agent in the same management screen,
disconnect that named binding if it exists, and explicitly approve a fresh
**Add agent** code. Keep the failed attempt and original app records. When the
response was saved but local selection was interrupted, rerunning the same
command reuses the private response and verifies the current credential without
submitting the code again. `host_credential_unverified` retains that response
while the owner inspects revocation or a network failure. A stale attempt reports
`host_selection_changed` and leaves the later credential selected. Concurrent
selection reports `host_selection_busy`; retry after the other command exits.
If a command crashed while holding `.tendriller/host-selection.lock`, confirm
all adoption commands have stopped before removing only that lock and resuming
the saved response. Keep every attempt, response and application checkpoint.
`delegation_unavailable` means that the selected host could not confirm these
preconditions; no code was submitted. Have the operator deploy the matching host
and retain the same service origin while resolving that prerequisite.

## 3. Define retained state and initialize the native session

Read `domain.mjs`. Its declared `addNote` command emits a retained `note` event.
Its `notes` query reads those events from one coherent view and returns the
verified author and operation ID separately from the note's payload. Local
drafts stay in page-local storage; they are not a second application database.

Immediately after creation, before owner claim:

```sh
npm run init
npx tendril --session ./session.mjs --mode own describe
npx tendril --session ./session.mjs --mode own query notes null
```

`init` performs every initial setup step:

1. Explicitly creates the native device in `.tendriller/device.sqlite`.
2. Saves one initial epoch key and history identity privately before sending
   configuration. An exact retry reuses both.
3. Describes the domain and derives the event execution-manifest digest using
   the installed public Chronolog package.
4. Calls `host.peers.configureApplication` with the definition, initial grants
   and key commitment, then verifies and pins the signed descriptor.
5. Saves an exact signed `reason: 'create'` transition and selects the first
   generation with `expectedGeneration: null` and `base: null`.
6. Opens the native application with that authority and initial key, reads the
   first notes view, and closes the session. This first data use persists the
   creator's keyring in its owned store.

**Configuring a descriptor alone does not open an application.** Without the
first generation, Chronolog reports `PEER_NO_SELECTED_GENERATION`. This is a
bootstrap step, not a missing backend.

Normal `session.mjs` opens omit `create: true`, reuse the same signer and store,
verify current authority against the pinned descriptor, attach the host control
participant, and install the maintained participation controller. There is no
private deployment module left to supply. Closing the CLI releases its storage
and transports. Only one native process may own this device at a time.

You can verify a retained write before building the UI:

```sh
npx tendril --session ./session.mjs --mode own command addNote '{"text":"First native note"}' \
  --operation first-native-note
npx tendril --session ./session.mjs --mode own operation first-native-note
npx tendril --session ./session.mjs --mode own query notes null
```

An `applied` response also has an `outcome`; check for `accepted`. Repeating an
uncertain action means inspecting or retrying `first-native-note`, not submitting
the same text with a new ID. `saved`, `applied` and `shared` describe different
observations; explicit recovery can exclude previously applied work.

The browser UI preserves its unresolved operation reference across reloads and
blocks another **Save note** until that operation is inspected or resolved.
Its retry action reuses the same input, captured revision and identity. After
an inspected recovery exclusion, **Reapply after reviewing current notes**
creates an explicit new attempt linked to the old one.

## 4. Build the page and owning browser Worker

```sh
npm run build
```

The build produces a complete `page/` graph containing `index.html`, bundled
page and Worker modules, their shared chunks, and `configuration.json`.
Configuration contains only the application ID, page URL, initialized native
device public key (`nativeDeviceId`) and pinned public descriptor. The native
public key identifies the optional inference participant; it is not a credential.
The build never copies the private handle, native database or
initial epoch key into `page/`.

The implementation is deliberately ordinary:

| File | Responsibility |
| --- | --- |
| `domain.mjs` | One definition shared by native and browser execution |
| `setup.mjs` | Explicit create, initial authority/generation and reviewed device enrollment |
| `host-adoption.mjs` | Retain and redeem owner-reviewed host delegation for the same application |
| `local.mjs` | Private local setup records and the authenticated native host client |
| `session.mjs` | Complete resumable native bootstrap for the CLI and running peer |
| `worker.mjs` | Browser identity, verified authority, session ownership, participation and key acquisition |
| `page.mjs` | Worker facade, Tendriller application/signal installation, rendering and operation inspection |
| `index.html` | The editable UI and its visible setup/status/retry controls |
| `build.mjs` | Bundle the public browser graph for one signed publication |

The page calls `openBrowserOwner` from
`@tendriller/core/collaboration/browser`, then installs
`createApplicationBackend({ id: session.applicationId, session })` into
`tendril.application` and `session.signals`. A SharedWorker owns the signer,
device storage and session when supported. The fallback elects one dedicated
Worker under an exclusive Web Lock; sibling views attach through bounded,
authenticated local channels. It never infers ownership from a heartbeat.
Closing a view detaches it; another view keeps its own subscriptions and work.
Installation availability is not connection readiness; the UI displays session
and participation status.

Drafts and pending operation references are scoped to a retained view ID. If a
duplicated tab requests the same live view ID, the owner assigns a fresh one; the
new tab can explicitly copy the original draft. Each reference names the actual
signer and original operation. Two views may inspect the same command without
removing each other's references. See [multi-participant composition](MULTIPARTICIPANT.md).

For a layout-only preview:

```sh
npx tendril-preview ./page
```

The app labels this as a layout preview and disables hosted enrollment there.
A localhost preview has a different origin, cookie context and device store.
Use the actual published page for this tutorial's authenticated connection
checks. A live preview for another application must supply that application's
explicit authorized bootstrap as described in [Preview](tools/PREVIEW.md).

## 5. Publish signed code

With the native peer stopped, publish **only `page/`**:

```sh
npx tendril --session ./session.mjs --mode own publish ./page --operation notes-release-1
npx tendril --session ./session.mjs --mode own publication
```

The CLI packs the complete authored graph, asks the session's control participant
to save a signed manifest, and uploads its hash-verified assets. The native
creator has an explicit publisher grant. Host login, administration and data
access alone do not confer publication rights.

Record the publication receipt's ID and version, then open the original page
URL. The rendered release is pinned to its immutable authored graph. If the
publish reply is uncertain, repeat the **same** command and operation ID with
unchanged files; Chronolog recovers the saved intent. A changed graph requires a
new release operation ID. A stale predecessor requires inspection of the
selected publication before making a deliberate new release.

After `npm run peer` starts, ordinary CLI reads and commands use the default
attachment mode; for example `npx tendril --session ./session.mjs self`. They do
not open or close the signer store. Publication and setup administration use the
explicit `--mode own` commands above while the resident owner is stopped.

Publishing code does not enroll the browser's future device. The page's
connection component does that the first time each browser opens it.

## 6. Enroll and connect the owner's browser

Start the private project's native participant before the owner opens the page:

```sh
npm run serve # Native participant with optional reviewed MCP access.
```

**Ship the connection component, not buttons.** The starter's `page.mjs` uses
`createOwnerConnection` from `connection.mjs` and `mountConnectionView` from
`connect-view.mjs` (see [Connect the browser](APP_PATTERNS.md#connect-the-browser)).
Opening the page is the whole flow; agents keep it when adapting the UI:

1. The page attaches to this browser's device owner. Every tab of the page shares
   it; a tab on another publication's Worker attaches to the running owner.
   A browser that is already enrolled is connected now, on every later visit,
   with no prompt.
2. A new browser retains one public request ID, creates its own key in a Worker
   and signs the service challenge. That challenge binds the key, account,
   application, service/page origins, exact read/write rights, current authority
   and expiry. The private key stays in Worker storage.
3. The host wakes the native owner. It saves the pairing intent, **durably pauses
   command ordering**, and stages the exact signed control proposal before
   review. The pause freezes the selected prefix; the proposal preserves all
   existing grants, epoch/key commitments and recovery floor and adds only the
   proved account/key with the narrow browser rights.
4. The page then opens the service-origin approval once, with `return_to` set to
   itself. The signed-in owner sees **Add this browser to APP?** and taps
   **Approve this device**: the single confirmation, with same-origin and CSRF
   checks, on a page that cannot be framed. Technical details (fingerprint,
   origins, generation, retained prefix, proposal digest) are folded below it.
   The service returns to the page, and only to that page's origin.
5. The page shows **Finishing setup…** while the native owner saves the exact
   commit attempt and submits the reviewed transition (the server rechecks
   account access and authority), then connects by itself.

If the owner leaves the approval without deciding, the page offers one
**Approve this browser** action. Expired or stale requests are renewed for the
same device; a denied request waits for an explicit **Ask again**. A request that
the participant committed while the page was away is found on the next open.
Errors are shown in user words (`describeConnectionError`), with the code folded
into technical details; never show raw codes such as `APPLICATION_DEVICE_NOT_FOUND`
or `OWNER_BUSY` as the message.

The native participant stays running independently of MCP connectivity. Its
authenticated setup WebSocket receives pairing and consent changes through the
existing hibernating page object, including requests from a device added later.
There are no idle status polls or heartbeat timers. Individual review requests
expire after ten minutes; one local deadline reconciles an active request.
Stopping the process does not erase a durable pause. Native records under `.tendriller/`
retain `pairing-ID-intent.json`, `pairing-ID-prepared.json`,
`pairing-ID-commit.json` and `pairing-ID-outcome.json`; the pause belongs to the
same device store. After a timeout, lost response or restart, the same
participant's first pass reconciles the original outcome before resuming ordering.
Uncertain or mismatched outcomes stay paused. Do not delete retained evidence,
rebase the proposal or create another signer to get past the pause. Exact
receipt recovery works even after a later generation change, and never restores
a subsequently revoked grant.

For a deliberate inspection/retry step with the resident owner stopped,
`npm run pair` performs one prepare/inspect/commit pass. It does not wait for human
approval. `npm run enroll -- PUBLIC_KEY` remains a deliberate manual
administration route; the ordinary browser flow uses its own signed proof and the
service-origin approval above.

This first app grants the browser **read and write**, with **no publication,
administration, coordination or recovery authority**. This keeps the first
workflow bounded: keep the native peer running while the browser applies writes.
The native process is a participant in the same Chronolog application, with the
same definition and journal semantics. It is not an additional persistence
service. Add browser coordination/recovery grants deliberately when the app's
availability policy needs them; see [Membership](MEMBERSHIP.md) and
[Peer connections](PEER_CONNECTIONS.md).

On connect, the Worker reopens its original identity,
reads signed authority through its authenticated page session, verifies the
pinned descriptor and starts participation. A current reader supplies the
committed epoch keys through the authenticated encrypted peer channel.
`awaiting-keys` while the native donor is absent is honest progress, not a reason
to embed a key in JavaScript or replace the browser identity.

The default native archive has no native RTC implementation, so this minimal
composition uses the host adapter's WebSocket fallback. The browser includes
the maintained RTC bridge and fallback; both transports use the same encrypted
session. Relay traffic uses host bandwidth and depends on the relay. Later,
install the matching native RTC capability and opener to qualify direct
connections; see [Peer connections](PEER_CONNECTIONS.md).

## 7. Verify completion, including reopening

Call the app complete only after checking the actual hosted behavior:

1. The browser reads the native note from step 3, then saves a new note with an
   accepted applied result. The native peer reports the changed notes count.
2. **Close connection** and reload. The page connects by itself and the
   browser displays the same public key and retained notes. Do not create a
   replacement identity to make a failed resume look successful.
3. Save a note, record its operation ID, and inspect it. Retrying that exact ID
   must preserve the operation and not add a second note.
4. Stop the native peer, save work in the connected browser and observe the
   distinction between local saving and waiting for applied execution. Restart
   the same native device and inspect/retry the original identity. A short UI
   timeout cancels observation; it does not cancel the saved operation.
5. Stop the native peer before a CLI invocation, then query through
   `npx tendril --session ./session.mjs --mode own query notes null`. Confirm the same
   retained data and original operation IDs. Start `npm run peer` again when done.
6. Rebuild a visible UI change and publish with a new operation, such as
   `notes-release-2`. Confirm the selected receipt and page content. Changing
   HTML/CSS does not require replacing application authority or data.

Report which of these ran, the exact source/package hashes, publication receipt,
target host, browser, and any unverified boundary. A static screenshot or build
does not establish enrollment, retained state, deployed OAuth, mobile durability
or Internet connectivity. The broader [release gates](RELEASE_COMPOSITION.md)
remain separate from this first-app acceptance.

### Retain and verify a private checkpoint

Keep the complete project and its `.tendriller/` directory in a persistent,
access-controlled location. That directory contains the setup credential,
device database, signing material, saved initialization/publication attempts,
reviewed host credentials and adoption attempts, and
optional assistant identity/cursor; retaining only the public `page/` files or
the page URL cannot resume the participant. Never add private state to a source
commit, publication archive, chat transcript or browser bundle.

For a filesystem checkpoint, stop the owned participant cleanly and confirm its
process has exited before copying the complete private directory. Preserve file
permissions and all database sidecars; do not copy an actively written SQLite
file on its own. Verify the destination exists and its copied file bytes match
before reporting a backup. A failed helper or an ephemeral working directory
does not establish durable storage. Record the private destination separately
from the public report without printing credentials.

Resume with the same project, selected service origin and saved device. Use
`tendril --session ./session.mjs --mode own self`, the explicit `query notes null`,
and `publication-operation ORIGINAL_ID` to inspect the retained identity, data
and original publication receipt. Stop that probe before restarting the resident
participant. A restore exercise must use one owner of the signer at a time; do
not run a copied device concurrently with its original. Recheck the actual
browser/MCP exchange after restarting: a successful checkpoint does not keep a
native process alive or authenticate a separate browser session.

## Adapt the app to the user's task

Keep the complete session composition and replace the notes domain/UI with the
smallest useful workflow. Use page-local state for drafts, session signals for
disposable presence/progress, event commands for retained facts, and a verified
SQL capability when transactions and relational guards are needed. The
[application contract](APPLICATION_BACKENDS.md) and
[cookbooks](https://cookbooks.tendriller.dev/) explain those choices.

Import the current [view and operation helpers](APP_PATTERNS.md), and use the
[reviewed media/inference flow](AI_INPUT.md) when the task needs capture or AI
suggestions. Reuse the optional runtime voice adapter and the camera controller's
native acquisition plus runtime sensor tracking. These modules are supplied in
the archive; an agent should not need to invent REST/SSE plumbing, a camera
lifecycle or a voice stack to make the app useful.

Define the domain before initial configuration: the descriptor binds the public
definition, semantic version, schema and execution manifest. A UI publication
does not replace that immutable application definition. For a new initial domain,
use a deliberately new application setup; do not erase existing users' stores
or misrepresent an unimplemented migration.

Keep original operation IDs on uncertain replies. Show `abandoned` and
`needsReapply` after explicit recovery; a reviewed reapplication uses a fresh
identity and current guards. An external API with irreversible effects needs
its own declared authorization and reconciliation policy. Ordinary applied
events do not provide irreversible finality.

After the app works, offer **Page options → Add to Home Screen** and explain
**Save for offline use** separately. Installation does not create an always-on
coordinator, transfer a signer, save application data everywhere, or prevent
mobile suspension.

## When a step fails

| Observation | Meaning and next action |
| --- | --- |
| Create is unavailable or contract mismatches | Read `/api/service` and the error; use a compatible host/package pair. Preserve the requested platform and report the actual blocker. |
| `forbidden` during configuration | Check the current private setup credential and its scopes, expiry and page identity. Configuration and signed publication support unclaimed pages; claim is not a prerequisite. |
| `setup_expired`, `setup_binding_inactive`, or a revoked setup token on a claimed page | Follow [same-app continuation](#continue-the-same-app-after-setup-credential-expiry-or-loss): owner **Add agent**, retain its private code and use `host:adopt`. Preserve the original signer and setup operation. |
| `peer_application_unconfigured` | Run the explicit initial configuration; a page handle alone has no application authority. |
| `PEER_NO_SELECTED_GENERATION` | Complete the saved first `create` transition before opening the session. |
| Missing `owner_account_id` | The host lacks this onboarding update. Upgrade it; do not guess an account binding. |
| `APPLICATION_DEVICE_NOT_FOUND`, missing keys or data | Resume from the correct saved device directory/origin. Inspect missing storage; never generate a replacement under an old identity. |
| `BYTES_STORE_IN_USE` or `BROWSER_STORAGE_IN_USE` | Close the other owner of that same device. Native CLI and `npm run peer` cannot share one open writer. |
| Browser is not enrolled | Request access from its retained browser device, keep the native peer running to stage the exact proposal, and complete the service-origin owner review. Check committed status before connecting. Account login and device grants are separate. |
| Pairing is pending or ordering is paused | Inspect the original request and retained native proposal. Keep the native owner running for setup notifications; after a process stop, reopen the same owner and reconcile uncertain commitment before resuming ordering. Never delete the pause or silently rebase the review. |
| `awaiting-keys`, connecting, or locally saved work | Keep the authorized native donor/coordinator running and inspect participation status and host access. Never paste the epoch key into the page. |
| Publication forbidden | Inspect the current explicit publisher grant and submitting account authorization. Administration is a separate right. |
| Stale publication or control transition | Inspect the selected head and saved request. Retry exact uncertain work; review a fresh change after a conflict. |
| Recovery excludes work | Inspect the original operation and selected history. Reapply only after a deliberate review, with a new ID. |

For exact API composition and ownership rules, continue to
[Session bootstrap](SESSION_BOOTSTRAP.md). For command syntax, use
[CLI](tools/CLI.md), `tendril --help`, and `tendril guide --server YOUR_ORIGIN`.

## Expose an application to an assistant

After the application has a working enrolled participant, use
`@tendriller/core/assistant` to expose selected queries, commands and events.
Give the owner the actual review URL and verify one applied writeback through
the same service origin. See [Connect any application](CLOUDFLARE_ASSISTANT.md#enroll-an-application)
for participant setup and [guide a user through ChatGPT](CHATGPT_INTEGRATION.md#agent-walkthrough)
for installation, account linking and workspace sharing.


## Prepare MCP access before sign-in

For a chat-linked Shared Notes app, after publication run:

```sh
npm run assistant:prepare
npm run serve
```

Use one `serve` process: it runs the same native participant with
the declared `notes` query and `addNote` command. Optional `note.added` forwarding
requires `--events` on both preparation and the running adapter, plus the owner's
corresponding permission review. It does not configure a future ChatGPT turn.
Missing consent, adapter timeouts, revocation or replacement stop only the
optional adapter; they never stop the application participant or pairing. New
consent arrives through the setup subscription and reconnects the adapter.
The runner distinguishes preparation, the native PID, adapter status, skipped
unapproved events and shutdown; verify a real round trip before claiming a
connection. Keep it
under the execution environment's process supervisor. The prepare command prints
the real permission-review URL even before claim. Give the owner the ready page
and that URL together; sign-in adopts the prepared application and makes the
permission review available. It does not approve MCP data access automatically.
Use a finite setup-status check if needed, without requiring a chat acknowledgement.
The owner still explicitly enrolls their browser and approves assistant capabilities.
A source ZIP or temporary process is not durable hosting for the native participant.
