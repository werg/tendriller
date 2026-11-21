# Develop and verify Tendriller

Use Node 22.15 or newer and `npm ci`. Core builds independently of contrib. There is one application contract and one fresh host storage baseline.

| Command | Result |
| --- | --- |
| `npm run build` | Build and package SDK, runtime and generic participant engine |
| `npm run build:tools` | Package the session CLI, authored-file packer and explicit preview against built public artifacts |
| `npm run build:artifacts` | Build all four public archives |
| `npm run dev` | Build assets and run the local account/page host |
| `npm run test:onboarding` | After a build: validate the discovery documentation graph, generated combined guide and safe tutorial archive |
| `npm run test:first-app -- --session-archive /absolute/path/to/chronolog-peer-session.tgz` | After `build:artifacts`: run the downloaded first-app tutorial against an isolated packed host and real Chromium |
| `npm run check` | Contract generation, types, build boundaries, Node/Worker tests, independent package consumer and tools |
| `npm run check:release` | Core checks plus browser qualification |
| `npm run test:agent:acceptance -- --help` | Maintained fresh-agent domain/MCP evaluation with private owner controls and independent observations |
| `npm run test:idle:soak -- --config PRIVATE_JSON --state PRIVATE_DIRECTORY` | Actual 24/48h isolated staging residency and idle measurement; see [idle soak](IDLE_SOAK.md) |
| `npm run test:idle:metrics -- --config PRIVATE_JSON --state PRIVATE_DIRECTORY --probe` | Read-only Cloudflare analytics schema/access probe, without application traffic |

## Boundaries

Chronolog owns application execution, signing identity, local bytes, command attempts and replication. The ordinary host path uses portable participant/control verification.
The optional Cloudflare assistant uses hibernating inbound sockets to route
approved operations to the existing application participants. The host verifies
published schemas and retains delivery state. Participants execute their own code. See [Cloudflare assistant setup](CLOUDFLARE_ASSISTANT.md). Browser composition exposes an installed session, signals and explicit host operations. Optional voice remains outside the kernel dependency graph.

The browser Chronolog participant is independent of database activation. Its protocol
identity and verified control metadata use small browser-native storage; OPFS, database
ownership, history and materialization load on first durable use inside that same
participant. The public `/browser` import contains the page facade; `/worker` contains
the protocol owner and reaches durable code through a dynamic import. Keep optional
SQL engine imports inside `createEngine` (or a custom `createMaterializer`), never
in a page's eager import graph.

`@tendriller/core` publishes host/participant and browser contracts. The runtime archive contains exact code/assets plus kernel and voice declarations. The engine exports the generic Worker, `Tendril`, `Admission`, account schema and public test fixture. Tools are a separate self-contained Node archive with `tendril` and `tendril-preview` executables and preview/pack/session exports.

Run `contract:generate` after executable metadata-schema edits. `contract:check` rejects stale generated files. `check:boundaries` examines source imports and built dependency graphs. `test:consumer` installs only public archives in an independent directory and checks runtime imports and strict declarations.

The collaboration browser owner's base silence fence is 15 seconds. A pending
finite facade call observed to have started before that fence expires can use
one fixed grace window, ending at its original request deadline (30 seconds from
request start by default). Classification belongs to Chronolog's public
`boundedRequest` getter; core does not inspect private RPC methods. New,
cancelled, or replacement caller requests cannot slide the selected deadline.
Only an authenticated owner response rearms the window. Passive applied/shared/
event waits grant no grace; without a finite call the silence fence stays 15 seconds.

