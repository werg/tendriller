# Retained record logs

The resident-agent deployment uses a native Chronolog finality provider by preference;
this Cloudflare log is an optional retained-storage/finality adapter. It is not
required for peer connections or application backends.

A resident Tendril can retain one opaque record history. Each append stores exact
bytes at a contiguous position, with content identity and a rolling integrity root.
Identical bytes always return the original entry. No record expires or is trimmed.

This primitive supplies storage and delivery. Applications verify their own author
signatures, membership, inclusion/closure proofs and SQL outcomes. A log position, hash,
or append response alone makes no assertion about database success or finality.
Chronolog replicas always derive application execution order from signed author
time and deterministic tie-breakers; receipt positions only enumerate inclusion.

## Provisioning and access

Claim the Tendril through the normal owner flow and set `lifetime` to `resident`.
Then call `records.provision()`. Provisioning is idempotent and returns the same
server-generated history identity. Page publication and rollback do not change it.
The owner page session and ordinary authorized agents can provision, append and
read. Guests, display links, stream producer tokens, and anonymous visitors cannot.
Record access never creates database membership or distributes application keys.

A Tendril containing a log cannot be switched to ordinary idle-expiring lifetime.
Provisioning and lifetime changes share a commit guard: a pending downgrade
prevents a new retained log from being committed while its account update is in
flight. An interrupted lifetime change retains its target and resumes on the next
request or alarm, including after restart.
Explicit Tendril/account deletion and other administrative lifecycle actions still
apply. Retention is for the Tendril lifetime, not an independent archive guarantee.

## Native and browser clients

The SDK and the headless browser runtime share one implementation:

```js
import { createClient } from '@tendriller/core';
const agent = createClient({ api, token });
const log = agent.records;
// In an authenticated page: const log = tendril.records;

const { descriptor, head } = await log.provision();
const historyId = descriptor.historyId;
// Persist historyId, operation identity and exact bytes in application storage
// before sending. Retry the same bytes after a lost/uncertain response.
const stored = await log.append(exactSignedBytes, { historyId });
const page = await log.read({ historyId, after: head.position, previous: head });

const stop = log.watch({
  historyId, after: page.cursor,
  onError(error) { console.error(error.code, error.message); },
}, latestHead => {
  // Schedule retained reads from the application's durable applied cursor.
  // Receiving this notification does not advance that cursor.
});
```

`@tendriller/core/records` exports the same client without the larger SDK:

```js
import { createRecordLogClient } from '@tendriller/core/records';
const log = createRecordLogClient({
  base: api,
  headers: () => ({ Authorization: `Bearer ${token}` }),
  subscribeHints: onHint => connection.onRecordHeadOrReconnect(onHint),
});
```

The page runtime connects watch to its existing socket and reconnect events.
Agent hosts can supply the same callback through `createClient`'s `recordLogHints`
option. Hosts without a socket can use the default one-second head polling.
With socket hints the fallback poll is thirty seconds. All watch events remain
hints: missed events are repaired by retained reads. Stop unsubscribes and aborts
an outstanding observation. Methods also accept an optional `AbortSignal`.

The client checks exact append receipts, content digests, entry continuity, and
the read page's stated head. Supplying `previous` binds catch-up to a head already
stored by the application. Watch reports backwards or conflicting head observations.
An application must retain its trusted history identity and durable verified prefix
across restarts; the transport does not introduce another application outbox.

## HTTP and bounds

These paths are relative to the agent API or the page's `_tendril/` prefix.
Mutation requests on the page path retain the normal same-origin checks.

| Method and path | Body/query | Result |
| --- | --- | --- |
| `POST records` | Empty object | `{descriptor, head}` |
| `GET records` | Optional `historyId` | `{descriptor, head}` |
| `POST records/entries` | `{historyId, record, expectedHead?}` | Original immutable entry |
| `GET records/entries` | Required `historyId`, `after`; optional `limit` | Contiguous bounded page and current head |

`record` is canonical padded base64. Entries contain `historyId`, `position`,
`recordId`, `previousRoot`, `root`, and `record`. A head contains `historyId`,
`position`, `root`, and total raw payload `bytes`. A page contains `historyId`,
`after`, `cursor`, `entries`, and `head`. `cursor` is the last returned position.

Optional `expectedHead: {position, root}` makes a fresh append conditional on that
exact predecessor. A mismatch returns `409 record_head_conflict` without retaining
the bytes. An exact byte retry returns its original receipt even if the head has
since advanced. This generic condition lets a finality adapter bind a signed
closure to its preceding prefix; the host does not interpret that record.

Records contain 1–262,144 bytes. Pages contain at most 128 entries and 1,048,576
encoded entry bytes; callers continue from the returned cursor. The history holds
at most 100,000 entries and 67,108,864 raw payload bytes. Metadata and base64 storage
overhead are additional. A full history returns `record_log_full`; earlier entries
remain readable and duplicate retries still return the original position.

`history_mismatch`, `history_gap`, and `cursor_ahead` require application attention.
Never silently replace the history or skip a missing range. `record_log_busy` is a
transient concurrent-append failure; retry the exact bytes. A timeout, network error,
or signing failure in a consuming application is not evidence that append failed.

## Integrity encoding

The portable format is `record-log/v1`. SHA-256 values are lowercase 64-character
hex. History identities are `h_` followed by 32 lowercase hex characters. Positions
are safe nonnegative JavaScript integers; entries start at one.

- `recordId = SHA256(exact bytes)`.
- Empty root hashes UTF-8 `JSON.stringify(["record-log/v1", "genesis", historyId])`.
- Entry root hashes UTF-8 `JSON.stringify(["record-log/v1", "entry", historyId,
  position, previousRoot, recordId])`.

Arrays use compact JSON without whitespace or a trailing newline. Restricted
field types make this encoding unambiguous. The public module exports helpers and
verification, and contract tests cross-check the encoding with Node's SHA-256.

Storage computes hashes outside synchronous transactions. Inside the transaction it
rechecks the captured head and current local authorization, then commits the entry,
unique content index, accumulated bytes and root atomically. Unconditional concurrent
writers retry a changed head internally; conditional appends must still match
their original predecessor. Notifications happen after durable commit.

## Recovery and deployment

This unreleased baseline uses page schema revision **8**, with no compatibility or
data migration. The checked-in canonical deployments still name revision-5 storage.
Deploy this code only to fresh resources selected deliberately; changing a schema
environment variable does not translate an existing namespace.

There is no administrative in-place history restore operation in this API. Restore
all committed history faithfully or retire that lineage and provision a different
Tendril/history. Resuming an old storage copy under an existing history identity
could reuse a committed position; it is unsupported. Consumers must halt on any
conflicting retained prefix rather than treating the copy as a fresh history.

An optional finality provider can compose around the public engine handler and read this
log through its public client. It must obtain the committed head itself and keep
its prefix certificates outside the log it certifies. Signed closure markers are
ordinary retained bytes committed before the covering certificate. Native finality
signing keys remain outside Tendriller. The separate [membership administrator](MEMBERSHIP.md)
stores its own private root/key material and roster decisions in the page's
private durable store; it uses the native certified ledger and does not provision
this optional retained Cloudflare log.
