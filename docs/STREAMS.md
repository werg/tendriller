# Streams: messaging and continuous data

Tendriller exposes named streams with a common record envelope, independently
authorized producers, and consumers that keep their own cursors. This supports
training dashboards and machine telemetry while preserving existing page and
agent messaging.

## Responsibilities

- A **stream** names a sequence of records within one tendril. Its durability and
  audience are explicit and immutable.
- A **producer** is an authenticated publisher. A machine collector receives a
  revocable token restricted to named custom streams. It cannot read events,
  modify the page, mint credentials, or impersonate the owner.
- A **consumer** chooses streams and keeps a separate cursor for each. Reading
  data never acknowledges successful application processing.
- The **agent** configures streams, builds pages, and interprets selected data.
  It does not run once per sample. Custom stream traffic never wakes it.

An optional supervised collector runs on the agent's machine independently of
the conversation. It can collect local utilization, tail training files, and
receive JSONL through explicitly configured SSH commands. It sends outbound
HTTPS requests to Tendriller; a dashboard uses its existing authenticated page
connection. Neither the training machine nor SSH hosts need a public listener.

## Two delivery policies

| Policy | Payload storage | Disconnection behavior | Typical use |
|---|---|---|---|
| `durable` | Append-only bounded SQLite history | Replay from a sequence cursor; report retention gaps | Training loss, logs, milestones |
| `ephemeral` | No payload storage or replay | Samples without a connected subscriber are lost | Current utilization, progress animation, presence |

Durability is a property of the stream, not the identity of its consumer. A
durable stream can serve a live chart and an independent historical reader.
An ephemeral stream must not acquire an offline outbox just because another
Tendriller message type uses one. Its small sequence counter and configuration
may be persisted; its record payload is not.

`durable` does not mean unlimited retention or exactly-once application effects.
The server acknowledges after committing a batch. A producer retries a lost
acknowledgement with the same record IDs; deduplication is scoped to that
producer and stream, within the retained history. Consumers must make their
own effects idempotent and store their cursor after handling a record.

Use a durable stream when past utilization matters. The same machine may
publish low-rate durable utilization and higher-rate ephemeral samples.

## Existing messaging becomes built-in streams

| Name | Policy | Readers | Existing source of truth |
|---|---|---|---|
| `system.events` | Durable | Agent | Page events, instructions, timers, wake metadata |
| `system.logs` | Durable | Agent | Browser console diagnostics |
| `system.transcript` | Durable | Page | The shared conversational transcript |
| `system.state` | Ephemeral | Page | Changes to the independently stored shared-state snapshot |
| `system.presence` | Ephemeral | Page | Agent presence changes |

The built-ins are adapters over the existing stores and writers, rather than
second copies of the same data. Existing event, log, and transcript sequence
numbers remain valid. Their existing retention bounds apply. Existing HTTP,
WebSocket, MCP, wake, and leased event-consumer APIs remain supported.

Built-ins are read-only through the generalized stream API. Write messages with
`tendril.send`, `say`, state operations, and their existing APIs so that owner
instruction provenance, wake budgets, speech targeting, offline handling, and
revision rules still apply. A custom record whose `type` is `instruction` is
ordinary data; it never becomes an owner instruction.

Shared state is a materialized snapshot, not an append-only history. Read the
snapshot using the state API; `system.state` only reports changes while
subscribed. Request/reply operations such as `eval` retain their own lifecycle.

## HTTP API

`A` is the tendril's private API base. Agent credentials manage streams and
producer grants. Stream names match `[a-z][a-z0-9._-]{0,63}`; `system.*` is reserved.

| Operation | Endpoint |
|---|---|
| List streams | `GET A/streams` |
| Create a custom stream | `POST A/streams` |
| Inspect policy | `GET A/streams/<name>` |
| Append a batch | `POST A/streams/<name>/records` |
| Read retained records | `GET A/streams/<name>/records?after=<seq>&limit=<n>` |
| List/create producer grants | `GET/POST A/producers` |
| Revoke a producer | `DELETE A/producers/<name>` |

For example, create a durable training stream:

```json
{
  "name": "training.metrics",
  "durability": "durable",
  "readers": "owner",
  "max_records": 10000,
  "max_age_seconds": 86400
}
```

Use `durability: "ephemeral"` without retention fields for a live-only stream.
`readers` defaults to `owner`; explicitly choosing `page` also exposes records
to authorized guests and display links. These are read permissions. Display
and guest access never grants publishing permission.

