# Unattended work: retries and processing checkpoints

Tendriller stores timer occurrences and incoming events in the page’s Durable
Object. Two additive features make recovery explicit: a notification outbox for
timer runs, and optional named event consumers with leased processing ownership.
Both work without a page tab. They still require an available page, an authorized
agent or notification subscription, and a host that actually runs the agent.

`A` below is the private handle’s API base. Every consumer request requires the
usual `Authorization: Bearer tk_…` token. Page scripts never need these secrets.
Times are epoch milliseconds.

## Timer notification outbox

For a fired timer with `notify:true`, the event, run receipt, notification intent,
and next schedule are committed in one SQLite transaction. A storage failure
rolls all of them back. An interruption after commit leaves an intent the next
alarm can recover. The run ID remains `<timer ID>:<scheduled time>` across every
attempt; repeated alarms do not create another event for that occurrence.

Push delivery happens after this transaction. An attempt is marked `sending`
with a 60-second ownership deadline before contacting the provider. Its network
budget is 30 seconds. If the process disappears, an alarm can reclaim the
attempt after its deadline. A late result cannot overwrite a cancelled or
reassigned attempt.

### Retry policy and cancellation

There are at most six attempts per occurrence, with ordinary retry delays of
10 seconds, 1 minute, 5 minutes, 15 minutes, and 1 hour. Transient transport
failures, timeouts, HTTP 408/425/429, and provider 5xx failures are retried.
Unavailable push configuration and permanent errors stop retries. The existing
20-notifications-per-hour page quota still applies; a quota rejection waits for
the next hour. All retry work expires 24 hours after the occurrence was recorded.

Known successes are remembered per device. If one device succeeds and another
has a transient failure, only the failed device is retried. A retry rechecks
current owner access and current subscriptions, so a revoked subscription or a
device that lost owner access is removed from delivery. A browser that has no
eligible subscription is not repeatedly retried in the hope that it subscribes
later. Local page banners are attempted on the first attempt only.

Every attempt rechecks page lifetime, claim, page/account availability, and the
service write mode. A service read-only period or unavailable account database
defers work for one minute without spending a delivery attempt. A held,
suspended, deleting, unclaimed, or expired page cannot send a retry. Holding the
page cancels outstanding notification intents; lifting that hold does not
resurrect those intents. The timer’s separate missed-run policy still controls
future scheduled occurrences.

Editing, cancelling, rescheduling, or removing a timer cancels its outstanding
notification intents. An already accepted provider request cannot be recalled.
Cancelling a timer does not erase its occurrence event or history.

### Delivery receipts

`GET A/timers/history` and the owner page’s `_tendril/timers/history` include
`delivery` on each run. Old or non-notifying runs have `delivery:null`.

```json
{
  "state": "pending",
  "attempts": 2,
  "next_attempt_at": 1794810060000,
  "last_attempt_at": 1794810000000,
  "last_error": "1 device notification not accepted; retry scheduled.",
  "sent": 1,
  "failed": 1
}
```

| State | Meaning |
|---|---|
| `pending` | An initial or retry attempt is waiting for its deadline |
| `sending` | An attempt owns delivery; its next deadline permits recovery if it disappears |
| `sent` | The provider accepted the tracked deliveries |
| `failed` | A permanent failure, exhausted attempts, or a full retry queue stopped delivery |
| `cancelled` | A timer/page lifecycle change or retry age limit stopped delivery |
| `unavailable` | No eligible subscribed device remains |

`sent` and `failed` count confirmed successes and currently unsuccessful device
targets; they are not human read receipts. `next_attempt_at` is null for terminal
states. The legacy `notification` field remains available for older clients.
Settings displays the delivery state, attempts, retry time, and last error.

The outbox permits 200 active intents. A full queue records a failed receipt
while retaining the timer event. History keeps the newest 200 run records plus
any older active intents until they finish; the API returns the newest 100.
These bounds prevent retries from making page storage grow without limit.

### Honest delivery guarantees

