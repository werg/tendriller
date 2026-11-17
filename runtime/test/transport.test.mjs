import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { fileURLToPath } from "node:url";

const built = buildSync({ stdin: {
  contents: 'export * from "./connection"; export * from "./requests"; export * from "./delivery"; export * from "./signals";',
  resolveDir: fileURLToPath(new URL("../src", import.meta.url)), loader: "ts",
}, bundle: true, write: false, format: "esm", platform: "browser", target: "es2022" });
const { createConnection, createRequests, createCommandReceipts, deliveryPolicy, createHostedSignals } =
  await import("data:text/javascript;base64," + Buffer.from(built.outputFiles[0].text).toString("base64"));

class Clock {
  now = 0;
  next = 0;
  jobs = new Map();
  setTimeout(callback, delay) { return this.add(callback, delay, false); }
  setInterval(callback, delay) { return this.add(callback, delay, true); }
  clearTimeout(id) { this.jobs.delete(id); }
  clearInterval(id) { this.jobs.delete(id); }
  add(callback, delay, repeat) {
    const id = this.next++;
    this.jobs.set(id, { callback, at: this.now + delay, interval: repeat ? delay : null });
    return id;
  }
  tick(ms) {
    const until = this.now + ms;
    for (;;) {
      const next = [...this.jobs].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next || next[1].at > until) break;
      const [id, job] = next;
      this.now = job.at;
      if (job.interval === null) this.jobs.delete(id); else job.at += job.interval;
      job.callback();
    }
    this.now = until;
  }
}

class Socket {
  readyState = 0;
  sent = [];
  closed = [];
  open() { this.readyState = 1; this.onopen?.({}); }
  send(text) { if (this.readyState !== 1) throw Error("socket closed"); this.sent.push(JSON.parse(text)); }
  message(value) { this.onmessage?.({ data: typeof value === "string" ? value : JSON.stringify(value) }); }
  close(code, reason) { this.closed.push({ code, reason }); this.readyState = 3; this.onclose?.({}); }
}

function requestsSetup(online = false) {
  const clock = new Clock(), persisted = [], sent = [];
  let next = 0, sendable = true;
  const requests = createRequests({ connected: () => online,
    send: message => { if (!sendable) return false; sent.push(message); return true; },
    enqueue: message => persisted.push(message), newCid: () => `c_${++next}`,
  }, clock);
  const receipts = createCommandReceipts(() => online, clock);
  return { clock, persisted, sent, requests, receipts,
    online(value) { online = value; }, sendable(value) { sendable = value; } };
}

test("offline policies preserve command queues, discard transient raw frames, and retain unknown control messages in memory", async () => {
  const h = requestsSetup();
  h.requests.raw({ t: "send", data: { text: "keep" } });
  h.requests.raw({ t: "state", ops: [] });
  h.requests.raw({ t: "log", entries: [] });
  h.requests.raw({ t: "ping" });
  h.requests.raw({ t: "eval_result", value: "obsolete" });
  h.requests.raw({ t: "future_control" });
  h.requests.raw({ t: "constructor" });
  assert.deepEqual(h.persisted.map(m => m.t), ["send", "state", "log"]);
  assert.ok(h.persisted.every(m => m.cid));
  assert.deepEqual(h.sent, []);
  for (const t of ["stream_subscribe", "stream_unsubscribe", "stream_publish", "state_snapshot"])
    await assert.rejects(h.requests.request({ t }), e => e.code === "offline" && /connected page/.test(e.message));
  assert.equal(h.clock.jobs.size, 0, "offline stream requests register no timeout or queue work");
  h.online(true); h.requests.flush();
  assert.deepEqual(h.sent.map(m => m.t), ["future_control", "constructor"]);
  assert.equal(h.persisted.length, 3, "flushing the volatile queue must not own durable work");
  assert.equal(deliveryPolicy("send").outboxCompletion, "ack");
  assert.equal(deliveryPolicy("state").outboxCompletion, "ack");
  assert.equal(deliveryPolicy("log").outboxCompletion, "written");
});

