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

## The route and its checkpoints

| Step | Do this | Evidence that it worked |
| --- | --- | --- |
| Discover | Read the host's `/api/service`, this guide and the supplied starter | Host contract, release and limits are known |
| Create | Create the page privately and retain the setup handle; keep preparing | A page handle and stable application ID |
| Define state | Declare `addNote` and `notes`; configure authority and select the first generation | The native session opens and reads a coherent empty notes view |
| Build the UI | Bundle the page and owning Worker | `page/` contains the complete authored graph and public configuration |
| Publish | Use the creator session's saved signed publication | A receipt and selected immutable release ready for the owner’s first signed-in visit |
| Owner sign-in | Give the person the already-published page and any prepared permission-review URL | Existing authority, keys and code retained; no new publication needed |
| Connect the browser | Create its device, explicitly enroll its public key, then connect | The session acquires keys from the native peer and shows real connection/data status |
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

Use **Node 24**, npm, Git, curl and a SHA-256 checker. Public artifact downloads
require no GitHub login. The first app uses the SQL-free event package. SQL,
native RTC and WASM engines are optional later capabilities.
For relational guards and multi-entity transactions, use the concrete
[SQL alternative](STATE_MODELS.md); do not configure this events definition first
and then attempt to replace its immutable authority.

Replace the service origin with the domain the user gave you. Read its live
descriptor before creating anything:

```sh
TENDRILLER_ORIGIN=https://tendriller.dev
mkdir shared-notes
cd shared-notes
curl --fail --show-error --silent "$TENDRILLER_ORIGIN/api/service" -o service.json
cat service.json
curl --fail --show-error --location "$TENDRILLER_ORIGIN/downloads/tendriller-first-app.tgz" -o first-app.tgz
tar -xzf first-app.tgz
```

