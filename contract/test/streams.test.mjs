import { test } from "node:test";
import assert from "node:assert/strict";
import { assertValid, validate, ContractError } from "../index.mjs";
import { createClient, ApiError } from "../client.mjs";

const record = { stream: "training.loss", seq: 1, ts: 10, received_at: 12, type: "metric", data: { loss: 0.42, step: 3 }, producer: "producer:trainer", id: "run1:3" };
const info = { name: record.stream, durability: "durable", readers: "owner", builtin: false, max_records: 10000, max_age_seconds: 86400 };
const append = { records: [{ id: record.id, ts: record.ts, type: record.type, data: record.data }] };
const batch = { stream: record.stream, durability: "durable", records: [record], cursor: 1,
  history: { earliest_available_seq: 1, latest_seq: 1, gap: false, missing_through: null } };

test("stream policies reject ambiguous retention, reserved streams, and malformed payloads", () => {
  assertValid("streamCreate", { name: "utilization", durability: "ephemeral", readers: "page" });
  assertValid("streamCreate", { name: "training.loss", durability: "durable", max_records: 500, max_age_seconds: 60 });
  for (const body of [
    { name: "system.events", durability: "durable" },
    { name: "a/b", durability: "durable" },
    { name: "metrics", durability: "ephemeral", max_records: 1 },
    { name: "metrics", durability: "ephemeral", max_age_seconds: 10 },
    { name: "metrics", durability: "durable", max_age_seconds: 2592001 },
    { name: "metrics", durability: "durable", max_records: 10001 },
    { name: "metrics", durability: "durable", readers: "agent" },
  ]) assert.ok(validate("streamCreate", body).length, JSON.stringify(body));
  assertValid("streamAppend", append);
  assertValid("streamAppend", { records: [{ id: "null", type: "data", data: [null, true, "text", { n: 4 }] }] });
  for (const data of [undefined, NaN, Infinity, { nested: undefined }, { nested: NaN }, 1n, () => 1]) {
    assert.ok(validate("streamAppend", { records: [{ id: "bad", type: "data", data }] }).length);
  }
  const cyclic = {}; cyclic.self = cyclic;
  assert.ok(validate("streamAppend", { records: [{ id: "cycle", type: "data", data: cyclic }] }).length);
  assert.ok(validate("streamAppend", { records: [] }).length);
  assert.ok(validate("streamAppend", { records: Array(101).fill(append.records[0]) }).length);
  assert.ok(validate("streamAppend", { records: [{ ...append.records[0], ts: Number.MAX_SAFE_INTEGER + 1 }] }).length);
});

test("stream results preserve provenance and explicit retained-history gaps", () => {
  assertValid("streamInfo", info);
  assertValid("streamBatch", batch);
  assertValid("streamBatch", { ...batch, records: [], cursor: 0, history: { earliest_available_seq: null, latest_seq: 12, gap: true, missing_through: 12 } });
  assert.ok(validate("streamRecord", { ...record, producer: undefined }).length);
  assert.ok(validate("streamRecord", { ...record, seq: NaN }).length);
  assertValid("streamRecord", { ...record, stream: "system.logs", ts: -0.5, received_at: -0.5, id: null });
  assert.ok(validate("streamRecord", { ...record, received_at: Infinity }).length);
  assert.ok(validate("streamInfo", { ...info, secret: "must not leak" }).length);
  assertValid("create", { owner: "me@example.com", mode: "dashboard" });
  assert.ok(validate("create", { owner: "me@example.com", mode: "silently_skip_auth" }).length);
});

