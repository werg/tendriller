// Small fixture transport for custom streams. The browser still runs its real
// stream client; production storage, credentials and quotas are not simulated.
import { assertValid, STREAM_RECORD_BYTES, STREAM_SNAPSHOT_RECORD_BYTES } from "@tendriller/core/contract";

const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };
const bytes = value => Buffer.byteLength(JSON.stringify(value));

export function createStreamFixtures(definitions = [], { historyPage, role, send }) {
  const streams = new Map(), subscriptions = new Map();
  const allowed = stream => stream.info.readers === "page" || role() === "owner";
  const get = (name, reader = true) => {
    assertValid("streamName", name);
    const stream = streams.get(name);
    if (!stream) fail(404, "not_found", "No such fixture stream");
    if (reader && !allowed(stream)) fail(403, "forbidden", "This stream is not shared with this reader");
    return stream;
  };
  const retained = stream => {
    if (stream.info.durability === "ephemeral") fail(409, "not_replayable", "Ephemeral streams have no retained records");
    const cutoff = Date.now() - stream.info.max_age_seconds * 1000;
    stream.records = stream.records.filter(record => record.received_at >= cutoff).slice(-stream.info.max_records);
    return stream.records;
  };
  const read = (name, after, limit = 100) => {
    const stream = get(name), rows = retained(stream);
    if (!Number.isSafeInteger(after) || after < 0) fail(400, "bad_request", "after must be a nonnegative safe integer");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) fail(400, "bad_request", "limit must be an integer from 1 to 500");
    if (after > stream.cursor) fail(400, "cursor_ahead", "after is beyond this stream's history");
    const page = historyPage(rows.filter(record => record.seq > after).slice(0, limit), {
      after, limit, latest: stream.cursor, earliest: rows[0]?.seq ?? null, maxBytes: 512 * 1024, sizeOf: bytes,
    });
    return { stream: name, durability: "durable", records: page.records, cursor: page.cursor, history: page.history };
  };
  const append = (name, inputs) => {
    const stream = get(name, false);
    if (!Array.isArray(inputs) || inputs.length > 10000) fail(400, "bad_request", "Fixture records must be an array of at most 10000 inputs");
    const records = inputs.map(input => structuredClone(assertValid("streamInput", input)));
    const recordLimit = stream.info.durability === "durable" && stream.info.max_records === 1
      ? STREAM_SNAPSHOT_RECORD_BYTES : STREAM_RECORD_BYTES;
    if (records.some(record => bytes(record) > recordLimit)) fail(413, "too_large", `Fixture records must not exceed ${recordLimit / 1024} KiB`);
    // Validate the whole step before changing anything. Retained IDs have the
    // same retry semantics as a single fixture producer on the real service.
    const known = new Map((stream.info.durability === "durable" ? retained(stream) : []).map(record => [record.id, record]));
    let cursor = stream.cursor;
    const fresh = [];
    for (const input of records) {
      const previous = known.get(input.id);
      if (previous) {
        if (previous.type !== input.type || JSON.stringify(previous.data) !== JSON.stringify(input.data)
          || input.ts !== undefined && previous.ts !== input.ts) fail(409, "id_conflict", "Fixture ID already identifies a different record");
        continue;
      }
      const now = Date.now();
      const record = { ...input, stream: name, seq: ++cursor, ts: input.ts ?? now, received_at: now, producer: "fixture" };
      fresh.push(record);
      if (stream.info.durability === "durable") known.set(input.id, record);
    }
    stream.cursor = cursor;
    if (stream.info.durability === "durable") { stream.records.push(...fresh); retained(stream); }
    for (const [ws, names] of subscriptions) {
      if (!names.has(name)) continue;
      if (!allowed(stream)) { names.delete(name); ws.close(4003, "Stream access revoked"); continue; }
      for (const record of fresh) if (record.seq > names.get(name)) {
        send(ws, { t: "stream_record", record }); names.set(name, record.seq);
      }
    }
  };
  if (!Array.isArray(definitions) || definitions.length > 64) fail(400, "bad_request", "streams must contain at most 64 fixture definitions");
  for (const { records = [], ...value } of definitions) {
    const definition = assertValid("streamCreate", value);
    if (streams.has(definition.name)) fail(409, "exists", "A fixture stream was declared twice");
    const durable = definition.durability === "durable";
    const info = { ...definition, readers: definition.readers ?? "owner", builtin: false,
      max_records: durable ? definition.max_records ?? 10000 : null,
      max_age_seconds: durable ? definition.max_age_seconds ?? 86400 : null };
    streams.set(info.name, { info, records: [], cursor: 0 });
    append(info.name, records);
  }
  return {
    list: () => ({ streams: [...streams.values()].filter(allowed).map(stream => stream.info) }),
    info: name => get(name).info,
    read,
    latest(name) {
      const stream = get(name), records = retained(stream);
      return { stream: name, durability: "durable", record: records.at(-1) ?? null, cursor: stream.cursor };
    },
    feed(values) {
      if (!Array.isArray(values)) fail(400, "bad_request", "A streams step must be an array of {name, records}");
      for (const value of values) {
        if (!value || Object.keys(value).some(key => key !== "name" && key !== "records"))
          fail(400, "bad_request", "A streams step accepts only name and records; declare streams at the fixture root");
        append(value.name, value.records);
      }
    },
    subscribe(ws, name, after) {
      const stream = get(name);
      if (after !== undefined && stream.info.durability === "ephemeral") fail(409, "not_replayable", "Subscribe to ephemeral streams without after");
      const batch = after === undefined ? undefined : read(name, after, 500);
      const names = subscriptions.get(ws) || new Map();
      if (!names.has(name) && names.size >= 16) fail(429, "quota", "At most 16 stream subscriptions per socket");
      names.set(name, stream.cursor); subscriptions.set(ws, names);
      return { stream: name, durability: stream.info.durability, cursor: stream.cursor, ...(batch ? { batch } : {}) };
    },
    unsubscribe(ws, name) { subscriptions.get(ws)?.delete(name); },
    disconnect(ws) { subscriptions.delete(ws); },
  };
}