test("unknown requests retain the memory default and expired requests cannot replay after reconnect", async () => {
  const h = requestsSetup();
  const unknown = h.requests.request({ t: "future_control", cid: "custom" });
  const expired = assert.rejects(h.requests.request({ t: "versions", cid: "expired" }), e => e.code === "offline");
  h.clock.tick(14_000);
  h.online(true); h.requests.flush();
  assert.deepEqual(h.sent.map(m => m.cid), ["custom", "expired"]);
  assert.equal(h.requests.receive({ t: "custom_result", cid: "custom", ok: true }), true);
  assert.equal((await unknown).ok, true);
  h.online(false); h.clock.tick(1000); await expired;
  const unsent = assert.rejects(h.requests.request({ t: "constructor", cid: "never-sent" }), e => e.code === "offline");
  h.clock.tick(15_000); await unsent;
  h.online(true); h.requests.flush();
  assert.deepEqual(h.sent.map(m => m.cid), ["custom", "expired"]);
  assert.equal(h.requests.receive({ t: "ack", cid: "never-sent" }), false);
  assert.deepEqual(h.persisted, []);
});

test("disconnect rejects stream RPCs but leaves durable commands and unrelated requests pending", async () => {
  const h = requestsSetup(true);
  const streams = ["stream_subscribe", "stream_unsubscribe", "stream_publish"].map(t =>
    assert.rejects(h.requests.request({ t }), e => e.code === "offline" && e.message === "Stream connection closed"));
  const state = h.requests.request({ t: "state", cid: "state-1", ops: [] });
  const control = h.requests.request({ t: "versions", cid: "control-1" });
  const receipt = h.receipts.wait("state-1");
  h.online(false); h.receipts.disconnected(); h.requests.disconnected();
  await Promise.all(streams);
  assert.equal(await receipt, null, "a lost command receipt means still queued");
  assert.equal(h.clock.jobs.size, 2, "stream request and receipt timers must be removed");
  assert.deepEqual(h.persisted.map(m => m.cid), ["state-1"]);
  h.online(true);
  assert.equal(h.requests.receive({ t: "versions", cid: "control-1", versions: [1] }), true);
  assert.deepEqual((await control).versions, [1]);
  const ack = { t: "ack", cid: "state-1", rev: 7 };
  assert.equal(h.requests.receive(ack), true);
  assert.equal(await state, ack);
  assert.equal(h.persisted.length, 1, "the domain ACK handler, not correlation, removes durable commands");
  assert.equal(h.clock.jobs.size, 0);
});

test("state snapshots are bounded connected reads and never enter either delivery queue", async () => {
  const h = requestsSetup(true);
  const timeout = assert.rejects(h.requests.request({ t: "state_snapshot" }), { code: "timeout" });
  h.clock.tick(15_000); await timeout;
  const disconnected = assert.rejects(h.requests.request({ t: "state_snapshot" }), { code: "offline" });
  h.online(false); h.requests.disconnected(); await disconnected;
  h.requests.raw({ t: "state_snapshot" });
  h.online(true); h.requests.flush();
  assert.equal(h.sent.length, 2); assert.deepEqual(h.persisted, []); assert.equal(h.clock.jobs.size, 0);
});

test('live requests are cancellable and never survive a disconnect or enter either queue', async () => {
  const h = requestsSetup(true), stop = new AbortController();
  const cancelled = assert.rejects(h.requests.request({ t: 'signal_send', cid: 'cancelled' }, { signal: stop.signal }), /disposed/);
  stop.abort(new Error('disposed')); await cancelled;
  assert.equal(h.clock.jobs.size, 0);
  assert.equal(h.requests.receive({ t: 'ack', cid: 'cancelled' }), false);
  const pending = ['signal_send', 'signal_subscribe', 'signal_unsubscribe'].map((t, i) =>
    assert.rejects(h.requests.request({ t, cid: `live-${i}` }), { code: 'offline' }));
  h.online(false); h.requests.disconnected(); await Promise.all(pending);
  assert.equal(h.clock.jobs.size, 0);
  for (const t of ['signal_send', 'signal_subscribe', 'signal_unsubscribe']) {
    h.requests.raw({ t });
    await assert.rejects(h.requests.request({ t }), { code: 'offline' });
  }
  const before = h.sent.length;
  h.online(true); h.requests.flush();
  assert.equal(h.sent.length, before); assert.deepEqual(h.persisted, []);
});

