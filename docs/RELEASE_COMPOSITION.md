# Qualify a three-repository release

Tendriller hosts the page and its controls. Chronolog owns the application session, the authored operation set, and peer replication. The cookbook repository supplies independent examples and black-box qualification. Each repository's CI tests only that repository. A green check in any one repository does not prove that three new commits work together.

## Choose exact source

Choose one full 40-character commit SHA from each repository: [core](https://github.com/werg/tendriller), [Chronolog](https://github.com/werg/chronolog-db), and [cookbooks](https://github.com/werg/tendriller-contrib). Record all three before building. Use a clean checkout; local edits cannot be reproduced by a commit SHA.

## Run local checks

| Repository | Minimum local gate |
| --- | --- |
| Core | `npm ci && npm run check:release` |
| Chronolog | `pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm docs:check` |
| Cookbooks | `npm ci && npm run check && npm run build` |

Core consumes Chronolog through the exact public archive pinned in `package.json`;
core's own browser, native-owner and staging gates exercise that combination.
Neither Chronolog nor the cookbook repository checks out or pins core.

## Prepare and qualify the first-app release

From a clean core checkpoint, run `npm run build:artifacts` and
`npm run release:artifacts`. Release preparation rejects dirty or stale core,
engine and tools provenance, mismatched versions/contracts/runtime identities,
missing public exports, altered runtime bytes and a stale served starter. It
reads the pinned public Chronolog archive from `package.json`; it does not
substitute a registry package or rebuild a moving companion branch.

`dist/composition.json` has a content-derived identity over these exact inputs:

| Component | Bound evidence |
| --- | --- |
| SDK, runtime, engine and tools | Archive SHA-256 and size, core source commit/tree, clean provenance, contract and runtime ID |
| First-app source | Allowlisted starter archive SHA-256 and size, checked byte-for-byte against this core checkpoint |
| Chronolog session | Public archive SHA-256 and size, full source commit/tree, clean events profile |
| Chronolog authority | Portable authority/publication/finality package (`chronolog-authority-package/v1`, profile `chronolog-crdt-v1`) with full source commit/tree and clean provenance, also embedded and verified inside the hashed engine archive |

The versioned `tendriller-first-app-VERSION.tgz` contains that starter,
`composition.json` and local SDK, tools, authority and session packages. `manifest.json` binds
the kit's own bytes, the separate composition file and build provenance. Its
composition ID does not include the kit hash, avoiding a self-referential archive.
`SHA256SUMS` covers every published component. Preserve the whole manifest and
all referenced artifacts when transferring a candidate between jobs.

Run the exact kit through the independent consumer:

```sh
npm run test:first-app -- --first-app-archive /absolute/tendriller-first-app-VERSION.tgz
```

This uses the packed engine, verifies the kit against the release manifest,
compares its source with the actual served starter, installs the bundled public
archives in a separate empty-cache consumer, and exercises native and Chromium
behavior. The Public service workflow requires this gate on its retained
artifact graph before publication and retains `.results/first-app.json`. The
SQL onboarding job consumes the same graph with its separately pinned engine.
`--native-only` is an explicitly partial local
check and does not satisfy that workflow's full browser gate. Generating a
composition is not itself qualification; assess the recorded checks and limits.

Release uploads verify exact tag/source identity and existing asset bytes before
uploading anything. They never move tags or overwrite differing same-name
assets, and publish `manifest.json` last. Trusted master publishes under
`source-<full commit SHA>`; package versions do not select the release graph.
Each source checkpoint gets its own immutable manifest and deployment bundle,
including workflow or documentation changes without a package-version bump.
Discovery embeds that exact source-tagged manifest and kit URL. The original
version-tagged releases remain untouched. Both environments restore the sealed
bundle and deploy the packaged Worker without bundling; staging acceptance and
MCP qualification gate production.
CI can produce candidates on a development branch without publishing or deploying.

The scripted local kit check does not establish live OAuth, selected ChatGPT
connector approval or calls, Internet/native RTC, mobile behavior, persistent
process hosting, or an unaided fresh-agent journey. Keep those operator and
cold-start gates alongside the exact source and archive evidence.

## Stage the host

Build and deploy the selected core commit to fresh staging storage. Run `node scripts/check-deployment.mjs https://staging.tendriller.dev`; it checks a real Durable Object read as well as public endpoints. Then exercise OAuth return, owner claim, a signed page publication, page reload, and an independent agent/browser exchange. Keep creation paused if the shared Durable Object quota or a required check fails. `STAGING_READY` and `STAGING_STORAGE_SCHEMA` must describe the actual staging deployment before CI may deploy it automatically.

The automatic staging and production jobs take source, composition, release,
runtime, engine and starter identities from the public-artifacts job. Before
any deployment mutation, `check-published-release.mjs` requires the canonical
public release manifest to match the artifact job's SHA-256, then verifies every
referenced artifact, including the exact versioned first-app kit and companion
packages. Missing or different bytes stop deployment. Publish the qualified
immutable release first, then rerun the service workflow against that same
current master commit; a newer source revision requires a new release identity.
Intentional unpublished branch previews use their separate workflow.

The deployment jobs also run `check-deployment-artifacts.mjs`: the checkout must still be
clean, its engine archive and served starter must match the prepared hashes,
and the served runtime bytes must match their manifest. Wrangler then receives
`SERVICE_SOURCE_COMMIT` and `SERVICE_COMPOSITION_ID` as public deployment metadata.
Readiness and MCP discovery report these as `build.sourceCommit` and
`build.compositionId`; an absent or invalid setting is explicitly `null`.

For an attested manual smoke check, pass `--source-commit`, `--composition-id`,
`--core-release` and `--runtime-id` from the selected manifest, along with
`--assistant`. The smoke check rejects missing or mismatched expected identity,
cross-origin readiness, and a tool catalog missing `tendril_guide`, even if a
direct call to that unadvertised tool would succeed. These public metadata fields
identify the operator's checked deployment composition; the post-deployment
check verifies what the service reports, while CI separately verifies local
deployment bytes. Live account linking and selected-connector approval/calls
remain separate acceptance evidence.

Production needs its own fresh storage baseline and explicit cutover. There is no old-state reader or migration path. The release tuple, passing composition artifact, staging evidence, runtime ID, and storage schema should be recorded together before production deployment.

## Browser record backend rollout gate

A passing core release check alone cannot qualify Chronolog's new browser
record backend. Before publishing a compatible release tuple, run the
Chronolog `tools/test-browser-storage.ts` Chromium Worker qualification and
the independent `webrtc.yml` packed-session consumer composition with the
**exact** Tendriller candidate commit. The first creates fresh OPFS and
IndexedDB records, confirms same-signer reopen, detects missing/corrupt records,
checks exclusive lock contention and preserves legacy OPFS identities.
Keep the independent cookbook commit pinned and record each artifact hash.

Only fresh devices may select IndexedDB automatically. Existing devices
remain pinned; browser updates, erased partial origin storage, disabled OPFS
or quota errors must surface failure without silently replacing history.
A real iPadOS 17 Safari **events-only** write/reload/resume/sync check is an
additional physical-device gate before claiming Safari 17 qualified. SQL's
DoltLite WASM/OPFS SAH-pool has a different gate, and no event-backend
qualification implies SQL or uninterrupted mobile background work.
