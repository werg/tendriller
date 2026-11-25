# Build your first Tendriller application

Start here when given a service domain and asked to build an app. Deliver the working signed page with [verification evidence](AGENT_DELIVERY.md), not a ZIP or disconnected preview. The immutable first-app kit below includes complete event-note and [ordinary SQL inventory](STATE_MODELS.md) starters. The first browser operates without a native participant or the agent program. One **agent** (one `ta_` credential and one signing key) maintains many pages from one workspace; see [multi-page agents](MULTI_PAGE_AGENTS.md). Use [capabilities](CAPABILITIES.md) before building plumbing and [session bootstrap](SESSION_BOOTSTRAP.md) for exact ownership/API boundaries.

**Several pages, one agent.** The kit is a workspace: one agent credential and one signing key serve every page you create, and a single page is a workspace with one page. A `404` `not_found` (`No such granted page`) from `/api/agent/pages/<id>/...` means the agent holds no grant for that page or the page is gone; restoring a credential cannot recreate it. Confirm the service origin and ask the owner to grant the page, or create a new page. Do not treat an uncertain request or ordinary access failure as a confirmed deletion.

To test an app against a release before touching production, use the [local release host](LOCAL_HOST.md). It provides a verified host and synthetic test owner for the same create, init, publish and connect flow below.

## Requests to the existing agent conversation

If the app must reach this same Codex or ChatGPT conversation during work or
after its current turn ends, qualify that route during setup with
[same-conversation delivery](CONVERSATION_DELIVERY.md) (`tendril_guide`,
`topic: "conversation"`). The workspace program owns page sessions; a request
worker and the host's conversation receiver have separate lifetimes.
Advertise only the active worker's handled topics, and keep requests pending
when its route is unavailable. For Codex, verify that a request arriving during
a running turn is injected into that active turn, then test idle wake and a
second request after the answering turn ends. Plain `codex queue` waits for
the current turn to finish; the receiver needs the verified steering route
for active delivery. A running page owner or printed event establishes neither.

## The route and its checkpoints

| Step | Do this | Evidence that it worked |
| --- | --- | --- |
| Discover | Read the host's `/api/service`, this guide and the supplied starter | Host contract, release and limits are known |
| Register and create | Register the workspace agent once, then create the page; keep preparing | An agent credential, a page ID and stable application ID |
| Define state and policy | Declare commands/queries; choose finality (default `none`) | Domain and policy are retained in the page source |
| Build and publish | `npm run init -- <slug>`, then `npm run deploy -- <slug>` | A receipt and selected immutable release ready for the owner's first signed-in visit |
| Owner sign-in | Give the person the already-published page URL | Existing code retained; no new publication needed |
| Initialize locally | The browser's own key proof initializes root, membership and local keys | The session opens and reads a coherent empty view with no native process |
| Verify | Save, reload offline, add a second device, inspect operation facts | Retained data, convergent replicas and the same operation identities survive reopening |

The owner sign-in and device-key proof are real authority boundaries. Prepare the code and exact commands before asking for them. A missing grant or package is a setup issue to diagnose, not a reason to silently substitute another persistence service.

## 1. Verify the selected service before installing

Use the exact supplied/connector origin, including staging. Never substitute production after an error.

