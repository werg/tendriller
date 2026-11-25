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
workspace agent program as creator/publisher, a browser Worker, a declared command and query, device
enrollment, signed publication, reopen and exact retry. The source is in
[`docs/tutorial/`](https://github.com/werg/tendriller/tree/master/docs/tutorial), and the running host serves the
[first-app source archive](/downloads/tendriller-first-app.tgz).
There is no missing `deployment.mjs` to invent.

**Several pages, one agent.** The kit is a workspace: one agent credential and
one signing key serve every page you create, and a single page is a workspace
with one page. See [multi-page agents](MULTI_PAGE_AGENTS.md) for the model. A
`404` `not_found` (`No such granted page`) from `/api/agent/pages/<id>/...` means
the agent holds no grant for that page or the page is gone; restoring a
credential cannot recreate it. Confirm the service origin and ask the owner to
grant the page, or create a new page. Do not treat an uncertain request or
ordinary access failure as a confirmed deletion.

To test an app against a release before touching production, use the
[local release host](LOCAL_HOST.md). It provides a verified host and synthetic
test owner for the same create, init, publish, pair and connect flow below.

When adapting this starter to a checklist or another application, first verify its
unchanged connected loop, then change the domain and UI. Keep device identity
independent of titles: the page, pairing Worker and application Worker all import
`shared/helpers/browser-profile.mjs`. Do not rename the profile in just one entry point
or replace a retained browser store. Keep `configuration.page_url` from the page
record; the service origin and the published page origin serve different roles.

## Requests to the existing agent conversation

If the app must reach this same Codex or ChatGPT conversation after its current
turn ends, qualify that route during setup with
[same-conversation delivery](CONVERSATION_DELIVERY.md) (`tendril_guide`,
`topic: "conversation"`). The workspace program owns page sessions; a request
worker and the host's conversation receiver have separate lifetimes.
Advertise only the active worker's handled topics, and keep requests pending
when its route is unavailable. Test a second request after the first turn ends;
a running page owner or printed event does not establish conversation wake.

## The route and its checkpoints

| Step | Do this | Evidence that it worked |
| --- | --- | --- |
| Discover | Read the host's `/api/service`, this guide and the supplied starter | Host contract, release and limits are known |
| Create | Register the workspace agent, then create the page; keep preparing | An agent credential, a page ID and stable application ID |
| Define state | Declare `addNote` and `notes`; configure authority and select the first generation | The native session opens and reads a coherent empty notes view |
| Build the UI | Bundle the page and owning Worker | `pages/<slug>/dist/` contains the complete authored graph and public configuration |
| Publish | Publish through the running agent program's page owner | A receipt and selected immutable release ready for the owner’s first signed-in visit |
| Owner sign-in | Give the person the already-published page and any prepared permission-review URL | Existing authority, keys and code retained; no new publication needed |
| Connect the browser | Request access with its own device and let the agent program stage an exact member-only proposal; the host approves it automatically | The approved signed grant is committed; the session connects, acquires keys and reads real application state |
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

Use **Node 24**, npm, curl, tar and a SHA-256 checker. Node 24 is the qualified
first-app runtime and both starters require at least 24; core's separate minimum
remains Node 22.15. The released first-app
archive contains the maintained starter and its exact public SDK, tools and
Chronolog events packages. Ordinary setup does not need a second repository
checkout or a Chronolog build. SQL, native RTC and WASM engines are separate
optional capabilities. For relational guards and multi-entity transactions, use
the concrete [SQL alternative](STATE_MODELS.md) before configuring authority.

For machine-readable setup output, use `npm run --silent page:new -- notes` and
`npm run --silent init -- notes`, or invoke `node setup.mjs new notes` /
`node setup.mjs init notes` directly; `tendril` prints one JSON object per result. Parse stdout and check the exit status. Node diagnostics, including
SQLite experimental warnings, stay on stderr; keep them visible and separate
from JSON. Node 24 does not promise warning-free stderr.

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
Once `pages/notes/dist/` exists, `npx tendril-preview ./pages/notes/dist` checks layout immediately;
[static versus real-session preview](tools/PREVIEW.md) explains what it establishes.
To exercise connected domain flows with development data before production sign-in,
use the [existing local-host UX review path](tools/PREVIEW.md#connected-ux-review-before-production-sign-in).
Complete the full UX pass before final delivery; production owner sign-in is not
blocked on a synthetic preview.
Keep the published page as the verification target for the actual account,
device enrollment and session. Enrollment requires `owner_account_id` in the
host's authenticated page `info()` response; absence means the host lacks the
matching onboarding contract.

For unreleased core development, commit a clean matching checkout, run `npm ci`,
`npm run build:artifacts` and `npm run release:artifacts`, then qualify its exact
first-app archive with `npm run test:first-app -- --first-app-archive
/absolute/tendriller-first-app-VERSION.tgz`. This creates local candidate artifacts;
it does not publish a release or qualify a deployed host. Never import core's
private server/test modules or Chronolog's source internals into the app.

## 2. Create the workspace agent and the page for the intended owner

The kit is an **agent workspace**: one agent credential and one signing key for
any number of pages, one install, and `pages/<slug>/` source per page. Register
the agent once per workspace, choosing the route your environment supports.

### From an account-linked MCP connection

The connector's linked account resolves the owner; no owner email or OAuth
access token enters the local project. Create the shared key and print the
public arguments:

```sh
npx tendril workspace key --service "$TENDRILLER_ORIGIN" --name notes-agent
```

Call `register_agent` through the **same selected account-linked connector** with
exactly the printed `register_agent` arguments (`name`, `publicKey`). Save its
result privately as `.tendriller/register-agent-result.json` (never in chat or
page assets), then retain it:

```sh
npx tendril workspace adopt --service "$TENDRILLER_ORIGIN" --credential .tendriller/register-agent-result.json
```

`adopt` verifies the token against `GET /api/agent` on that origin before saving
`.tendriller/agent/credential.json` and `tendriller.json`. Calling
`register_agent` again with the same name rotates the token; adopt the newest
result. A missing tool or scope is an explicit catalog/deployment/consent
prerequisite: keep this origin and key while resolving it.

### From a domain without account-linked creation

Register an unclaimed agent for the actual owner's verified login email:

```sh
npx tendril workspace init --service "$TENDRILLER_ORIGIN" --owner owner@example.com --name notes-agent
```

It checks readiness and the host contract, creates the shared key in
`.tendriller/agent/identity.sqlite` and registers the agent with
`POST /api/agents`. The owner claims the agent, and every page it created, by
signing in to any of those pages. A signed-in owner can instead create a one-time
code under **Dashboard → Your agents → Add agent**; then use
`npx tendril workspace join --service "$TENDRILLER_ORIGIN" --code CODE`.

A second `workspace init` in the same folder is refused rather than registering
another agent. A lost registration reply is not reconstructed; inspect the
account's agents before registering again.

### Create the page

```sh
npm run page:new -- notes --template notes --name "Shared notes"
```

This checks readiness, creates the page with `POST /api/agent/pages` (the
creating agent receives a full grant), records `{ "notes": { "id": PAGE_ID } }`
in `tendriller.json`, keeps the page URL and `application.id` private in
`.tendriller/pages/PAGE_ID/page.json`, and copies the template into
`pages/notes/`. It refuses a non-empty `pages/notes/`; rerunning it for a
registered slug resumes without creating a second page. An existing page needs
the owner's explicit grant, then `npx tendril page grant <slug> <page-id>`.

Keep preparing: initialize, build, run the agent program and publish before
asking the owner to open the ready URL and sign in. Agent credentials cannot
claim the page for them. An unclaimed page expires after 24 hours; report a
blocked claim explicitly. The service's `/api/service` advertises one resource
policy for prepared and claimed pages, currently 8 MiB per authored file and
25 MiB per page, including retained control bytes.

The page has two identities: its hosted ID/URL and `application.id`. The agent
token (`ta_…`) is a host credential, not the device signing key or a data key.
The supplied `.gitignore` excludes `.tendriller/`, `node_modules/`,
`pages/*/dist/` and `pages/*/engine/`. `tendriller.json` holds no secret.

### Give the app a recognizable favicon

```sh
npx tendril --page notes meta '{"icon":"📝"}'
```

The host converts the emoji to an SVG favicon automatically, including compound
emoji such as `👩🏽‍💻`. An HTTPS image URL also works; `icon: null` restores the
default. Authored icon tags or a manifest retain control when supplied. See
[favicons and page branding](BROWSER_API.md#favicons-and-page-branding) and the
[CLI example](tools/CLI.md#set-a-favicon).

### Continue after a lost credential or device

`.tendriller/agent/` (credential and shared signer) and
`.tendriller/pages/PAGE_ID/` (device store, descriptor, setup and pairing records)
are the workspace's private checkpoint. Restore them from a verified checkpoint;
there is no reissue of a lost key. If only the token is lost or revoked, the owner can add the agent again
from the dashboard and `workspace join` a fresh folder; the page's signed
application grants belong to the key, so a new key also needs explicit signed
enrollment or recovery with surviving authorized devices.

## 3. Define retained state and initialize the page

Read `pages/notes/domain.mjs`. Its declared `addNote` command emits a retained
`note` event. Its `notes` query reads those events from one coherent view and
returns the verified author and operation ID separately from the note's payload.
Local drafts stay in page-local storage; they are not a second application database.

Immediately after page creation, before owner claim:

```sh
npm run init -- notes
```

`init` performs every initial setup step:

1. Explicitly creates the page device in `.tendriller/pages/PAGE_ID/device.sqlite`,
   signed by the workspace's shared agent key.
2. Saves one initial epoch key and history identity privately before sending
   configuration. An exact retry reuses both.
3. Describes the domain and derives the event execution-manifest digest using
   the installed public Chronolog package.
4. Calls `host.peers.configureApplication` with the definition, initial grants
   (the agent key as administrator and publisher) and key commitment, then
   verifies and pins the signed descriptor.
5. Saves an exact signed `reason: 'create'` transition and selects the first
   generation with `expectedGeneration: null` and `base: null`.
6. Opens the application, reads the first notes view, closes the session and
   writes `initialized.json`.

**Configuring a descriptor alone does not open an application.** Without the
first generation, Chronolog reports `PEER_NO_SELECTED_GENERATION`. This is a
bootstrap step, not a missing backend.

Then start the workspace's only long-running local program and keep it running:

```sh
npm run agent        # tendril agent run
```

It keeps one hub connection to the host for every page's setup notices,
discovery, invitations, rendezvous and assistant streams, opens one session per
initialized page through `pages/<slug>/agent.mjs`, and serves them on one local
attach socket. A page initialized while it runs is opened without a restart.
Only one agent program may own the workspace at a time. CLI commands attach to it:

```sh
npx tendril --page notes describe
npx tendril --page notes query notes null
npx tendril --page notes command addNote '{"text":"First native note"}' --operation first-native-note
npx tendril --page notes operation first-native-note
npx tendril --page notes query notes null
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
npm run build -- notes
```

The build produces a complete `pages/notes/dist/` graph containing `index.html`, bundled
page and Worker modules, their shared chunks, and `configuration.json`.
Configuration contains only public application/definition IDs and versions,
page/service addresses, the initialized native device public key (`nativeDeviceId`)
and the pinned public descriptor. The native
public key identifies the optional inference participant; it is not a credential.
The build never copies the agent credential, page records, device database or
initial epoch key into `dist/`.

The build derives `definitionId` and `definitionVersion` from `domain.mjs` and
checks its public definition digest against the retained initialized descriptor.
A mismatch fails the build and removes `dist/`; restore the initialized definition
or create a new page for a different domain. Rebuilding UI does not authorize
replacement of a signer, definition or history. Initialization and generic peer
logging need no domain-specific query.

When adapting the starter, deliberately edit the domain, rendered views and
handlers, display name, and assistant command/query allowlists and event
projection. New declared commands are not automatically granted to the assistant.
Keep executable domain and optional SQL initialization in the native/Worker
composition; the page needs only the generated public identity.

Before choosing external APIs or assets, read the [published-page security policy](BROWSER_API.md#published-page-security-policy).
The sign-in redirect is not evidence of the authenticated authored page's policy.

The implementation is deliberately ordinary:

| File | Responsibility |
| --- | --- |
| `setup.mjs` (workspace root) | Page lifecycle: `page:new`, `init`, `build`, `deploy`, `enroll`, `assistant:prepare` |
| `shared/local.mjs`, `shared/native-page.mjs` | Page context from the workspace; one page's owner inside the agent program |
| `pages/notes/domain.mjs` | One definition shared by native and browser execution |
| `pages/notes/setup.mjs` | Initial authority/generation and reviewed device enrollment |
| `pages/notes/agent.mjs` | `openPage(context)`: the page owner `tendril agent run` opens |
| `pages/notes/worker.mjs` | Browser identity, verified authority, session ownership, participation and key acquisition |
| `page.mjs` | Worker facade, Tendriller application/signal installation, rendering and operation inspection |
| `index.html` | The editable UI and its visible setup/status/retry controls |
| `build.mjs` | Bundle the public browser graph for one signed publication |

The page calls `openBrowserOwner` from
`@tendriller/core/browser-owner`, then installs
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
npx tendril-preview ./pages/notes/dist
```

The app labels this as a layout preview and disables hosted enrollment there.
A localhost preview has a different origin, cookie context and device store.
Use the actual published page for this tutorial's authenticated connection
checks. A live preview for another application must supply that application's
explicit authorized bootstrap as described in [Preview](tools/PREVIEW.md).

## 5. Publish signed code

With `npm run agent` running, publish **only `pages/notes/dist/`**:

```sh
npm run deploy -- notes      # build, then tendril --page notes publish pages/notes/dist
npx tendril --page notes publication
```

The CLI packs the complete authored graph, asks the page owner's control
participant to save a signed manifest, and uploads its hash-verified assets. The
agent key has an explicit publisher grant. Host login, administration and data
access alone do not confer publication rights. The agent program's local attach
binding permits publication; see [publication capability and retained bindings](tools/CLI.md#publication-capability-and-retained-bindings).

Record the publication receipt's ID and version, then open the original page
URL. The rendered release is pinned to its immutable authored graph. If a
publish reply is uncertain, retain the exact files and operation ID and inspect
`npx tendril --page notes publication-operation OPERATION` and `publication`
before an exact retry. A changed graph requires a new release operation ID.
Tutorial CLIs close their attachment, flush output and exit; cleanup or output
failure stays nonzero. See [owned shutdown and uncertain operations](SESSION_BOOTSTRAP.md#own-shutdown-and-uncertain-operations).

Publishing code does not enroll the browser's future device. The page's
connection component does that the first time each browser opens it.

## 6. Enroll and connect the owner's browser

Keep the workspace's agent program running before the owner opens the page:

```sh
npm run agent   # every page's native owner, with optional reviewed MCP access
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
   command ordering**, and stages the exact signed control proposal. The pause freezes the selected prefix; the proposal preserves all
   existing grants, epoch/key commitments and recovery floor and adds only the
   proved account/key with the narrow browser rights.
4. The host verifies the staged member-only proposal against the proved key,
   account and current authority and approves it automatically for the
   signed-in owner or an admitted guest. There is no approval screen; the page
   stays put and shows **Setting up this browser…**.
5. The page shows **Finishing setup…** while the native owner saves the exact
   commit attempt and submits the approved transition (the server rechecks
   account access and authority), then connects by itself.

Expired or stale requests are renewed for the
same device once automatically per visit; further expiry waits for **Request another review**, so an unattended tab cannot exhaust its retained history. A denied request waits for an explicit **Ask again**. A request that
the participant committed while the page was away is found on the next open.
Errors are shown in user words (`describeConnectionError`), with the code folded
into technical details; never show raw codes such as `APPLICATION_DEVICE_NOT_FOUND`
or `OWNER_BUSY` as the message.

The native participant stays running independently of MCP connectivity. Its
authenticated setup WebSocket receives pairing and consent changes through the
existing hibernating page object, including requests from a device added later.
There are no idle status polls or heartbeat timers. Individual review requests
expire after ten minutes; one local deadline reconciles an active request.
Stopping the process does not erase a durable pause. Page records under `.tendriller/pages/PAGE_ID/`
retain `pairing-ID-intent.json`, `pairing-ID-prepared.json`,
`pairing-ID-commit.json` and `pairing-ID-outcome.json`; the pause belongs to the
same device store. After a timeout, lost response or restart, the same
participant's first pass reconciles the original outcome before resuming ordering.
Uncertain or mismatched outcomes stay paused. Do not delete retained evidence,
rebase the proposal or create another signer to get past the pause. Exact
receipt recovery works even after a later generation change, and never restores
a subsequently revoked grant.

`npm run enroll -- notes PUBLIC_KEY` remains a deliberate manual
administration route (stop the agent program first; it owns the page device); the ordinary browser flow uses its own signed proof and the
automatic host approval described above.

This first app grants the browser **read and write**, with **no publication,
administration, coordination or recovery authority**. This keeps the first
workflow bounded: keep the agent program running while the browser applies writes.
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

Both supplied owners use the [canonical P2P-first participation path](PEER_CONNECTIONS.md).
The standard session installation includes native RTC; the browser owner provides
the page-side RTC bridge automatically. Direct traffic saves host bandwidth.
When the network or browser cannot establish RTC, the same session uses the
bounded encrypted WebSocket fallback. Keep these helpers when adapting the app;
do not postpone direct connectivity or replace it with an always-failing opener.
Record actual transport selection and relay payload bytes in the delivery proof.

## 7. Verify completion, including reopening

Call the app complete only after checking the actual hosted behavior:

1. The browser reads the native note from step 3, then saves a new note with an
   accepted applied result. The agent program reports the page's changed revision.
2. **Close connection** and reload. The page connects by itself and the
   browser displays the same public key and retained notes. Do not create a
   replacement identity to make a failed resume look successful.
3. Save a note, record its operation ID, and inspect it. Retrying that exact ID
   must preserve the operation and not add a second note.
4. Stop the agent program, save work in the connected browser and observe the
   distinction between local saving and waiting for applied execution. Restart
   the same native device and inspect/retry the original identity. A short UI
   timeout cancels observation; it does not cancel the saved operation.
5. To verify native reopening, restart `npm run agent` and query
   `npx tendril --page notes query notes null`. Confirm the same retained data
   and original operation IDs.
6. Rebuild a visible UI change and publish with a new operation, such as
   `notes-release-2`. Confirm the selected receipt and page content. Changing
   HTML/CSS does not require replacing application authority or data.

7. Run the **user experience acceptance pass** below. The transport checks above
   are necessary; the app must also support the person's actual tasks.

### User experience acceptance pass

Before implementation, name the app's main user flows and the appropriate domain
views: conversations for episodes, timelines for activity, named links for related
records, and reviewed inline changes for edits. A JSON editor or a form that
mirrors every stored field is a diagnostic fallback, never the finished result
for a full-featured or rich request. Adapt the [importable UI patterns](APP_PATTERNS.md#domain-views-you-can-import).

After the first working version, use the [dedicated second-pass prompt and flow
matrix](AGENT_DELIVERY.md#the-user-experience-is-part-of-the-deliverable). In fresh
browser profiles at desktop and phone widths, walk every main flow from arrival
to its visible result. Test search/filter and detail deep links, reload and Back,
keyboard focus, review/save/undo where supported, long content, empty data,
loading and failures. Keep normal content behind the state-aware connection card
until the app is usable. Fix confusing hierarchy, raw URL labels, hidden actions,
horizontal overflow and lost drafts before the final pass.

Record each flow's tested URL/release, viewport, steps, outcome, and linked
before/after screenshots. Re-run the changed flow after each fix. A blocked
browser check stays explicitly unverified; it cannot be replaced by a build or
an attractive screenshot of another state.

Report which of these ran, the exact source/package hashes, publication receipt,
target host, browser, and any unverified boundary. A static screenshot or build
does not establish enrollment, retained state, deployed OAuth, mobile durability
or Internet connectivity. The broader [release gates](RELEASE_COMPOSITION.md)
remain separate from this first-app acceptance.

### Retain and verify a private checkpoint

Keep the complete workspace and its `.tendriller/` directory in a persistent,
access-controlled location. That directory contains the agent credential and
shared signer, each page's device database, saved initialization/publication
attempts, pairing records and optional assistant identity/cursor; retaining only
the public `dist/` files or the page URL cannot resume the participant. Never add private state to a source
commit, publication archive, chat transcript or browser bundle.

For a filesystem checkpoint, stop the agent program cleanly and confirm its
process has exited before copying the complete private directory. Preserve file
permissions and all database sidecars; do not copy an actively written SQLite
file on its own. Verify the destination exists and its copied file bytes match
before reporting a backup. A failed helper or an ephemeral working directory
does not establish durable storage. Record the private destination separately
from the public report without printing credentials.

Resume with the same workspace, selected service origin and saved devices. Start
`npm run agent`, then use `tendril --page notes self`, `query notes null` and
`publication-operation ORIGINAL_ID` to inspect the retained identity, data and
original publication receipt. A restore exercise must use one owner of the signer at a time; do
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

Hosted pages already expose **Page options → Set up voice input** for optional
tap-to-talk and a foreground wake phrase. Model download and microphone access
require a separate local consent action; the generic control only produces a
reviewable, editable draft and **Copy text**. It does not submit domain commands.
For an authored input flow, use `mountVoiceControls(runtime, { container,
transcript })` from the optional `voice.mjs` module; `transcript` runs after the
person chooses **Use text**. Feed that reviewed text into the application's
existing review/submission flow. The default control uses the pinned on-device
model (18,224,260 bytes including engines), with a visible microphone state,
Stop, bounded sessions, and no listening while hidden or closed. Follow the
[voice lifecycle and consent guide](HANDS_FREE.md) and preserve the
[physical-device qualification limits](WAKE_WORD_QUALIFICATION.md).

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
| `forbidden` during configuration | Check that the agent holds a grant for this page with the needed scopes. Configuration and signed publication support unclaimed pages; claim is not a prerequisite. |
| Agent `revoked` or the hub reports `replaced` | The owner revoked the agent, or another agent program runs for the same credential. Stop duplicates; a revoked agent needs the owner to add it again. Preserve the signer and page records. |
| `peer_application_unconfigured` | Run `npm run init -- <slug>`; a created page alone has no application authority. |
| `PEER_NO_SELECTED_GENERATION` | Complete the saved first `create` transition before opening the session. |
| Missing `owner_account_id` | The host lacks the matching onboarding contract. Use a host and kit of the same release; do not guess an account binding. |
| `APPLICATION_DEVICE_NOT_FOUND`, missing keys or data | Resume from the correct saved device directory/origin. Inspect missing storage; never generate a replacement under an old identity. |
| `BYTES_STORE_IN_USE` or `BROWSER_STORAGE_IN_USE` | Close the other owner of that same device. CLI commands attach to the running agent program; only one agent program may own a workspace. |
| Browser is not enrolled | Request access from its retained browser device, and keep the agent program running to stage the exact proposal; the host approves it automatically. Check committed status before connecting. Account login and device grants are separate. |
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
npm run assistant:prepare -- notes
npm run agent
```

The agent program connects the page's adapter after approval, with the declared
`notes` query and `addNote` command. Optional `note.added` forwarding requires
`npm run assistant:prepare -- notes --events`, plus the owner's corresponding
permission review. It does not configure a future ChatGPT turn.
Missing consent, adapter timeouts, revocation or replacement stop only the
optional adapter; they never stop the application participant or pairing. New
consent arrives through the setup subscription and reconnects the adapter.
The agent program reports preparation, adapter status, skipped
unapproved events and shutdown; verify a real round trip before claiming a
connection. Keep it
under the execution environment's process supervisor. The prepare command prints
the real permission-review URL even before claim. Give the owner the ready page
and that URL together; sign-in adopts the prepared application and makes the
permission review available. It does not approve MCP data access automatically.
Use a finite setup-status check if needed, without requiring a chat acknowledgement.
The browser completes proved-device enrollment automatically; assistant
capabilities still require explicit owner approval.
A source ZIP or temporary process is not durable hosting for the native participant.