test('cancelling an unsent request removes its volatile work before reconnect', async () => {
  const h = requestsSetup(false), stop = new AbortController();
  const pending = assert.rejects(h.requests.request({ t: 'versions', cid: 'discarded' }, { signal: stop.signal }), /disposed/);
  stop.abort(new Error('disposed')); await pending;
  h.online(true); h.requests.flush();
  assert.deepEqual(h.sent, []); assert.equal(h.clock.jobs.size, 0);
  assert.equal(h.requests.receive({ t: 'versions', cid: 'discarded' }), false);
});

test('live request pressure is nonfatal, releases correlation work and does not enter an outbox', async () => {
  const h = requestsSetup(true);
  h.sendable(false);
  await assert.rejects(h.requests.request({ t: 'signal_send' }), { code: 'signal_backpressure' });
  assert.equal(h.clock.jobs.size, 0);
  h.sendable(true); h.requests.flush();
  assert.deepEqual(h.sent, []); assert.deepEqual(h.persisted, []);
  const later = h.requests.request({ t: 'signal_send', cid: 'later' });
  h.requests.receive({ t: 'ack', cid: 'later', signal: { payload: 'current' } });
  assert.equal((await later).signal.payload, 'current');
});

test('the hosted page adapter restores subscriptions after reconnect and discards old data without replay', async () => {
  const h = requestsSetup(true), listeners = new Map();
  let online = true;
  const bus = { on(type, listener) {
    const values = listeners.get(type) ?? new Set(); values.add(listener); listeners.set(type, values);
    return () => values.delete(listener);
  }, emit(type, value) { for (const listener of listeners.get(type) ?? []) listener(value); } };
  const port = createHostedSignals({ bus, application: { selection: { kind: 'cloudflare', id: 'cf:page' } },
    get connected() { return online; }, transportRequest: h.requests.request });
  assert.deepEqual(h.sent, []);
  const input = port.subscribe();
  h.requests.receive({ t: 'ack', cid: h.sent.at(-1).cid });
  await new Promise(resolve => setImmediate(resolve));
  const now = Date.now(), message = { scope: 'cf:page', authorId: 'agent:main', sessionId: 'one', sequence: 1,
    topic: 'progress', payload: 1, issuedAtMs: now, expiresAtMs: now + 5000 };
  bus.emit('signal', { signal: message });
  const pending = port.send('progress', 2);
  online = false; h.online(false); h.requests.disconnected(); bus.emit('disconnect');
  await assert.rejects(pending);
  online = true; h.online(true); bus.emit('connect');
  h.requests.receive({ t: 'ack', cid: h.sent.at(-1).cid });
  assert.deepEqual(h.sent.map(value => value.t), ['signal_subscribe', 'signal_send', 'signal_subscribe']);
  bus.emit('signal', { signal: { ...message, scope: 'cf:other' } });
  bus.emit('signal', { signal: { ...message, sequence: 3, payload: 3 } });
  assert.equal((await input.next()).value.sequence, 3);
  await input.return(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.sent.at(-1).t, 'signal_unsubscribe');
  h.requests.receive({ t: 'ack', cid: h.sent.at(-1).cid });
  await new Promise(resolve => setImmediate(resolve)); port.close();
  assert.deepEqual(h.persisted, []); assert.equal(h.clock.jobs.size, 0);
});

