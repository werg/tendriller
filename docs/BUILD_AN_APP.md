# Build your first Tendriller application

Start here when given a service domain and asked to build an app. Deliver the working signed page with [verification evidence](AGENT_DELIVERY.md), not a ZIP or disconnected preview. The immutable first-app kit below includes complete event-note and [ordinary SQL inventory](STATE_MODELS.md) starters. The first browser operates without a native participant. Use [capabilities](CAPABILITIES.md) before building plumbing and [session bootstrap](SESSION_BOOTSTRAP.md) for exact ownership/API boundaries.

## 1. Verify the selected service before installing

Use the exact supplied/connector origin, including staging. Never substitute production after an error.

```sh
set -eu
export TENDRILLER_ORIGIN=https://YOUR_SELECTED_SERVICE
export TENDRILLER_PROFILE=events # choose sql for the ordinary relational starter
mkdir shared-notes && cd shared-notes
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
if [ "$TENDRILLER_PROFILE" = sql ]; then cd sql; fi
```

Retain composition, manifest, archive hashes and lockfile. The SDK/runtime/host/tools/authority/session and served starter must belong to that composition. The [source-only archive](/downloads/tendriller-first-app.tgz) is useful for inspection, not proof of a complete release. A missing release requires operator publication/qualification, not guessed pins. The SQL kit selects `session-sql-browser` and carries the exact qualified browser engine graph. It contains no application native SQL binary; the events kit does not execute SQL. `sql/init` verifies/copies only its four package-public WASM assets, rejects a different retained graph, and needs no separate download or native process.

## 3. Create for the actual owner and retain the original intent

### Account-linked MCP

```sh
npm run setup:prepare -- "$TENDRILLER_ORIGIN" "YOUR_APP_NAME"
```

This saves the private intent before printing **public** `prepare.arguments`. Call `prepare_tendril_setup` through the same account-linked connector with those exact arguments. The host derives the verified owner. Save the exact public ready result as `.tendriller/account-setup-result.json`, then:

```sh
npm run setup:finish -- .tendriller/account-setup-result.json
```

After a lost reply, use `inspect_tendril_setup` with the original operation ID. Never mint another intent, copy an OAuth token into the project, or replace a lost private credential from a public result. A missing tool/scope is a deployment/consent prerequisite. See [MCP route](MCP_AGENT_GUIDE.md).

### Domain-only route

Use the intended owner's actual verified login email, not the agent's identity:

```sh
npm run create -- "$TENDRILLER_ORIGIN" owner@example.com "YOUR_APP_NAME"
```

Both routes retain a private `.tendriller/handle.json`. Never publish the project root, `.tendriller/`, a signing identity or epoch keys. Resume retained records rather than resetting state.

## 4. Choose policy, prepare and publish before owner sign-in

The default is complete no-finality operation: local durability and provisional reads have no provider dependency.

```sh
npm run init
npm run deploy
```

`init` creates only an **independent publication signer**, saves `HostAppConfig`, and prepares the host's publisher policy. It does not create a native data device, choose an application order, freeze SQL schema, or need the first browser's public key. `deploy` builds the complete `page/` graph and signs an immutable publication using that publisher. Signed publication attempts are retained before sending and retried exactly after uncertain replies.

An explicitly selected browser signed-frontier policy can be prepared with `npm run init -- --browser-finalizer` on a new app. It grants the first browser a separate finalizer right. Configured policy is not demonstrated provider availability: exercise the browser's explicit frontier action and actual operation facts before claiming finality. Closing time may exclude genuinely offline work first seen behind it; never silently retimestamp it. Fixed-validator quorum configuration needs its actual authenticated validators/votes. Ordinary Save stays available when a provider is absent. No-finality waits fail as unsupported rather than manufacturing success.

For the selected SQL kit, the same commands run from `sql/`. Its manifest is computed from the kit's verified package-public WASM graph without supplemental acquisition, a native addon or native data process. Tables are created later by an ordinary browser transaction. See [state models](STATE_MODELS.md).

## 5. Give the ready page URL to the person

Do not wait for a “claimed” reply. The owner opens the already-published page and completes their own sign-in. The browser proves its signing key; first initialization atomically binds the descriptor root and initial signed membership to that key and its epoch-key commitment. The actual key was durably saved **locally before the proof**. A lost reply resumes the original local key/intent, never replacement keys.

The host stores signed control metadata and immutable code. It never receives plaintext epoch keys or application programs as a backend. A native process is optional.

## 6. Verify local use, offline readiness, and another device

- Save a real note; inspect **stored locally**, **materialized locally (revisable)**, **retained by peers**, **finalized**, and **excluded** independently.
- Save the complete signed graph using **Save complete app for offline use**. Only the service-worker acknowledgment establishes `offlineReady`; a loaded page or installed adapter does not.
- Disconnect the device, reload, edit/create/delete and inspect its original operations. Save depends on local key/storage readiness, not peers, a current global read, an agent or finalizer.
- Open a fresh browser profile/device and sign in. It must initially remain keyless. Create its public provisioning request, review its fingerprint on an existing authorized device, grant exact independent rights, wrap keys to that recipient, and import the package there. The agreement private key never leaves its owner.
- Confirm the two devices automatically union operations and derive the same state. Check authenticated peer retention separately from current execution. SQL privileges need explicit ordinary permission transactions in addition to crypto writing.
- Submit late earlier work and observe rederived rows/counts/details/outcomes while unsent drafts, focus and deep links survive. A changed/missing query must label the previous snapshot not current without clearing local input.

## 7. Finish with evidence and honest lifetime

Give the ready page URL, publication ID/receipt, tested devices/viewports, stored/materialized and cross-device observations, offline reload evidence, and any remaining limitation. Name actual browser/optional process lifetimes and exact resume instructions. Browser residency/MCP does not establish future wake of an existing conversation. Use the [desktop/320px flow matrix](AGENT_DELIVERY.md#the-user-experience-is-part-of-the-deliverable), not only transport tests. Production deployment is a separate action.
