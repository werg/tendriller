# Develop and verify Tendriller

Use Node 22.15 or newer and install the locked dependencies with `npm ci`.
Core builds and tests without a contrib checkout. Its default Worker has an
empty trusted-extension registry; a cookbook never installs server code.

## Build and run

| Command | Result |
| --- | --- |
| `npm run build` | Build the headless browser runtime, optional runtime adapters, public SDK, and generic Worker; package SDK, runtime, and engine archives in `dist/`. |
| `npm run build:tools` | Install the isolated tools package against the built public SDK/runtime, then package its CLI, preview, collectors, and host bridges. Run after `build`. |
| `npm run build:artifacts` | Build all four public archives, including the optional tools. |
| `npm run dev` | Build assets, initialize the local account database, and supervise the asset watcher and local Wrangler Worker. |
| `npm run check` | Validate the contract, types, build boundaries, unit/Worker tests, clean public-package consumers, and operational tools. |
| `npm run check:release` | Run `check` and the browser suites required for a release. |

The SDK publishes the browser, agent-client, and trusted-host contracts. The
runtime archive contains the exact browser assets and manifest plus public
preview support. The engine archive exposes the Worker, `Tendril` and `Admission`
classes, account schema, and an explicit test fixture. The tools archive is a
self-contained Node distribution: extracting it does not require an npm install
or a source checkout. See [operational artifact details](tools/ARTIFACTS.md).

`npm run contract:generate` refreshes `contract/wire.d.mts` and `contract/v2.json`
from the executable schemas. `npm run contract:check` rejects stale generated
files. This repository defines one target contract and storage baseline. Tests
create their own accounts, pages, commands, captures, and records under that
baseline.

## Boundaries and deliberate trusted extensions

The deployed Worker does not include Node tools or cookbook implementation code.
The browser kernel does not import conversation UI, speech, or domain rule policy.
The hosted entry adds a small recovery and device-use utility; authored pages use
the public browser API to choose their own interaction design. Optional speech
requires an explicit adapter and user interaction.

A deployment that needs extra enforcement selects a reviewed `WorkflowModule`
through the public engine export. For example, an application entry can import
its own module and retain the engine's platform handlers:

```ts
import worker, {
  Admission, Tendril, configureWorkflows,
} from '@tendriller/engine';
import type { WorkflowModule } from '@tendriller/core/host';
import { reviewedCapability } from './reviewed-capability.js';

const selected: readonly WorkflowModule[] = [reviewedCapability];
configureWorkflows(selected);
export { Admission, Tendril };
export default worker;
```

This is a deliberate source-level deployment decision. Page files and catalog
metadata cannot change that registry. The ordinary core entry selects no module.
Exercise authorization, private-record access, scope invalidation, and atomic
updates in the actual Worker host, using fresh records. HTTP fixtures are useful
for UI behavior but do not establish those service guarantees.

`npm run check:boundaries` examines source imports and built input graphs.
`npm run test:consumer` checks the packed public packages from an independent
consumer. Tools likewise use the built public SDK and runtime instead of private
server or runtime source imports.

## Choose the smallest meaningful verification

Use `npm run test:contract` for the executable wire contract,
`npm run test:runtime-unit` for headless durability and lifecycle behavior,
`npm run test:server` for actual Worker authorization and transactions, and
`npm run test:tools` for publishing, preview, collector, bridge, and installed
archive behavior. Run `npm run test:browser` for browser integration and
`npm run test:tools:browser` for the operational preview fixtures. The
[browser testing guide](E2E_TESTING.md) explains the local service, pinned speech
test, and physical-device limits.

Contrib owns cookbook prose, snippets, adapted examples, and their focused checks.
Those checks may pin exact core artifacts for reproducibility. Core's build does
not fetch contrib, and a cookbook edit does not require a synchronized platform
release. Content review should check the stated assumptions, alternatives,
provenance, and relevant behavior rather than require upstream snippet equality.

## Release artifacts

Run `npm run check:release`, then `npm run release:artifacts`. The release manifest
records the source commit, contract, runtime identity, and hashes of the SDK,
runtime, engine, and tools archives. The normal service deploy uses the generic
engine and the same runtime assets; installing the tools is optional.

Create `release/v<package-version>` at the exact tested source commit to request
release-candidate publication. Branch creation and later pushes run the release
gate. Matching version tags and published-release events also run the gate.
Manual workflow dispatch builds and verifies any selected ref; publication is
limited to a matching release branch or version tag.

The publisher requires the package, manifest, selected ref, and workflow source
to agree. Existing tags must identify the same commit, and existing release
assets must have the same bytes. Use a new version for different artifacts.
These checks identify the current publication; they do not introduce runtime
selection, compatibility readers, or a coupled contrib release.

## Deployment and branch previews

Initialize empty account storage with `server/migrations/0001_accounts.sql` and
fresh Durable Object namespaces for `Tendril` and `Admission`. The current
Durable Object schema revision is reported by `node scripts/storage-schema.mjs`.
The service starts with page creation paused until its identity and isolation
checks pass. See [operations](OPERATIONS.md) for provisioning and activation.

The branch-preview controller selects an exact passing commit and verifies that
it is still the branch head before deploying isolated resources. It builds the
same generic engine and publishes the same immutable runtime as staging.
Preview cleanup removes only that branch's resources.