test("stream send failures do not queue, and both response error envelopes preserve their error codes", async () => {
  const h = requestsSetup(true);
  h.sendable(false);
  await assert.rejects(h.requests.request({ t: "stream_publish" }), e => e.code === "offline");
  h.sendable(true); h.requests.flush();
  assert.deepEqual(h.sent, []);
  assert.equal(h.clock.jobs.size, 0);
  const error = assert.rejects(h.requests.request({ t: "stream_subscribe", cid: "denied" }),
    e => e.code === "OWNER_ONLY" && e.message === "Owner required");
  assert.equal(h.requests.receive({ t: "error", cid: "denied", code: "OWNER_ONLY", message: "Owner required" }), true);
  await error;
  const rejected = assert.rejects(h.requests.request({ t: "stream_publish", cid: "bad" }),
    e => e.code === "bad_request" && e.message === "Invalid record");
  assert.equal(h.requests.receive({ t: "ack", cid: "bad", error: { code: "bad_request", message: "Invalid record" } }), true);
  await rejected;
  assert.equal(h.clock.jobs.size, 0);
});

test("command receipts time out without rejection and remain distinct from correlated RPC errors", async () => {
  const h = requestsSetup(false);
  const offline = h.receipts.wait("offline-command");
  h.clock.tick(3000); assert.equal(await offline, null);
  h.online(true);
  const delayed = h.receipts.wait("delayed-command");
  h.clock.tick(7999); assert.equal(h.clock.jobs.size, 1);
  h.clock.tick(1); assert.equal(await delayed, null);
  const ack = { t: "ack", cid: "rejected-command", error: "rate_limit" };
  const rejected = h.receipts.wait(ack.cid);
  h.receipts.acknowledge(ack.cid, ack);
  assert.equal(await rejected, ack, "command callers interpret accepted/rejected/queued receipts themselves");
  const a = h.receipts.wait("a"), b = h.receipts.wait("b");
  h.receipts.disconnected(); h.receipts.disconnected();
  assert.deepEqual(await Promise.all([a, b]), [null, null]);
  h.receipts.acknowledge("delayed-command", { t: "ack", seq: 12 });
  assert.equal(h.clock.jobs.size, 0);
});

test("concurrent exact command callers receive one receipt without replacing each other's waiters", async () => {
  const h = requestsSetup(true), ack = { t: "ack", cid: "same", rev: 2 };
  const one = h.receipts.wait(ack.cid), two = h.receipts.wait(ack.cid);
  h.receipts.acknowledge(ack.cid, ack);
  assert.equal(h.clock.jobs.size, 0);
  assert.deepEqual(await Promise.all([one, two]), [ack, ack]);
});

test("an expired command waiter cannot remove a later exact caller's receipt", async () => {
  const h = requestsSetup(true), ack = { t: "ack", cid: "same", rev: 2 };
  const expired = h.receipts.wait(ack.cid);
  h.clock.tick(1000);
  const later = h.receipts.wait(ack.cid);
  h.clock.tick(7000); assert.equal(await expired, null);
  h.receipts.acknowledge(ack.cid, ack);
  assert.equal(h.clock.jobs.size, 0);
  assert.equal(await later, ack);
});

function connectionSetup({ failOpens = 0 } = {}) {
  const clock = new Clock(), sockets = [], messages = [], disconnects = [];
  let rev = 0, attempts = 0;
  const connection = createConnection({ url: () => "wss://page.example/_tendril/ws",
    hello: () => ({ t: "hello", rev }),
    message(message) { messages.push(message); if (message.t === "welcome") connection.welcome(); },
    disconnected(wasConnected) { disconnects.push(wasConnected); },
  }, { clock, random: () => 0, socket: url => {
    assert.equal(url, "wss://page.example/_tendril/ws");
    if (++attempts <= failOpens) throw Error("network unavailable");
    const socket = new Socket(); sockets.push(socket); return socket;
  } });
  return { connection, clock, sockets, messages, disconnects, rev(value) { rev = value; }, attempts: () => attempts };
}

