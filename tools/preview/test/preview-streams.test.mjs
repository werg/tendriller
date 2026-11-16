import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { startServer } from "../lib/preview.mjs";
import { assertValid } from "@tendriller/core/contract";

const input = (id, value) => ({ id, type: "sample", ts: 1000, data: { value } });
async function setup(t, fixture) {
  const dir = mkdtempSync(join(tmpdir(), "tendril-preview-streams-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>Streams</title>");
  const server = await startServer(dir, undefined, fixture);
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await server.stopPreview(); rmSync(dir, { recursive: true, force: true }); });
  return { server, base, async get(path) { const response = await fetch(base + "/_tendril/streams" + path); return { status: response.status, body: await response.json() }; } };
}
async function socket(base) {
  const ws = new WebSocket(base.replace("http:", "ws:") + "/_tendril/ws");
  const frames = [];
  ws.on("message", raw => frames.push(JSON.parse(String(raw))));
  await once(ws, "open");
  const welcome = once(ws, "message");
  ws.send(JSON.stringify({ t: "hello", device_id: "fixture-device" }));
  await welcome;
  let id = 0;
  const call = message => new Promise(resolve => {
    const cid = `call-${++id}`;
    const onMessage = raw => { const frame = JSON.parse(String(raw)); if (frame.cid === cid) { ws.off("message", onMessage); resolve(frame); } };
    ws.on("message", onMessage); ws.send(JSON.stringify({ ...message, cid }));
  });
  return { ws, frames, call };
}

test("preview stream reads use real envelopes, bounded history and explicit durable/ephemeral errors", async t => {
  const f = await setup(t, { streams: [
    { name: "metrics", durability: "durable", max_records: 2, records: [input("a", 1), input("b", 2), input("c", 3)] },
    { name: "empty", durability: "durable" }, { name: "live", durability: "ephemeral" },
  ] });
  const list = await f.get(""); assertValid("streamList", list.body); assert.equal(list.body.streams.length, 3);
  const info = await f.get("/metrics"); assertValid("streamInfo", info.body); assert.equal(info.body.max_records, 2);
  const batch = (await f.get("/metrics/records?after=0&limit=1")).body;
  assertValid("streamBatch", batch);
  assert.deepEqual(batch.records.map(record => record.seq), [2]);
  assert.equal(batch.cursor, 2);
  assert.deepEqual(batch.history, { earliest_available_seq: 2, latest_seq: 3, gap: true, missing_through: 1 });
  const latest = (await f.get("/metrics/latest")).body;
  assertValid("streamLatest", latest); assert.equal(latest.record.data.value, 3);
  assert.deepEqual((await f.get("/empty/latest")).body, { stream: "empty", durability: "durable", record: null, cursor: 0 });
  for (const [path, status, code] of [["/metrics/records", 400, "cursor_required"], ["/metrics/records?after=4", 400, "cursor_ahead"],
    ["/metrics/records?after=0&limit=0", 400, "bad_request"], ["/live/records?after=0", 409, "not_replayable"],
    ["/live/latest", 409, "not_replayable"], ["/unknown", 404, "not_found"]]) {
    const result = await f.get(path); assert.equal(result.status, status, path); assert.equal(result.body.error.code, code, path);
  }
  const post = await fetch(f.base + "/_tendril/streams", { method: "POST" });
  assert.equal(post.status, 405);
  assert.equal((await post.json()).error.code, "preview_unsupported");
});

