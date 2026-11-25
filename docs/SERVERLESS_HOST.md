# Request-driven session hosting

`@tendriller/core/serverless` is an explicit, optional request-driven hosting
adapter. No application requires it for browser reads, durable local writes or
peer convergence. It adapts an already configured application session to finite
HTTPS requests. It supplies no identity, permissions, engine or storage
owner election. Use the matching public Chronolog session/engine and preserve the
same device and original operation IDs between requests.

Construct `createServerlessHostAdapter` with all of:

- `applicationId` and durable byte `storage` (`get`, `put`, optional `list`).
- `authorize(request)`, returning exactly `true` for permitted requests. Check the
  caller's rights for the requested operation, not only its login. All HTTP routes,
  including health, require authorization; the adapter grants no public writes.
- `withLock(applicationId, work, {signal})`, supplied by the host's real storage
  owner. It must serialize **every** writer of this application's bytes across
  isolates/processes, and await `work()` through flush and owned close. An
  isolate-local promise queue or independent locks in separate Workers do not
  meet this requirement. A host may cancel queued admission using `signal`; it
  must never release an acquired lock while `work()` is still running.
- `retainTask(task)`, registering the physical work with the embedding execution
  context **before it starts**. In a Cloudflare Worker, bind this to
  `task => ctx.waitUntil(task)` on a per-request adapter. A module-global Promise
  does not extend a Worker request's lifetime. Other hosts must supply their real
  task-lifetime guarantee; a no-op is valid only if that guarantee already covers
  the entire physical operation and cleanup. The hook receives an observed,
  settling Promise, so request errors are not duplicated in host error logs.
- `openSession({store, signal})`, returning `{session, flush?, close?}`. The session
  is the common Chronolog `ApplicationSession`. Flush persists the original stored
  intents even when an optional wait fails. Close releases
  that request's owned resources; it does not rotate the device identity.

The default response deadline is 30 seconds (`timeoutMs`, maximum 120 seconds).
JSON bodies and GET query input are limited to 64 KiB (`maxBodyBytes`, maximum
1 MiB); a batch has at most 64 commands. Supply a distinct retained `operationId`
for each batch item. IDs follow the canonical 512-code-unit nonempty text limit
(no control characters below U+0020). Every command must supply its own `input`
field; use `null` deliberately for a command without arguments. Batches execute sequentially, **not atomically**.

A deadline bounds the response, not a promise that non-cooperative engine work has
stopped. Physical work retains its owner lock until it settles and flush/close
complete. The embedding execution context must retain that physical task. A generic
Promise or a lock alone does not guarantee post-response execution in a Worker.
This can block subsequent requests; it cannot admit a second writer.
Do not treat cancellation as permission to start another device or unlock storage.

## Routes, commands and operation facts

All routes sit under `/v1/apps/APP_ID/` and require `authorize`.

| Route | Behavior |
| --- | --- |
| `GET health` | Authorized liveness; opens no session. |
| `POST query` / `GET query?query=&input=` | `session.query(name, input)`, returned as `{applicationId, revision, value}`. Any other shape, or another application ID, is `SERVERLESS_SESSION_INVALID`. |
| `POST commands`, `POST commands/batch` | `session.command(command, input, {operationId})`. |
| `GET operations/OPERATION_ID[?wait=FACT]` | Inspect the operation through `session.operations.get(id)`. Unknown IDs return 404 `operation_not_found`. |

A command body has exactly `command`, `input`, the original `operationId` and an
optional `wait`. Any other field is rejected with 400. There is no `basedOn`
ordering prerequisite, because the session orders operations by signed author time
and never by request order. The adapter has no retry route or queue: retry is
the same command body with the same `operationId`, which the session resolves to
the original signed proposal.

`wait` selects one independent fact to observe before responding:

| `wait` | Meaning |
| --- | --- |
| `stored` (default) | `session.command` resolved, so the exact signed intent is durable in the owned store. No network, materialization or retention wait. |
| `materialized` | The current accepted or rejected outcome exists at a revision. It remains revisable by earlier operations. |
| `retained` | Authenticated peer retention evidence exists. |
| `finalized` | Closed-time finality verifies under the configured policy. Under the `none` policy it is rejected as `finality_unsupported` (409) before submission, so no command is stored for it. |

The old `recorded`, `applied`, `saved` and `shared` values, and the
`lifecycle` ladder with `abandoned` and `needsReapply`, do not exist. Unknown
values are rejected with no aliases.

Each command result is `{operationId, command, submission, wait, operation}`.
`submission` is `not_submitted`, `uncertain` (attempted, but the durable storage
reply was not observed) or `stored`. `operation` is an explicit plain-data
projection of the session's operation inspection: `applicationId`, `author`,
`authorTimestampMs`, `proposalId`, `operationId`, `stored`, `pending`,
`materialized` (`outcome`, `rejectionCode`, `failingStatementIndex` and revision
digests), `retained` (`peer`, `storageId`), `finalized` and `excluded`. The
session, its operation handle, private owner state and signed evidence bytes are
never serialized.

An `uncertain` submission returns HTTP 202 with its original ID and error. A
`stored` command whose wait reaches its deadline or wait timeout also returns 202,
because the work is durable. Inspect the operation rather than creating a new ID.
An operation that a configured closed frontier excluded fails its wait with 409,
`excludedOperation` and `excluded: true`. Its original intent stays inspectable
and is never retimestamped or resubmitted. Batch error responses retain completed
results and identify the unsubmitted tail with `complete: false`. Flush/close
failures remain errors even after known results, which are retained alongside
them. A primary execution failure remains primary, with `cleanupErrors` reported
separately.

`storage.list()` may return a Durable Object-style `Map<string, bytes>` snapshot
or an array of keys. Map values are copied directly, without rereading newer rows.
The adapter's public `store.entries()` holds the owner lock through enumeration;
internal session IO uses the already-held lock. The standalone
`createTransactionalBytesStore(storage)` is a raw wrapper: its caller must hold
its own owner lock around the entire enumeration, especially for a key-list
backend. Ordinary eventual-consistency KV alone supplies no such lock or atomic
snapshot.

These are generic adapter contracts. Portable unit tests do not qualify a
particular deployed Durable Object, SQL engine, or post-exit host availability.
