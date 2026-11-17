# Develop and verify Tendriller

Use Node 22.15 or newer and `npm ci`. Core builds independently of contrib. There is one application contract and one fresh host storage baseline.

| Command | Result |
| --- | --- |
| `npm run build` | Build and package SDK, runtime and generic participant engine |
| `npm run build:tools` | Package the session CLI, authored-file packer and explicit preview against built public artifacts |
| `npm run build:artifacts` | Build all four public archives |
| `npm run dev` | Build assets and run the local account/page host |
| `npm run check` | Contract generation, types, build boundaries, Node/Worker tests, independent package consumer and tools |
| `npm run check:release` | Core checks plus browser qualification |

## Boundaries

Chronolog owns application execution, signing identity, local bytes, command attempts and replication. The Worker embeds only portable participant/control verification. It has no application extension registry, SQL executor or second data model. Browser composition exposes an installed session, signals and explicit host operations. Optional voice remains outside the kernel dependency graph.

The browser Chronolog participant is independent of database activation. Its protocol
identity and verified control metadata use small browser-native storage; OPFS, database
ownership, history and materialization load on first durable use inside that same
participant. The public `/browser` import contains the page facade; `/worker` contains
the protocol owner and reaches durable code through a dynamic import. Keep optional
SQL engine imports inside `createEngine` (or a custom `createMaterializer`), never
in a page's eager import graph.

`@tendriller/core` publishes host/participant and browser contracts. The runtime archive contains exact code/assets plus kernel and voice declarations. The engine exports the generic Worker, `Tendril`, `Admission`, account schema and public test fixture. Tools are a separate self-contained Node archive with `tendril` and `tendril-preview` executables and preview/pack/session exports.

Run `contract:generate` after executable metadata-schema edits. `contract:check` rejects stale generated files. `check:boundaries` examines source imports and built dependency graphs. `test:consumer` installs only public archives in an independent directory and checks runtime imports and strict declarations.

## Verification

Use `test:contract` for wire filters and SDK semantics; `test:runtime-unit` for inert composition, capability/sensor lifecycle and immutable publication caching; `test:server` for real workerd authorization, controls, signed releases, storage CAS and restart. `test:tools` exercises public-session tooling and extracted artifacts. Browser tests cover actual runtime behavior, owner claim/origin boundaries, signed code serving and explicit speech use.

The application session's command/query/replication implementation is qualified in Chronolog and by independent contrib consumers. A static browser fixture does not establish RTC, recovery or database guarantees. The public host fixture permits combining those real boundaries without private imports.

## Public Worker fixture

`@tendriller/engine/testing` initializes fresh synthetic accounts and pages inside the Cloudflare Vitest pool. `createTestPage({application:{id}})` exposes authenticated `api`, `ownerApi`, `exchange`, `ownerExchange`, `asset(path)`, participant access, invitation/rendezvous sockets, clock advance and actual Durable Object restart.

`hostTraffic` counts HTTP/body bytes and separate invitation/SDP upgrade/frame bytes, excluding synthetic setup. Snapshot it around ordinary application operations to test host independence. `asset` lets consumers verify actual served HTML/JavaScript and historical immutable URLs after signed publication and restart.

An independently packaged workerd fixture can read `@tendriller/engine/testing-ratelimits` when constructing its Wrangler configuration. The engine archive pins these bindings in its provenance, so external tests use the host's current page/account traffic limits without copying their values.

## Checkpoints and releases

Every build writes exact source commit/tree, clean/dirty state and archive SHA-256 values to `dist/provenance.json`. The engine embeds portable Chronolog provenance and hashes. Independent qualification copies clean artifacts and verifies their hashes before installing; a branch name does not identify tested bytes.

Commit and push incremental changes before publishing clean artifacts. A source build may update the tracked runtime manifest; include that generated update in a checkpoint, then rebuild from the clean tree. Release publication is separate from deployment. Use `check:release` and the repository's release workflow for a deliberately selected release ref.

Fresh deployments initialize `0001_accounts.sql` and new Durable Object namespaces. `node scripts/storage-schema.mjs` reports the current baseline. Existing mismatched storage is rejected without mutation. See [operations](OPERATIONS.md).

For a candidate spanning core, Chronolog, and cookbooks, use the [three-repository qualification guide](RELEASE_COMPOSITION.md). The [branch inventory](BRANCH_ARCHIVE.md) records preserved unmerged heads separately from the shipped default branches.
