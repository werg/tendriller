# Develop and verify Tendriller

Use Node 22.15 or newer. Install the locked development dependencies with `npm ci`.

## Engine and public artifacts

`npm run build:engine` builds the generic engine, browser runtime and public SDK/support archives with no contrib checkout or installation. `npm run dev` builds and runs the local Worker with asset watching. `npm run build:artifacts` emits only the public archives in `dist/`.

`npm run contract:generate` refreshes `contract/wire.d.mts` and `contract/v2.json` from the executable schemas. `npm run contract:check` rejects stale generated files. There is one contract and no compatibility profile.

`npm run test:pair` verifies the deployment lock, builds the service with its exact vendored workflow archive, and runs the pairing integration suite in the Worker runtime. The suite exercises the compiled service through public requests; it does not import contrib source. Core CI runs this separately from the application-neutral engine tests.

`npm run check` runs typechecking, the independent engine build, import-boundary checks, core unit/Worker tests and a clean artifact consumer. The consumer installs the actual SDK/runtime tarballs outside the checkout and validates imports and TypeScript declarations. It receives no optional tools or private source paths.

## Trusted service composition

`composition.lock.json` records the exact trusted workflow archive, its SHA-256 digest and the supported core contract. `npm run build:service` verifies the lock and statically compiles it with the engine. Its input graph must contain no CLI, collector, preview or component implementations.

The default development Worker runs the empty generic registry. Trusted-module tests explicitly install the selected module through `configureWorkflows`; ordinary payloads cannot register one.

## Browser and integration tests

`npm run test:browser` runs core browser and service flows. Browser executable paths can be supplied through `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`. Core tests cover actual browser transport, durable outbox semantics, conversation controls, state and publication caching. Worker tests cover identity, quotas and atomic operations.

Contrib owns component accessibility, recipe/scaffold flows, collectors, host bridges, complete local preview and portable application tests. Its consumer test runs packed tools in a fresh directory against the exact released core runtime. Preview fixtures report unsupported operations instead of claiming service behavior.

## Release gates

1. Run core checks and build public interface/runtime artifacts.
2. Build contrib against those exact bytes and run its checks.
3. Pin the produced Worker artifact and run service integration and publication tests.
4. Generate release manifests, record the tested pair and publish release-candidate assets.
5. Retain the immutable runtime in the existing service asset bucket. For the initial pre-release cutover, deploy the matched composition at the canonical URLs with a new page namespace and discard the old page registrations. Use fresh named fixtures only when an isolated environment is actually needed.

Create `release/v<package-version>` at the exact source commit to publish a release candidate. Both branch creation and subsequent pushes run the release gate; core runs `npm run check:release`, and contrib requires its full Node and browser checks. The workflow creates the matching version tag and GitHub pre-release at the tested commit. Existing `v<package-version>` tags and published releases also run the same checks and publisher. Manual dispatch publishes only when its selected ref is one of those release branches or tags; other refs only build and verify artifacts.

Publication requires agreement between the ref, package version, manifest version, manifest source commit and checked-out workflow commit. An existing lightweight or annotated tag must resolve to that same source. Repeated branch/tag events are serialized and verify existing asset bytes before uploading missing assets, with the manifest last. A mismatched tag or asset fails publication; choose a new version instead of moving a tag or replacing published files. A normal component/tool release can reuse the deployed workflow interface; deploying new trusted code requires a composition-lock change.

## Branch previews

The existing branch-preview controller selects passing branch commits and deploys isolated resources. The controller comes from the default branch, with branch-head checks before build and deployment. Provisioning uses the same core composition entry and immutable-runtime publication path as staging. Preview cleanup deletes only that branch's resources.