test("preview subscriptions replay durable records and feed actual WebSocket frames without waking the agent", async t => {
  const f = await setup(t, { streams: [{ name: "metrics", durability: "durable", records: [input("a", 1)] },
    { name: "live", durability: "ephemeral", records: [input("before", 0)] }] });
  const live = await socket(f.base);
  const replay = await live.call({ t: "stream_subscribe", stream: "metrics", after: 0 });
  assertValid("streamSubscription", replay);
  assert.equal(replay.batch.records[0].data.value, 1);
  assert.equal((await live.call({ t: "stream_subscribe", stream: "live", after: 0 })).error, "not_replayable");
  const ephemeral = await live.call({ t: "stream_subscribe", stream: "live" });
  assert.equal(ephemeral.cursor, 1); assert.equal(ephemeral.batch, undefined);
  const delivered = once(live.ws, "message");
  f.server.preview.streams.feed([{ name: "metrics", records: [input("b", 2)] }]);
  const frame = JSON.parse(String((await delivered)[0]));
  assert.equal(frame.t, "stream_record"); assertValid("streamRecord", frame.record);
  assert.equal(frame.record.seq, 2);
  assert.equal(f.server.preview.events.length, 0);
  assert.equal(f.server.preview.activity.some(event => event.kind === "event"), false);
  const closed = once(live.ws, "close"); live.ws.close(); await closed;
  f.server.preview.streams.feed([{ name: "metrics", records: [input("c", 3)] }, { name: "live", records: [input("missed", 2)] }]);
  const next = await socket(f.base);
  const caughtUp = await next.call({ t: "stream_subscribe", stream: "metrics", after: 2 });
  assert.deepEqual(caughtUp.batch.records.map(record => record.seq), [3]);
  const rejoined = await next.call({ t: "stream_subscribe", stream: "live" });
  assert.equal(rejoined.cursor, 2); assert.equal(rejoined.batch, undefined);
  assert.equal(next.frames.some(frame => frame.t === "stream_record"), false);
  assert.equal((await next.call({ t: "stream_publish", stream: "metrics", records: [input("not-fixture", 4)] })).error, "preview_unsupported");
  await next.call({ t: "stream_unsubscribe", stream: "metrics" });
  f.server.preview.streams.feed([{ name: "metrics", records: [input("after-stop", 4)] }]);
  await next.call({ t: "ping" }); // delivery ordering barrier
  assert.equal(next.frames.some(frame => frame.t === "stream_record"), false);
});

test("fixture stream permissions apply to reads, subscriptions and later role changes", async t => {
  const f = await setup(t, { role: "guest", streams: [{ name: "private", durability: "durable" }, { name: "shared", durability: "durable", readers: "page" }] });
  assert.deepEqual((await f.get("")).body.streams.map(stream => stream.name), ["shared"]);
  assert.equal((await f.get("/private/latest")).status, 403);
  const live = await socket(f.base);
  assert.equal((await live.call({ t: "stream_subscribe", stream: "private" })).error, "forbidden");
  f.server.preview.setRole("owner");
  await live.call({ t: "stream_subscribe", stream: "private" });
  f.server.preview.setRole("guest");
  const revoked = once(live.ws, "close");
  f.server.preview.streams.feed([{ name: "private", records: [input("secret", 42)] }]);
  assert.equal((await revoked)[0], 4003);
  assert.equal(live.frames.some(frame => frame.t === "stream_record"), false);
});

test("fixture records retain retry IDs and reject malformed steps without corrupting history", async t => {
  const f = await setup(t, { streams: [{ name: "metrics", durability: "durable", records: [input("a", { nested: true })] }] });
  f.server.preview.streams.feed([{ name: "metrics", records: [input("a", { nested: true })] }]);
  assert.equal((await f.get("/metrics/latest")).body.cursor, 1);
  assert.throws(() => f.server.preview.streams.feed([{ name: "metrics", records: [input("new", 2), input("a", 3)] }]), { code: "id_conflict" });
  assert.equal((await f.get("/metrics/latest")).body.cursor, 1);
  assert.throws(() => f.server.preview.streams.feed([{ name: "metrics", records: [input("b", 2)], typo: true }]));
  assert.throws(() => f.server.preview.streams.feed([{ name: "missing", records: [input("a", 1)] }]), { code: "not_found" });
});

test("preview retains and replays one larger snapshot with the production record bounds", async t => {
  const f = await setup(t, { streams: [
    { name: "snapshot", durability: "durable", max_records: 1 },
    { name: "history", durability: "durable", max_records: 2 },
    { name: "live", durability: "ephemeral" },
  ] });
  const large = input("large", "x".repeat(180 * 1024));
  f.server.preview.streams.feed([{ name: "snapshot", records: [large] }]);
  const live = await socket(f.base);
  const replay = await live.call({ t: "stream_subscribe", stream: "snapshot", after: 0 });
  assert.equal(replay.batch.records[0].data.value, large.data.value);
  for (const name of ["history", "live"]) assert.throws(() => f.server.preview.streams.feed([{ name, records: [large] }]), { code: "too_large" });
  assert.throws(() => f.server.preview.streams.feed([{ name: "snapshot", records: [input("over", "x".repeat(192 * 1024))] }]), { code: "too_large" });
  assert.equal((await f.get("/snapshot/latest")).body.cursor, 1);
  f.server.preview.streams.feed([{ name: "snapshot", records: [input("new", "current")] }]);
  const retained = (await f.get("/snapshot/records?after=0")).body;
  assert.equal(retained.records.length, 1);
  assert.equal(retained.records[0].data.value, "current");
});
