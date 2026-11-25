# Choose existing capabilities before building

Use the selected service's `/.well-known/tendriller-capabilities.json` and [Build an app](BUILD_AN_APP.md). Discovery is not permission, working hardware, process availability or verified transport. Do not add a separately hosted backend unless the application has a concrete requirement beyond the device-owned session.

## Starter archetypes (pick one first)

- **Shared notes/events:** complete browser-first `domain.mjs`, `setup.mjs`, `publish.mjs`, `worker.mjs`, `page.mjs`. Event notifications invalidate a coherent domain projection; they are not an arrival-ordered UI database.
- **Ordinary SQL:** `sql/` inventory, guarded atomic DML, explicit ordinary schema initialization/ALTER and separate SQL permission grants. Use the exact qualified native/WASM engine profile; no immutable application-schema descriptor exists.
- **Several views/agents:** retain one physical owner and separate view drafts/approved consumer bindings. Provisional resource claims are revisable, not globally exclusive locks or permission for irreversible effects.

## Task to implementation

| Need | Existing import or source | Boundary |
| --- | --- | --- |
| Durable state/commands/queries | `@chronolog/peer-session`: `createApplicationSession`, `defineApplication`, `defineCommand`, `defineQuery` | Signing/storage readiness permits offline Save; no peer/finalizer/agent gate |
| Signed control/crypto grants | `@chronolog/authority`; `@tendriller/core/authority` transport | Account access, root principal, reader/writer/admin/publisher/finalizer and application SQL permissions remain distinct |
| Browser owner | `@tendriller/core/browser-owner`, `@tendriller/core/worker-owner` | SharedWorker/elected Worker retain one device store and bounded root lifetimes, not global order |
| Recipient key transfer | `session.provisioning.createProvisioningRequest/exportProvisioning/importProvisioning`; `helpers/provisioning-view.mjs` | Explicit signed request, owner review/grant, HPKE-wrapped keys; no plaintext epoch keys reach authored assets or host |
| RTC/relay | `@tendriller/core/participation`, `@tendriller/core/native-rtc`, `@tendriller/core/peers` | Optional bounded background introductions; verify actual authenticated data traffic |
| Reactive domain UI | `createLiveView`, `createViewStore`; event/SQL pages and `ui/` examples | Render coherent materialization plus independent drafts/view state; preserve focus/deep links across revised outcomes/schema |
| Operation facts/exact retry | `operations.get/retry/subscribe`, `operation.inspect/materialized/retained/finalized` | Stored, revisable execution, peer retention and optional finality are separate; uncertainty retains originals |
| Optional finality | Configured `none`, `fixed-validator`, `signed-frontier`; `session.finality` provider methods | Closing author time may exclude late unseen offline work; cannot allocate order, guarantee retention or exactly-once effects |
| Immutable UI and offline graph | `publish.mjs`; `tendril.publication.saveOffline()` | Independent publisher authorization before first root exists; offline ready only after complete graph acknowledgment |
| Many pages for one agent | `tendril workspace init` or `join`, `tendril page new`, `tendril agent run`; [multi-page agents](MULTI_PAGE_AGENTS.md) | One `ta_` credential and one signing key per agent, owner-granted pages, one hub connection for control traffic only; page sync data keeps per-page connections; the program is optional for browser writes |
| Native tools/local CLI | `@tendriller/core/native-owner`; [CLI](tools/CLI.md) (`--page <slug|id>`) | Optional private supervisor/IPC and explicit device provisioning; no native process required for browser writes |
| Optional assistant gateway | `@tendriller/core/assistant`; [agents and grants](AGENT_BINDINGS.md) | Approved consumer scope/provider routing is independent from CRDT authorship and cannot silently expand on schema changes |
| Signals/presence/progress | `session.signals`; `helpers/signal-request.mjs` | Disposable authenticated live updates, not durable ordering or private recipient authorization |
| Reviewed photos/content | `session.content`, `helpers/reviewed-input.mjs`, `media/camera.mjs` | Acquisition and inference suggestions never commit automatically; explicit local consent/review required |
| Sensors/voice | `tendril.capabilities/sensors`, optional `@tendriller/runtime/voice` | Trusted gestures and tracked cancellation; API presence does not prove permission/hardware/provider availability |
| Local diagnostics | `@tendriller/core/diagnostics`, transport/error inspectors | Observations are not command success, retention, finality or future process wake guarantees |

## Use the correct package and layer

The immutable first-app kit carries matching public SDK, tools, **authority** and session archives, with runtime/host/source hashes bound by composition. Read readiness before installing. Use public `@chronolog/authority` and session entrypoints; do not import private kernel files or tutorial modules into the host/kernel.

The host authenticates accounts/origins, verifies signed control/publication/finality metadata, serves immutable UI, and introduces peers. It does not receive or execute application programs as a backend. The session's signed authored-time operation set and deterministic local materializer own data. SQL DDL and grants are ordinary permissioned transactions, not host configuration switches.

## Acquisition, tracking, interpretation and commit

Keep these stages distinct: user gesture/acquisition, bounded local preview, explicit optional sharing, inference/interpretation, editable review, then durable submission of reviewed values. Stop camera/microphone/screen/hardware resources on cancellation/hide and check late permission results. An absent inference participant disables analysis only, never ordinary domain edits. See [sensors](SENSORS.md), [reviewed input](AI_INPUT.md), and [patterns](APP_PATTERNS.md).

## Preview early, verify the hosted session

A static preview checks layout only. Final verification uses the actual signed page, browser-first enrollment, offline author/reload and a second explicitly provisioned participant. Exercise late earlier operations and schema changes, stale query errors and stable-ID draft/focus/deep-link preservation at desktop and 320px. Report exact evidence and untested boundaries under [delivery](AGENT_DELIVERY.md).

## Use contrib as an implementation source with evidence

Reuse current public consumer examples from the matching composition. An old receipt/source checkpoint is not replacement-protocol qualification. Never preserve a second ordering stack, schema-freezing setup, compatibility alias or migration path to make an old example appear green.
