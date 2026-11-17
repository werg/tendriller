# Streams: delivery and bounded history

Streams are transport-independent envelopes. Core owns admission, permissions, retention, sequence numbers, producer grants and lifecycle. Optional core tools own collectors and source adapters. Contrib cookbooks explain modeling, transformation and presentation choices for page-owned implementations.

## Policies

A durable stream retains bounded records and supports explicit cursor replay. An ephemeral stream distributes live records and cannot claim historical replay. Built-in streams expose platform events, logs, state, presence and conversation through the same envelope; their existing platform APIs remain the only writers.

Custom stream creation declares a name, durability, reader audience and (for durable streams) retention. Configuration is immutable. Reserved `system.*` names cannot be allocated by applications. Payload types, field names and application data do not change retention or authorization.

```json
{"name":"telemetry.samples","durability":"durable","readers":"page","max_records":500,"max_age_seconds":3600}
```

Record envelopes preserve `stream`, `seq`, producer identity, producer-supplied `id`, timestamp, received timestamp, type and opaque JSON `data`. Durable inputs require a stable `id`; a retry is deduplicated under its authenticated producer identity while the record is retained. Ephemeral inputs may omit `id` (the delivered envelope uses `null`), and repeated sends are distinct live observations with no deduplication or delivery acknowledgement. Sequence numbers never rewind after trim or retention cleanup.

Choose these hosted streams when an external producer needs scoped ingestion
credentials and a declared audience or retention policy. Both hosted and peer
pages use the independent [`tendril.signals` API](APPLICATION_SIGNALS.md) for
transient application traffic. Hosted pages receive that port automatically;
peer pages install their chosen implementation. Use the selected application
backend's durable events when a message must recover through its history.
Neither transient path needs a Chronolog transaction or finality operation.

## HTTP and browser operations

The agent API under `A` provides stream creation/listing, append, replay, latest, trim, and scoped producer management:

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` / `POST` | `A/streams` | List/create streams |
| `GET` | `A/streams/<name>` | Read configuration |
| `GET` | `A/streams/<name>/records?after=N&limit=M` | Durable replay; `after` required |
| `GET` | `A/streams/<name>/latest` | Latest durable record (possibly null), plus high-water cursor |
| `POST` | `A/streams/<name>/records` | Append records with agent or scoped producer credential |
| `DELETE` | `A/streams/<name>/records?through=N` | Trim retained records through explicit observed sequence |
| `GET` / `POST` | `A/producers` | List/create scoped producers |
| `DELETE` | `A/producers/<name>` | Revoke producer |

There is no stream-definition deletion route: configuration is immutable. All `A` URLs are relative to the private agent API base in the creation response. Producer credentials can append only to the streams in their grant and cannot access page-management or workflow operations. Page subscriptions enforce the declared reader audience and the authenticated role.

Use `client.streams.read(name,{after})` with an explicit nonnegative cursor. Responses include records, cursor and history metadata. `earliest_available_seq`, `latest_seq`, `gap` and `missing_through` expose missing retained history; callers must not treat an empty page as proof that no history was lost. Bounded pages always make progress when a valid record exists.

`client.streams.latest(name)` returns the latest retained durable record or null without scanning its whole history. Trimming requires an explicit observed `through` bound and reports the removed count. It does not reset producer identities, quotas or sequence numbers.

In browser code, use `const {record,cursor} = await tendril.streams.latest("telemetry.samples")`, then `tendril.streams.subscribe("telemetry.samples", handler, {after:cursor,onGap})` to avoid missing writes between snapshot and subscription. `tendril.streams.read(name,{after:0})` explicitly reads retained history and `tendril.streams.publish(name,{records})` requires a connected owner. See [Browser API](BROWSER_API.md). The runtime maintains reconnect cursors and reports replay gaps. Application rendering may aggregate or batch records independently of ingestion. [Cookbooks](https://github.com/werg/tendriller-contrib) explain display budgets, smoothing, honest gaps and checkpoint choices.

## Authoritative resource policy

`contract/limits.mjs` exports `STREAM_LIMITS`. The service imports this source, and `/api/service` exposes the policy. Page metadata exposes effective limits where lifecycle changes the allowance. Consumers must read those values instead of copying hidden constants.

| Resource | Policy |
| --- | --- |
| Ordinary producer record | 64 KiB UTF-8 input JSON |
| Single retained snapshot (`durable`, `max_records:1`) | 192 KiB UTF-8 input JSON |
| Append batch | 100 records, 256 KiB total |
| Replay page | 500 records, 512 KiB preferred page budget |
| Custom streams / producer grants / browser subscriptions | 64 / 32 / 16 |
| Total retained custom records | 20,000 per page |
| Total retained custom bytes | 1 MiB unclaimed, 8 MiB claimed |
| Per-stream records / retention age | Up to 10,000 / 30 days |

The larger snapshot is a general bounded-storage policy. It does not change total batch/storage quotas and does not inspect table parts, training metrics or particular stream names. A single retained snapshot can therefore represent any opaque current-state document within its limits.

Producer rate budgets, whole-page storage quotas and lifecycle checks remain authoritative even when a stream's own retention permits more records. Publishing a catalog or choosing a collector option cannot increase them.

## Retention sizing recipe

Estimate an average JSON input record size `B` bytes, sampling every `S` seconds, with a desired lookback of `H` hours. Then estimate records `N = ceil(H * 3600 / S)` and retained bytes `N * B`. For example, 2 hours of 10-second samples at 400 bytes is about 720 records / 288 KiB. Set `max_records` somewhat above 720 for clock jitter and `max_age_seconds` at 7200 (or above for a margin). Both constraints apply; **neither guarantees** a full lookback if the page's shared 8 MiB claimed aggregate quota, 20,000-record cap or other stream workloads trim data first. A 1-second 24-hour stream would need 86,400 records and exceeds the per-stream and per-page caps. For current values, read `/api/service` rather than relying on this illustration. Ephemeral streams hold no historical lookback.

## Lifecycle and wake behavior

Interactive pages retain conversational delivery requirements. Dashboard mode permits telemetry publication without an agent listener; both modes use the same stream and access rules. Producer activity does not assert that an agent is listening. Sustained collection begins after owner claim so the page has its effective claimed allowance. Producer activity cannot extend an unclaimed page's claim deadline.

Routine telemetry does not need to wake a conversation. Applications can separately emit meaningful bounded events. A stream record's `type` or payload never becomes a trusted workflow operation.

## Optional tools

[Core tools](tools/COLLECTOR.md) contain the collector, initialization command, source adapters and bounded spool manager. Their archive records its exact core contract and runtime. They are optional Node programs excluded from the Worker dependency graph. Cookbook prose has an independent content revision.
