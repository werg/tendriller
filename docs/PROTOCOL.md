# Tendriller public protocol

This is the sole supported **contract 2**. Executable schemas are published at `/contract/v2.json` and generated from `contract/index.mjs`. JSON errors have `{ "error": { "code": "snake_case", "message": "..." } }`. Timestamps are milliseconds since epoch unless a field explicitly says seconds.

## Identity and origins

The service origin owns agent HTTP/MCP APIs, account sign-in, the dashboard and administration. Each page uses a separate origin and its own host-only session cookie. A page key selects a page; it does not authorize a viewer. Mutations and WebSocket upgrades require the page's actual Origin. Owner, approved guest and display permissions come from authenticated sessions, never event data or generation tokens.

Agent tokens authorize `A`, the `api` URL in a page handle. Scoped producer tokens authorize only appends to their explicitly granted streams. Device IDs/secrets establish browser identity for presence, delivery and deduplication; they cannot grant owner privileges.

## Service descriptor and artifacts

`GET /api/service` exposes `contract`, `core_release`, installed workflow interface/schema and implementation revisions, and shared resource policy. `GET A/service` exposes the page's installed interfaces and limits. Browser/device capabilities remain separate. A tool checks its declared requirements before provisioning or writing application data.

Core release, contrib release and page publication are distinct identities. A contrib component release can reuse an existing workflow interface. Trusted implementation changes require deployment composition. A catalog never activates server code.

## Lifecycle and delivery

`POST /api/tendrils` requires an owner email and accepts optional name and mode. Interactive pages require a live receiver or configured wake path before first publication; dashboards can publish without conversational delivery. Owner sign-in claims the page. Claim deadlines, residency, quotas, invited guest approval and suspension are enforced on the server.

`GET A/events?after=<cursor>&wait=<seconds>` requires an explicit nonnegative cursor. Wait is 0–300 seconds. Reconnect after every response. An authenticated agent socket at `A/events/socket` uses `tendriller.agent.v2` and a token or one-use ticket in the WebSocket subprotocol header. It sends count-only wake notices; clients fetch event bodies through the authorized API. Tokens never belong in URLs.

Wake transport success does not prove a host resumed the intended conversation. `POST A/wake/probe`, `GET A/wake/probe` and the returned acknowledgement URL exercise end-to-end delivery. Named consumers add independent processing checkpoints and bounded leases; reading alone never acknowledges handling. See [durability](DURABILITY.md).

## Opaque application data

An application event is data, even when its payload contains `session`, `session_id`, a recipe-like `type`, or any familiar workflow name. Shared state is opaque JSON. No field selects a module, changes an authoritative generation or bypasses permission checks.

Generic `POST A/events` and browser `send` accept a command envelope:

```json
{
  "cid": "stable-command-id",
  "scope": "opaque-scope-id",
  "expected_generations": {"opaque-scope-id":"captured-generation"},
  "data": {"type":"job.status","session":"application-owned value"}
}
```

`scope` is optional; `cid`, `expected_generations` and the operation payload are explicit. An unguarded operation uses an empty generation map. Command IDs are scoped by authenticated actor. Reusing one with different content returns `command_conflict`.

## Authoritative scopes and generations

A scope contains `id`, `generation`, normalized `paths` (arrays of string segments), and explicit operation targets. Supported targets are `state`, `event`, `capture`, `bundle.publish` and `workflow:<module>:<operation>`; a workflow namespace can bind `workflow:<module>:*`. Paths independently protect every state writer. Other platform operations retain their own permission and resource policies.

- `GET A/scopes` reads active descriptors.
- `PUT A/scopes/<id>` registers or rebinds `{cid,expected_generations,paths,operations}`.
- `POST A/scopes/<id>/rotate` deliberately advances a generation.
- `DELETE A/scopes/<id>` retires it.

Lifecycle mutations require authorized control access. Rebinding requires the current generation and always creates a new token. Trusted modules own their scopes and cannot overwrite another controller's bindings. Retired metadata prevents queued work from silently acquiring another meaning.