This changes the **connection fence**, not RPC deadlines: with defaults, the first
eligible finite call can start just before 15 seconds of silence and retain its
original 30-second budget. The resulting logical connection fence is therefore
less than 45 seconds from the last authenticated response, subject to normal
browser/event-loop scheduling. For example, a first call at silence +10 seconds
can retain the route until +40 seconds; later calls cannot extend it. Owner-loss
qualification must use this separate connection-fence bound rather than a global
30-second operation timeout, and measure the actual pending request/closure.
An elected route resumes suspension only after a bounded authenticated reply.
Initial connection readiness retains its own existing opening deadline; the
finite-request source binds only after that initial facade connection returns.
Hidden/frozen documents automatically park their local observation fence before
awaiting any RPC. A visible resume uses a fresh private-root acknowledgement or
an authenticated elected-owner nonce reply. Queued old traffic and browser
lifecycle events cannot renew that resume proof. Repeated hide/resume transitions
must retain the same owner without rearming a still-suspended attachment.
This does not preempt a synchronous SQL call or qualify passive-only SQL stalls.

## Verification

Use `test:contract` for wire filters and SDK semantics; `test:runtime-unit` for inert composition, capability/sensor lifecycle and immutable publication caching; `test:server` for real workerd authorization, controls, signed releases, storage CAS and restart. `test:tools` exercises public-session tooling and extracted artifacts. Browser tests cover actual runtime behavior, owner claim/origin boundaries, signed code serving and explicit speech use.

The application session's command/query/replication implementation is qualified in Chronolog and by independent contrib consumers. A static browser fixture does not establish RTC, recovery or database guarantees. The public host fixture permits combining those real boundaries without private imports.

With a restored qualified deployment graph and the matching combined SQL consumer
and WASM engine, run `E2E_CHRONOLOG_CONSUMER=/absolute/consumer E2E_CHRONOLOG_WASM=/absolute/wasm node node_modules/@playwright/test/cli.js test --config test/e2e/browser-sql-opening.playwright.config.ts`.
Staging acceptance runs this local regression before the live scenarios, using the
packaged Worker with bundling disabled. It retains SQL replication, correction and
reopen checks while delaying either peer's metadata response by twelve seconds,
and combining a six-second metadata delay with a cold SQL response held for at
least twenty-one seconds. This explicit SQL fixture keeps metadata preparation's
25-second bound and gives SQL activation a separate fixed 30-second readiness
phase before exposing the page facade. Only metadata readiness starts that phase;
engine progress cannot renew it, and a successful first SQL read is required.
The ordinary page RPC deadline stays 20 seconds. This separates fixture startup
qualification from an operation latency bound; metadata alone does not qualify SQL.
The view subscribes before reading and consumes the initial change snapshot;
revision equality coalesces that notification instead of starting a second read
after “Ready”. Its bounded 20-second initial observation exposes Ready only after
a coherent read, including changes arriving during that read. Deterministic
blocked-read tests run in `test:ci`; the browser regression requires one initial
view read on both peers. This removes fixture overlap without qualifying a kernel
latency claim.
Replication checks first observe the source's applied result within its declared
15-second bound, then start the unchanged five-second remote-display check.
Fixed startup stages/timings and cached session-state diagnostics identify which
boundary failed without logging keys, request bodies or authored data.
The SQL specimen deliberately opens a one-shot relay rather than canonical
`participate()` discovery. Both sessions must finish preparation before either
physical connection starts; canonical participation instead owns bounded
connection failures and backoff during asymmetric startup. This fixture check
does not replace qualification of that controller or rebuild deployed bytes.

### Pre-release participant composition

The relay window and reciprocal authenticated peer readiness are explicit parts
of their respective connection protocols. Consume the matching qualified SDK and
session graph; mixing old and new participant packages is not supported. Republish existing apps with the current runtime and SDK and
upgrade their native participants. Close old app tabs before reopening after
this cutover, so an earlier running SharedWorker cannot retain the old transport.
Keep each device's storage, identity, signed attempts and application history.
Attaching across publications shares a compatible owner; it does not upgrade
code already executing inside that owner. This needs no storage migration.

## Public Worker fixture

`@tendriller/engine/testing` initializes fresh synthetic accounts and pages inside the Cloudflare Vitest pool. `createTestPage({application:{id}})` exposes authenticated `api`, `ownerApi`, `exchange`, `ownerExchange`, `asset(path)`, participant access, invitation/rendezvous sockets, clock advance and actual Durable Object restart.

