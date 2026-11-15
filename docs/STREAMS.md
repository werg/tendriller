# Streams: delivery and bounded history

Streams are transport-independent envelopes. Core owns admission, permissions, retention, sequence numbers, producer grants and lifecycle. Contrib owns collectors, transforms, visual components and application examples.

## Policies

A durable stream retains bounded records and supports explicit cursor replay. An ephemeral stream distributes live records and cannot claim historical replay. Built-in streams expose platform events, logs, state, presence and conversation through the same envelope; their existing platform APIs remain the only writers.

Custom stream creation declares a name, durability, reader audience and (for durable streams) retention. Configuration is immutable. Reserved `system.*` names cannot be allocated by applications. Payload types, field names and application data do not change retention or authorization.

```json
{"name":"telemetry.samples","durability":"durable","readers":"page","max_records":500,"max_age_seconds":3600}
```

Record envelopes preserve `stream`, `seq`, producer identity, producer-supplied `id`, timestamp, received timestamp, type and opaque JSON `data`. A producer retry with the same ID is deduplicated under its authenticated producer identity. Sequence numbers never rewind after trim or retention cleanup.

## HTTP and browser operations

The agent API under `A` provides stream creation/listing, append, replay, latest, trim and deletion, and scoped producer management. Producer credentials can append only to the streams in their grant and cannot access page-management or workflow operations. Page subscriptions enforce the declared reader audience and the authenticated role.

Use `client.streams.read(name,{after})` with an explicit nonnegative cursor. Responses include records, cursor and history metadata. `earliest_available_seq`, `latest_seq`, `gap` and `missing_through` expose missing retained history; callers must not treat an empty page as proof that no history was lost. Bounded pages always make progress when a valid record exists.

`client.streams.latest(name)` returns the latest retained durable record or null without scanning its whole history. Trimming requires an explicit observed `through` bound and reports the removed count. It does not reset producer identities, quotas or sequence numbers.

In browser code, subscribe through `tendril.streams`; the runtime maintains reconnect cursors and reports replay gaps. Application rendering may aggregate or batch records. Rendering options and reusable chart/view components are documented in [contrib](https://github.com/werg/tendriller-contrib).

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

## Lifecycle and wake behavior

Interactive pages retain conversational delivery requirements. Dashboard mode permits telemetry publication without an agent listener; both modes use the same stream and access rules. Producer activity does not assert that an agent is listening. Sustained collection begins after owner claim so the page has its effective claimed allowance. Producer activity cannot extend an unclaimed page's claim deadline.

Routine telemetry does not need to wake a conversation. Applications can separately emit meaningful bounded events. A stream record's `type` or payload never becomes a trusted workflow operation.

## Optional tools

[Contrib releases](https://github.com/werg/tendriller-contrib/releases) contain the collector, initialization tools, source adapters, spool manager, components and examples. Their manifests pin the core contract and runtime artifacts they were tested with. A tool update can ship without redeploying the core service.
