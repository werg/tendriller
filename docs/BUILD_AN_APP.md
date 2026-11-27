# Build your first Tendriller application

Start here when given a service domain and asked to build an app. Deliver the working signed page with [verification evidence](AGENT_DELIVERY.md), not a ZIP or disconnected preview. The immutable first-app kit below includes complete event-note (`notes`), [ordinary SQL inventory](STATE_MODELS.md) (`inventory`), and [WebRTC video/audio call](WEBRTC_MEDIA.md) (`call`) starters. An admitted browser operates without a native participant or the agent program; the running agent program admits new browsers. One **agent** (one `ta_` credential, one signing key and one wrap key) maintains many pages from one workspace; see [multi-page agents](MULTI_PAGE_AGENTS.md). Use [capabilities](CAPABILITIES.md) before building plumbing and [session bootstrap](SESSION_BOOTSTRAP.md) for exact ownership/API boundaries.

**Several pages, one agent.** The kit is a workspace: one agent credential and one signing key serve every page you create, and a single page is a workspace with one page. A `404` `not_found` (`No such granted page`) from `/api/agent/pages/<id>/...` means the agent holds no grant for that page or the page is gone; restoring a credential cannot recreate it. Confirm the service origin and ask the owner to grant the page, or create a new page. Do not treat an uncertain request or ordinary access failure as a confirmed deletion.

To test an app against a release before touching production, use the [local release host](LOCAL_HOST.md). It provides a verified host and synthetic test owner for the same create, init, publish and connect flow below.

**Returning to an older or fallow workspace?** Before editing or redeploying an existing workspace, run `tendril status` (check its `catchup` and `broadcasts` fields) and pull the [platform changelog](CHANGELOG.md) via `tendril changelog --since YYYY-MM-DD` (or `/changelog.md` / `/api/changelog`) to catch any security advisories, upcoming sunsets, breaking upgrades, or new built-in capabilities landed while the repo was idle.

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
| Create keys and publish | `npm run init -- <slug>`, then `npm run deploy -- <slug>` | The agent holds the page's genesis and first epoch key (`initialized.json`); a receipt and selected immutable release ready for the owner's first signed-in visit |
| Owner sign-in | Give the person the already-published page URL | Existing code retained; no new publication needed |
| Admit the browser | With `npm run agent` running, the agent admits the owner's attested browser and wraps its keys | **Devices and access** lists the browser; the session reads a coherent view |
| Verify | Save, reload offline, add a second device, inspect operation facts | Retained data, convergent replicas and the same operation identities survive reopening |

The owner sign-in and member-signed admission are real authority boundaries. Prepare the code and exact commands before asking for them. A missing grant or package is a setup issue to diagnose, not a reason to silently substitute another persistence service.

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

**Upgrading an existing workspace to a newer release composition:** Never copy newer archives over `packages/` and run `npm install --package-lock-only` in place — when two releases share the same semver filename (`0.3.0-rc.17`), npm retains the old lockfile's integrity hashes and silently installs stale packages. Instead run:

```sh
npx tendril workspace upgrade --kit artifacts/"$KIT_FILE"
```

This verifies `composition.json` and every archive SHA-256, updates only kit files (preserving `.tendriller/`, `tendriller.json`, and `pages/`), regenerates `package-lock.json` in a clean directory against the new archives, runs `npm ci --ignore-scripts`, and fails closed if any lockfile integrity or installed package disagrees with the selected immutable composition ID. Run `npx tendril workspace verify` at any time to check an existing workspace; `tendril status` also compares immutable `compositionId` and `sourceCommit` against the host.

## 3. Register the workspace agent and create the page for the intended owner

The kit is an **agent workspace**: one agent credential, one signing key and one wrap key for any number of pages, one install, and `pages/<slug>/` source per page. Register the agent once per workspace, choosing the route your environment supports. The private workspace (`.tendriller/`) holds the credential, shared signer and wrap key; `tendriller.json` holds no secret.

### From an account-linked MCP connection

The connector's linked account resolves the owner; no owner email or OAuth access token enters the local project. Create the shared keys and print the public arguments:

```sh
npx tendril workspace key --service "$TENDRILLER_ORIGIN" --handle notes-agent
```

Call `register_agent` through the **same selected account-linked connector** with exactly the printed arguments (`handle`, `bio`, `publicKey`, `wrapKey`). Save its result privately as `.tendriller/register-agent-result.json` (never in chat or page assets), then retain it:

```sh
npx tendril workspace adopt --service "$TENDRILLER_ORIGIN" --credential .tendriller/register-agent-result.json
```

`adopt` verifies the token against `GET /api/agent` on that origin before saving `.tendriller/agent/credential.json` and `tendriller.json`. Calling `register_agent` again with the same name rotates the token; adopt the newest result. A missing tool or scope is a deployment/consent prerequisite: keep this origin and key while resolving it. See [MCP route](MCP_AGENT_GUIDE.md).