`hostTraffic` counts HTTP/body bytes and separate invitation/SDP upgrade/frame bytes, excluding synthetic setup. Snapshot it around ordinary application operations to test host independence. `asset` lets consumers verify actual served HTML/JavaScript and historical immutable URLs after signed publication and restart.

An independently packaged workerd fixture can read `@tendriller/engine/testing-ratelimits` when constructing its Wrangler configuration. The engine archive pins these bindings in its provenance, so external tests use the host's current page/account traffic limits without copying their values.

## Checkpoints and releases

Every build writes exact source commit/tree, clean/dirty state and archive SHA-256 values to `dist/provenance.json`. The engine embeds portable Chronolog provenance and hashes. Independent qualification copies clean artifacts and verifies their hashes before installing; a branch name does not identify tested bytes.

Tools record the same source identity in `dist/tools-manifest.json`.
`release:artifacts` requires both proofs to match the clean checkout, checks the
actual packed metadata/exports and runtime bytes, and binds all four core
archives, the exact served starter and the pinned public Chronolog session in
`dist/composition.json`. It also creates a versioned first-app archive containing
the starter and local SDK/tools/session packages. `dist/manifest.json` binds the
composition, first-app archive and provenance files for immutable publication.

Commit and push incremental changes before publishing clean artifacts. A source build may update the tracked runtime manifest; include that generated update in a checkpoint, then rebuild from the clean tree.

The Public service workflow builds/checks once on Node 24, seals a deployment
bundle into the manifest, then qualifies those same bytes in browser, exact-kit
and native jobs. Browser qualification runs the exact first-app kit with both the shared owner and the elected fallback (SharedWorker disabled). Both reports gate promotion. Node 22 retains a separate compatibility check. PR and branch
jobs have read-only permissions and never publish or deploy. Only trusted master
publishes, using `source-<full commit SHA>` release tags, with the manifest uploaded
last. Package versions may stay unchanged across source checkpoints; the existing
`v0.3.0-rc.17` release is never overwritten. Missing or different published bytes
fail closed; an interrupted publication can resume only with identical assets.

Publication is an explicit dependency of staging deployment. Both staging and
production restore the same manifest-bound deployment archive, check its entire
file graph and the engine/runtime/starter identities, and deploy the packaged
Worker with bundling disabled. They never rebuild deployment bytes. Staging
acceptance and MCP qualification consume that graph and both gate production.
Post-deployment MCP qualification downloads the originating run's artifacts;
manual/weekly MCP runs download and verify the checkpoint's public source-tagged
graph. Service discovery and packed SDK navigation embed the exact source-tagged
manifest/kit URLs. Do not move source tags or replace their assets. A workflow rerun
must reproduce the existing bytes or fail; it cannot silently replace a release.
The workflow's existing readiness, storage-schema, current-master and environment
gates still apply. No local check performs publication or deployment.

Fresh deployments initialize `0001_accounts.sql` and new Durable Object namespaces. `node scripts/storage-schema.mjs` reports the current baseline. Existing mismatched storage is rejected without mutation. See [operations](OPERATIONS.md).

For a candidate spanning core, Chronolog, and cookbooks, use the [three-repository qualification guide](RELEASE_COMPOSITION.md).

## Onboarding as a public surface

The homepage, `agent.md`, `AGENTS.md`, ordered `llms.txt`, machine discovery at
`/.well-known/tendriller.json`, CLI `guide` and MCP `tendril_guide` all lead to
`docs/BUILD_AN_APP.md`. Discovery uses a separate document and HTTP Link headers;
the task-oriented `/.well-known/tendriller-capabilities.json` points to actual
imports, starter modules, guides and ownership boundaries. Neither catalog probes
device permissions. `docs/AGENT_DELIVERY.md` defines completion as the live
connected application with explicit process lifetime and resume evidence;
the strict existing `/api/service` JSON contract remains unchanged. Staging and
branch previews rewrite host documentation links to their own service origin.
Live creation/write availability is separate at `/api/readiness`, advertised in
the navigation descriptor and HTTP Link headers. The read-only preflight fails
closed when service state is unavailable and reserves no account, page or quota.
MCP discovery identifies its canonical origin; optional public
`SERVICE_ENVIRONMENT` and `SERVICE_SOURCE_COMMIT` values label the deployment
without guessing which custom hosts are production. An absent source checkpoint
is reported as null; core release and runtime identity remain explicit.

