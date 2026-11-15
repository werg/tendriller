import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { fileURLToPath } from "node:url";

const built = buildSync({ entryPoints: [fileURLToPath(new URL("../src/streams.ts", import.meta.url))], bundle: true, write: false, format: "esm", platform: "browser", target: "es2022" });
const { createStreams } = await import("data:text/javascript;base64," + Buffer.from(built.outputFiles[0].text).toString("base64"));
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const record = (seq, stream = "training.loss") => ({ stream, seq, ts: seq * 10, received_at: seq * 10 + 1, type: "metric", data: { loss: 1 / seq }, producer: "producer:trainer", id: `run:${seq}` });
const batch = (records, after, latest, history = {}) => ({ stream: "training.loss", durability: "durable", records,
  cursor: records.at(-1)?.seq ?? after, history: { earliest_available_seq: 1, latest_seq: latest, gap: false, missing_through: null, ...history } });

function setup({ request, fetch } = {}) {
  const listeners = new Map(), emitted = [], requests = [];
  let online = true;
  const bus = {
    on(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); return () => listeners.get(name).delete(fn); },
    emit(name, value) { emitted.push({ name, value }); for (const fn of [...listeners.get(name) || []]) fn(value); },
  };
  const host = { bus, base: "https://page.example/s/key/", connected: () => online, headers: () => ({ "X-Tendril-Device": "d_test" }),
    request: async msg => { requests.push(msg); return request?.(msg, requests.length); }, fetch };
  return { api: createStreams(host), bus, requests, emitted,
    offline() { online = false; bus.emit("disconnect"); }, online() { online = true; bus.emit("connect"); } };
}

test("durable subscriptions page >500 retained records before buffered live data and resume exactly at the delivery cursor", async () => {
  const page = deferred(), received = [], reads = [];
  let subscribes = 0;
  const h = setup({
    request: msg => {
      if (msg.t !== "stream_subscribe") return {};
      if (++subscribes === 1) return { stream: msg.stream, durability: "durable", cursor: 700,
        batch: batch(Array.from({ length: 500 }, (_, i) => record(i + 1)), 0, 700) };
      assert.equal(msg.after, 701);
      return { stream: msg.stream, durability: "durable", cursor: 703, batch: batch([record(702), record(703)], 701, 703) };
    },
    fetch: async (url, options) => { reads.push({ url, options }); return page.promise; },
  });
  const stop = h.api.subscribe("training.loss", r => received.push(r.seq), { after: 0 });
  await turn();
  assert.equal(received.length, 500);
  h.bus.emit("stream_record", record(701));
  assert.equal(received.length, 500, "new live data must wait for older history");
  page.resolve(Response.json(batch(Array.from({ length: 200 }, (_, i) => record(i + 501)), 500, 700)));
  await turn();
  assert.deepEqual(received, Array.from({ length: 701 }, (_, i) => i + 1));
  assert.match(reads[0].url, /records\?after=500&limit=500$/);
  assert.equal(reads[0].options.cache, "no-store");
  h.offline(); h.online(); await turn();
  assert.deepEqual(received.slice(-3), [701, 702, 703]);
  stop();
});

test("fully expired history reports a gap and advances the reconnect cursor without an empty replay loop", async () => {
  const gaps = [], received = [];
  let count = 0;
  const h = setup({ request: msg => {
    if (msg.t !== "stream_subscribe") return {};
    if (++count > 1) assert.equal(msg.after, 12);
    return { stream: msg.stream, durability: "durable", cursor: 12,
      batch: batch([], msg.after, 12, { earliest_available_seq: null, gap: msg.after < 12, missing_through: msg.after < 12 ? 12 : null }) };
  }, fetch: () => { throw Error("No HTTP read is needed for the acknowledged gap"); } });
  const stop = h.api.subscribe("training.loss", r => received.push(r.seq), { after: 0, onGap: gap => gaps.push(gap) });
  await turn();
  assert.equal(gaps[0].missing_through, 12);
  assert.equal(h.emitted.filter(e => e.name === "stream_gap").length, 1);
  h.offline(); h.online(); await turn();
  h.bus.emit("stream_record", record(13));
  assert.deepEqual(received, [13]);
  stop();
});

test("ephemeral subscriptions reconnect without replay and offline publishing never enters a queue", async () => {
  const received = [];
  const h = setup({ request: msg => {
    if (msg.t !== "stream_subscribe") return {};
    assert.equal(Object.hasOwn(msg, "after"), false);
    return { stream: msg.stream, durability: "ephemeral", cursor: 5 };
  } });
  const stop = h.api.subscribe("machine.live", r => received.push(r.seq));
  await turn(); h.bus.emit("stream_record", record(6, "machine.live"));
  h.offline();
  const before = h.requests.length;
  await assert.rejects(h.api.publish("machine.live", { records: [{ id: "sample", type: "metric", data: {} }] }), e => e.code === "offline");
  assert.equal(h.requests.length, before);
  h.online(); await turn(); h.bus.emit("stream_record", record(7, "machine.live"));
  assert.deepEqual(received, [6, 7]);
  assert.throws(() => h.api.subscribe("machine.live", () => {}, { after: 0 }), e => e.code === "not_replayable");
  stop();
});