```sh
set -eu
export TENDRILLER_ORIGIN=https://YOUR_SELECTED_SERVICE
export TENDRILLER_PROFILE=events # choose sql for the ordinary relational starter
mkdir my-pages && cd my-pages
curl --fail --show-error --silent "$TENDRILLER_ORIGIN/api/readiness" -o readiness.json
curl --fail --show-error --silent "$TENDRILLER_ORIGIN/api/service" -o service.json
curl --fail --show-error --silent "$TENDRILLER_ORIGIN/.well-known/tendriller.json" -o onboarding.json
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read = name => JSON.parse(readFileSync(name));
const r = read('readiness.json'), s = read('service.json'), o = read('onboarding.json');
assert.equal(new URL(process.env.TENDRILLER_ORIGIN).origin, process.env.TENDRILLER_ORIGIN);
assert.equal(r.schemaVersion, 1); assert.equal(r.serviceOrigin, process.env.TENDRILLER_ORIGIN);
assert.equal(r.mode, 'open', r.creation?.nextAction); assert.equal(r.creation?.available, true);
assert.equal(s.contract, 3); assert.equal(s.core_release, r.build.coreRelease);
assert.match(r.build.sourceCommit, /^[a-f0-9]{40}$/); assert.match(r.build.compositionId, /^[a-f0-9]{64}$/);
const base = 'https://github.com/werg/tendriller/releases/download/source-' + r.build.sourceCommit;
assert.equal(o.firstApp.release.manifest, base + '/manifest.json');
assert.equal(o.firstApp.release.archive, base + '/tendriller-first-app-' + s.core_release + '.tgz');
assert.equal(o.firstApp.release.sqlArchive, base + '/tendriller-first-app-sql-' + s.core_release + '.tgz');
assert.ok(['events','sql'].includes(process.env.TENDRILLER_PROFILE));
JS
```

These descriptor requests do not follow redirects. Pause, unavailable/unsupported readiness, malformed metadata, missing artifacts or a mismatched origin stops setup. Report the returned next action. Readiness is advisory; allocation checks it again. See [troubleshooting](TROUBLESHOOTING.md).

## 2. Install one immutable public composition

Use Node 24 for the supplied tooling, npm, tar and a SHA-256 checker. No private kernel imports or second repository checkout is required. Choose `events` or `sql` **before installing**. Download its advertised `firstApp.release.archive` or `sqlArchive`; both are complete exact kits, not a mutable starter paired with a guessed supplemental engine.

```sh
RELEASE=$(node -p "JSON.parse(require('fs').readFileSync('service.json')).core_release")
RELEASE_URL=$(node -p "JSON.parse(require('fs').readFileSync('onboarding.json')).firstApp.release.manifest.slice(0,-'/manifest.json'.length)")
KIT_URL=$(node -p "const x=JSON.parse(require('fs').readFileSync('onboarding.json')).firstApp.release; process.env.TENDRILLER_PROFILE==='sql'?x.sqlArchive:x.archive")
KIT_FILE=$(node -p "new URL('$KIT_URL').pathname.split('/').at(-1)")
export KIT_FILE
mkdir artifacts
for file in "$KIT_FILE" manifest.json SHA256SUMS; do
  curl --fail --show-error --location "$RELEASE_URL/$file" -o "artifacts/$file"
done
(cd artifacts && sha256sum --ignore-missing --check SHA256SUMS)
tar -xzf "artifacts/$KIT_FILE"
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const read = name => JSON.parse(readFileSync(name));
const c = read('composition.json'), r = read('readiness.json'), m = read('artifacts/manifest.json');
const {id,...body} = c;
assert.equal(createHash('sha256').update(JSON.stringify(body)).digest('hex'), id);
assert.equal(id, m.composition.id); assert.equal(id, r.build.compositionId);
assert.equal(c.core.source, r.build.sourceCommit); assert.equal(c.core.dirty, false);
assert.equal(c.runtime, r.build.runtimeId); assert.equal(c.version, r.build.coreRelease);
const selected = read('first-app-profile.json');
assert.equal(selected.profile, process.env.TENDRILLER_PROFILE);
assert.deepEqual({session:selected.session,packages:selected.packages}, c.profiles[selected.profile]);
const kit = selected.profile === 'sql' ? m.first_apps.sql : m.first_app;
assert.equal(kit.file, process.env.KIT_FILE); assert.deepEqual(kit.packages, selected.packages);
const kitRecord = m.artifacts.find(item => item.file === kit.file);
assert.equal(createHash('sha256').update(readFileSync('artifacts/' + kit.file)).digest('hex'), kitRecord.sha256);
for (const role of selected.packages) {
  const item = c.components.find(item => item.role === role);
  assert.ok(item, 'Missing public component ' + role);
  assert.equal(createHash('sha256').update(readFileSync('packages/' + item.file)).digest('hex'), item.sha256);
}
JS
(cd packages && sha256sum --check SHA256SUMS)
AUTHORITY_ARCHIVE=$(node -p "JSON.parse(require('fs').readFileSync('composition.json')).components.find(x=>x.role==='authority').file")
SESSION_ARCHIVE=$(node -p "const fs=require('fs'); const p=JSON.parse(fs.readFileSync('first-app-profile.json')); JSON.parse(fs.readFileSync('composition.json')).components.find(x=>x.role===p.session).file")
npm install --ignore-scripts --save-exact \
  "./packages/tendriller-sdk-$RELEASE.tgz" "./packages/tendriller-tools-$RELEASE.tgz" \
  "./packages/$AUTHORITY_ARCHIVE" "./packages/$SESSION_ARCHIVE"
npm install --save-dev --save-exact esbuild@0.28.2
```