`scripts/onboarding.mjs` generates `llms-full.txt` from maintained guides and
packages the explicitly enumerated tutorial source files into a download.
Generated private handles, device stores, epoch keys and build output must never
enter that archive. Tutorial HTML is available inside the download, not as an
executable document on the service origin. `npm run test:onboarding` runs in the
normal Node test gate; public Worker tests follow the discovery links anonymously.

The tutorial is an application consumer of public packages. It does not enter the
SDK, host or runtime import graph. Validate it with an exact Chronolog archive
when changing application APIs. [The cold-start acceptance test](AGENT_ONBOARDING_TEST.md)
measures the full domain-only journey separately from automated route/link tests.

`test:first-app` downloads the starter from its own isolated host, installs only
public archives in a temporary consumer, and exercises owner claim, descriptor
configuration, initial generation selection, native commands and process reopen,
signed publication, browser enrollment, shared state and uncertain-command retry
after reload. It records source/archive identities and results in
`.results/first-app.json`, with desktop and narrow-viewport homepage and connected
starter screenshots. The photo flow transports actual encrypted session content
and signals to an authorized native test participant. It uses an injected
deterministic provider, verifies analysis makes no domain write, then commits only
the person's edited observation and reopens it. It does not call a live AI service.
Helper tests also cover stale reads, cancellation, uncertain operation states,
failed preparation, fixed reviewed values and explicit reapplication lineage. The
`Agent onboarding` workflow runs it with a pinned Chronolog source commit and
the repository's Playwright container. It needs no production credentials.

For a local release candidate, commit a clean checkpoint, run
`npm run build:artifacts` and `npm run release:artifacts`, then pass
`--first-app-archive /absolute/tendriller-first-app-VERSION.tgz` to `test:first-app`.
That mode verifies and installs the packages carried by the kit; the release
workflow requires it before publication. `--session-archive` remains available
for deliberate alternate-source and SQL qualification, without claiming that it
is the released first-app composition. Use Playwright's installed Chromium,
or set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to an existing Chromium executable.
If the environment cannot start
a browser, `--native-only` runs setup, durable commands/reopen, bundling and signed
publication, and explicitly records a **partial** result with browser checks
omitted. It does not qualify browser behavior. The default browser run requires real native/browser WebRTC traffic with no
host relay payload, including recovery after the original RTC provider tab closes.
`--transport relay` deliberately disables browser RTC and requires encrypted
relay traffic carrying the same verified application command. Both modes use a
synthetic local owner session. They do not qualify live OAuth, Internet NAT
traversal, physical mobile execution or unaided agent usability. A native-only
run does not qualify browser transport.

The workflow also builds the pinned optional SQL-native engine on its Node 24
runner and runs `test:first-app -- --session-archive /absolute/sql-archive.tgz
--sql-native-only`. That mode records `.results/first-app-sql.json` and qualifies
the separate SQL starter's setup, signed schema, guarded transfer, atomic
rejection, exact retry and native process reopen. It reports native coverage
explicitly and does not claim the supplied SQL browser Worker is qualified by
that check. Engine archives must match the target Node/platform/architecture/libc
requirements; an events-only archive cannot stand in for SQL.


## Keep guidance synchronized

`contract/onboarding.mjs` owns the public navigation and lifecycle descriptor.
The host, account-linked MCP guide catalog and packaged CLI consume that same
public module (`@tendriller/core/onboarding`). Edit the maintained Markdown guides
for procedures; MCP reads those deployed assets rather than a copied manual.
`scripts/onboarding.mjs` builds the combined text from those documents, and the
plugin builder packages the maintained skill directly.