The event/run/intent transaction is durable. Push delivery is **at least once**:
if a provider accepts a request and the process disappears before recording
that response, the recovered attempt can send it again. Every attempt uses the
same run ID as its notification tag so browsers can replace the same visible
notification, but that does not prove the provider or person sees it exactly
once. Confirmed device successes are not resent; an unrecorded success remains
uncertain. Provider acceptance does not guarantee that a browser displays it.

Timer events are ordinary page data and follow normal wake budgets. An agent
that performs work in another service should use the run ID as an idempotency
key there and store the result before acknowledging the event. Notification
failure never removes the event or executes the agent’s work on its behalf.

## Named event consumers

The legacy `GET A/events?after=…` interface, long polling, WebSocket wakes,
existing host bridges, and their cursors are unchanged. New workers may opt into
a server-stored **handled checkpoint** when they need failover or more explicit
processing ownership.

Use the **same consumer name** for replacement workers doing one job. Only one
of them can hold that consumer at a time. Use **different names** for independent
subscriptions that intentionally process the same events, such as a reply worker
and an audit worker. A different name is not a way to take over another worker’s
checkpoint.

Consumer names contain 1–64 letters, digits, periods, underscores, or hyphens and
start with a letter or digit. There are at most 16 names per page. Reuse stable
logical names across process restarts; put the process-specific identity in
`holder`, a 1–100-character label.

### API

| Operation | Request | Result |
|---|---|---|
| Inspect | `GET A/consumers` | `{consumers:[…]}` with checkpoints and current holders, no secret proof |
| Claim | `POST A/consumers/<name>/claim` with `{holder,ttl_seconds?,after?}` | `{consumer,lease_token}` |
| Read or replay | `GET A/consumers/<name>/events?limit=100` | `{consumer,events,cursor,history}` |
| Renew | `POST A/consumers/<name>/renew` with `{ttl_seconds?}` | `{consumer}` |
| Acknowledge handling | `POST A/consumers/<name>/ack` with `{through,gap_acknowledged?}` | `{consumer}` |
| Release | `POST A/consumers/<name>/release` | `{consumer}` without moving its checkpoint |

Reads, renewals, acknowledgements, and release require
`X-Tendril-Lease: <lease_token>` in addition to the agent bearer token. The lease
token is returned only by claim and stored on the server as a hash. Keep it
private and out of URLs. Expiry is 30–900 seconds, default 90 seconds. Renewal
starts that interval from the current server time.

A new consumer starts at zero unless its first claim explicitly supplies
`after`. That initial value must be no greater than the event log’s high-water
sequence. An existing consumer rejects `after`; reclaiming it never overwrites
its handled checkpoint. Each successful claim increases `generation` and issues
a fresh proof. A busy claim returns `409 lease_busy`, with the current holder and
expiry. There is no force-takeover operation; wait for release or expiry.

The public consumer record includes `handled_seq`, the observed/acknowledged
`delivered_seq` ceiling for the current lease, `generation`, and
`lease:{holder,expires_at}` or null. Lease expiry is enforced by server time, not
by a client’s clock. An expired, released, or superseded proof returns
`409 lease_lost`. Release is idempotent for the same proof until another holder
claims the consumer.

### Process, persist, then acknowledge

Reading always starts after the stored `handled_seq`; it never acknowledges the
batch. A worker can read again after an interruption and receive the same
unhandled events. The `limit` is 1–500, default 100. There is no separate `after`
override on a consumer read.

After an event’s reply, state update, or external result has succeeded, advance
`through` to that event’s sequence. Partial progress is supported. Acknowledging
the existing checkpoint is idempotent. A backwards checkpoint is rejected, and
a worker cannot acknowledge beyond the range it read under its current lease.
A replacement holder must read again; an old holder’s proof cannot update its
successor’s checkpoint.

The typed client exposes `consumers`, `claimConsumer`, `readConsumer`,
`renewConsumer`, `ackConsumer`, and `releaseConsumer`:

```js
const { consumer, lease_token } = await client.claimConsumer("replies", {
  holder: instanceId,
  ttl_seconds: 90,
});
const batch = await client.readConsumer(consumer.name, lease_token, { limit: 20 });
if (batch.history.gap) {
  // Reconstruct context before explicitly advancing over unavailable history.
  throw new Error("Recover retained-history gap before processing");
}
for (const event of batch.events) {
  // Application work must be retryable using a key such as `${tendrilId}:${event.seq}`.
  await processAndPersistResult(event);
  await client.ackConsumer(consumer.name, lease_token, { through: event.seq });
}
await client.releaseConsumer(consumer.name, lease_token);
```

This example assumes each batch finishes within its lease. A long-running worker
must renew well before expiry while work is running, and stop dispatching work
if renewal fails. Losing a lease cannot cancel an already running request to a
different service or prohibit ordinary `say`/state calls; those effects still
need idempotency and application-level coordination. Do not acknowledge before
the result is safely recorded merely to avoid seeing an event twice.

MCP provides equivalent `list_event_consumers`, `claim_event_consumer`,
`read_consumer_events`, `renew_event_consumer`, `acknowledge_consumer_events`, and
`release_event_consumer` tools with the same bounded contracts and proof checks.

### Retention gaps are explicit

Leases do not extend event retention: the existing 30-day / 10,000-event bounds
remain. A batch includes:

```json
{
  "cursor": 46,
  "history": {
    "earliest_available_seq": 42,
    "latest_seq": 46,
    "gap": true,
    "missing_through": 41
  }
}
```

`cursor` is the last actual event returned, or the current handled checkpoint
when the batch is empty. It is never silently advanced to the high-water mark.
If all retained events are gone, `events` is empty, `cursor` stays put,
`earliest_available_seq` is null, and `missing_through` identifies the observed
missing boundary. Gaps already observed under a lease remain recorded across
smaller replay batches until acknowledged.

An acknowledgement crossing a gap returns `409 history_gap`. Recover using the
session brief, saved results, or another source of evidence, then explicitly
send `{through:N,gap_acknowledged:true}` for the observed range. This records a
conscious recovery decision; it does not claim the missing inputs were seen.
Even with that flag, advancing beyond the observed event/gap ceiling is rejected.
Events already fetched can be acknowledged if their retained rows expire while
the worker handles them.

### Wakes and compatibility

Consumer reads are immediate reads, not long polls. Keep a persistent host
receiver, or use an explicitly scheduled worker, to start processing. The
existing WebSocket and webhook signals remain count-only wake mechanisms. A
consumer neither runs code on the server nor makes a particular conversation
available when its host is stopped.

Existing bridges may keep using their legacy event-read/local-ack transport
path, then let a worker claim a named consumer for handled progress. The global
legacy transport cursor, the session brief’s `last_handled_seq`, and each named
consumer’s checkpoint are independent. Consumer reads do not advance the legacy
cursor or satisfy the old delivery-probe read requirement; run probes through
the attached bridge/legacy read path as before. A host changing to leased reads
must preserve that transport setup and its verified wake path. No existing
bridge is silently opted into lease mode.

New consumer and notification tables are added when an existing Durable Object
initializes; no D1 migration is needed. Unfinished old timer notifications cannot
be reconstructed retroactively: only new runs create durable intents. Bundle
export and remix do not copy consumers, active leases, or retry jobs.

## Validation

`server/test/durability.public.test.ts` runs against the actual Worker and SQLite
Durable Object. It covers concurrent claims, expired-holder fencing, replay,
partial acknowledgement, retention gaps, bounded contracts, MCP parity, atomic
run/intent rollback, interruptions before and after provider acceptance, partial
device success, revoked/demoted subscriptions, timer cancellation during a send,
backoff/quota exhaustion, service/account/expiry gates, and bounded history.
Contract tests cover nested event validation, private proof transport, and typed
client/result shapes. Fault injection exercises recovery semantics; it does not
claim to test a real push provider or a particular agent host’s idle wake behavior.