Retain composition, manifest, archive hashes and lockfile. The SDK/runtime/host/tools/authority/session and served starter must belong to that composition. The [source-only archive](/downloads/tendriller-first-app.tgz) is useful for inspection, not proof of a complete release. A missing release requires operator publication/qualification, not guessed pins. The SQL kit selects `session-sql-browser` and carries the exact qualified browser engine graph. It contains no application native SQL binary; the events kit does not execute SQL. `sql/init` verifies/copies only its four package-public WASM assets, rejects a different retained graph, and needs no separate download or native process.

## 3. Register the workspace agent and create the page for the intended owner

The kit is an **agent workspace**: one agent credential and one signing key for any number of pages, one install, and `pages/<slug>/` source per page. Register the agent once per workspace, choosing the route your environment supports. The private workspace (`.tendriller/`) holds the credential and shared signer; `tendriller.json` holds no secret.

### From an account-linked MCP connection

The connector's linked account resolves the owner; no owner email or OAuth access token enters the local project. Create the shared key and print the public arguments:

```sh
npx tendril workspace key --service "$TENDRILLER_ORIGIN" --name notes-agent
```

Call `register_agent` through the **same selected account-linked connector** with exactly the printed arguments (`name`, `publicKey`). Save its result privately as `.tendriller/register-agent-result.json` (never in chat or page assets), then retain it:

```sh
npx tendril workspace adopt --service "$TENDRILLER_ORIGIN" --credential .tendriller/register-agent-result.json
```

`adopt` verifies the token against `GET /api/agent` on that origin before saving `.tendriller/agent/credential.json` and `tendriller.json`. Calling `register_agent` again with the same name rotates the token; adopt the newest result. A missing tool or scope is a deployment/consent prerequisite: keep this origin and key while resolving it. See [MCP route](MCP_AGENT_GUIDE.md).

### From a domain without account-linked creation

Register an unclaimed agent for the intended owner's actual verified login email, not the agent's identity:

```sh
npx tendril workspace init --service "$TENDRILLER_ORIGIN" --owner owner@example.com --name notes-agent
```

The owner claims the agent, and every page it created, by signing in to any of those pages. A signed-in owner can instead create a one-time code under **Dashboard → Your agents → Add agent**; then use `npx tendril workspace join --service "$TENDRILLER_ORIGIN" --code CODE`. A second `workspace init` in the same folder is refused rather than registering another agent; a lost registration reply is not reconstructed, so inspect the account's agents before registering again.

### Create the page

```sh
npm run page:new -- notes --template notes --name "Shared notes"
```

This checks readiness, creates the page with `POST /api/agent/pages` (the creating agent receives a full grant), records `{ "notes": { "id": PAGE_ID } }` in `tendriller.json`, keeps the page URL and `application.id` private in `.tendriller/pages/PAGE_ID/page.json`, and creates `pages/notes/`. `POST /api/agent/pages` accepts a `name`, an optional `mode` (`interactive` or `dashboard`) and an optional explicit `application: {id}` (a stable 32-byte lowercase hex identity) when binding a known application; otherwise the host generates one independent of the page ID. Rerunning it for a registered slug resumes without creating a second page. An existing page needs the owner's explicit grant (the per-agent checkbox on the dashboard or the page's **Add people & devices → An agent**), then `npx tendril page grant <slug> <page-id>`. Agent credentials cannot claim a page for the owner; an unclaimed page expires after 24 hours.