### From a domain without account-linked creation

Register an unclaimed agent for the intended owner's actual verified login email, not the agent's identity:

```sh
npx tendril workspace init --service "$TENDRILLER_ORIGIN" --owner owner@example.com --handle atlas --bio "Notes builder"
```

The owner claims the agent, and every page it created, by signing in to any of those pages. A signed-in owner can instead create a one-time code under **Dashboard → Your agents → Add agent**; then use `npx tendril workspace join --service "$TENDRILLER_ORIGIN" --code CODE --handle atlas`. A second `workspace init` in the same folder is refused rather than registering another agent; a lost registration reply is not reconstructed, so inspect the account's agents before registering again.

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

`.tendriller/agent/` (credential, shared signer and wrap key), `tendriller.json` and `.tendriller/pages/PAGE_ID/` (descriptor, device store and page keys) are the workspace's private state. There is no reissue of a lost key, so keep a way to move it: stop `tendril agent run`, then `tendril checkpoint export FILE` writes all of it as one encrypted file and retires this copy (a move, not a backup); `tendril checkpoint restore FILE` recreates it in an empty folder and verifies every page device against the restored signer. Page source moves separately with `tendril handoff source`. See [the CLI reference](tools/CLI.md#move-a-workspace-with-a-checkpoint). If only the token is lost or revoked, the owner can add the agent again from the dashboard and `workspace join` a fresh folder; a new key is admitted like any other agent from its signed host grant, by a surviving member.

## 4. Choose policy, create the page keys and publish before owner sign-in

The default is complete no-finality operation: local durability and provisional reads have no provider dependency.

```sh
npm run init -- notes
npm run deploy -- notes
```

`init` saves `HostAppConfig`, prepares the host's publisher policy (the workspace's one opaque shared signer is the publisher; there is no per-page key) and creates the page data as its **creator**: it signs the descriptor, genesis membership (the agent alone, as administrator, pinning the owner account and the host attestation key in the admission policy) and first epoch key into the agent's own page store, then writes `initialized.json`. It does not choose an application order or freeze SQL schema. `deploy` builds the complete `pages/<slug>/dist/` graph and signs an immutable publication with that publisher. Signed publication and genesis attempts are retained before sending and retried exactly after uncertain replies. With the keys in hand, the agent can import data through an attached session (`npx tendril command … --page <slug>` while `npm run agent` runs) before the owner ever signs in.

`npm run init -- notes --browser-first` leaves creation to the owner's first browser instead: no data exists until they sign in, and the agent is admitted later from its signed host grant.

An explicitly selected browser signed-frontier policy can be prepared with `npm run init -- notes --browser-finalizer` on a new page. It implies `--browser-first`: the first browser creates the page and holds the separate finalizer right. Configured policy is not demonstrated provider availability: exercise the browser's explicit frontier action and actual operation facts before claiming finality. Closing time may exclude genuinely offline work first seen behind it; never silently retimestamp it. Fixed-validator quorum configuration needs its actual authenticated validators/votes. Ordinary Save stays available when a provider is absent. No-finality waits fail as unsupported rather than manufacturing success.

For the selected SQL kit, run the same commands from its workspace (`npm run page:new -- inventory --template inventory`). Its manifest is computed from the kit's verified package-public WASM graph without supplemental acquisition, a native addon or native data process. Tables are created later by an ordinary browser transaction. See [state models](STATE_MODELS.md).

### Live stage updates & dedicated per-participant UIs (facets)

Pages that keep long-lived browser state (such as `templates/call/` with active WebRTC video/audio) or expose different dedicated views for different people, roles, or devices over the same Chronolog data can use `tendril.publication.mountFacets` / `mountSlot`:

