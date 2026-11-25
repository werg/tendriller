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
| Page keys and device admission | `@tendriller/core/admission` (`openPageAuthority`, `createAdmission`); `shared/helpers/page-data.mjs`, `browser-bootstrap.mjs`, `devices-view.mjs`; `tendril page devices/approve/remove-device/mode/invite/revoke-invite` | The creator signs genesis; host attestation, invites and strict-mode approval are one mechanism; members sign membership and wrap keys to each wrap key; Remove device rotates; no plaintext epoch key reaches authored assets or host |
| RTC/relay | `@tendriller/core/participation`, `@tendriller/core/native-rtc`, `@tendriller/core/peers` | Optional bounded background introductions; verify actual authenticated data traffic |
| Reactive domain UI | `createLiveView`, `createViewStore`; event/SQL pages and `shared/ui/` examples | Render coherent materialization plus independent drafts/view state; preserve focus/deep links across revised outcomes/schema |
| Operation facts/exact retry | `operations.get/retry/subscribe`, `operation.inspect/materialized/retained/finalized` | Stored, revisable execution, peer retention and optional finality are separate; uncertainty retains originals |
| Optional finality | Configured `none`, `fixed-validator`, `signed-frontier`; `session.finality` provider methods | Closing author time may exclude late unseen offline work; cannot allocate order, guarantee retention or exactly-once effects |
| Immutable UI and offline graph | `publish.mjs`; `tendril.publication.saveOffline()` | Independent publisher authorization, separate from data access; offline ready only after complete graph acknowledgment |
| Many pages for one agent | `tendril workspace init` or `join`, `tendril page new`, `tendril agent run`; [multi-page agents](MULTI_PAGE_AGENTS.md) | One `ta_` credential, one signing key and one wrap key per agent, owner-granted pages, one hub connection for control traffic only; page sync data keeps per-page connections; the program is optional for browser writes |
| Native tools/local CLI | `@tendriller/core/native-owner`; [CLI](tools/CLI.md) (`--page <slug|id>`) | Optional private supervisor/IPC and admission actions through the running agent program; no native process required for browser writes |
| Multi-agent `@handles` & hosted MCP | `tendril.agents`, `shared/helpers/agent-requests.mjs`, [hosted MCP](CLOUDFLARE_ASSISTANT.md) | Self-chosen `@handles`, one optional primary agent per page, and opt-in OAuth-token-wrapped hosted MCP with zero plaintext keys at rest |
| Signals/presence/progress | `session.signals`; `shared/helpers/signal-request.mjs` | Disposable authenticated live updates, not durable ordering or private recipient authorization |
| Reviewed photos/content | `session.content`, `shared/helpers/reviewed-input.mjs`, `shared/media/camera.mjs` | Acquisition and inference suggestions never commit automatically; explicit local consent/review required |
| Sensors/voice | `tendril.capabilities/sensors`, optional `@tendriller/runtime/voice` | Trusted gestures and tracked cancellation; API presence does not prove permission/hardware/provider availability |
| Local diagnostics | `@tendriller/core/diagnostics`, transport/error inspectors | Observations are not command success, retention, finality or future process wake guarantees |

## Use the correct package and layer

The immutable first-app kit carries matching public SDK, tools, **authority** and session archives, with runtime/host/source hashes bound by composition. Read readiness before installing. Use public `@chronolog/authority` and session entrypoints; do not import private kernel files or tutorial modules into the host/kernel.

The host authenticates accounts/origins, verifies signed control/publication/finality metadata, serves immutable UI, and introduces peers. It does not receive or execute application programs as a backend. The session's signed authored-time operation set and deterministic local materializer own data. SQL DDL and grants are ordinary permissioned transactions, not host configuration switches.

## Acquisition, tracking, interpretation and commit

Keep these stages distinct: user gesture/acquisition, bounded local preview, explicit optional sharing, inference/interpretation, editable review, then durable submission of reviewed values. Stop camera/microphone/screen/hardware resources on cancellation/hide and check late permission results. An absent inference participant disables analysis only, never ordinary domain edits. See [sensors](SENSORS.md), [reviewed input](AI_INPUT.md), and [patterns](APP_PATTERNS.md).

## Preview early, verify the hosted session

A static preview checks layout only. Final verification uses the actual signed page, owner sign-in admitted by the running agent, offline author/reload, a second admitted device and Remove device. Exercise late earlier operations and schema changes, stale query errors and stable-ID draft/focus/deep-link preservation at desktop and 320px. Report exact evidence and untested boundaries under [delivery](AGENT_DELIVERY.md).

## Use contrib as an implementation source with evidence

Reuse current public consumer examples from the matching composition. An old receipt/source checkpoint is not replacement-protocol qualification. Never preserve a second ordering stack, schema-freezing setup, compatibility alias or migration path to make an old example appear green.

## Same-conversation delivery

A running session watcher receives application work only while its process exists. The optional [ChatGPT integration](CHATGPT_INTEGRATION.md) adds remote tools, explicit supported event subscriptions, a mounted widget and a separate published Workspace Agent route; these need deployment, trusted account adapters, an enrolled device and owner consent, and page residency does not enable them. For the same existing Codex or ChatGPT conversation, inspect the actual host's execution/admission route using [same-conversation delivery](CONVERSATION_DELIVERY.md) and retain per-page handled checkpoints. For Codex, verify that a request arriving during a running turn is steered into that turn, then idle wake and a second request after the first turn ends; a queue that merely waits for a busy turn does not satisfy active delivery. A native participant, event forwarder or one-shot waiter does not establish this capability. Record actual live acceptance evidence; native and injected-transport tests alone do not qualify a deployed connection.