test("stream client validates boundaries and uses scoped credentials only in headers", async () => {
  const seen = [];
  const producer = { name: "trainer", streams: [record.stream], created_at: 1, last_seen: null };
  const client = createClient({ api: "https://example.test/api/t/id/", token: "tp_private" }, {
    fetch: async (url, options) => {
      seen.push({ url, options });
      const value = url.includes("/records?") ? batch : url.endsWith("/records") ? { records: [record], cursor: 1, durability: "durable" }
        : url.endsWith("/producers") ? options.method === "POST" ? { producer, token: "tp_" + "a".repeat(40) } : { producers: [producer] }
        : url.endsWith("/producers/trainer") ? undefined
        : url.endsWith("/streams") && options.method === "GET" ? { streams: [info] } : info;
      return value ? Response.json(value) : new Response(null, { status: 204 });
    },
  });
  assert.deepEqual(await client.streams.list(), { streams: [info] });
  assert.deepEqual(await client.streams.create({ name: record.stream, durability: "durable" }), info);
  assert.deepEqual(await client.streams.info(record.stream), info);
  assert.equal((await client.streams.append(record.stream, append)).cursor, 1);
  assert.deepEqual(await client.streams.read(record.stream, { after: 0, limit: 500 }), batch);
  await client.producers.list();
  await client.producers.create({ name: "trainer", streams: [record.stream] });
  await client.producers.revoke("trainer");
  assert.match(seen[4].url, /records\?after=0&limit=500$/);
  for (const call of seen) {
    assert.equal(call.options.headers.Authorization, "Bearer tp_private");
    assert.ok(!call.url.includes("tp_private"));
  }
  const count = seen.length;
  for (const after of [undefined, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => client.streams.read(record.stream, { after }), TypeError);
  assert.throws(() => client.streams.read(record.stream, { after: 0, limit: 501 }), TypeError);
  assert.throws(() => client.streams.info("../tokens"), ContractError);
  assert.throws(() => client.producers.create({ name: "trainer", streams: ["system.events"] }), ContractError);
  assert.equal(seen.length, count);
});

test("producer authorization errors and malformed stream responses remain explicit", async () => {
  const forbidden = createClient({ api: "https://example.test", token: "tp_private" }, {
    fetch: async () => Response.json({ error: { code: "forbidden", message: "Publish only" } }, { status: 403 }),
  });
  await assert.rejects(forbidden.streams.list(), error => error instanceof ApiError && error.code === "forbidden");
  const malformed = createClient({ api: "https://example.test", token: "tk_private" }, { fetch: async () => Response.json({ ...batch, records: [{ data: {} }] }) });
  await assert.rejects(malformed.streams.read(record.stream, { after: 0 }), error => error instanceof ApiError && error.code === "invalid_response");
});

test("latest snapshot reads validate nullable records, names, response shape and cancellation", async () => {
  const value = { stream: record.stream, durability: "durable", record, cursor: 1 };
  const signal = new AbortController().signal;
  const client = createClient({ api: "https://example.test", token: "private" }, { fetch: async (url, options) => {
    assert.equal(url, `https://example.test/streams/${record.stream}/latest`);
    assert.equal(options.signal, signal);
    return Response.json(value);
  } });
  assert.deepEqual(await client.streams.latest(record.stream, { signal }), value);
  assertValid("streamLatest", { ...value, record: null, cursor: 12 });
  assert.throws(() => client.streams.latest("../tokens"), ContractError);
  const malformed = createClient({ api: "https://example.test", token: "private" }, { fetch: async () => Response.json({ ...value, record: {} }) });
  await assert.rejects(malformed.streams.latest(record.stream), error => error instanceof ApiError && error.code === "invalid_response");
});

test("trimming requires an explicit safe bound and validates its receipt", async () => {
  const value = { stream: record.stream, through: 1, deleted_records: 1, cursor: 2 };
  let calls = 0;
  const client = createClient({ api: "https://example.test", token: "private" }, { fetch: async (url, options) => {
    calls++;
    assert.equal(url, `https://example.test/streams/${record.stream}/records?through=1`);
    assert.equal(options.method, "DELETE");
    return Response.json(value);
  } });
  assert.deepEqual(await client.streams.trim(record.stream, { through: 1 }), value);
  for (const through of [undefined, null, "1", -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => client.streams.trim(record.stream, { through }), ContractError);
  assert.throws(() => client.streams.trim(record.stream), ContractError);
  assert.throws(() => client.streams.trim("../tokens", { through: 1 }), ContractError);
  assert.equal(calls, 1);
  const malformed = createClient({ api: "https://example.test", token: "private" }, { fetch: async () => Response.json({ ...value, cursor: -1 }) });
  await assert.rejects(malformed.streams.trim(record.stream, { through: 1 }), error => error instanceof ApiError && error.code === "invalid_response");
});
