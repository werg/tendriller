# Tendriller public protocol

This is the sole supported **contract 3**. Executable schemas are published at `/contract/v3.json` and generated from `contract/index.mjs`. JSON errors have `{ "error": { "code": "snake_case", "message": "..." } }`. Timestamps are milliseconds since epoch unless a field explicitly says seconds.

## Identity and origins

The service origin owns agent HTTP/MCP APIs, account sign-in, the dashboard and administration. Each page uses a separate origin and its own host-only session cookie. A page key selects a page; it does not authorize a viewer. Mutations and WebSocket upgrades require the page's actual Origin. Owner, approved guest and display permissions come from authenticated sessions, never event data or generation tokens.

Agent tokens authorize `A`, the `api` URL in a page handle. Scoped producer tokens authorize only appends to their explicitly granted streams. Device IDs/secrets establish browser identity for presence, delivery and deduplication; they cannot grant owner privileges.

## Service descriptor and artifacts

`GET /api/service` exposes `contract`, `core_release`, installed workflow interface/schema and implementation revisions, and shared resource policy. `GET A/service` exposes the page's installed interfaces and limits. Browser/device capabilities remain separate. A tool checks its declared requirements before provisioning or writing application data.

Core software releases, cookbook content revisions and page publications are distinct identities. Trusted implementations are deliberately selected by a deployment. Cookbook discovery cannot activate code. Core builds and releases do not depend on contrib executable artifacts.

The [MCP interface](MCP.md) invokes the same authenticated routes and command
semantics as HTTP. It does not define a separate storage or publication model.

## Lifecycle and delivery

`POST /api/tendrils` requires an owner email and accepts optional name and mode. Interactive pages require a live receiver or configured wake path before first publication; dashboards can publish without conversational delivery. Owner sign-in claims the page. Claim deadlines, residency, quotas, invited guest approval and suspension are enforced on the server.

`GET A/events?after=<cursor>&wait=<seconds>` requires an explicit nonnegative cursor. Wait is 0–300 seconds. Reconnect after every response. An authenticated agent socket at `A/events/socket` uses `tendriller.agent.v2` and a token or one-use ticket in the WebSocket subprotocol header. It sends count-only wake notices; clients fetch event bodies through the authorized API. The Durable Object automatically answers exact JSON `{"t":"ping"}` messages with `{"t":"pong"}` while hibernating; host watchers should send a heartbeat more frequently than common proxy idle timeouts (for example every 25 seconds), detect missing pongs, and reconnect with an explicit `after` handled cursor. Arbitrary agent-socket messages are forbidden. Normal disconnects may still occur at network/proxy boundaries: a successful reconnect does not itself imply new work. The service records agent-socket connection and close code/reason/duration in `GET A/activity` without storing credentials, so operator diagnostics can distinguish server close frames from abnormal network disconnects (usually client code 1006). This does not identify an upstream proxy's internal cause without its logs. Tokens never belong in URLs.

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

A scope contains `id`, `generation`, normalized `paths` (arrays of string segments), and explicit operation targets. Supported targets are `state`, `event`, `capture`, `blob.pin`, `file.write`, `publication.publish`, `bundle.publish` and `workflow:<module>:<operation>`; a workflow namespace can bind `workflow:<module>:*`. Paths independently protect every state writer. Other platform operations retain their own permission and resource policies.

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

The browser's connected-only `state.snapshot()` sends
`{t:"state_snapshot",cid}` on its authenticated socket and receives
`{t:"state_snapshot",cid,state,rev,scopes}`. The fields describe one committed
server snapshot. This read has no durable command receipt, queue or optimistic
overlay. It does not wait for unsent local writes and does not install the reply
over the browser's evolving local view. A later write can make it stale; capture
its revision and relevant scope generations as write preconditions. Offline or
disconnected reads fail explicitly; a missing response times out after 15 seconds.

`set(null)` is a value; `delete` removes a path. Root state remains an object.
Array path segments are literal keys; dots and slashes inside them do not split.
Dotted strings split on dots and ignore empty segments. Numeric segments become
object keys; arrays are whole values, never indexed update containers. Missing
object parents can be created, but explicit traversal through an existing array,
scalar or null fails atomically with `state_conflict`. Replace that parent with
an explicit `set` when replacement is intended. The browser's RFC 7396 merge
patch conversion deliberately emits such parent replacements.

