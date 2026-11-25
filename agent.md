# Build a Tendriller application

The deliverable is a working signed page, not a preview or an installed adapter. One **agent** (one `ta_` credential and one signing key) maintains many pages from one workspace and one optional local program; see [multi-page agents](docs/MULTI_PAGE_AGENTS.md) and [agent credentials and grants](docs/AGENT_BINDINGS.md). Start with [Build an app](docs/BUILD_AN_APP.md), [capabilities](docs/CAPABILITIES.md), [session bootstrap](docs/SESSION_BOOTSTRAP.md), and [delivery](docs/AGENT_DELIVERY.md).

For account-linked tools, follow the [MCP agent guide](docs/MCP_AGENT_GUIDE.md).

## Service and release first

Use the exact service origin supplied by the person or account-linked connector, including staging. Read `/api/service`, `/.well-known/tendriller.json`, and `/api/readiness` before downloading or installing packages. Continue only with verified same-origin readiness, `mode: "open"`, and `creation.available: true`. Otherwise stop and report its next action. Use the immutable `firstApp.release` kit and its exact SDK, tools, authority and session composition; do not mix source checkouts or same-version archives.

## Browser-first route

1. **Register the agent once, then create the page.** With account-linked MCP, run `tendril workspace key --handle HANDLE`, call `register_agent` with its public arguments and retain the result with `tendril workspace adopt`; the host derives the verified owner. From a domain, run `tendril workspace init --owner EMAIL`; with a dashboard join code, `tendril workspace join`. The workspace holds one credential and one signing key for every page. `npm run page:new` (`tendril page new <slug>`) creates a page and grants it to the creating agent automatically; an existing page needs the owner's explicit per-agent grant (dashboard checkbox, then `tendril page grant`). Retain the private workspace (`.tendriller/`).
2. **Define state and choose policy.** Ordinary offline-first apps use finality `none`. Commands, queries and optional tool declarations describe application behavior; they do not freeze SQL schema.
3. **Prepare and publish before the first browser key is known.** `npm run init -- <slug>` prepares only the publisher policy and `HostAppConfig`, using the workspace's one opaque shared signer as the publisher (no per-page key, and no device, data root or epoch key). `npm run deploy -- <slug>` signs and publishes the entire authored asset graph without creating a data device. The agent program opens a page only after the explicit native `sign-enrollment`, `provisioning-request` and `import-provisioning` steps have verified its reader grant and current epoch key and written `initialized.json`; the browser-first route needs no agent process.
4. **Give the ready page URL to the owner.** They complete their own sign-in. Do not ask for a claimed reply or require the agent program or any native participant.
5. **Initialize locally.** The first browser's signed key proof initializes `rootPrincipal`, initial membership and an epoch-key commitment. The actual epoch key is durably retained only in the browser. The host neither receives keys nor executes application programs.
6. **Add another device explicitly.** It proves its key and creates a retained recipient request. The owner reviews exact independent rights, grants crypto membership, and an existing device wraps keys to that recipient. A fresh keyless browser cannot read old data merely by signing in. SQL row/object/namespace permissions remain separate ordinary transactions.
7. **Verify local authoring, offline reload, replication and signatures.** Report actual process lifetime and resume prerequisites.

`tendril agent run` (`npm run agent`) is the workspace's one optional local program: one hub connection carries every page's control traffic (setup notices, introductions, invitations, WebRTC negotiation) and it opens one Chronolog session per initialized page with the shared agent key. Per-page sync data keeps per-page connections. CLI commands address a page with `--page <slug|id>`. Browser reads and durable writes never depend on it; an unreachable program is `OWNER_UNREACHABLE` for native attach, never a reason to open a second signer.

## Data contract

Chronolog merges authenticated immutable operation sets. Canonical order is solely `(signed authorTimestampMs, signing public-key bytes, stable proposal-ID bytes)`. Arrival, host time and participant roles do not allocate application order.

```js
const operation = await session.submit({ program, operationId, authorTimestampMs });
// Resolved: this exact signed intent is durable locally, even without peers.
const current = await operation.materialized(); // coherent, revisable local outcome
const inspection = await operation.inspect();
// inspection.stored / materialized / retained / finalized / excluded are separate facts.
```

`authorTimestampMs` is an optional bigint allocated once by the authoring device when omitted. Preserve operation IDs and signed bytes across uncertain responses. `session.operations.retry(id)` retries the retained original, never a new timestamp or operation. Finality waits on a no-finality app fail explicitly as unsupported.

A delayed earlier operation can revise later SQL success, rejection, events and schema. Render coherent materialized snapshots plus separate local drafts/view state. Invalidate and rederive on changes; do not append arrival events into a second UI database. Keep stable IDs, focus, deep links and unsent text. A missing query/table marks the last snapshot **not current**, without deleting drafts or disabling unrelated local submissions.

## Boundaries

- `@chronolog/peer-session` owns devices, durable operations, execution and peer reconciliation. `createApplicationSession({device,definition,authority?,applicationId?,epochKeys?,createMaterializer?})` is the opening factory.
- `@chronolog/authority` owns portable signed descriptors, membership, enrollment, publication and optional finality evidence. Crypto rights `reader`, `writer`, `administrator`, `publisher`, and `finalizer` are independent.
- Tendriller owns account/origin authorization, bounded control transport, immutable signed code and peer introductions. It is not an application data backend.
- SQL DDL/DML and permission changes are ordinary authenticated programs. Engine/platform manifests establish deterministic semantics, not fixed application schema.
- Browser/native/host finality placement is authenticated policy, not an ordering coordinator. Missing finality never blocks local authoring. Closing time can exclude unseen offline work behind the frontier; explain this consequence and keep excluded originals inspectable.
- Optional tools, inference, signals and media require their own availability/consent. Missing agents affect those features, not ordinary Save. Provisional claims never authorize irreversible effects by themselves.

For an app with an agent-request consumer, verify its worker-owned ephemeral presence and the request/receipt/answer flow (see [request lifecycle](docs/AGENT_REQUESTS.md) and the [restart checklist](docs/AGENT_RESTART.md)). Stop that worker while the native participant stays connected and confirm its availability becomes stopped or stale; a fetcher or event forwarder never advertises an interactive assistant's topics. Applied journal work does not mean an agent has seen or answered it. For one conversation handling several pages after a turn ends, read [same-conversation delivery](docs/CONVERSATION_DELIVERY.md) (also `tendril_guide` topic `conversation`): retain one handled checkpoint per page, steer an active Codex turn, use queue/resume only while idle, and treat host admission alone as neither receipt nor answer.

See [patterns](docs/APP_PATTERNS.md), [state models](docs/STATE_MODELS.md), [multi-participant composition](docs/MULTIPARTICIPANT.md), [agent bindings](docs/AGENT_BINDINGS.md), [CLI](docs/tools/CLI.md), [sensor consent](docs/SENSORS.md), and [troubleshooting](docs/TROUBLESHOOTING.md). Use the [local release host](docs/LOCAL_HOST.md) for isolated testing. There are no old-format readers, ordering transitions, compatibility aliases or migration procedures in this application path.