1. Keep domain data in Chronolog commands/queries and high-frequency previews in signals or `app:*` DataChannels—never publish code just to update data.
2. When you *do* want to update a visualization, whiteboard, or companion view live without reloading the shell, edit `facets/stage.mjs` (or add `facets/<name>.mjs` and list it in `facets.json`) and run `npm run deploy -- <slug>`.
3. Because `build.mjs` bundles each facet standalone (`splitting: false`), only the changed facet's SHA-256 changes; open tabs hot-swap it live inside Shadow DOM (preserving media tracks and `ctx.slotState`) and expose shareable `?view=<id>` URLs over the exact same Chronolog state.
4. For role-, device-, or participant-specific views over one Chronolog session, add `roles` and `defaultFor` rules in `facets.json` (e.g. `role:display`, `role:guest+form:phone`, `participant:<id>`, `device:<id>`), optionally pick a **Target view** when creating invite or page-only links (`POST _tendril/links` `view`), and plug `shared/helpers/view-bindings.mjs` (`createViewBindingSource`) into `mountFacets(..., { bindings })` for live remotely-changeable view assignments. See [URL-addressable facets & hot-swappable slots](APP_PATTERNS.md#url-addressable-facets--hot-swappable-slots) and [Dedicated UIs per participant, role, or device](APP_PATTERNS.md#dedicated-uis-per-participant-role-or-device-facets).

For on-device speech recognition in page code, load `const { bindDictation, transcribeAudio } = await window.tendril.loadVoice()` rather than bundling a second WASM model; it shares the tab's verified Cactus Whistle worker and captures 16 kHz PCM directly via `AudioWorklet`. See [voice & hands-free](HANDS_FREE.md).

For third-party service integrations (GitHub, Google, Linear, Notion, Slack, Spotify, Strava, etc., or BYO OAuth 2.1) and GitHub/Google org or team page admission, discuss the Tier A (`agent-held`, zero-trust) vs. Tier B (`host-brokered`, wrapped `K_conn` with `personal` or `page` custody) trade-offs with the user in chat and configure the chosen tier via API or `tendril connection connect` / `tendril page group`. See [outbound OAuth & org tie-ins](OAUTH_CONNECTIONS.md).

## 5. Give the ready page URL to the person

Do not wait for a “claimed” reply. Start `npm run agent` and keep it running, then give the owner the page URL. They open the already-published page and complete their own sign-in. The browser creates its device key and wrap key, and the host attests them for the owner account. The agent (or any other online member) verifies that attestation against the signed admission policy, appends the browser to membership and wraps the epoch keys to it. Until then the page shows that it is waiting and retries; nothing needs pasting. On a `--browser-first` page the first browser creates the genesis itself and its key is saved **locally before sending**; a lost reply resends the same genesis, never replacement keys.

The host stores signed control metadata, attestations, key wraps and immutable code. It never signs membership and never receives plaintext epoch keys or application programs. The agent program (`npm run agent`, one hub connection and one session per initialized page) admits new devices and keeps keys wrapped; it is not needed for an admitted browser's reads and Save. Report its actual lifetime. The page's **Devices and access** view (`shared/helpers/devices-view.mjs`) lists every member with an **Admin** badge for administrators (owner-account devices are administrators by default), shows **New device signed in** notices and lets an administrator Remove a device (rotating the key), switch strict mode, approve waiting devices and create or revoke invites; the CLI offers the same actions (`tendril page devices|approve|remove-device|mode|owner-grant|invite|revoke-invite`).

## 6. Verify local use, offline readiness, and another device

- Save a real note; inspect **stored locally**, **materialized locally (revisable)**, **retained by peers**, **finalized**, and **excluded** independently.
- Save the complete signed graph using **Save complete app for offline use**. Only the service-worker acknowledgment establishes `offlineReady`; a loaded page or installed adapter does not.
- Disconnect the device, reload, edit/create/delete and inspect its original operations. Save depends on local key/storage readiness, not peers, a current global read, an agent or finalizer.
- Open a fresh browser profile/device and sign in. It waits (`waiting-admission`) until a member is online, then is admitted and receives its keys; the first device sees a **New device signed in** notice. Remove it from the first device and confirm it stops receiving new changes (`removed`) while the others continue under the rotated key. Optionally switch strict mode and Approve a device, or redeem an invite in another account.
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
| `waiting-admission`, `waiting-approval` or `waiting-keys` | No member holding the keys is online, the page is in strict mode, or the keys are not wrapped yet. Keep the page open and start `npm run agent` (or open an admitted device); in strict mode an administrator approves it. Never paste an epoch key into the page. |
| `PAGE_UNINITIALIZED` | The creator has not created the page data. Run `npm run init -- <slug>` (or, on a browser-first page, the owner opens it). |
| Stale publication or control transition | Inspect the selected head and saved request. Retry exact uncertain work; review a fresh change after a conflict. |
| An operation is excluded or its outcome changed | A late earlier operation or a closed-time frontier revised it. Inspect the original signed intent; the person reviews and submits a new operation if the intent is still wanted. |

For exact API composition and ownership rules, continue to [Session bootstrap](SESSION_BOOTSTRAP.md). For command syntax, use [CLI](tools/CLI.md), `tendril --help`, and `tendril guide --server YOUR_ORIGIN`; see [troubleshooting](TROUBLESHOOTING.md).

## Optional hosted MCP access

After the application works, the page owner can opt into the hosted Chronolog MCP participant at `/connections` (or `_tendril/mcp/connect`). The browser generates a dedicated signing key, admits it in `$permissions` / `$keys`, and seals the signing and epoch keys to the OAuth grant's X25519 `wrap_public_key`. Zero plaintext keys are stored at rest; the OAuth Bearer token unseals them strictly in RAM per `/mcp` request and runs the page's hash-pinned in-chain `$reducers` ES Modules inside QuickJS-NG WASM (with built-in `sqlite-cas.wasm` + `chronolog/sql` for SQL topics, zero separate `domain.js` bundle). See [Hosted MCP](CLOUDFLARE_ASSISTANT.md) and [ChatGPT setup](CHATGPT_INTEGRATION.md).