The archive extracts the tutorial files into the current directory. If the target
host does not yet serve this archive, copy `docs/tutorial/` from the matching
[Tendriller source](https://github.com/werg/tendriller). Record the source commit.
This tutorial's enrollment command requires a host that exposes
`owner_account_id` in authenticated agent `info()` responses. If that field is
absent, the host needs the onboarding update; the tool reports that boundary.

As soon as these packages are available, create the real page in step 2 and
continue through initialization, building and publication before asking for sign-in.
Then give the owner the ready page URL. Never stop to request a "claimed" reply.
Once `page/` exists, `npx tendril-preview ./page` checks layout immediately;
[static versus real-session preview](tools/PREVIEW.md) explains what it establishes.
Keep the published page as the verification target for this tutorial's actual
account, device enrollment and session.

Get the SDK and tools from the host's advertised release, and check their hashes:

```sh
TENDRILLER_RELEASE=$(node -p "JSON.parse(require('fs').readFileSync('service.json','utf8')).core_release")
mkdir artifacts
TENDRILLER_RELEASE_URL="https://github.com/werg/tendriller/releases/download/v$TENDRILLER_RELEASE"
for artifact in "tendriller-sdk-$TENDRILLER_RELEASE.tgz" \
  "tendriller-tools-$TENDRILLER_RELEASE.tgz" SHA256SUMS manifest.json
do
  curl --fail --show-error --location "$TENDRILLER_RELEASE_URL/$artifact" -o "artifacts/$artifact"
done
cd artifacts
sha256sum --ignore-missing --check SHA256SUMS
cd ..
npm install --save-exact "./artifacts/tendriller-sdk-$TENDRILLER_RELEASE.tgz" \
  "./artifacts/tendriller-tools-$TENDRILLER_RELEASE.tgz"
npm install --save-dev --save-exact esbuild@0.28.2
```

Chronolog's public session package is currently produced from exact source; do
not assume `npm install @chronolog/peer-session` retrieves the required package.
The source baseline for this tutorial is
`d3efeb6d75ac24bb9b44899f27d6940475ab55e9`. Build its ordinary events archive:

```sh
git clone https://github.com/werg/chronolog-db.git ../chronolog-source
git -C ../chronolog-source checkout --detach d3efeb6d75ac24bb9b44899f27d6940475ab55e9
cd ../chronolog-source
corepack pnpm install --frozen-lockfile --ignore-scripts
node tools/package-peer-session.mjs
cd ../shared-notes
npm install --save-exact ../chronolog-source/artifacts/peer-session/chronolog-peer-session-d3efeb6d.tgz
```

Keep the archive's reported SHA-256, `provenance.json`, exact source SHA and the
application's `package-lock.json`. If an operator supplies a different qualified
composition, use its exact matching package instead and run the same acceptance
checks. A source baseline is not a claim that an arbitrary host/package pair has
passed deployed qualification. [Release composition](RELEASE_COMPOSITION.md)
explains that separate gate.

The SQL-free session packer consumes the installed workspace directly; disabling
install scripts avoids unrelated native SQL engine compilation. SQL/native RTC
packages have separate build and installation requirements.

For unreleased core development, build the matching checkout with `npm ci` and
`npm run build:artifacts`, then install its `dist/tendriller-sdk-*.tgz` and
`dist/tendriller-tools-*.tgz` in this application. Never import core's private
server/test modules or Chronolog's source internals into the app.

## 2. Create the application and let the owner claim it

Use the actual owner's verified email:

```sh
npm run create -- "$TENDRILLER_ORIGIN" owner@example.com "Shared notes"
```

The command checks the host contract, creates the page and saves its returned
handle privately in `.tendriller/handle.json`. It prints the page URL and next
step. Keep preparing: initialize, build, publish and start the participant before
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
separate action from initialization: if the create response is lost before the
handle is saved, inspect the host/account state before issuing another create.

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

Publishing code does not enroll the browser's future device. The first visit
therefore shows the next setup action explicitly.

## 6. Enroll and connect the owner's browser

Open the published page while signed in as its owner. Choose **Set up this
browser**. This explicit action creates or resumes a browser-owned identity,
closes that short setup owner, and displays its public key. It transfers no
private key or plaintext epoch key.

Verify that this is the intended owner's browser. Stop `npm run peer` or `npm run assistant` if it is
already running, then copy the exact command shown in the page:

```sh
npm run enroll -- BROWSER_PUBLIC_KEY_FROM_THE_PAGE
npm run peer # Or restart npm run assistant when using MCP access.
```

Enrollment uses the current native coordinator's complete retained prefix,
preserves existing grants and key commitments, explicitly binds the new device
to `info().owner_account_id`, and saves the exact signed control-change request
before sending it. A lost reply retries that saved request. The script refuses
an unexpected coordinator or an existing grant rather than silently selecting
another history or widening device rights.

This first app grants the browser **read and write**, with **no publication,
administration, coordination or recovery authority**. This keeps the first
workflow bounded: keep the native peer running while the browser applies writes.
The native process is a participant in the same Chronolog application, with the
same definition and journal semantics. It is not an additional persistence
service. Add browser coordination/recovery grants deliberately when the app's
availability policy needs them; see [Membership](MEMBERSHIP.md) and
[Peer connections](PEER_CONNECTIONS.md).

Now choose **Connect existing device**. The Worker reopens its original identity,
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
2. **Close connection**, reload, and choose **Connect existing device**. The
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
| `peer_application_unconfigured` | Run the explicit initial configuration; a page handle alone has no application authority. |
| `PEER_NO_SELECTED_GENERATION` | Complete the saved first `create` transition before opening the session. |
| Missing `owner_account_id` | The host lacks this onboarding update. Upgrade it; do not guess an account binding. |
| `APPLICATION_DEVICE_NOT_FOUND`, missing keys or data | Resume from the correct saved device directory/origin. Inspect missing storage; never generate a replacement under an old identity. |
| `BYTES_STORE_IN_USE` or `BROWSER_STORAGE_IN_USE` | Close the other owner of that same device. Native CLI and `npm run peer` cannot share one open writer. |
| Browser is not enrolled | Verify its displayed public key, run the explicit owner-bound enrollment command, then reconnect. Account login and device grants are separate. |
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
npm run assistant
```

Use `assistant` **instead of** `peer`: it runs the same native participant with
the declared `notes`, `addNote` and minimal `note.added` event adapter. Keep it
under the execution environment's process supervisor. The prepare command prints
the real permission-review URL even before claim. Give the owner the ready page
and that URL together; sign-in adopts the prepared application and makes the
permission review available. It does not approve MCP data access automatically.
Use a finite setup-status check if needed, without requiring a chat acknowledgement.
The owner still explicitly enrolls their browser and approves assistant capabilities.
A source ZIP or temporary process is not durable hosting for the native participant.
