# Request-driven session hosting

`@tendriller/core/serverless` adapts an already configured application session to
finite HTTPS requests. It supplies no identity, permissions, engine or storage
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
- `openSession({store, signal})`, returning `{session, flush?, close?}`. Flush
  persists the original saved intents even on command wait failure. Close releases
  that request's owned resources; it does not rotate the device identity.

The default response deadline is 30 seconds (`timeoutMs`, maximum 120 seconds).
JSON bodies and GET query input are limited to 64 KiB (`maxBodyBytes`, maximum
1 MiB); a batch has at most 64 commands. Supply a distinct retained `operationId`
for each batch item. Batches execute sequentially, **not atomically**.

A deadline bounds the response, not a promise that non-cooperative engine work has
stopped. Physical work retains its owner lock until it settles and flush/close
complete. This can block subsequent requests; it cannot admit a second writer.
Do not treat cancellation as permission to start another device or unlock storage.

Command responses distinguish `recorded`, `applied`, `rejected`, `unknown`,
`abandoned`, `needsReapply`, and `not_submitted`. An uncertain attempted command
returns HTTP 202 with its original ID and error, rather than claiming rejection.
Inspect `/v1/apps/APP_ID/operations/OPERATION_ID`; never create a new ID to replace
an uncertain command. Recovery states require deliberate application recovery.
Batch error responses retain completed results and identify the unsubmitted tail
with `complete: false`. Flush/close failures remain errors even after a known
applied result; the known result is retained alongside them. A primary execution
failure remains primary, with `cleanupErrors` reported separately.

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