The server derives required guards from all overlapping paths, explicit operation targets and selected scopes. A write to an ancestor or the document root overlaps a protected descendant. Extra supplied guards are validated too. Missing required guards return `generation_required`; stale, unknown or retired guards return `stale_generation`.

Generation validation, the mutation and its deduplication receipt share the same local transaction. A duplicate accepted command returns its saved result after a lost acknowledgement. It does not apply twice, including after later generation rotation.

## Shared-state writes

`GET A/state` returns `{state,rev,scopes}`. `PATCH A/state` accepts one of:

```json
{"cid":"change-1","expected_generations":{},"ops":[{"op":"set","path":["count"],"value":1}]}
```

```json
{"cid":"replace-1","expected_generations":{},"state":{"count":1}}
```

`set(null)` is a value; `delete` removes a path. Root state remains an object. Prototype-polluting keys, malformed paths, invalid JSON and excessive sizes are rejected. There is no raw merge-patch HTTP body that hides command metadata. The browser's convenience `state.patch` derives explicit operations, persists their original guards, then applies optimism.

HTTP, MCP, WebSocket, whole replacement, bundle restore and trusted-module state changes all use the same protected-operation rule. Imports cannot install authoritative bindings or generations from application JSON. A staged bundle's state is checked against current guards atomically at publication.

## Trusted workflows

The engine's workflow registry is empty. A reviewed deployment statically selects a hash-pinned Worker artifact. `POST A/workflows/<module>/<operation>` invokes one declared operation using the generic command envelope. Page payloads cannot register implementations.

Modules declare their operation permissions, schemas and explicit scope targets. The host passes authenticated identity, namespaced records, state/scopes, blob pinning, participant identities and post-commit effects. It never passes private SQL or the full Durable Object. The operation runs synchronously under the core transaction. A private response stays outside shared page state; archive/reset and generation rotation commit together. Module replacement or removal rotates/retires owned generations even if the interface revision is unchanged.

Contrib owns workflow-specific APIs, defaults, presentation and documentation. Core exposes validated workflow context separately from event `data`.

## Durable browser operations and captures

Before delivery or optimistic application, the runtime durably stores the command ID, original scope and captured generation map. Reconnect/reload use those exact values. Reconstructed optimistic state excludes obsolete commands, and rejection is surfaced without overwriting the current session.

`send`, state writes and captures return accepted, queued or rejected results. An accepted event has a server sequence; queued work has none. Media bytes are uploaded separately, and explicit `capture_complete` admits the associated event using the original preconditions. A payload field cannot impersonate capture completion. See [captures](CAPTURES.md).

## Publications and browser assets

Publishing files snapshots all files under an immutable publication ID and locks the current runtime artifact. HTML injects a first base URL at `P_publications/<id>/` and loads `P_tendril/runtime/<runtime-id>/tendril.js`. The publication manifest lists paths, content types, byte counts and SHA-256 hashes. Runtime manifests do the same for runtime assets and their transitive dependencies.

The executing page pins its browser URL to its publication. Accepting an update navigates to the canonical latest page; a deferred update leaves the existing graph intact. The service worker caches complete, hash-verified graphs and keeps active client/publication associations. Injected HTML is validated by its `X-Tendril-Publication` response header. Non-HTML bytes match their manifest hashes.

Core retains runtime artifacts in the existing FILES bucket across deployments. Page-file pruning preserves current/recent publications, open sockets and thirty-day offline leases. Normal publication A/B and offline recovery operate within this contract; this is not a promise to run historical pre-release clients.

## Remaining platform APIs

Core owns files and versions, health/rollback, authenticated conversation, device purpose/focus, timers, agent context/checkpoints, portability, blobs, streams, activity, delivery and lifecycle. Optional tools, host bridges, preview, components and examples are downloaded from [contrib releases](https://github.com/werg/tendriller-contrib/releases).

Limits are defined in `contract/limits.mjs`, imported by enforcement, and exposed in metadata. [Streams](STREAMS.md) documents stream retention, producer grants and replay. [Architecture](ARCHITECTURE.md) documents artifact composition and verification. [Operations](OPERATIONS.md) documents provisioning, immutable runtime publication and deployment.