test('a full live browser buffer leaves the shared connection and durable send path usable', () => {
  const h = connectionSetup(); h.connection.start();
  const socket = h.sockets[0]; socket.open(); socket.message({ t: 'welcome' });
  socket.bufferedAmount = 256 * 1024;
  assert.equal(h.connection.sendLive({ t: 'signal_send', message: { payload: 'drop me' } }), false);
  assert.equal(h.connection.connected, true); assert.deepEqual(socket.closed, []);
  assert.equal(h.connection.send({ t: 'state', cid: 'durable' }), true);
  socket.bufferedAmount = 0;
  assert.equal(h.connection.sendLive({ t: 'signal_send', message: { payload: 'fresh' } }), true);
  assert.deepEqual(socket.sent.map(message => message.t), ['hello', 'state', 'signal_send']);
});

test("connection waits for initialization and ignores callbacks from an earlier socket generation", () => {
  const h = connectionSetup();
  h.connection.reconnect(); assert.equal(h.sockets.length, 0);
  h.connection.start(); h.connection.start(); assert.equal(h.sockets.length, 1);
  const first = h.sockets[0]; first.open();
  assert.deepEqual(first.sent, [{ t: "hello", rev: 0 }]);
  assert.equal(h.connection.connected, false);
  first.message({ t: "welcome" }); assert.equal(h.connection.connected, true);
  first.close(); assert.equal(h.connection.connected, false);
  assert.deepEqual(h.disconnects, [true]);
  h.clock.tick(249); assert.equal(h.sockets.length, 1);
  h.rev(9); h.clock.tick(1);
  const second = h.sockets[1];
  first.open(); first.message({ t: "welcome" }); first.close();
  assert.equal(h.connection.connected, false);
  assert.deepEqual(second.sent, []);
  assert.deepEqual(h.disconnects, [true]);
  assert.equal(h.messages.length, 1);
  second.open(); assert.deepEqual(second.sent, [{ t: "hello", rev: 9 }]);
  second.message({ t: "welcome" }); assert.equal(h.connection.connected, true);
});

test("connection retries failed opens, times out unwelcomed sockets, and manual reconnect cancels backoff", () => {
  const h = connectionSetup({ failOpens: 2 });
  h.connection.start(); assert.equal(h.attempts(), 1);
  h.clock.tick(250); assert.equal(h.attempts(), 2);
  h.clock.tick(499); assert.equal(h.sockets.length, 0);
  h.clock.tick(1); assert.equal(h.sockets.length, 1);
  const first = h.sockets[0]; first.open();
  h.clock.tick(15_000); assert.equal(first.closed.length, 1);
  assert.deepEqual(h.disconnects, [false]);
  h.connection.reconnect(); assert.equal(h.sockets.length, 2);
  h.clock.tick(1000); assert.equal(h.sockets.length, 2, "old reconnect timer must not create another socket");
  const second = h.sockets[1]; second.open(); second.message({ t: "welcome" });
  h.clock.tick(15_000); assert.equal(second.closed.length, 0, "welcome cancels its deadline");
});

test("heartbeat accepts any frame as liveness and an old timeout cannot close a replacement socket", () => {
  const h = connectionSetup();
  h.connection.start(); const first = h.sockets[0]; first.open(); first.message({ t: "welcome" });
  h.clock.tick(25_000); assert.equal(first.sent.at(-1).t, "ping");
  h.clock.tick(9999); first.message("malformed JSON"); h.clock.tick(1);
  assert.equal(first.closed.length, 0);
  h.clock.tick(15_000);
  const oldTimeout = [...h.clock.jobs.values()].find(job => job.interval === null).callback;
  first.close(); h.connection.reconnect();
  const second = h.sockets[1]; second.open(); second.message({ t: "welcome" });
  h.clock.tick(25_000);
  oldTimeout();
  second.message({ t: "pong" }); h.clock.tick(10_000);
  assert.equal(second.closed.length, 0, "an obsolete timeout must not clear the new socket's liveness timer");
  h.clock.tick(15_000); h.clock.tick(10_000);
  assert.equal(second.closed.length, 1, "a genuinely unresponsive current socket reconnects");
});