State-write envelopes also accept `conditions` and `expected_revision`:

```json
{
  "cid": "claim-item-1",
  "expected_generations": {},
  "conditions": [{"path":["claims","item-1"],"exists":false}],
  "ops": [
    {"op":"set","path":["claims","item-1"],"value":"device-a"},
    {"op":"set","path":["items","item-1","status"],"value":"claimed"}
  ]
}
```

Every condition is exactly `{path,equals:<JSON>}` or `{path,exists:<boolean>}`.
All conditions are checked against the same authoritative pre-mutation state,
then all operations commit together. Missing differs from null. Object equality
ignores key order; arrays compare as complete ordered values. A condition whose
path crosses a non-object ancestor fails, including an `exists:false` condition.
The empty path denotes the whole object. Up to 128 conditions and 64 KiB of
normalized condition JSON are allowed; paths and JSON nesting are bounded to
128 levels. Non-JSON values, sparse arrays, prototype keys and excessive sizes
are rejected before admission.

`expected_revision` is an optional nonnegative safe integer matched to the global
state revision. It detects change-and-change-back (ABA) as well as unrelated
writes. Field conditions allow independent edits to different fields. Both may
be supplied, including with an empty operation list for a conditional check.
Every nonempty accepted batch advances the revision once, even for equal values.

Scope selection includes condition-read paths as well as write paths. Generation
guards, conditions and operations run under the same transaction. A failed
condition or incompatible write path returns HTTP 409 `state_conflict`, with the
observed `rev` and `conflict` (`kind`, optional condition index and path), without
state, revision, activity or state-stream effects. It reveals no current field
values. WebSocket rejection is followed by an authoritative `state_reset`.
The terminal conflict receipt is durable: retrying the same command returns that
same rejection even if the condition later becomes true. Accepted receipts also
replay unchanged. Changed predicates under the same ID produce `command_conflict`.
After review, revised intent needs a new command ID. Malformed, authorization,
generation and receipt-quota failures do not consume the ID; receipt-quota
failure rolls back the entire attempted mutation.

These checks provide optimistic concurrency, not permission or application
policy. An otherwise authorized writer can omit a condition. Enforced ownership,
private records or booking rules require an authorized trusted operation.
There is no raw merge-patch HTTP body that hides command metadata.

HTTP, MCP, WebSocket, whole replacement, bundle restore and trusted-module state changes all use the same protected-operation rule. Imports cannot install authoritative bindings or generations from application JSON. A staged bundle's state is checked against current guards atomically at publication.

## Trusted workflows

The engine's workflow registry is empty. A reviewed deployment entry explicitly selects exact implementations through `configureWorkflows`. `POST A/workflows/<module>/<operation>` invokes one declared operation using the generic command envelope. Page payloads cannot register implementations.

Modules declare their operation permissions, schemas and explicit scope targets. The host passes authenticated identity, namespaced records, state/scopes, blob pinning, participant identities and post-commit effects. It never passes private SQL or the full Durable Object. The operation runs synchronously under the core transaction. A private response stays outside shared page state; archive/reset and generation rotation commit together. Module replacement or removal rotates/retires owned generations even if the interface revision is unchanged.

Each selected implementation owns its operation schema and application policy. Cookbook references explain defaults, alternatives and verification; they are not installed by discovery. Core exposes validated workflow context separately from event `data`. Private records have per-record, count and aggregate-byte quotas, enforced within the operation transaction; a quota failure rolls back state, records, generations and effects together.

## Durable browser operations and captures

Before delivery or optimistic application, the runtime durably stores the command ID, original scope and captured generation map. Reconnect/reload use those exact values. Reconstructed optimistic state excludes obsolete commands, and rejection is surfaced without overwriting the current session.

`send`, state writes and captures return accepted, queued or rejected results. An accepted event has a server sequence; queued work has none. Media bytes are uploaded separately, and explicit `capture_complete` admits the associated event using the original preconditions. A payload field cannot impersonate capture completion. See [captures](CAPTURES.md).