The page has two identities: its hosted ID/URL and `application.id`. The agent token (`ta_…`) is a host credential, not a device signing or data key. Never publish the project root, `.tendriller/`, a signing identity or epoch keys. Resume retained records rather than resetting state.

### Give the app a recognizable favicon

```sh
npx tendril --page notes meta '{"icon":"📝"}'
```

The host converts the emoji to an SVG favicon automatically. An HTTPS image URL also works; `icon: null` restores the default. See [favicons and page branding](BROWSER_API.md#favicons-and-page-branding).

### Continue after a lost credential or device

`.tendriller/agent/` (credential and shared signer), `tendriller.json` and `.tendriller/pages/PAGE_ID/` (publisher identity, descriptor and device store) are the workspace's private state. There is no reissue of a lost key, so keep a way to move it: stop `tendril agent run`, then `tendril checkpoint export FILE` writes all of it as one encrypted file and retires this copy (a move, not a backup); `tendril checkpoint restore FILE` recreates it in an empty folder and verifies every page device against the restored signer. Page source moves separately with `tendril handoff source`. See [the CLI reference](tools/CLI.md#move-a-workspace-with-a-checkpoint). If only the token is lost or revoked, the owner can add the agent again from the dashboard and `workspace join` a fresh folder; a new key also needs explicit signed membership and key provisioning from surviving authorized devices.

## 4. Choose policy, prepare and publish before owner sign-in

The default is complete no-finality operation: local durability and provisional reads have no provider dependency.

```sh
npm run init -- notes
npm run deploy -- notes
```

`init` saves `HostAppConfig` and prepares only the host's publisher policy, using the workspace's one opaque shared signer as the publisher; there is no per-page key. It does not create a device, data root or epoch key, choose an application order, freeze SQL schema, or need the first browser's public key. `deploy` builds the complete `pages/<slug>/dist/` graph and signs an immutable publication with that publisher. Signed publication attempts are retained before sending and retried exactly after uncertain replies.

An explicitly selected browser signed-frontier policy can be prepared with `npm run init -- notes --browser-finalizer` on a new page. It grants the first browser a separate finalizer right. Configured policy is not demonstrated provider availability: exercise the browser's explicit frontier action and actual operation facts before claiming finality. Closing time may exclude genuinely offline work first seen behind it; never silently retimestamp it. Fixed-validator quorum configuration needs its actual authenticated validators/votes. Ordinary Save stays available when a provider is absent. No-finality waits fail as unsupported rather than manufacturing success.

For the selected SQL kit, run the same commands from its workspace (`npm run page:new -- inventory --template inventory`). Its manifest is computed from the kit's verified package-public WASM graph without supplemental acquisition, a native addon or native data process. Tables are created later by an ordinary browser transaction. See [state models](STATE_MODELS.md).

## 5. Give the ready page URL to the person

Do not wait for a “claimed” reply. The owner opens the already-published page and completes their own sign-in. The browser proves its signing key; first initialization atomically binds the descriptor root and initial signed membership to that key and its epoch-key commitment. The actual key was durably saved **locally before the proof**. A lost reply resumes the original local key/intent, never replacement keys.

The host stores signed control metadata and immutable code. It never receives plaintext epoch keys or application programs as a backend. The agent program (`npm run agent`, one hub connection and one session per initialized page) and any native process are optional; start one only when the application needs native coordination, private APIs or an assistant adapter, and report its actual lifetime. The program opens a page only after the starter's explicit native `sign-enrollment`, `provisioning-request` and `import-provisioning` steps have joined the shared signer to that page: the owner's browser proves and reviews the key and wraps the epoch keys to that recipient, and `initialized.json` is written only after the reader grant and current epoch key are verified. `init` alone never creates it.

## 6. Verify local use, offline readiness, and another device

- Save a real note; inspect **stored locally**, **materialized locally (revisable)**, **retained by peers**, **finalized**, and **excluded** independently.
- Save the complete signed graph using **Save complete app for offline use**. Only the service-worker acknowledgment establishes `offlineReady`; a loaded page or installed adapter does not.
- Disconnect the device, reload, edit/create/delete and inspect its original operations. Save depends on local key/storage readiness, not peers, a current global read, an agent or finalizer.
- Open a fresh browser profile/device and sign in. It must initially remain keyless. Create its public provisioning request, review its fingerprint on an existing authorized device, grant exact independent rights, wrap keys to that recipient, and import the package there. The agreement private key never leaves its owner.
- Confirm the two devices automatically union operations and derive the same state. Check authenticated peer retention separately from current execution. SQL privileges need explicit ordinary permission transactions in addition to crypto writing.
- Submit late earlier work and observe rederived rows/counts/details/outcomes while unsent drafts, focus and deep links survive. A changed/missing query must label the previous snapshot not current without clearing local input.

## 7. Finish with evidence and honest lifetime

Give the ready page URL, publication ID/receipt, tested devices/viewports, stored/materialized and cross-device observations, offline reload evidence, and any remaining limitation. Name actual browser/optional process lifetimes and exact resume instructions. Browser residency/MCP does not establish future wake of an existing conversation. Use the [desktop/320px flow matrix](AGENT_DELIVERY.md#the-user-experience-is-part-of-the-deliverable), not only transport tests. Production deployment is a separate action.

## When a step fails

| Observation | Meaning and next action |
| --- | --- |
| Create is unavailable or contract mismatches | Read `/api/service` and the error; use a compatible host/package pair. Preserve the requested platform and report the actual blocker. |
| `forbidden` during configuration or publication | Check that the agent holds a grant for this page with the needed scopes, and that the shared signer holds an explicit publisher right. Claim is not a prerequisite. |
| Agent `revoked` or the hub reports `replaced` | The owner revoked the agent, or another agent program runs for the same credential. Stop duplicates; a revoked agent needs the owner to add it again. Preserve the signer and page records. |
| `peer_application_unconfigured` | Run `npm run init -- <slug>`; a created page alone has no application authority. |
| `APPLICATION_DEVICE_NOT_FOUND`, missing keys or data | Resume from the correct saved device directory/origin. Inspect missing storage; never generate a replacement under an old identity. |
| `BYTES_STORE_IN_USE` or `BROWSER_STORAGE_IN_USE` | Close the other owner of that same device. CLI commands attach to the running agent program; only one agent program may own a workspace. |
| `awaiting-keys`, connecting, or locally saved work | The device lacks epoch keys until explicit authenticated provisioning. Keep local work; an authorized device reviews the recipient request. Never paste an epoch key into the page. |
| Stale publication or control transition | Inspect the selected head and saved request. Retry exact uncertain work; review a fresh change after a conflict. |
| An operation is excluded or its outcome changed | A late earlier operation or a closed-time frontier revised it. Inspect the original signed intent; the person reviews and submits a new operation if the intent is still wanted. |

For exact API composition and ownership rules, continue to [Session bootstrap](SESSION_BOOTSTRAP.md). For command syntax, use [CLI](tools/CLI.md), `tendril --help`, and `tendril guide --server YOUR_ORIGIN`; see [troubleshooting](TROUBLESHOOTING.md).

## Optional assistant access

After the application works, `@tendriller/core/assistant` can expose selected queries, commands and events to an assistant. Prepare it with the page's retained workspace (`npm run assistant:prepare -- <slug>`, with `--events` for optional event forwarding) and keep `npm run agent` running so the page's adapter connects after the owner's explicit permission review. The prepare command prints the real review URL even before claim; give the owner the ready page and that URL together. Sign-in adopts the prepared application but never approves assistant data access automatically. Missing consent, adapter timeouts, revocation or replacement stop only the optional adapter; they never stop the agent program or ordinary browser Save. Verify a real round trip before claiming a connection, and see [Connect any application](CLOUDFLARE_ASSISTANT.md#enroll-an-application) and [ChatGPT setup](CHATGPT_INTEGRATION.md#agent-walkthrough). A source ZIP or temporary process is not durable hosting for the agent program.
