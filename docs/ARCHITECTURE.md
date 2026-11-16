# Core, trusted composition, and contrib

This document is the architecture decision for contract **2** and release **0.2.0-rc.5**. It replaces the pre-release combined package. Existing prototypes are rebuilt; there are no old-client adapters or storage translators.

## Ownership and dependency direction

| Surface | Owner | Public dependency |
| --- | --- | --- |
| Authentication, authorization, state, events, blobs, streams, lifecycle | Core engine | Core contract |
| Browser transport, durable commands, conversation, required controls | Core runtime | Core contract |
| Workflow records and execution transaction | Core host | Narrow `WorkflowHost` interface |
| Session workflows, decisions, assignments, private responses, archive/reset | Contrib workflows | `@tendriller/core/host` |
| CLI, collectors, bridges, preview | Contrib tools | Released SDK/runtime artifacts |
| Components, recipes, examples | Contrib | Pinned page assets |
| Deployed selection of reviewed modules | Core `composition/` | Exact contrib workflow archive |

The engine has an empty workflow registry. Only the deployment entry calls `configureWorkflows`. Neither page JSON nor event payloads can add modules. An explicit `/workflows/<module>/<operation>` invocation selects an installed implementation; its permission and precondition checks run before the implementation.

`npm run build:engine` needs no contrib installation. `npm run build:service` checks the SHA-256 digest in `composition.lock.json`, extracts the Worker-compatible workflow artifact, and statically compiles it with the engine. CLI and component code never enter that graph. The import-boundary check rejects optional implementation imports in engine code and inspects both build input graphs.

## One transaction boundary

Platform concurrency fields are outside application data:

```json
{
  "cid": "persisted-command-id",
  "scope": "opaque-scope",
  "expected_generations": { "opaque-scope": "captured-token" },
  "data": { "type": "job.status", "session": "application value" }
}
```

Scopes are records in authoritative storage, separate from shared state. Each has an opaque ID and generation, protected paths, operation targets, and an optional trusted module owner. Binding registration, rebinding, rotation and retirement are explicit authorized operations. A new binding meaning receives a new token. Retired scope IDs remain tombstoned so queued work cannot silently acquire a new meaning.

The admission function derives required scopes from operation targets and every changed state path. A protected descendant also guards writes to its ancestors and the whole document. All supplied guards are validated, including guards for a removed scope. A token is a concurrency observation, never an access grant.

Browser state/events, agent HTTP/MCP, capture completion, bundle publication and workflow mutations use this admission rule inside the local transaction. Idempotency is keyed by authenticated actor and stable command ID; reuse with different content is rejected. A repeated accepted command returns its saved result, including after a generation rotation. Storage changes and the command result commit together. Broadcasts and other effects run after commit.

Application state and event payloads have no workflow dispatch semantics. Names such as `experiment`, `notebook`, `guide_progress`, `facilitation`, `session` and `session_id` are ordinary JSON. Validated scope/workflow context is attached separately to accepted events.

## Durable browser work

The browser stores command ID, original scope and captured generation map before applying optimistic state or sending a command. Reconnect and reload reuse this record verbatim. Current authoritative scope metadata filters optimistic reconstruction; an obsolete command cannot obscure a newer session. Rejection remains an explicit result that an application can explain or discard.

A capture records this metadata with its bytes and application payload. Uploading bytes and accepting their event are distinct operations; `capture_complete` performs guarded admission. A familiar `data.type` cannot invoke that operation.

## Narrow trusted host

`contract/host.d.mts` is the complete server integration interface. A module declares named operations, access policies, input schemas, affected targets and a synchronous `run` function. The host supplies authenticated identity, namespaced records, state access, generation operations, participant identities, blob pinning, event emission and post-commit notifications.

Modules receive neither the Durable Object nor a database connection. They cannot import server implementation paths. Synchronous operation execution prevents yielding in the middle of the local transaction. Private workflow records do not live in shared page state, and access is checked before returning them.

## Public artifacts and release order

1. Core publishes `tendriller-sdk-<version>.tgz` (`@tendriller/core`) and `tendriller-runtime-<version>.tgz` (`@tendriller/runtime`). The runtime includes compiled browser code, its content manifest, and public pure state/history primitives.
2. Contrib installs these exact archives using its lockfile and builds tools, components/catalog and a separate workflow archive.
3. Core composition pins the workflow archive digest. A release-pair manifest records the tested versions and hashes.

`/api/service` describes deployed contract and workflow interface/schema revisions. A contrib tool release is a separate identity: changing a chart or collector does not change an installed workflow interface. Tools check this descriptor before provisioning or writing application data.

Release assets carry source commit, filename, size, content type and SHA-256. A discovery URL may point to the latest release, but dependency records contain immutable release URLs and hashes.

## Publication and offline asset identity

A page publication locks its core runtime ID at creation. The server manifest lists the complete page files and their hashes, served under `_publications/<publication>/`. Injected HTML has its first base URL set to that immutable directory and loads the exact runtime under `_tendril/runtime/<digest>/`. Components are ordinary vendored page files and resolve siblings within their own asset set.

The service worker caches manifest-declared assets per publication and persists client associations. It verifies asset hashes; injected HTML is identified by the server's `X-Tendril-Publication` header because injection changes the source bytes. Existing tabs retain their graph when a newer publication is available. Active sockets and thirty-day publication leases preserve server files for ordinary offline recovery; local caches retain the publications still associated with clients.

Runtime archives are retained under content-addressed keys in the existing service `FILES` bucket before deployment. The currently bundled artifact is served by `ASSETS`; older publication runtime URLs resolve to the retained immutable object. This uses the existing storage service and does not retain old helper URL aliases.

## Preview boundary

The contrib preview embeds the actual released runtime and imports `@tendriller/runtime/preview-support`. Its fixture socket/transport is a documented runtime boundary. It does not access a private event bus or import private server files. Fixtures explicitly reject unimplemented service operations. Real Worker tests remain authoritative for identity, authorization, quotas and transactions.

## Resource policy

`contract/limits.mjs` owns public state, file, blob, event and stream limits. Server enforcement imports those values; the descriptor exposes them to tools and preview. A larger single retained snapshot uses the same batch and total storage budgets. No policy depends on table names, metric fields or particular applications.