For acknowledged browser state and `send` commands, including conversation
instructions, the original server outcome is a durable phase of the existing
local outbox row. Terminal result notifications follow committed removal of
that row. Storage failure during settlement keeps the command unresolved; a
saved outcome resumes local cleanup without resending the mutation after
reload. This also prevents an uncached authority or rate-limit rejection from
later becoming a fresh server decision after the page reported it as terminal.
An outcome that could not be saved before interruption remains uncertain and
may replay its unchanged command. Accepted state outcomes still require a full
state resynchronization when a newer delta arrived before their own ACK.

Admitted browser state results include their command `cid`. `state.pending()`
and `state_queue` expose detached original commands from the existing durable
outbox, and `state_result` carries the original normalized operations and guards
for correlation after reload. Terminal outcomes remove those commands from the
pending view; it is not a second queue or a retained history. Local admission
failure has no durable result identity. Empty unconditional work is explicitly
`unchanged`, with no command or server acceptance. Empty conditional checks are
admitted commands and still receive an authoritative outcome.

## Conversation and interaction

A transcript entry has a persistent message ID; owner messages also retain their original command ID and device. Replies can reference the exact owner message. Repeated identical text is never used to match acknowledgements. Retries and reconnect history preserve those identities. `conversation.presented(messageId)` records presentation of an actual stored agent message; merely receiving the socket frame is not presentation.

The kernel exposes conversation data and durable send results without mounting application UI. The hosted utility exposes management/recovery access and active-sensor stop. Permission requests, spoken output, microphone input and notification subscription require explicit page behavior and user consent. Device purpose, speech target and display targeting affect presentation, not authorization. Local mute/stop choices remain local.

## Immutable bytes and shared files

`POST A/uploads` reserves `{cid,sha256,size,type,name?}` and returns an immutable
upload/session identity. Send raw bytes with `PUT A/uploads/<id>/content`
(`application/octet-stream`), then `POST A/uploads/<id>/complete`. Start/status,
completion and retries agree on the original digest, length and blob ID. A known
digest is reused only when its authoritative stored length also matches.
`GET A/uploads/<id>` resumes status and `DELETE A/uploads/<id>` aborts unfinished
work. Upload receipts retain their IDs within a bounded page budget; reaching the
budget rejects new work without forgetting accepted identities.

`GET A/blobs?after=<id>&limit=100` lists metadata in ID order with an explicit
continuation cursor. `GET A/blobs/<id>/info` returns `{id,sha256,size,type,url,
created_at,retention}` and optional name. `GET`/`HEAD A/blobs/<id>` retrieve bytes
with optional single byte ranges. Downloads default to attachment disposition;
`?disposition=inline` remains sandboxed. `PUT A/blobs/<id>/pin` is a guarded
`{cid,expected_generations,scope?,keep}` command. Pins, icons, current shared files,
retained file history, staged imports and publications retain their content. Unreferenced uploads
expire after 30 days regardless of who uploaded them. Application JSON containing
a blob ID is not itself a retention root.

Shared files are mutable names pointing to immutable bytes. `GET A/file-refs?path=…`
returns the current head, including a tombstone's retained revision. `PUT` writes
`{cid,expected_generations,scope?,path,expected_revision,blob_id,name?,type?}`;
`DELETE` uses the same original guards/path/revision without a blob. Missing or
stale revisions reject. A file write targets `file.write` and `["files",path]`,
where the canonical whole file path is one segment. Names must use NFC, with no
traversal, empty segments or reserved service paths.

The authoritative scope registry is the sole source of file bindings. To protect
one file, register `paths: [["files","reports/result.json"]], operations: []`.
Bindings combine by OR: an operation binding of `file.write` protects every file
mutation. Every write checks all matching current registry generations, even if
the command omits `scope`. Optional command `scope` adds a precondition for that
operation; it never establishes a persistent file binding and is not file metadata.
Retiring a scope rejects old commands carrying that guard. Fresh authorized work
uses the current file revision and any remaining active registry guards. An
ordinary `DELETE` then creates the next tombstone; there is no separate cleanup
operation and deletion never resets the revision to zero.