A producer grant contains a name and an explicit list of custom streams. The
returned `tp_…` token is shown once. Save it in a private configuration file,
not in page code, URLs, terminal arguments, or shared logs. It authorizes only
appends to those streams. Revocation takes effect on the next append.

An append contains up to 100 records:

```json
{
  "records": [{
    "id": "run-42:worker-0:step-100",
    "ts": 1794744000000,
    "type": "training.metrics",
    "data": {"source": "gpu-box", "run": "run-42", "step": 100, "loss": 2.1}
  }]
}
```

The server returns records in the common envelope:

```json
{
  "stream": "training.metrics",
  "seq": 17,
  "ts": 1794744000000,
  "received_at": 1794744000250,
  "producer": "producer:training-host",
  "id": "run-42:worker-0:step-100",
  "type": "training.metrics",
  "data": {"source": "gpu-box", "run": "run-42", "step": 100, "loss": 2.1}
}
```

`seq` is the server ordering within the stream. `ts` is the producer's sample
time, and `received_at` is server arrival time; do not order records from
different machines by their unsynchronized clocks. Run/step/source/rank are
application data, so the transport remains useful beyond ML telemetry.

Reads require an explicit nonnegative `after` cursor and accept a limit of
1–500. The result contains `records`, `cursor`, and `history` with the retained
lower boundary, high-water sequence, and any missing history. The cursor is
the last returned sequence, not an implicit acknowledgement. Ephemeral reads
fail with `not_replayable` instead of returning misleading empty history.

## Browser consumers

The injected runtime exposes `tendril.streams.list()`, `.info(name)`,
`.read(name, {after, limit})`, `.subscribe(name, handler, options)`, and
`.publish(name, {records})`. HTTP reads use `_tendril/streams` and page sessions;
the browser never needs an agent or producer token.

Subscriptions share the authenticated page WebSocket. They are explicit per
stream, restored after reconnect, and authorized against the stream audience.
A durable subscription can request `after` to replay history before delivering
new samples. Registration captures a high-water mark; the runtime catches up
in pages while holding new frames, avoiding a query/subscribe race. Retention
gaps are surfaced to the caller. Ephemeral subscriptions resume only live data.
Unsubscribe when a chart is removed.

Subscription cursors live in memory and represent callback delivery, not
successful asynchronous processing. Persist a cursor in your application and
pass it as `after` to resume across page reloads, or use explicit reads when
processing needs its own handled checkpoint.

Only an owner page may publish to custom streams. Browser stream publishing
requires a live connection; callers that need durable offline production use
the collector. Existing `send` and shared-state offline behavior is unchanged.

## Lifecycle, limits, and operational boundaries

Create a telemetry-only page with `mode: "dashboard"`. It can publish without
an agent wake receiver. The default `interactive` mode retains the receiver
requirement. This changes readiness, not access control, page/account lifetime,
ownership, holds, or write-pause enforcement. Use a claimed resident tendril for
an ongoing dashboard within the account's existing resident allowance.

Producer activity is separate from conversational presence. A collector upload
updates its own `last_seen`; it does not mark the AI as attentive or clear a
pending wake. The dashboard should show the last sample time and distinguish a
connected browser from a healthy data source.

Page bundles do not copy stream history or producer credentials. The existing
remix operation creates an interactive page with its receiver requirement. To
reuse a passive dashboard, create a new `dashboard` destination, import its page
bundle, and provision streams and producers for that destination.

The custom stream allowance is separate from file/blob storage: 8 MiB on a
claimed tendril (1 MiB unclaimed), with at most 20,000 retained records across
all custom streams. A record is at most 64 KiB; an append request is at most
256 KiB and 100 records. Reads return at most 500 records or 512 KiB, so paginate
using their returned cursor even when fewer than the requested number arrive.
There are at most 64 custom streams, 32 producers, and 16 subscriptions per
socket. Ingestion is limited per principal and across the tendril.

Backpressure is explicit: a full durable spool
or rejected append must report its status rather than silently claiming data
was saved. Live samples may be dropped/coalesced; training must continue when
telemetry is unavailable.

This implementation keeps stream ownership within a tendril and adds no new
infrastructure. Long-term archival, cross-tendril source sharing, server-side
downsampling, and generic leased worker groups can be added behind the stream
interfaces when required. The existing leased consumers remain available for
`system.events`; general consumers use their own persisted replay cursors.

See [COLLECTOR.md](COLLECTOR.md) and
[the training dashboard example](../examples/training-dashboard/) for a complete
local/SSH collection workflow.