When changing the lifecycle or supported setup routes, update its primary guide,
agent entry/index and the plugin skill together. `npm run test:onboarding` checks
the guide catalog, shipped documents, entry-point links, skill routes and combined
text. The server tests exercise unauthenticated MCP discovery, all guide topics,
staging URL rewriting and an empty account's next action. CLI tests compare its
embedded navigation with the shared descriptor. Rebuild before these checks.

Contrib should link to the target service's current guides for setup; keep pinned
source links in qualification reports as evidence for their recorded runs. After
changing contrib's reading index, run its generator and normal checks rather than
editing generated `agent.md` or `llms.txt` alone. Run the MCP-only cold-start
scenario in [Agent onboarding](AGENT_ONBOARDING_TEST.md) for actual agent behavior;
link and consistency checks do not prove that an unfamiliar agent can finish.

Account-bound setup retains one client credential and allocation across retries.
Reviewed device pairing uses the browser's own key proof, a native proposal prepared before owner
review, and a durable ordering pause until the exact signed outcome is resolved.
The native participant uses hibernating setup notifications without idle polling;
individual reviews expire after ten minutes. Its lifetime is independent of the
optional MCP adapter. Closing or restarting it does not erase uncertain work. Public SDK/endpoint and tutorial helper tests cover their named
boundaries. The exact packed first-app/browser run, selected-host MCP run and
unaided cold-start exercise are separate evidence; source changes do not deploy
the features or complete those qualifications.

## Live MCP reviewer qualification

`npm run test:plugin:live -- --access /private/account.json --config
server/wrangler.staging.jsonc --output /private/evidence` creates an isolated
synthetic app and records a real Codex MCP client's tool-level acceptance run.
Build and prepare release artifacts from the exact clean deployed checkpoint
first; install the qualified Codex CLI and Playwright Chromium. Anonymous
preflight requires the deployed source, release, runtime and composition to
match those artifacts. It checks the current pinned session's actual bytes.
The CI workflow checks source/readiness before package acquisition and complete
composition before reviewer credential renewal. Paused staging or production
stops qualification; the fixture never changes service mode.
No model turns or OpenAI model credentials are used. The test verifies prepared
publication before claim, real OAuth/PKCE, reads, a write, retry, retained events,
rejections and reload, then deletes only its own fixture. It leaves the stable
reviewer sample untouched. It does not establish ChatGPT web or model behavior.

The [qualification workflow](../.github/workflows/plugin-qualification.yml)
gates production promotion on staging, verifies production after successful
master deployments, and runs weekly on both environments.
Private account records live in each environment's `TENDRILLER_REVIEW_ACCESS_JSON`
secret; the same account is renewed automatically. Reports, screenshots and video
use an explicit artifact allowlist; private fixture credentials stay outside it.
See [review preparation](../plugin/REVIEW.md) for static
reviewer login, credential renewal/revocation and persistent sample operation.

The live MCP qualifier accepts `--artifact-root /absolute/clean/deployed-checkout`
when running a diagnostic-tool revision against a separately restored CI graph.
The flag selects only package/composition artifacts. Fixture consumer sources always
come from the tool's own clean checkout (`consumerRoot`), so an older artifact root
need not contain the new review helper. Evidence separately records `consumerSource`
(commit/tree/dirty) and hashes of the exact copied fixture sources, alongside the
deployment's package provenance; a mixed diagnostic run is not a new release-graph
qualification. Normal CI defaults both roots to its selected source checkpoint.
The artifact checkout must remain clean and its manifest, composition and archives must
match the actual deployment; the option does not bypass provenance or readiness.
Claim/review failure evidence identifies a fixed step, normalized response routes
and status codes, fixed UI markers and process state. It omits URLs, browser/child
error text, console text, tokens and bodies. Provider enrollment retains a 25-second deadline after approval-driven startup,
uses at most one ordinary read per second and backs off on 429; owner consent is
submitted once. The native app/publication is independent of optional MCP
connectivity; setup notifications start only the exactly approved component.