`GET A/file-refs/snapshot` returns the complete bounded active set plus cursor.
Capacity and UTF-8 metadata-byte bounds are enforced atomically on writes;
snapshots never silently truncate. History retains the current revision and up
to ten prior revisions for 30 days. `GET A/file-refs/history?path=…` exposes that
history. `GET A/file-refs/changes?after=N&limit=100` returns ordered changes;
`410 file_cursor_expired` means history was pruned and requires a fresh snapshot.
Deletion does not erase the path's CAS identity.

The same upload/blob/file-reference paths under `P_tendril/` use page session and
same-origin authorization. Uploads also require a registered device proof.
Owner/approved-guest sessions can write shared data; displays can read but cannot
write. Only owners may change blob pins. Page sessions cannot publish code.
These shared-data routes provide no private-record or per-participant media
policy; that requires a deliberately selected trusted capability.

## Publications and browser assets

`GET A/publications` exposes current/latest/healthy/served versions and a monotonic
`head_revision`. `GET A/publications/<version>` gives the exact declared entry and
sorted files with blob IDs, types, verified digests and byte counts.
`POST A/publications` accepts `{cid,expected_generations,scope?,expected_head_revision,
entry,files,message?}`. Its files are the complete graph of `{path,blob_id,type}`;
the entry must be one of its authored HTML files. A replacement targets
`publication.publish` and the whole `["publications"]` namespace, including removed
paths. `POST A/publications/rollback` requires the same guards/head plus an explicit
version. Every publication selection, including recovery and health fallback,
advances the head revision. Retried accepted commands return their saved receipt;
stale new work requires review.

Publishing snapshots all files under an immutable publication ID and locks the current runtime artifact. HTML injects a first base URL at the requested HTML file’s encoded directory under `P_publications/<id>/` and loads `P_tendril/runtime/<runtime-id>/tendril.js`. The publication manifest lists paths, content types, byte counts and SHA-256 hashes. Runtime manifests do the same for runtime assets and their transitive dependencies. `publication.base` is the immutable root and required `publication.entry` is the canonical authored HTML entry, unchanged across document responses. Required `documentPath` carries the decoded logical path of the current HTML document; it is `null` only without a publication. Current-document base, pinning, and update reload use `documentPath`; service-worker announcements and root navigation use the canonical manifest. Path segments are URL-encoded separately. Publication roots select the canonical entry; explicit nested directory URLs select their declared `index.html`. Missing routes return 404. Hash routing and explicit multi-page publications need no application framework. An authored install manifest is preserved.

The executing page pins its browser URL to its publication. Accepting an update navigates to the canonical latest page; a deferred update leaves the existing graph intact. The service worker caches complete, hash-verified graphs and keeps active client/publication associations. Injected HTML is validated by its `X-Tendril-Publication` response header. Non-HTML bytes match their manifest hashes.

Offline readiness is acknowledged for one exact publication. Page code calls `tendril.publication.saveOffline()` and awaits success. At the transport boundary, send `{ t: "publication", publication: <manifest> }` to the activated controlling service worker with a transferred `MessageChannel` port. It replies on that port with `{ t: "publication", id: <publication-id>, status: "ready" }` only after the complete asset graph, client binding and cleanup metadata have been committed. A failed request replies with `status: "error"` and `error: { code, message }`; the codes are `invalid_publication` and `publication_save_failed`. Asset visibility in the Cache API alone does not establish readiness. Optional lazy runtime resources are cached and verified when first used.

Core retains runtime artifacts in the existing FILES bucket across deployments. Page-file pruning preserves current/recent publications, open sockets and thirty-day offline leases. Normal publication A/B and offline recovery operate within this contract; this is not a promise to run historical pre-release clients.

## Remaining platform APIs

Core owns files and versions, health/rollback, authenticated conversation, device purpose/focus, timers, agent context/checkpoints, portability, blobs, streams, activity, delivery and lifecycle. Optional CLI, host bridges, exact-file preview and collectors are distributed as the separate core tools archive. [Cookbooks](https://github.com/werg/tendriller-contrib) guide page-owned presentation and domain decisions.

Limits are defined in `contract/limits.mjs`, imported by enforcement, and exposed in metadata. [Streams](STREAMS.md) documents stream retention, producer grants and replay. [Architecture](ARCHITECTURE.md) documents artifact composition and verification. [Operations](OPERATIONS.md) documents provisioning, immutable runtime publication and deployment.