test("multiple consumers share a server subscription but retain independent cursors and unsubscription", async () => {
  const a = [], b = [];
  const h = setup({ request: msg => {
    if (msg.t !== "stream_subscribe") return {};
    return { stream: msg.stream, durability: "durable", cursor: 3,
      batch: batch([record(1), record(2), record(3)].filter(r => r.seq > msg.after), msg.after, 3) };
  } });
  const stopA = h.api.subscribe("training.loss", r => a.push(r.seq), { after: 0 }); await turn();
  const stopB = h.api.subscribe("training.loss", r => b.push(r.seq), { after: 1 }); await turn();
  assert.deepEqual(a, [1, 2, 3]); assert.deepEqual(b, [2, 3]);
  h.bus.emit("stream_record", record(4));
  stopA();
  assert.equal(h.requests.filter(r => r.t === "stream_unsubscribe").length, 0);
  h.bus.emit("stream_record", record(5));
  assert.deepEqual(a, [1, 2, 3, 4]); assert.deepEqual(b, [2, 3, 4, 5]);
  stopB(); stopB();
  assert.equal(h.requests.filter(r => r.t === "stream_unsubscribe").length, 1);
});

test("a consumer exception does not block other consumers, and unsubscribe cancels an outstanding handshake", async () => {
  const ack = deferred(), errors = [], received = [];
  const h = setup({ request: msg => msg.t === "stream_subscribe" ? ack.promise : {} });
  const stopA = h.api.subscribe("training.loss", () => { throw Error("widget failed"); }, { after: 0, onError: e => errors.push(e.code) });
  const stopB = h.api.subscribe("training.loss", r => received.push(r.seq), { after: 0 });
  ack.resolve({ stream: "training.loss", durability: "durable", cursor: 1, batch: batch([record(1)], 0, 1) });
  await turn();
  assert.deepEqual(errors, ["handler_error"]); assert.deepEqual(received, [1]);
  stopA(); stopB();
  const pending = deferred();
  const late = setup({ request: msg => msg.t === "stream_subscribe" ? pending.promise : {} });
  const stop = late.api.subscribe("training.loss", () => { throw Error("cancelled handler called"); }, { after: 0 });
  stop();
  pending.resolve({ stream: "training.loss", durability: "durable", cursor: 1, batch: batch([record(1)], 0, 1) });
  await turn();
  assert.equal(late.emitted.filter(e => e.name === "stream_error").length, 0);
});

test("a stalled replay has a bounded live buffer and reports overflow before scheduling recovery", async () => {
  const ack = deferred(), errors = [];
  const h = setup({ request: msg => msg.t === "stream_subscribe" ? ack.promise : {} });
  const stop = h.api.subscribe("training.loss", () => {}, { after: 0, onError: error => errors.push(error.code) });
  for (let seq = 1; seq <= 1001; seq++) h.bus.emit("stream_record", record(seq));
  assert.deepEqual(errors, ["stream_overflow"]);
  stop(); // Cancels the scheduled recovery as well as the stale handshake.
  ack.resolve({ stream: "training.loss", durability: "durable", cursor: 0, batch: batch([], 0, 0) });
  await turn();
  assert.equal(h.requests.filter(r => r.t === "stream_subscribe").length, 1);
});

test("a missing durable live frame triggers replay before a later cursor can hide it", async () => {
  const received = [];
  let subscribes = 0;
  const h = setup({ request: msg => {
    if (msg.t !== "stream_subscribe") return {};
    if (++subscribes === 1) return { stream: msg.stream, durability: "durable", cursor: 1, batch: batch([record(1)], 0, 1) };
    assert.equal(msg.after, 1);
    return { stream: msg.stream, durability: "durable", cursor: 3, batch: batch([record(2), record(3)], 1, 3) };
  } });
  const stop = h.api.subscribe("training.loss", r => received.push(r.seq), { after: 0 });
  await turn();
  h.bus.emit("stream_record", record(3));
  assert.deepEqual(received, [1], "do not advance past missing record 2");
  await turn();
  assert.deepEqual(received, [1, 2, 3]);
  stop();
});

test("a replay callback that disconnects the page stops stale delivery", async () => {
  const received = [];
  let h;
  h = setup({ request: msg => msg.t === "stream_subscribe"
    ? { stream: msg.stream, durability: "durable", cursor: 2, batch: batch([record(1), record(2)], 0, 2) } : {} });
  const stop = h.api.subscribe("training.loss", item => {
    received.push(item.seq);
    if (item.seq === 1) h.offline();
  }, { after: 0 });
  await turn();
  assert.deepEqual(received, [1]);
  stop();
});

test("joining an ephemeral stream during its handshake keeps buffered live frames", async () => {
  const pending = deferred(), a = [], b = [];
  const h = setup({ request: msg => msg.t === "stream_subscribe" ? pending.promise : {} });
  const stopA = h.api.subscribe("machine.live", item => a.push(item.seq));
  h.bus.emit("stream_record", record(6, "machine.live"));
  const stopB = h.api.subscribe("machine.live", item => b.push(item.seq));
  pending.resolve({ stream: "machine.live", durability: "ephemeral", cursor: 5 });
  await turn();
  assert.deepEqual(a, [6]);
  assert.deepEqual(b, [6]);
  assert.equal(h.requests.filter(item => item.t === "stream_subscribe").length, 1);
  stopA(); stopB();
});
