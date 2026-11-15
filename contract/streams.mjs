// Transport-independent envelopes. Durability belongs to the stream, not its payload.
// UTF-8 bytes of one producer input, before the server adds its record envelope.
// A single retained snapshot can be larger without expanding the batch or page quota.
export const STREAM_RECORD_BYTES = 64 * 1024;
export const STREAM_SNAPSHOT_RECORD_BYTES = 192 * 1024;

const integer = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const nullableInteger = { anyOf: [integer, { type: "null" }] };
const object = (properties, required = [], additionalProperties = false) => ({ type: "object", properties, required, additionalProperties });
const name = { type: "string", pattern: "^[a-z][a-z0-9._-]{0,63}$" };
const customName = { type: "string", pattern: "^(?!system\\.)[a-z][a-z0-9._-]{0,63}$" };
const durability = { enum: ["durable", "ephemeral"] };
const json = { $ref: "#/$defs/streamJson" };
const jsonValue = { anyOf: [
  { type: "null" }, { type: "boolean" }, { type: "number" }, { type: "string" },
  { type: "array", items: json }, { type: "object", additionalProperties: json },
] };
const input = object({ id: { type: "string", minLength: 1, maxLength: 128 }, ts: integer,
  type: { type: "string", minLength: 1, maxLength: 80 }, data: json }, ["id", "type", "data"]);
// Browser diagnostics historically accepted fractional/negative epoch values.
// Preserve those stored timestamps in adapters; new producer input stays integral.
const record = object({ stream: name, seq: integer, ts: { type: "number" }, received_at: { type: "number" },
  type: { type: "string", minLength: 1, maxLength: 80 }, data: json,
  producer: { type: "string", minLength: 1, maxLength: 200 }, id: { anyOf: [input.properties.id, { type: "null" }] },
}, ["stream", "seq", "ts", "received_at", "type", "data", "producer", "id"]);
const history = object({ earliest_available_seq: nullableInteger, latest_seq: integer,
  gap: { type: "boolean" }, missing_through: nullableInteger }, ["earliest_available_seq", "latest_seq", "gap", "missing_through"]);
const info = object({ name, durability, readers: { enum: ["agent", "owner", "page"] }, builtin: { type: "boolean" },
  max_records: nullableInteger, max_age_seconds: nullableInteger }, ["name", "durability", "readers", "builtin", "max_records", "max_age_seconds"]);
const batch = object({ stream: name, durability, records: { type: "array", maxItems: 500, items: record },
  cursor: integer, history }, ["stream", "durability", "records", "cursor", "history"]);
const producer = object({ name, streams: { type: "array", minItems: 1, maxItems: 32, items: customName },
  created_at: integer, last_seen: nullableInteger }, ["name", "streams", "created_at", "last_seen"]);

export const streamSchemas = {
  streamName: name,
  streamCustomName: customName,
  streamJson: jsonValue,
  streamInfo: info,
  streamCreate: { anyOf: [
    object({ name: customName, durability: { const: "durable" }, readers: { enum: ["owner", "page"] },
      max_records: { type: "integer", minimum: 1, maximum: 10000 }, max_age_seconds: { type: "integer", minimum: 1, maximum: 2592000 },
    }, ["name", "durability"]),
    object({ name: customName, durability: { const: "ephemeral" }, readers: { enum: ["owner", "page"] } }, ["name", "durability"]),
  ] },
  streamInput: input,
  streamRecord: record,
  streamHistory: history,
  streamAppend: object({ records: { type: "array", minItems: 1, maxItems: 100, items: input } }, ["records"]),
  streamAppendResult: object({ records: { type: "array", maxItems: 100, items: record }, cursor: integer, durability }, ["records", "cursor", "durability"]),
  streamBatch: batch,
  streamLatest: object({ stream: name, durability: { const: "durable" },
    record: { anyOf: [record, { type: "null" }] }, cursor: integer }, ["stream", "durability", "record", "cursor"]),
  streamTrim: object({ through: integer }, ["through"]),
  streamTrimResult: object({ stream: name, through: integer, deleted_records: integer, cursor: integer },
    ["stream", "through", "deleted_records", "cursor"]),
  streamList: object({ streams: { type: "array", items: info } }, ["streams"]),
  streamSubscription: object({ stream: name, durability, cursor: integer, batch }, ["stream", "durability", "cursor"], true),
  producer,
  producerCreate: object({ name, streams: producer.properties.streams }, ["name", "streams"]),
  producerList: object({ producers: { type: "array", items: producer } }, ["producers"]),
  producerResult: object({ producer, token: { type: "string", pattern: "^tp_[a-z2-7]{32,64}$" } }, ["producer", "token"]),
};
