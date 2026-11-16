import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { webcrypto, createHash } from "node:crypto";
import { build } from "esbuild";
import { assertValid } from "../../contract/index.mjs";
const built = await build({ stdin: { contents: 'export { createCore } from "./core"; export { createFixtureTransport } from "./preview";', resolveDir: new URL("../src/", import.meta.url).pathname, loader: "ts" }, bundle: true, format: "iife", globalName: "Runtime", platform: "browser", write: false });
const flush = async () => {
  for (let round = 0; round < 3; round++) {
    await new Promise(setImmediate);
    for (let i = 0; i < 20; i++) await Promise.resolve();
  }
};
async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate() && Date.now() < deadline) await flush();
  assert.ok(predicate(), "Fixture did not reach the expected transfer phase");
}

function blobService() {
  const calls = [], sessions = new Map(), pins = new Map();
  const blobId = "b_" + "a".repeat(20), uploadId = "u_" + "a".repeat(20);
  const metadata = session => ({ id: blobId, sha256: session.sha256, size: session.size, type: session.type,
    url: "/page/_tendril/blobs/" + blobId, created_at: 1000, retention: { expires_at: 100000, reasons: [] } });
  const service = {
    calls, sessions, pins, dropComplete: 0, dropCompleteBody: 0, dropPin: 0, rejectPin: false, beforeComplete: null,
    fetch: async (url, init) => {
      const path = new URL(url, "https://fixture.test").pathname.replace("/page/_tendril", "");
      const body = init.headers["Content-Type"] === "application/json" ? JSON.parse(new TextDecoder().decode(init.body)) : init.body;
      calls.push({ path, method: init.method, body });
      assert.ok(init.headers["X-Tendril-Device"]);
      assert.ok(init.headers["X-Tendril-Device-Secret"]);
      if (path === "/uploads") {
        let session = sessions.get(body.cid);
        if (!session) {
          session = { ...body, id: uploadId, blob_id: blobId, phase: "ready", upload_required: true, expires_at: 100000 };
          sessions.set(body.cid, session);
        } else assert.deepEqual({ cid: session.cid, sha256: session.sha256, size: session.size, type: session.type, ...(session.name === undefined ? {} : { name: session.name }) }, body);
        const { cid, type, name, ...response } = session;
        return json(response);
      }
      const session = [...sessions.values()][0];
      if (path === `/uploads/${uploadId}/content`) {
        assert.equal(createHash("sha256").update(body).digest("hex"), session.sha256);
        assert.equal(body.byteLength, session.size);
        session.phase = "received"; session.upload_required = false;
        return new Response(null, { status: 204 });
      }
      if (path === `/uploads/${uploadId}/complete`) {
        assert.ok(["received", "completed"].includes(session.phase));
        session.phase = "completed";
        if (service.beforeComplete) await service.beforeComplete();
        if (service.dropComplete > 0) { service.dropComplete--; throw new TypeError("Connection lost after completion"); }
        if (service.dropCompleteBody > 0) {
          service.dropCompleteBody--;
          return new Response(new ReadableStream({ start(controller) {
            controller.enqueue(new TextEncoder().encode('{"status":"completed","blob":'));
            controller.error(new TypeError("Connection lost during response body"));
          } }), { headers: { "Content-Type": "application/json" } });
        }
        return json({ status: "completed", blob: metadata(session) });
      }
      if (path === `/blobs/${blobId}/pin`) {
        if (pins.has(body.cid)) return json(pins.get(body.cid));
        if (service.rejectPin) return json({ error: { code: "stale_generation", message: "The original pin scope changed" } }, 409);
        const receipt = { ...metadata(session), retention: body.keep ? { expires_at: null, reasons: ["pinned"] } : { expires_at: 100000, reasons: [] } };
        pins.set(body.cid, receipt);
        if (service.dropPin > 0) { service.dropPin--; throw new TypeError("Connection lost after pinning"); }
        return json(receipt);
      }
      throw new Error(`Unexpected blob request ${path}`);
    },
  };
  return service;
}

// The fake controls transaction completion (not the runtime's queuing policy).
// This lets tests observe the interval between a put request and durable commit.
class Database {
  stores = { outbox: new Map(), kv: new Map() };
  opened = [];
  pending = [];
  failure = false;
  indexedDB = {
    open: name => {
      this.opened.push(name);
      const request = {};
      queueMicrotask(() => { request.result = this; request.onsuccess?.(); });
      return request;
    },
  };
  objectStoreNames = { contains: () => true };
  transaction(names, mode) {
    const mutations = [];
    const transaction = { error: null, objectStore: name => {
      const records = this.stores[name];
      const request = value => {
        const result = {};
        queueMicrotask(() => { result.result = structuredClone(value); result.onsuccess?.(); });
        return result;
      };
      return {
        get: key => request(records.get(key)), getAll: () => request([...records.values()]),
        put: (value, key = value?.key) => { mutations.push(() => records.set(key, structuredClone(value))); return request(key); },
        delete: key => { mutations.push(() => records.delete(key)); return request(undefined); },
      };
    } };
    if (mode === "readwrite") this.pending.push(() => {
      if (this.failure) { transaction.error = new Error("fixture disk failed"); transaction.onabort?.(); }
      else { for (const mutation of mutations) mutation(); transaction.oncomplete?.(); }
    });
    return transaction;
  }
  commit() { for (const commit of this.pending.splice(0)) commit(); }
}
function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}
async function environment({ database = new Database(), localStorage = storage(), scopes = [], state = {}, rev = 1, online = true, blobs = blobService(), configuration = {}, fetcher = blobs.fetch, onCore } = {}) {
  const timers = new Map(); let next = 0;
  const clock = { setTimeout(fn, ms) { const id = ++next; timers.set(id, { fn, ms }); return id; }, clearTimeout(id) { timers.delete(id); }, setInterval() { return ++next; }, clearInterval() {} };
  const window = new EventTarget(), document = Object.assign(new EventTarget(), { visibilityState: "hidden", readyState: "complete", currentScript: { src: "https://fixture.test/runtime/tendril.js" } });
  const navigations = [];
  const globals = { window, document, localStorage, sessionStorage: storage(), indexedDB: database.indexedDB,
    crypto: webcrypto, Blob, URL, Headers, Response, Uint8Array, ArrayBuffer, TextEncoder, URLSearchParams, structuredClone, AbortController, Event, CustomEvent: class extends Event { constructor(type, options) { super(type, options); this.detail = options?.detail; } },
    location: { href: "https://fixture.test/page/?review=1#draft", origin: "https://fixture.test", host: "fixture.test", pathname: "/page/", protocol: "https:", search: "?review=1", hash: "#draft", assign(url) { navigations.push(url); }, reload() {} },
    navigator: { onLine: online, userAgent: "Fixture", language: "en", userActivation: { isActive: false } }, screen: { width: 800, height: 600 },
    console: { log() {}, info() {}, warn() {}, error() {} }, queueMicrotask, ...clock,
    fetch: fetcher,
  };
  runInNewContext(built.outputFiles[0].text, globals);
  const transport = globals.Runtime.createFixtureTransport(), sent = [];
  window.__TENDRIL_TRANSPORT__ = transport.socket;
  transport.onSend((frame, reply) => {
    sent.push(structuredClone(frame));
    if (frame.t === "hello" && online) reply({ t: "welcome", state, scopes, rev, role: "owner", pending: false, transcript: [] });
  });
  const core = globals.Runtime.createCore({ id: "page", base: "/page/", version: 1, documentPath: null, ws: "wss://fixture.test/page/_tendril/ws", preview: true, features: {push:false,vapid:null,shared_by:"Fixture",speech:null}, ...configuration });
  onCore?.(core);
  await flush();
  return { core, database, localStorage, transport, sent, window, blobs, navigations,
    async commit() { database.commit(); await flush(); },
    async settle() { for (const [id, timer] of [...timers]) { timers.delete(id); timer.fn(); } await flush(); },
    async expire(ms) { for (const [id, timer] of [...timers]) if (timer.ms === ms) { timers.delete(id); timer.fn(); } await flush(); },
  };
}
// An ACK phase and its deletion are separate IndexedDB transactions. Ordinary
// receipt assertions advance both; failure tests advance each phase explicitly.
async function commitAck(env) { await flush(); await env.commit(); await env.commit(); }
function json(value, status = 200) { return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } }); }

test("peer pages select one backend and never open or deliver a Cloudflare application outbox", async () => {
  const env = await environment({ configuration: { application: { kind: "peer", id: "history-one" } } });
  assert.deepEqual(env.database.opened, ["tendril:v3:page:host"]);
  assert.throws(() => env.core.application.backend, { code: "backend_unavailable" });
  await assert.rejects(env.core.send({ type: "task" }), { code: "application_backend" });
  assert.throws(() => env.core.state.apply([{ op: "set", path: ["task"], value: 1 }]), { code: "application_backend" });
  const authored = [], backend = { id: "history-one", capabilities: ["events"], async submit(program, options) { authored.push({ program, options }); },
    readView() {}, events: { publish() {}, read() {}, subscribe() {} }, operations: { get() {}, subscribe() {} } };
  env.core.application.install(backend);
  assert.equal(await env.core.application.ready(), backend);
  await backend.submit({ exact: "proposal" }, { operationId: "original" });
  assert.equal(authored.length, 1);
  assert.equal(env.database.stores.outbox.size, 0);
  assert.equal(env.sent.filter(message => ["send", "state", "application"].includes(message.t)).length, 0);
  assert.throws(() => env.core.application.install(backend), { code: "backend_already_selected" });
});

test("application submissions use the existing durable outbox and retain the original complete program", async () => {
  const calls = [];
  const env = await environment({ fetcher: async (url, options) => {
    const body = JSON.parse(options.body); calls.push({ url, body });
    return json({ operationId: body.operationId, proposalId: "exact-proposal", status: "final", outcome: "accepted", revision: "r1" });
  } });
  const input = { version: 1, expected_generations: { task: "captured" }, steps: [{ kind: "emit", topic: "tasks", payload: { value: 1 } }] };
  const submitted = env.core.application.backend.submit(input, { operationId: "stable" });
  input.steps[0].payload.value = 99; input.expected_generations.task = "new";
  await flush(); assert.equal(calls.length, 0);
  await env.commit();
  assert.equal(calls.length, 1); assert.equal(calls[0].body.program.steps[0].payload.value, 1);
  assert.equal(calls[0].body.program.expected_generations.task, "captured");
  await env.commit(); await env.commit();
  assert.equal((await submitted).proposalId, "exact-proposal");
  assert.equal(env.database.stores.outbox.size, 0);
  assert.equal(env.sent.filter(message => message.t === "application").length, 0);
});

test("application cursor reads use validated relative query URLs and keep revision-scoped snapshots coherent", async () => {
  const calls = [];
  const env = await environment({ fetcher: async url => {
    calls.push(url);
    if (url.endsWith("application/view")) return json({ revision: "view-1", state: { task: 1 }, scopes: [] });
    return json({ transactions: [], scannedThrough: "cursor-2", hasMore: false, revision: new URL(url, "https://fixture.test").searchParams.get("revision") || "view-2" });
  } });
  const backend = env.core.application.backend, view = await backend.readView();
  const batch = await view.readEvents({ cursor: "opaque/a+b=", topics: ["tasks"] });
  assert.equal(batch.revision, view.revision); assert.equal(view.query("state").task, 1);
  assert.equal(new URL(calls.at(-1), "https://fixture.test").searchParams.get("cursor"), "opaque/a+b=");
  assert.equal(new URL(calls.at(-1), "https://fixture.test").searchParams.get("topics"), '["tasks"]');
  for (const path of ["../outside?ok=1", "/outside?ok=1", "https://elsewhere.test?ok=1", "%2e%2e/outside?ok=1", "application/view#fragment"])
    await assert.rejects(env.core.request(path), /relative path/);
  view.release(); assert.throws(() => view.query("state"), { code: "view_released" });
});

test("malformed or lost application receipts retain exact authored work across reload", async () => {
  const calls = [];
  let malformed = true;
  const fetcher = async (url, options) => {
    const body = JSON.parse(options.body); calls.push(body);
    return json({ operationId: body.operationId, proposalId: "stable-proposal", status: "final", ...(malformed ? {} : { outcome: "accepted" }) });
  };
  const first = await environment({ fetcher });
  const program = { version: 1, steps: [{ kind: "emit", topic: "tasks", payload: { reviewed: true } }], expected_generations: { tasks: "original" } };
  void first.core.application.backend.submit(program, { operationId: "reviewed" });
  await flush(); await first.commit(); await flush();
  assert.equal(first.database.stores.outbox.size, 1);
  assert.equal((await first.core.application.backend.operations.get("reviewed")).status, "queued");
  first.transport.disconnect(); malformed = false;
  const second = await environment({ database: first.database, localStorage: first.localStorage, fetcher });
  await until(() => calls.length === 2);
  assert.deepEqual(calls[0], calls[1]);
  await second.commit(); await second.commit();
  assert.equal(second.database.stores.outbox.size, 0);
});

test("application admission refusals preserve the reviewed draft and terminal status after offline reload", async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return json({ error: { code: "history_quota", message: "Full retained history" } }, 429); };
  const first = await environment({ fetcher });
  const program = { version: 1, steps: [{ kind: "emit", topic: "tasks", payload: { reviewed: true } }], expected_generations: {} };
  const submitted = first.core.application.backend.submit(program, { operationId: "retained" });
  await flush(); await first.commit(); await first.commit();
  assert.equal((await submitted).error, "history_quota");
  assert.equal(first.database.stores.outbox.size, 1);
  first.transport.disconnect();
  const second = await environment({ database: first.database, localStorage: first.localStorage, fetcher, online: false });
  assert.equal((await second.core.application.backend.operations.get("retained")).status, "rejected");
  assert.equal((await second.core.application.backend.submit(program, { operationId: "retained" })).error, "history_quota");
  await assert.rejects(second.core.application.backend.submit({ ...program, steps: [{ kind: "emit", topic: "tasks", payload: "different" }] }, { operationId: "retained" }), { code: "operation_conflict" });
  assert.equal(calls, 1);
});

test("sensor observers receive isolated snapshots without changing later observers or service usage", async () => {
  const env = await environment(), received = [];
  const status = { active: ["camera"], pending: ["microphone"] };
  env.core.bus.on("sensors", value => {
    value.active.splice(0, value.active.length, "screen");
    value.pending.push("location");
  });
  env.core.bus.on("sensors", value => received.push(plain(value)));
  env.core.bus.emit("sensors", status);
  assert.deepEqual(status, { active: ["camera"], pending: ["microphone"] }, "the kernel's subsequent sensor_usage still sees its original snapshot");
  assert.deepEqual(received, [{ active: ["camera"], pending: ["microphone"] }]);
});

const descriptor = { id: "opaque-scope", generation: "original", paths: [["notebook"]], operations: [] };

const timerScope = { id: "schedule", generation: "reviewed", paths: [], operations: ["timer.write"] };
const plain = value => JSON.parse(JSON.stringify(value));
function timerService() {
  const calls = [], receipts = new Map();
  const initial = { id: "timer-1", revision: 1, title: "Reviewed timer", due_at: 4000, timezone: "UTC", missed: "fire_once",
    notify: false, state: "scheduled", created_at: 1000, updated_at: 1000 };
  const service = {
    calls, receipts, current: { ...initial }, reject: null, drop: 0, dropBody: 0, response: null,
    fetch: async (url, options) => {
      const path = new URL(url, "https://fixture.test").pathname.replace("/page/_tendril/", "");
      const body = options.body === undefined ? undefined : JSON.parse(options.body);
      const call = { path, method: options.method, body };
      calls.push(call);
      assert.equal(options.credentials, "same-origin"); assert.equal(options.cache, "no-store");
      assert.ok(options.headers["X-Tendril-Device"]); assert.ok(options.headers["X-Tendril-Device-Secret"]);
      if (options.method !== "GET") assertValid(options.method === "POST" ? "timerCreate" : options.method === "PATCH" ? "timerWrite" : "timerDelete", body);
      if (service.response) return service.response(call, options);
      if (service.reject) return json({ error: service.reject.error }, service.reject.status);
      if (path === "timers" && options.method === "GET")
        return json({ timers: [service.current], execution: "server", lifetime: "resident", expires_at: null });
      if (path === "timers/history" && options.method === "GET") return json({ runs: [] });
      let receipt = receipts.get(body.cid);
      if (receipt) assert.deepEqual(call, receipt.call, "replay must preserve the entire original command");
      else {
        const { cid, scope, expected_generations, expected_revision, ...settings } = body;
        const id = options.method === "POST" ? `timer-${receipts.size + 1}` : path.slice("timers/".length);
        const value = options.method === "DELETE" ? { id, revision: expected_revision + 1, deleted: true }
          : { ...(options.method === "POST" ? initial : service.current), ...settings, id,
            revision: options.method === "POST" ? 1 : expected_revision + 1 };
        assertValid(options.method === "DELETE" ? "timerDeleted" : "timer", value);
        receipt = { call, value }; receipts.set(cid, receipt);
        if (options.method !== "DELETE") service.current = value;
      }
      if (service.drop > 0) { service.drop--; throw new TypeError("Connection lost after timer commit"); }
      if (service.dropBody > 0) {
        service.dropBody--;
        return new Response(new ReadableStream({ start(controller) {
          controller.enqueue(new TextEncoder().encode('{"id":'));
          controller.error(new TypeError("Timer response body interrupted"));
        } }));
      }
      return json(receipt.value);
    },
  };
  return service;
}

test("timer commands capture immutable settings and guards before storage, then expose correlated durable receipts", async () => {
  const service = timerService(), results = [], queues = [];
  const env = await environment({ fetcher: service.fetch, scopes: [timerScope] });
  env.core.bus.on("timer_result", result => { result.command.title = "Observer changed its copy"; if (result.value) result.value.title = "Observer changed its receipt"; });
  env.core.bus.on("timer_queue", queue => { if (queue.length) queue[0].command.title = "Observer changed its queue"; });
  env.core.bus.on("timer_result", result => results.push(plain(result)));
  env.core.bus.on("timer_queue", queue => queues.push(plain(queue)));
  const settings = { title: "Reviewed", due_at: 4000, timezone: "UTC", repeat: { at: "09:00", days: [1, 3] } };
  const promise = env.core.timers.create(settings);
  settings.title = "New draft"; settings.repeat.days.push(5);
  env.transport.receive({ t: "scopes", scopes: [{ ...timerScope, generation: "new-review" }] });
  await flush();
  assert.equal(service.calls.length, 0); assert.equal(env.core.pendingWork().timers, 0);
  assert.deepEqual(plain(env.core.timers.pending()), []); assert.equal(results.length, 0);
  await env.commit();
  assert.equal(service.calls.length, 1); assert.equal(env.core.pendingWork().timers, 1);
  const original = service.calls[0].body;
  assert.deepEqual(original.expected_generations, { schedule: "reviewed" });
  assert.equal(original.title, "Reviewed"); assert.deepEqual(original.repeat.days, [1, 3]);
  assert.equal(results[0].status, "queued"); assert.equal(queues[0][0].cid, original.cid);
  const copy = env.core.timers.pending(); copy[0].command.title = "changed copy";
  assert.equal(env.core.timers.pending()[0].command.title, "Reviewed");
  await env.commit();
  assert.equal([...env.database.stores.outbox.values()][0].msg.outcome.status, "accepted");
  assert.deepEqual(results.map(result => result.status), ["queued"], "persisting the outcome is not yet durable cleanup");
  await env.commit();
  const result = await promise;
  assert.equal(result.status, "accepted"); assert.equal(result.cid, original.cid); assert.equal(result.value.revision, 1);
  assert.equal(result.value.title, "Reviewed"); assert.equal(queues[0][0].command.title, "Reviewed");
  assert.deepEqual(results.map(result => result.status), ["queued", "accepted"]);
  assert.deepEqual(results[1].command, original); assert.equal(env.core.pendingWork().timers, 0);
  assert.deepEqual(queues.at(-1), []);
});

test("unsaved timer work rejects without sending or claiming a queued timer", async () => {
  const service = timerService(), results = [];
  const env = await environment({ fetcher: service.fetch });
  env.core.bus.on("timer_result", result => results.push(result));
  env.database.failure = true;
  const promise = env.core.timers.create({ title: "Keep this draft", due_at: 4000 });
  await flush(); await env.commit();
  const result = await promise;
  assert.equal(result.status, "rejected"); assert.equal(result.error, "storage_unavailable");
  assert.equal(results.length, 1); assert.equal(results[0].command.title, "Keep this draft");
  assert.equal(service.calls.length, 0); assert.equal(env.core.pendingWork().timers, 0);
});

test("offline timer edits replay the original revision and guards after reload without rebasing", async () => {
  const service = timerService(), restored = [], results = [];
  const first = await environment({ fetcher: service.fetch, scopes: [timerScope] });
  first.transport.disconnect();
  const promise = first.core.timers.update("timer-1", { due_at: 4000 }, { expected_revision: 7, scope: "schedule" });
  await flush(); await first.commit(); await first.expire(3000);
  assert.equal((await promise).status, "queued"); assert.equal(service.calls.length, 0);
  const original = plain(first.core.timers.pending()[0]);
  service.reject = { status: 409, error: { code: "stale_generation", message: "Review the active schedule" } };
  const second = await environment({ database: first.database, localStorage: first.localStorage, fetcher: service.fetch,
    scopes: [{ ...timerScope, generation: "rotated" }], onCore(core) {
      core.bus.on("timer_queue", queue => restored.push(plain(queue)));
      core.bus.on("timer_result", result => results.push(plain(result)));
    } });
  assert.deepEqual(service.calls[0].body, original.command);
  assert.equal(service.calls[0].body.expected_revision, 7); assert.deepEqual(restored[0], [original]);
  await second.commit(); await second.commit();
  assert.equal(results[0].cid, original.cid); assert.equal(results[0].error, "stale_generation");
  assert.equal(results[0].operation, "update"); assert.deepEqual(results[0].command, original.command);
  assert.equal(second.core.pendingWork().timers, 0);
});

test("lost timer success or body interruption replays one intent and reports its historical receipt after reload", async () => {
  for (const failure of ["drop", "dropBody"]) {
    const service = timerService(), results = []; service[failure] = 1;
    const first = await environment({ fetcher: service.fetch });
    const promise = first.core.timers.create({ title: "Original", due_at: 4000 });
    await flush(); await first.commit(); await first.expire(8000);
    const queued = await promise; assert.equal(queued.status, "queued");
    assert.equal(service.receipts.size, 1);
    service.current = { ...service.current, revision: 3, title: "Changed elsewhere" };
    const second = await environment({ database: first.database, localStorage: first.localStorage, fetcher: service.fetch,
      onCore(core) { core.bus.on("timer_result", result => results.push(plain(result))); } });
    await second.commit(); await second.commit();
    assert.equal(service.receipts.size, 1); assert.deepEqual(service.calls[1], service.calls[0]);
    assert.equal(results[0].cid, queued.cid); assert.equal(results[0].status, "accepted");
    assert.equal(results[0].value.revision, 1); assert.equal(results[0].value.title, "Original");
    assert.equal((await second.core.timers.list()).timers[0].revision, 3);
  }
});

test("timer revision, authority and explicit capacity rejections terminate without automatic new work", async () => {
  for (const [status, code] of [[409, "timer_conflict"], [403, "forbidden"], [429, "quota"], [429, "resource_quota"], [428, "generation_required"]]) {
    const service = timerService();
    service.reject = { status, error: { code, message: "Review this operation", ...(code === "timer_conflict" ? { current: 4 } : {}) } };
    const env = await environment({ fetcher: service.fetch });
    const promise = env.core.timers.update("timer-1", { title: "Review" }, { expected_revision: 2 });
    await flush(); await env.commit(); await env.commit(); await env.commit();
    const result = await promise;
    assert.equal(result.status, "rejected"); assert.equal(result.error, code);
    if (code === "timer_conflict") assert.equal(result.details.current, 4);
    assert.equal(env.core.pendingWork().timers, 0);
    await env.expire(5000); assert.equal(service.calls.length, 1);
  }
});

test("timer outcome persistence retries storage without falsely settling or repeating the HTTP operation", async () => {
  for (const rejected of [false, true]) {
    const service = timerService(), results = [];
    if (rejected) service.reject = { status: 403, error: { code: "forbidden", message: "Owner access required" } };
    const env = await environment({ fetcher: service.fetch });
    env.core.bus.on("timer_result", result => results.push(plain(result)));
    const promise = env.core.timers.create({ title: "Reviewed", due_at: 4000 });
    await flush(); await env.commit();
    env.database.failure = true;
    await env.commit(); await env.expire(8000);
    assert.equal((await promise).status, "queued"); assert.equal(env.core.pendingWork().timers, 1);
    assert.deepEqual(results.map(result => result.status), ["queued"]);
    service.reject = null; env.database.failure = false;
    await env.expire(5000); await env.commit(); await env.commit();
    assert.equal(service.calls.length, 1, "a known terminal receipt only retries durable cleanup");
    assert.equal(results.at(-1).status, rejected ? "rejected" : "accepted");
    assert.equal(env.core.pendingWork().timers, 0);
  }
});

test("a persisted timer outcome survives failed removal and reload without another HTTP command", async () => {
  for (const rejected of [false, true]) {
    const service = timerService(), before = [], after = [];
    if (rejected) service.reject = { status: 403, error: { code: "forbidden", message: "Owner access required" } };
    const first = await environment({ fetcher: service.fetch });
    first.core.bus.on("timer_result", result => before.push(plain(result)));
    const promise = first.core.timers.create({ title: "Exact original intent", due_at: 4000 });
    await flush(); await first.commit(); await first.commit();
    const saved = [...first.database.stores.outbox.values()][0].msg;
    assert.equal(saved.outcome.status, rejected ? "rejected" : "accepted");
    assert.equal(saved.intent.command.title, "Exact original intent");
    first.database.failure = true;
    await first.commit(); await first.expire(8000);
    assert.equal((await promise).status, "queued");
    assert.deepEqual(before.map(result => result.status), ["queued"]);
    service.reject = null; first.database.failure = false;
    const second = await environment({ database: first.database, localStorage: first.localStorage, fetcher: service.fetch,
      onCore(core) { core.bus.on("timer_result", result => after.push(plain(result))); } });
    assert.equal(service.calls.length, 1, "the saved terminal phase only needs local cleanup after reload");
    await second.commit();
    assert.equal(after[0].status, rejected ? "rejected" : "accepted");
    assert.deepEqual(after[0].command, saved.intent.command);
    assert.equal(after[0].cid, saved.cid); assert.equal(second.core.pendingWork().timers, 0);
  }
});

test("an outcome that could not be saved remains unresolved and replays its immutable intent after reload", async () => {
  const service = timerService(), results = [];
  service.reject = { status: 403, error: { code: "forbidden", message: "Owner access required" } };
  const first = await environment({ fetcher: service.fetch });
  first.core.bus.on("timer_result", result => results.push(plain(result)));
  const promise = first.core.timers.create({ title: "Still unresolved", due_at: 4000 });
  await flush(); await first.commit();
  first.database.failure = true;
  await first.commit(); await first.expire(8000);
  assert.equal((await promise).status, "queued");
  const saved = [...first.database.stores.outbox.values()][0].msg;
  assert.equal(saved.outcome, undefined); assert.deepEqual(results.map(result => result.status), ["queued"]);
  // Current-authority rejection was not durable. The runtime must not pretend
  // it saved that result; the same unresolved command can be retried by reload.
  service.reject = null; first.database.failure = false;
  const second = await environment({ database: first.database, localStorage: first.localStorage, fetcher: service.fetch });
  assert.deepEqual(service.calls[1], service.calls[0]);
  await second.commit(); await second.commit();
  assert.equal(second.core.pendingWork().timers, 0); assert.equal(service.receipts.size, 1);
});

test("transient timer errors retry unchanged with delay, and malformed success never claims rejection", async () => {
  for (const mode of ["rate_limited", "read_only", "invalid_response"]) {
    const service = timerService(), results = [];
    service.response = () => mode === "invalid_response" ? json({ accepted: true })
      : json({ error: { code: mode, message: "Try again" } }, mode === "rate_limited" ? 429 : 503);
    const env = await environment({ fetcher: service.fetch });
    env.core.bus.on("timer_result", result => results.push(plain(result)));
    const promise = env.core.timers.create({ title: "Keep exact intent", due_at: 4000 });
    await flush(); await env.commit(); await env.expire(8000);
    assert.equal((await promise).status, "queued"); assert.equal(service.calls.length, 1);
    await flush(); assert.equal(service.calls.length, 1, "no hot-loop retry");
    await env.expire(5000); assert.equal(service.calls.length, 2);
    service.response = null;
    await env.expire(10000); await env.commit(); await env.commit();
    assert.equal(service.calls.length, 3); assert.deepEqual(service.calls[1], service.calls[0]); assert.deepEqual(service.calls[2], service.calls[0]);
    assert.deepEqual(results.map(result => result.status), ["queued", "accepted"]);
  }
});

test("a hung timer attempt has a deadline and retains its original command for a later attempt", async () => {
  const service = timerService(); service.response = () => new Promise(() => {});
  const env = await environment({ fetcher: service.fetch });
  const promise = env.core.timers.create({ title: "Bounded attempt", due_at: 4000 });
  await flush(); await env.commit(); await env.expire(8000);
  assert.equal((await promise).status, "queued");
  await env.expire(15000);
  service.response = null;
  await env.expire(5000); await env.commit(); await env.commit();
  assert.deepEqual(service.calls[1], service.calls[0]); assert.equal(env.core.pendingWork().timers, 0);
});

test("timer delete requires a matching deletion receipt and reads expose fresh validated server data", async () => {
  const service = timerService(), results = [];
  const env = await environment({ fetcher: service.fetch });
  env.core.bus.on("timer_result", result => results.push(plain(result)));
  service.response = () => json({ id: "other-timer", revision: 2, deleted: true });
  const promise = env.core.timers.remove("timer-1", { expected_revision: 1 });
  await flush(); await env.commit(); await env.expire(8000);
  assert.equal((await promise).status, "queued"); assert.equal(env.core.pendingWork().timers, 1);
  service.response = null;
  await env.expire(5000); await env.commit(); await env.commit();
  assert.equal(results.at(-1).operation, "remove");
  assert.deepEqual(results.at(-1).value, { id: "timer-1", revision: 2, deleted: true });
  assert.equal(service.calls[0].method, "DELETE"); assert.deepEqual(service.calls[1], service.calls[0]);
  const listing = await env.core.timers.list(); assert.equal(listing.execution, "server");
  assert.deepEqual(plain(await env.core.timers.history()), { runs: [] });
  service.reject = { status: 403, error: { code: "forbidden", message: "Owner access required" } };
  await assert.rejects(env.core.timers.list(), error => error.code === "forbidden" && error.status === 403);
  service.response = () => json({ timers: [] });
  await assert.rejects(env.core.timers.list(), error => error.code === "invalid_response");
});

test("invalid timer metadata and missing review revisions fail before any local queue write", async () => {
  const service = timerService(); const env = await environment({ fetcher: service.fetch });
  const bad = [
    () => env.core.timers.create({ title: "Review", due_at: 4000, cid: "injected" }),
    () => env.core.timers.create({ title: "Review", due_at: 4000 }, { cid: "injected" }),
    () => env.core.timers.create({ title: "Review", due_at: 4000 }, { scope: "" }),
    ...[null, [], "abc"].map(expected_generations => () => env.core.timers.create({ title: "Review", due_at: 4000 }, { expected_generations })),
    () => env.core.timers.create({ title: "Review", repeat: { at: "29:00" } }),
    () => env.core.timers.update("timer-1", { title: "Review" }, {}),
    () => env.core.timers.update("timer-1", { expected_revision: 2 }, { expected_revision: 1 }),
    () => env.core.timers.remove("timer-1", { expected_revision: 0 }),
    () => env.core.timers.remove("../timer-1", { expected_revision: 1 }),
  ];
  for (const run of bad) assert.throws(run);
  await flush();
  assert.equal(service.calls.length, 0); assert.equal(env.database.pending.length, 0); assert.equal(env.core.pendingWork().timers, 0);
});

test("publication updates preserve the explicit current document after draft deferral", async () => {
  for (const documentPath of [null, 'notes #1?/café 100%/review.html']) {
    const configuration = documentPath === null ? { documentPath } : { documentPath,
      publication: { id: '1', base: '/page/_publications/1/', entry: 'app.html', runtime: { base: '/runtime/', version: 'fixture' },
        assets: [{ path: 'app.html', type: 'text/html', sha256: 'a'.repeat(64) }, { path: documentPath, type: 'text/html', sha256: 'b'.repeat(64) }] } };
    const env = await environment({ configuration });
    let pending;
    env.window.addEventListener('tendril:before-reload', event => { event.preventDefault(); pending = event.detail; });
    env.transport.receive({ t: 'reload', version: 2 });
    await flush();
    assert.equal(pending.version, 2); assert.deepEqual(env.navigations, []);
    pending.apply(); pending.apply();
    await flush();
    const path = documentPath === null ? '' : documentPath.split('/').map(encodeURIComponent).join('/');
    assert.deepEqual(env.navigations, ['https://fixture.test/page/' + path + '?review=1#draft']);
  }
});

test("Contract 3 opens only its own persistence and ignores obsolete snapshots", async () => {
  const localStorage = storage();
  const obsolete = JSON.stringify({ rev: 12, state: { obsolete: true }, pending: [], transcript: [], scopes: [] });
  localStorage.setItem("tendril:v2:page:snapshot", obsolete);
  const env = await environment({ localStorage, online: false });
  assert.deepEqual(env.database.opened, ["tendril:v3:page"]);
  assert.deepEqual(JSON.parse(JSON.stringify(env.core.state.get())), {});
  assert.equal(localStorage.getItem("tendril:v2:page:snapshot"), obsolete, "Fresh persistence does not migrate old work");
});

test("application data has no prescribed preferences or device namespaces", async () => {
  const data = { _prefs: { audio: false, mode: "display" }, _device: { zoom: 3 }, notebook: { session_id: "opaque" } };
  const env = await environment({ state: data });
  assert.deepEqual(JSON.parse(JSON.stringify(env.core.state.get())), data);
  assert.equal(env.core.state.mine, undefined);
  assert.equal(env.core.preferences, undefined);
  assert.equal(env.core.tts, undefined);
  assert.equal(env.core.speak, undefined);
  assert.equal(env.core.rules, undefined);
});

test("welcome updates service availability without replacing publication-pinned runtime features", async () => {
  const env = await environment();
  const speech = { model: "pinned", url: "model-a", sha256: "a".repeat(64), engine: { script: "engine-a", wasm: "wasm-a", wasm_sha256: "b".repeat(64) } };
  env.core.config.publication = { id: "1", base: "/page/_publications/1/", assets: [], runtime: { base: "/page/runtime/", version: "1", features: { speech } } };
  env.transport.receive({ t: "welcome", state: {}, scopes: [], rev: 1, features: { push: true, speech: { model: "new deployment" } } });
  await flush();
  assert.equal(env.core.config.features.push, true);
  assert.deepEqual(JSON.parse(JSON.stringify(env.core.config.features.speech)), speech);
});

test("state and events persist original identity and guards before optimism or delivery", async () => {
  const env = await environment({ scopes: [descriptor], state: { notebook: {} } });
  assert.equal(env.core.connected, true);
  const pending = env.core.state.set(["notebook", "draft"], "saved");
  const input = env.core.send({ type: "job.status", session: "application-owned" }, { scope: descriptor.id });
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(env.core.state.get())), { notebook: {} });
  assert.equal(env.sent.filter(frame => ["state", "send"].includes(frame.t)).length, 0);
  await env.commit();
  assert.equal(env.core.state.get("notebook.draft"), "saved");
  const messages = env.sent.filter(frame => ["state", "send"].includes(frame.t));
  assert.equal(messages.length, 2);
  for (const frame of messages) {
    assert.equal(frame.expected_generations[descriptor.id], "original");
    const stored = [...env.database.stores.outbox.values()].find(value => value.cid === frame.cid);
    assert.deepEqual(stored.msg, frame);
    env.transport.receive({ t: "ack", cid: frame.cid, rev: 2, seq: 1 });
  }
  await commitAck(env);
  assert.equal((await pending).status, "accepted");
  assert.equal((await input).status, "accepted");
  assert.equal(messages.find(frame => frame.t === "send").data.session, "application-owned");
});

test("conditional apply freezes predicates and all ops before durable admission, with no optimistic success", async () => {
  const env = await environment({ scopes: [descriptor], state: { notebook: { version: 1 }, claim: null } });
  const ops = [{ op: "set", path: ["claim"], value: { owner: "a" } }, { op: "set", path: ["status"], value: "claimed" }];
  const options = { conditions: [{ path: ["notebook", "version"], equals: 1 }], expected_revision: 1 };
  const changes = [], results = [];
  env.core.state.on(state => changes.push(state));
  env.core.bus.on("state_result", result => results.push(result));
  const pending = env.core.state.apply(ops, options);
  ops[0].value.owner = "changed"; ops[1].path[0] = "wrong";
  options.conditions[0].path[0] = "other"; options.conditions[0].equals = 99; options.expected_revision = 99;
  await flush();
  assert.equal(env.sent.some(frame => frame.t === "state"), false);
  await env.commit();
  const frame = env.sent.find(frame => frame.t === "state");
  assert.deepEqual(frame.conditions, [{ path: ["notebook", "version"], equals: 1 }]);
  assert.equal(frame.expected_revision, 1);
  assert.deepEqual(frame.expected_generations, { "opaque-scope": "original" });
  assert.deepEqual(frame.ops, [{ op: "set", path: ["claim"], value: { owner: "a" } }, { op: "set", path: ["status"], value: "claimed" }]);
  assert.deepEqual(JSON.parse(JSON.stringify(env.core.state.get())), { notebook: { version: 1 }, claim: null });
  assert.equal(changes.length, 0);
  env.transport.receive({ t: "ack", cid: frame.cid, rev: 2 });
  await commitAck(env);
  assert.equal((await pending).status, "accepted");
  assert.equal(env.core.state.get("claim").owner, "a");
  assert.equal(env.core.state.get("status"), "claimed");
  assert.deepEqual(JSON.parse(JSON.stringify(results[0].conditions)), frame.conditions);
});

test("pending state commands and queue observers expose detached durable identities without a second queue", async () => {
  const env = await environment({ state: { item: { done: false } }, scopes: [descriptor] });
  const observed = [];
  env.core.bus.on("state_queue", queue => {
    if (queue[0]) { queue[0].ops[0].value = "observer changed"; queue[0].conditions[0].equals = "observer changed"; queue[0].expected_generations[descriptor.id] = "observer changed"; }
    queue.length = 0;
  });
  env.core.bus.on("state_queue", queue => observed.push(queue));
  const write = env.core.state.set("item.done", true, { conditions: [{ path: ["item", "done"], equals: false }], scope: descriptor.id });
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(env.core.state.pending())), []);
  await env.commit();
  const original = env.sent.find(frame => frame.t === "state");
  assert.equal(observed.at(-1)[0].cid, original.cid);
  assert.equal(observed.at(-1)[0].ops[0].value, true);
  assert.equal(observed.at(-1)[0].conditions[0].equals, false);
  const inspected = env.core.state.pending();
  inspected[0].ops[0].path[0] = "wrong"; inspected[0].ops[0].value = false;
  inspected[0].conditions[0].equals = true; inspected[0].expected_generations[descriptor.id] = "changed";
  const saved = env.core.state.pending()[0];
  assert.equal(saved.status, "queued"); assert.equal(saved.cid, original.cid);
  assert.deepEqual(JSON.parse(JSON.stringify(saved.ops)), original.ops);
  assert.deepEqual(JSON.parse(JSON.stringify(saved.conditions)), original.conditions);
  assert.equal(saved.expected_generations[descriptor.id], "original");
  env.transport.disconnect();
  const queued = await write;
  assert.equal(queued.status, "queued"); assert.equal(queued.cid, original.cid);
  const resumed = await environment({ database: env.database, localStorage: env.localStorage, state: { item: { done: true } }, scopes: [descriptor] });
  assert.equal(resumed.core.state.pending()[0].cid, original.cid);
  const receipts = [];
  resumed.core.bus.on("state_result", receipt => { receipt.ops[0].value = "mutated"; receipt.conditions[0].equals = "mutated"; });
  resumed.core.bus.on("state_result", receipt => receipts.push(receipt));
  resumed.transport.receive({ t: "ack", cid: original.cid, error: "state_conflict", rev: 1, conflict: { kind: "condition", condition: 0, path: ["item", "done"] } });
  await flush(); await resumed.commit();
  assert.equal(receipts.length, 0, "saving the outcome does not yet claim completed cleanup");
  assert.equal([...env.database.stores.outbox.values()][0].msg.ops[0].value, true);
  await resumed.commit();
  assert.equal(receipts[0].cid, original.cid);
  assert.deepEqual(JSON.parse(JSON.stringify(receipts[0].ops)), original.ops);
  assert.deepEqual(JSON.parse(JSON.stringify(receipts[0].conditions)), original.conditions);
  assert.deepEqual(JSON.parse(JSON.stringify(resumed.core.state.pending())), []);
  assert.equal(env.database.stores.outbox.size, 0, "terminal observers run after durable deletion");
});

test("unchanged local operations have no command receipt while conditional empty checks have real identities", async () => {
  const env = await environment();
  assert.deepEqual(JSON.parse(JSON.stringify(await env.core.state.apply([]))), { status: "unchanged", rev: 1 });
  assert.deepEqual(JSON.parse(JSON.stringify(await env.core.state.patch({ absent: null }))), { status: "unchanged", rev: 1 });
  assert.equal(env.sent.some(frame => frame.t === "state"), false);
  const pending = env.core.state.apply([], { expected_revision: 1 });
  await flush(); await env.commit();
  const frame = env.sent.find(frame => frame.t === "state");
  env.transport.receive({ t: "ack", cid: frame.cid, rev: 1 });
  await commitAck(env);
  const result = await pending;
  assert.equal(result.status, "accepted"); assert.equal(result.cid, frame.cid); assert.equal(result.rev, 1);
  env.transport.receive({ t: "state", rev: 2, ops: [{ op: "set", path: ["remote"], value: true }] });
  const check = env.core.state.apply([], { expected_revision: 2 });
  await flush(); await env.commit();
  const next = env.sent.filter(frame => frame.t === "state").at(-1);
  env.transport.receive({ t: "ack", cid: next.cid, rev: 2 });
  await commitAck(env);
  assert.equal((await check).status, "accepted");
  assert.equal(env.core.connected, true, "an accepted check has no missing own delta to resynchronize");
  assert.equal(env.core.state.revision, 2); assert.equal(env.core.state.get("remote"), true);
});

test("state.snapshot returns authoritative state and matching revision without flushing or discarding optimism", async () => {
  const env = await environment({ state: { count: 0 }, scopes: [descriptor] });
  const pending = env.core.state.set("count", 1);
  await flush(); await env.commit();
  assert.equal(env.core.state.get("count"), 1); assert.equal(env.core.state.revision, 1);
  const read = env.core.state.snapshot();
  const request = env.sent.find(frame => frame.t === "state_snapshot");
  env.transport.receive({ t: "state_snapshot", cid: request.cid, state: { count: 0 }, rev: 1, scopes: [descriptor] });
  const snapshot = await read;
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), { state: { count: 0 }, rev: 1, scopes: [descriptor] });
  assert.equal(env.core.state.get("count"), 1); assert.equal(env.core.pendingWork().state, 1);
  assert.equal([...env.database.stores.outbox.values()].some(item => item.msg.t === "state_snapshot"), false);
  snapshot.state.count = 999; snapshot.scopes[0].generation = "changed";
  assert.equal(env.core.state.get("count"), 1); assert.equal(env.core.scopes.list()[0].generation, "original");
  const write = env.sent.find(frame => frame.t === "state");
  env.transport.receive({ t: "ack", cid: write.cid, rev: 2 });
  await commitAck(env);
  assert.equal((await pending).status, "accepted");
});

test("late snapshots and conditional ACKs cannot overwrite a newer broadcast or lose durable work", async () => {
  const initial = { shared: "before" };
  const env = await environment({ state: initial });
  const pending = env.core.state.apply([{ op: "set", path: ["mine"], value: "accepted" }, { op: "set", path: ["shared"], value: "earlier" }],
    { expected_revision: 1 });
  await flush(); await env.commit();
  const original = env.sent.find(frame => frame.t === "state");
  const read = env.core.state.snapshot();
  const request = env.sent.find(frame => frame.t === "state_snapshot");
  env.transport.receive({ t: "state", rev: 3, ops: [{ op: "set", path: ["remote"], value: true }, { op: "set", path: ["shared"], value: "later" }] });
  env.transport.receive({ t: "state_snapshot", cid: request.cid, state: { mine: "accepted", shared: "earlier" }, rev: 2, scopes: [] });
  const observed = await read;
  assert.equal(observed.rev, 2); assert.equal(observed.state.shared, "earlier");
  assert.equal(env.core.state.get("shared"), "later"); assert.equal(env.core.state.revision, 3);
  env.transport.receive({ t: "ack", cid: original.cid, rev: 2 });
  await env.commit(); // Persist the accepted ACK before requesting a full snapshot.
  assert.equal((await pending).status, "queued");
  assert.equal(env.core.connected, false); assert.equal(env.core.pendingWork().state, 1);
  const authority = { mine: "accepted", shared: "later", remote: true };
  const resumed = await environment({ database: env.database, localStorage: env.localStorage, state: authority, rev: 3 });
  assert.equal(resumed.sent.some(frame => frame.t === "state"), false, "the saved ACK needs a snapshot, not another mutation");
  await resumed.commit();
  assert.deepEqual(JSON.parse(JSON.stringify(resumed.core.state.get())), authority);
  assert.equal(resumed.core.state.revision, 3); assert.equal(resumed.core.pendingWork().state, 0);
});

test("an accepted ACK from a rotated scope waits for the authoritative snapshot", async () => {
  const env = await environment({ scopes: [descriptor], state: { notebook: { count: 0 } } });
  const pending = env.core.state.set("notebook.count", 1, { scope: descriptor.id });
  await flush(); await env.commit();
  const original = env.sent.find(frame => frame.t === "state");
  const rotated = [{ ...descriptor, generation: "rotated" }];
  env.transport.receive({ t: "scopes", scopes: rotated });
  env.transport.receive({ t: "ack", cid: original.cid, rev: 2 });
  await env.commit();
  assert.equal((await pending).status, "queued");
  assert.equal(env.core.connected, false);
  assert.equal(env.core.pendingWork().state, 1);
  const resumed = await environment({ database: env.database, localStorage: env.localStorage,
    state: { notebook: { count: 1 } }, rev: 2, scopes: rotated });
  assert.equal(resumed.sent.some(frame => frame.t === "state"), false);
  await resumed.commit();
  assert.equal(resumed.core.state.get("notebook.count"), 1);
  assert.equal(resumed.core.pendingWork().state, 0);
});

test("a nested remote delta depending on an unacknowledged parent replacement resyncs without losing either write", async () => {
  const env = await environment({ state: { parent: null } });
  const pending = env.core.state.set("parent", { child: 1 }, { expected_revision: 1 });
  await flush(); await env.commit();
  const original = env.sent.find(frame => frame.t === "state");
  // Authority accepted our parent replacement at revision 2; its ACK is delayed.
  // Another writer's revision 3 is valid there, but not against local parent:null.
  env.transport.receive({ t: "state", rev: 3, ops: [{ op: "set", path: ["parent", "child"], value: 2 }] });
  assert.equal((await pending).status, "queued");
  assert.equal(env.core.connected, false); assert.equal(env.core.pendingWork().state, 1);
  assert.equal(env.core.state.revision, 1); assert.equal(env.core.state.get("parent"), null);
  const resumed = await environment({ database: env.database, localStorage: env.localStorage, state: { parent: { child: 2 } }, rev: 3 });
  assert.deepEqual(resumed.sent.find(frame => frame.t === "state"), original);
  resumed.transport.receive({ t: "ack", cid: original.cid, rev: 2 }); await commitAck(resumed);
  assert.equal(resumed.core.state.get("parent.child"), 2);
  assert.equal(resumed.core.state.revision, 3); assert.equal(resumed.core.pendingWork().state, 0);
});

test("snapshot reads fail explicitly offline, on disconnect and on malformed replies without queuing", async () => {
  const offline = await environment({ online: false });
  await assert.rejects(offline.core.state.snapshot(), { code: "offline" });
  assert.equal(offline.sent.some(frame => frame.t === "state_snapshot"), false);
  const env = await environment();
  const failed = assert.rejects(env.core.state.snapshot(), { code: "invalid_response" });
  const request = env.sent.find(frame => frame.t === "state_snapshot");
  env.transport.receive({ t: "state_snapshot", cid: request.cid, state: {}, rev: "invalid", scopes: [] }); await failed;
  const disconnected = assert.rejects(env.core.state.snapshot(), { code: "offline" });
  env.transport.disconnect(); await disconnected;
  assert.equal(env.database.stores.outbox.size, 0);
});

test("conditional replay keeps the exact durable predicate and never covers a newer snapshot", async () => {
  const first = await environment({ state: { owner: null } });
  void first.core.state.set("owner", "a", { conditions: [{ path: ["owner"], equals: null }] });
  await flush(); await first.commit();
  const original = first.sent.find(frame => frame.t === "state");
  first.transport.disconnect(); await flush();
  const second = await environment({ database: first.database, localStorage: first.localStorage, state: { owner: "b" } });
  const replay = second.sent.find(frame => frame.t === "state");
  assert.deepEqual(replay, original);
  assert.equal(second.core.state.get("owner"), "b");
  const results = [];
  second.core.bus.on("state_result", value => results.push(value));
  second.transport.receive({ t: "ack", cid: replay.cid, error: "state_conflict", message: "Changed", rev: 1,
    conflict: { kind: "condition", condition: 0, path: ["owner"] } });
  second.transport.receive({ t: "state_reset", state: { owner: "b" }, rev: 1, scopes: [] });
  await commitAck(second);
  assert.equal(second.core.state.get("owner"), "b");
  assert.equal(second.core.pendingWork().state, 0);
  assert.equal(results[0].status, "rejected");
  assert.equal(results[0].conflict.condition, 0);
});

test("an empty conditional batch is sent for authoritative evaluation and reports the conflict details", async () => {
  const env = await environment();
  const pending = env.core.state.apply([], { expected_revision: 0 });
  await flush(); await env.commit();
  const frame = env.sent.find(frame => frame.t === "state");
  assert.deepEqual(frame.ops, []);
  env.transport.receive({ t: "ack", cid: frame.cid, error: "state_conflict", rev: 1, conflict: { kind: "revision" } });
  await commitAck(env);
  const result = await pending;
  assert.equal(result.status, "rejected"); assert.equal(result.rev, 1); assert.equal(result.conflict.kind, "revision");
  assert.throws(() => env.core.state.apply([{ op: "set", path: ["bad"], value: NaN }]));
  assert.throws(() => env.core.state.set("bad", 1, { conditions: [{ path: ["bad"], equals: undefined }] }));
});

test("invalid or misspelled state guards never become unconditional writes", async () => {
  const env = await environment({ state: { count: 0 } });
  for (const options of [{ expected_revison: 1 }, { conditions: [], unexpected: true }, { expected_generations: null }, { expected_generations: [] },
    { expected_generations: "v1" }, { expected_generations: new Map() }])
    assert.throws(() => env.core.state.apply([{ op: "set", path: ["count"], value: 1 }], options), { code: "bad_request" });
  await flush(); await env.commit();
  assert.equal(env.core.state.get("count"), 0);
  assert.equal(env.core.pendingWork().state, 0);
  assert.equal(env.sent.some(frame => frame.t === "state"), false);
  assert.equal(env.database.stores.outbox.size, 0);
});

test("an optimistic result exceeding state nesting limits still receives its admitted command outcome", async () => {
  const env = await environment();
  const path = Array.from({ length: 128 }, (_, index) => `level-${index}`);
  // Path and value are individually valid; their combined result exceeds the
  // state depth limit. Suppress that optimism without calling admission failed.
  const pending = env.core.state.set(path, { child: 1 });
  await flush(); await env.commit();
  const frame = env.sent.find(frame => frame.t === "state");
  assert.ok(frame); assert.equal(env.core.state.pending()[0].cid, frame.cid);
  assert.deepEqual(JSON.parse(JSON.stringify(env.core.state.get())), {});
  env.transport.receive({ t: "ack", cid: frame.cid, error: "bad_ops", message: "State nesting exceeds 128 levels" });
  await commitAck(env);
  const result = await pending;
  assert.equal(result.status, "rejected"); assert.equal(result.error, "bad_ops"); assert.equal(result.cid, frame.cid);
  assert.deepEqual(JSON.parse(JSON.stringify(env.core.state.pending())), []);
});

test("a remote parent replacement suppresses incompatible pending optimism without losing the command", async () => {
  const env = await environment({ state: { parent: { child: 1 } } });
  const pending = env.core.state.set("parent.child", 2);
  await flush(); await env.commit();
  const frame = env.sent.find(frame => frame.t === "state");
  assert.equal(env.core.state.get("parent.child"), 2);
  env.transport.receive({ t: "state", rev: 2, ops: [{ op: "set", path: ["parent"], value: [3] }] });
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(env.core.state.get("parent"))), [3]);
  assert.equal(env.core.pendingWork().state, 1);
  env.transport.receive({ t: "ack", cid: frame.cid, error: "state_conflict", rev: 2, conflict: { kind: "path", path: ["parent", "child"] } });
  await commitAck(env);
  assert.equal((await pending).status, "rejected");
});

test("a saved acceptance reconciles once while durable cleanup waits behind later state broadcasts", async () => {
  const env = await environment({ state: { count: 0 } }), results = [];
  env.core.bus.on("state_result", result => results.push(result));
  const pending = env.core.state.set("count", 1, { expected_revision: 1 });
  await flush(); await env.commit();
  const original = env.sent.find(frame => frame.t === "state");
  env.transport.receive({ t: "ack", cid: original.cid, rev: 2 });
  assert.equal(env.core.state.get("count"), 0);
  assert.equal(results.length, 0);
  await env.commit();
  assert.equal(env.core.state.get("count"), 1, "a saved ACK is authoritative, although cleanup is still pending");
  assert.equal(results.length, 0); assert.equal(env.core.state.pending().length, 1);
  env.transport.receive({ t: "state", rev: 3, ops: [{ op: "set", path: ["count"], value: 2 }] });
  env.database.failure = true;
  await env.commit(); await env.expire(8000);
  assert.equal((await pending).status, "queued");
  assert.equal(env.core.state.get("count"), 2); assert.equal(results.length, 0);
  assert.equal([...env.database.stores.outbox.values()][0].msg.outcome.rev, 2);
  // A duplicate or contradictory ACK must not replace the first saved decision.
  env.transport.receive({ t: "ack", cid: original.cid, error: "forbidden" });
  env.database.failure = false;
  await env.expire(5000); await env.commit();
  assert.equal(results.length, 1); assert.equal(results[0].status, "accepted");
  assert.equal(results[0].rev, 2); assert.equal(results[0].cid, original.cid);
  assert.equal(env.core.state.get("count"), 2); assert.equal(env.core.state.revision, 3);
  assert.equal(env.core.connected, true); assert.equal(env.core.state.pending().length, 0);
  assert.equal(env.database.stores.outbox.size, 0);
  assert.equal(env.sent.filter(frame => frame.t === "state").length, 1);
});

const acknowledgedOperations = [
  { name: "state", event: "state_result", error: "forbidden", start: core => core.state.set("notebook.draft", "reviewed", {
    scope: descriptor.id, conditions: [{ path: ["notebook", "draft"], equals: "original" }], expected_revision: 1,
  }) },
  { name: "send", event: "send_result", error: "rate_limited", start: core => core.send({ type: "reviewed.input", record: "item-1" }, { scope: descriptor.id }) },
  { name: "instruction", event: "conversation_result", error: "resource_quota", start: core => core.conversation.send("Keep the exact reviewed instruction") },
];

test("failed ACK persistence keeps state, send and conversation unresolved and retries only local storage", async () => {
  for (const operation of acknowledgedOperations) {
    const env = await environment({ state: { notebook: { draft: "original" } }, scopes: [descriptor] }), results = [];
    env.core.bus.on(operation.event, result => results.push(result));
    const pending = operation.start(env.core);
    await flush(); await env.commit();
    const original = env.sent.find(frame => ["state", "send"].includes(frame.t));
    env.transport.receive({ t: "ack", cid: original.cid, error: operation.error, message: "Current decision" });
    env.database.failure = true;
    await env.commit(); await env.expire(8000);
    assert.equal((await pending).status, "queued", operation.name);
    assert.equal(results.some(result => result.status !== "queued"), false, operation.name);
    assert.equal([...env.database.stores.outbox.values()][0].msg.outcome, undefined);
    env.transport.disconnect(); env.window.dispatchEvent(new Event("online")); await flush();
    assert.equal(env.sent.filter(frame => ["state", "send"].includes(frame.t)).length, 1,
      "a reconnect must not resend a known ACK whose outcome write failed");
    env.database.failure = false;
    await env.commit(); await env.commit();
    const final = results.at(-1);
    assert.equal(final.status, "rejected"); assert.equal(final.error, operation.error); assert.equal(final.cid, original.cid);
    assert.equal(env.database.stores.outbox.size, 0);
    assert.equal(env.core.pendingWork().state + env.core.pendingWork().events, 0);
  }
});

test("persisted state, send and conversation rejections survive failed deletion and reload without another mutation", async () => {
  for (const operation of acknowledgedOperations) {
    const first = await environment({ state: { notebook: { draft: "original" } }, scopes: [descriptor] }), before = [];
    first.core.bus.on(operation.event, result => before.push(result));
    const pending = operation.start(first.core);
    await flush(); await first.commit();
    const original = first.sent.find(frame => ["state", "send"].includes(frame.t));
    const ack = { t: "ack", cid: original.cid, error: operation.error, message: "Original authority rejected this command" };
    first.transport.receive(ack); await first.commit();
    const saved = [...first.database.stores.outbox.values()][0].msg;
    const { outcome, ...savedCommand } = saved;
    assert.deepEqual(outcome, ack); assert.deepEqual(savedCommand, original);
    first.database.failure = true;
    await first.commit(); await first.expire(8000);
    assert.equal((await pending).status, "queued");
    assert.equal(before.some(result => result.status !== "queued"), false);
    first.transport.disconnect(); first.database.failure = false;
    const second = await environment({ database: first.database, localStorage: first.localStorage,
      state: { notebook: { draft: "new authority" } }, rev: 3, scopes: [{ ...descriptor, generation: "rotated" }] });
    const after = [];
    second.core.bus.on(operation.event, result => after.push(result));
    assert.equal(second.sent.some(frame => ["state", "send"].includes(frame.t)), false,
      "only local outcome cleanup may run after reload, even if current authority would now accept");
    assert.equal(second.core.state.get("notebook.draft"), "new authority");
    assert.equal(after.length, 0);
    await second.commit();
    assert.equal(after.length, 1); assert.equal(after[0].status, "rejected");
    assert.equal(after[0].cid, original.cid); assert.equal(after[0].error, operation.error);
    if (operation.name === "state") {
      assert.deepEqual(JSON.parse(JSON.stringify(after[0].ops)), original.ops);
      assert.deepEqual(JSON.parse(JSON.stringify(after[0].conditions)), original.conditions);
      assert.deepEqual(JSON.parse(JSON.stringify(after[0].expected_generations)), original.expected_generations);
    } else if (operation.name === "send") assert.deepEqual(JSON.parse(JSON.stringify(after[0].data)), original.data);
    else {
      assert.equal(after[0].text, original.text);
      assert.equal(second.core.conversation.entries()[0].status, "rejected");
      assert.equal(second.core.conversation.entries()[0].text, original.text);
    }
    assert.equal(second.database.stores.outbox.size, 0);
  }
});

test("an ACK that was never saved stays unresolved across reload and retries the exact original conditional command", async () => {
  const first = await environment({ state: { owner: null } }), before = [];
  first.core.bus.on("state_result", result => before.push(result));
  const pending = first.core.state.set("owner", "claimant", { conditions: [{ path: ["owner"], equals: null }], expected_revision: 1 });
  await flush(); await first.commit();
  const original = first.sent.find(frame => frame.t === "state");
  first.transport.receive({ t: "ack", cid: original.cid, error: "forbidden" });
  first.database.failure = true;
  await first.commit(); await first.expire(8000);
  assert.equal((await pending).status, "queued"); assert.equal(before.length, 0);
  assert.equal([...first.database.stores.outbox.values()][0].msg.outcome, undefined);
  first.transport.disconnect(); first.database.failure = false;
  const second = await environment({ database: first.database, localStorage: first.localStorage, state: { owner: null } });
  assert.deepEqual(second.sent.find(frame => frame.t === "state"), original);
  const after = [];
  second.core.bus.on("state_result", result => after.push(result));
  second.transport.receive({ t: "ack", cid: original.cid, rev: 2 }); await commitAck(second);
  assert.equal(after[0].status, "accepted"); assert.equal(after[0].cid, original.cid);
  assert.equal(second.core.state.get("owner"), "claimant"); assert.equal(second.core.state.pending().length, 0);
});

test("failed durable commit never changes optimistic state or sends the command", async () => {
  const env = await environment({ scopes: [descriptor] });
  env.database.failure = true;
  const pending = env.core.state.set("notebook", { draft: "not saved" });
  const input = env.core.send({ type: "experiment.done", session: "opaque" });
  await flush(); await env.commit();
  const stateResult = await pending;
  assert.equal(stateResult.error, "storage_unavailable");
  assert.equal(stateResult.cid, undefined, "a failed local admission has no durable result identity");
  assert.deepEqual(JSON.parse(JSON.stringify(env.core.state.pending())), []);
  assert.equal((await input).error, "storage_unavailable");
  assert.deepEqual(JSON.parse(JSON.stringify(env.core.state.get())), {});
  assert.equal(env.sent.filter(frame => ["state", "send"].includes(frame.t)).length, 0);
});

test("reload replays unchanged commands and rotated scopes cannot hide current state", async () => {
  const first = await environment({ scopes: [descriptor], state: { notebook: {} } });
  void first.core.state.set("notebook.draft", "old");
  await flush(); await first.commit();
  const original = first.sent.find(frame => frame.t === "state");
  const second = await environment({ database: first.database, localStorage: first.localStorage,
    scopes: [{ ...descriptor, generation: "new" }], state: { notebook: { draft: "current" } }, rev: 2 });
  const replay = second.sent.find(frame => frame.t === "state");
  assert.deepEqual(replay, original);
  assert.equal(second.core.state.get("notebook.draft"), "current");
  assert.equal(second.core.pendingWork().state, 1);
  second.transport.receive({ t: "ack", cid: replay.cid, rev: 2, scopes: [descriptor] });
  await commitAck(second);
  assert.equal(second.core.pendingWork().state, 0);
  assert.equal(second.core.state.get("notebook.draft"), "current");
  assert.equal(second.core.scopes.list()[0].generation, "new", "cached ACK metadata cannot rewind authoritative scopes");
});

async function captureAwaitingAck(env) {
  const promise = env.core.uploadEvent(new Blob(["reviewed evidence"]), { data: { submission_id: "reviewed-evidence", note: "original" }, scope: descriptor.id });
  await flush(); await env.commit();
  await until(() => env.database.pending.length > 0 && env.blobs.calls.some(call => call.path.endsWith("/complete")));
  await env.commit();
  const completion = env.sent.find(frame => frame.t === "capture_complete");
  assert.ok(completion);
  return { promise, completion, id: env.core.captures()[0].capture_id };
}

test("capture outcome save failures remain queued and retry only local storage across reconnect", async () => {
  for (const rejected of [false, true]) {
    const env = await environment({ scopes: [descriptor] }), results = [];
    env.core.bus.on("upload_event", result => results.push(plain(result)));
    const { promise, completion, id } = await captureAwaitingAck(env);
    const requests = env.blobs.calls.length;
    env.transport.receive({ t: "ack", cid: completion.cid, ...(rejected ? { error: "forbidden", message: "Review owner access" } : { seq: 11 }) });
    env.database.failure = true;
    await env.commit(); await env.expire(8000);
    assert.equal((await promise).status, "queued");
    assert.equal(env.core.captures()[0].status, "queued");
    assert.equal([...env.database.stores.outbox.values()][0].msg.outcome, undefined);
    assert.deepEqual(results.map(result => result.status), ["queued"]);
    // retryCapture on an unresolved acceptance must not erase that known result.
    const retry = env.core.retryCapture(id);
    await flush();
    env.transport.disconnect(); env.window.dispatchEvent(new Event("online")); await flush();
    assert.equal(env.sent.filter(frame => frame.t === "capture_complete").length, 1);
    assert.equal(env.blobs.calls.length, requests);
    env.database.failure = false;
    await env.commit();
    if (!rejected) await env.commit();
    const settled = await retry;
    assert.equal(settled.status, rejected ? "rejected" : "accepted"); assert.equal(settled.capture_id, id);
    assert.equal(results.at(-1).status, settled.status);
    if (rejected) {
      const saved = [...env.database.stores.outbox.values()][0].msg;
      assert.equal(saved.outcome.error, "forbidden"); assert.equal(saved.failed.error, "forbidden");
      assert.equal(env.core.captures()[0].status, "rejected");
    } else assert.equal(env.core.captures().length, 0);
  }
});

test("a saved capture acceptance survives failed deletion and offline reload without upload, pin or semantic replay", async () => {
  const first = await environment({ scopes: [descriptor] }), before = [], after = [];
  first.core.bus.on("upload_event", result => before.push(plain(result)));
  const { promise, completion, id } = await captureAwaitingAck(first);
  const requests = first.blobs.calls.length;
  first.transport.receive({ t: "ack", cid: completion.cid, seq: 12 });
  await first.commit();
  const saved = [...first.database.stores.outbox.values()][0].msg;
  assert.equal(saved.outcome.status, "accepted"); assert.equal(saved.outcome.capture_id, id);
  assert.equal(saved.event_cid, completion.cid); assert.equal(before.length, 0);
  first.database.failure = true;
  await first.commit(); await first.expire(8000);
  assert.equal((await promise).status, "queued"); assert.equal(first.core.captures()[0].status, "queued");
  first.transport.disconnect(); first.database.failure = false;
  const second = await environment({ database: first.database, localStorage: first.localStorage, blobs: first.blobs,
    online: false, scopes: [{ ...descriptor, generation: "rotated" }], onCore(core) { core.bus.on("upload_event", result => after.push(plain(result))); } });
  assert.equal(second.sent.some(frame => frame.t === "capture_complete"), false);
  assert.equal(second.blobs.calls.length, requests); assert.equal(after.length, 0);
  await second.commit();
  assert.deepEqual(after, [saved.outcome]); assert.equal(after[0].seq, 12);
  assert.equal(after[0].blob.id, completion.blob); assert.equal(second.core.captures().length, 0);
  assert.equal(second.database.stores.outbox.size, 0);
});

test("saved capture rejection restores visibly and explicit retry durably clears only that rejection", async () => {
  const first = await environment({ scopes: [descriptor] });
  const { promise, completion, id } = await captureAwaitingAck(first);
  first.transport.receive({ t: "ack", cid: completion.cid, error: "forbidden", message: "Owner access required" });
  await first.commit(); assert.equal((await promise).status, "rejected");
  const saved = [...first.database.stores.outbox.values()][0].msg;
  const requests = first.blobs.calls.length;
  first.transport.disconnect();
  const second = await environment({ database: first.database, localStorage: first.localStorage, blobs: first.blobs,
    scopes: [{ ...descriptor, generation: "rotated" }] });
  assert.equal(second.core.captures()[0].status, "rejected");
  assert.equal(second.sent.some(frame => frame.t === "capture_complete"), false);
  assert.equal(second.blobs.calls.length, requests);
  second.database.failure = true;
  const failedRetry = assert.rejects(second.core.retryCapture(id), /fixture disk failed/);
  await flush(); await second.commit(); await failedRetry;
  assert.equal(second.core.captures()[0].status, "rejected");
  assert.equal(second.sent.some(frame => frame.t === "capture_complete"), false);
  second.database.failure = false;
  const retry = second.core.retryCapture(id);
  await flush();
  assert.equal([...second.database.stores.outbox.values()][0].msg.outcome.status, "rejected");
  await second.commit();
  const fresh = [...second.database.stores.outbox.values()][0].msg;
  assert.equal(fresh.failed, undefined); assert.equal(fresh.outcome, undefined);
  assert.deepEqual(fresh.expected_generations, saved.expected_generations);
  assert.equal(fresh.event_cid, completion.cid); assert.equal(second.core.captures()[0].status, "queued");
  const retried = second.sent.find(frame => frame.t === "capture_complete");
  assert.deepEqual(retried, completion); assert.equal(second.blobs.calls.length, requests);
  second.transport.receive({ t: "ack", cid: retried.cid, seq: 13 });
  await second.commit(); await second.commit();
  assert.equal((await retry).status, "accepted"); assert.equal(second.core.captures().length, 0);
});

test("an unsaved capture rejection remains unresolved through reload and replays the original semantic command", async () => {
  const first = await environment({ scopes: [descriptor] }), before = [], after = [];
  first.core.bus.on("upload_event", result => before.push(plain(result)));
  const { promise, completion, id } = await captureAwaitingAck(first);
  first.transport.receive({ t: "ack", cid: completion.cid, error: "forbidden", message: "Current owner access required" });
  first.database.failure = true;
  await first.commit(); await first.expire(8000);
  assert.equal((await promise).status, "queued"); assert.deepEqual(before.map(result => result.status), ["queued"]);
  assert.equal([...first.database.stores.outbox.values()][0].msg.outcome, undefined);
  first.transport.disconnect(); first.database.failure = false;
  const second = await environment({ database: first.database, localStorage: first.localStorage, blobs: first.blobs, scopes: [descriptor],
    onCore(core) { core.bus.on("upload_event", result => after.push(plain(result))); } });
  const replay = second.sent.find(frame => frame.t === "capture_complete");
  assert.deepEqual(replay, completion);
  second.transport.receive({ t: "ack", cid: replay.cid, seq: 14 });
  await second.commit(); await second.commit();
  assert.equal(after[0].status, "accepted"); assert.equal(after[0].capture_id, id);
  assert.equal(second.core.captures().length, 0);
});

test("a pin rejection whose capture outcome cannot be saved never resumes pinning or semantic delivery", async () => {
  const blobs = blobService(); blobs.rejectPin = true;
  const env = await environment({ blobs, scopes: [{ ...descriptor, operations: ["capture", "blob.pin"] }] }), results = [];
  env.core.bus.on("upload_event", result => results.push(plain(result)));
  const promise = env.core.uploadEvent(new Blob(["reviewed bytes"]), { data: { submission_id: "pin-failure" }, keep: true, scope: descriptor.id });
  await flush(); await env.commit();
  await until(() => env.database.pending.length > 0 && blobs.calls.some(call => call.path.endsWith("/complete")));
  await env.commit();
  await until(() => env.database.pending.length > 0 && blobs.calls.some(call => call.path.endsWith("/pin")));
  env.database.failure = true;
  await env.commit(); await env.expire(8000);
  assert.equal((await promise).status, "queued"); assert.equal(env.core.captures()[0].status, "queued");
  blobs.rejectPin = false;
  await env.expire(5000); env.database.failure = false; await env.commit();
  assert.equal(results.at(-1).status, "rejected"); assert.equal(results.at(-1).error, "stale_generation");
  assert.equal(blobs.calls.filter(call => call.path.endsWith("/pin")).length, 1);
  assert.equal(env.sent.some(frame => frame.t === "capture_complete"), false);
  assert.equal(env.core.captures()[0].status, "rejected");
});

test("discard during accepted capture settlement shares durable cleanup and emits only the accepted receipt", async () => {
  for (const afterOutcomeSave of [false, true]) {
    const env = await environment({ scopes: [descriptor] }), results = [];
    env.core.bus.on("upload_event", result => results.push(plain(result)));
    const { promise, completion, id } = await captureAwaitingAck(env);
    env.transport.receive({ t: "ack", cid: completion.cid, seq: 15 });
    if (afterOutcomeSave) await env.commit();
    let discarded = false;
    const discarding = env.core.discardCapture(id).then(() => { discarded = true; });
    await flush();
    assert.equal(discarded, false); assert.equal(results.length, 0);
    await env.commit();
    if (!afterOutcomeSave) {
      assert.equal(discarded, false); assert.equal(results.length, 0);
      await env.commit();
    }
    await discarding;
    assert.equal((await promise).status, "accepted");
    await env.expire(5000); await env.commit();
    assert.deepEqual(results.map(result => result.status), ["accepted"]);
    assert.equal(results[0].seq, 15);
    assert.equal(env.database.stores.outbox.size, 0); assert.equal(env.core.captures().length, 0);
    const second = await environment({ database: env.database, localStorage: env.localStorage, blobs: env.blobs });
    assert.equal(second.sent.some(frame => frame.t === "capture_complete"), false);
  }
});

test("discard before a capture decision cannot be resurrected by a late acknowledgement", async () => {
  const env = await environment({ scopes: [descriptor] }), results = [];
  env.core.bus.on("upload_event", result => results.push(plain(result)));
  const { promise, completion, id } = await captureAwaitingAck(env);
  const first = env.core.discardCapture(id), second = env.core.discardCapture(id);
  await flush();
  env.transport.receive({ t: "ack", cid: completion.cid, seq: 16 });
  await env.commit(); await Promise.all([first, second]);
  assert.equal((await promise).error, "discarded");
  await env.expire(5000); await env.commit();
  assert.deepEqual(results.map(result => result.error), ["discarded"]);
  assert.equal(env.database.stores.outbox.size, 0); assert.equal(env.core.captures().length, 0);
});

test("a rejection saved during a failed discard settles locally even after disconnect", async () => {
  const env = await environment({ scopes: [descriptor] }), results = [];
  env.core.bus.on("upload_event", result => results.push(plain(result)));
  const { promise, completion, id } = await captureAwaitingAck(env);
  env.transport.receive({ t: "ack", cid: completion.cid, error: "forbidden", message: "Original rejection" });
  const discarded = assert.rejects(env.core.discardCapture(id), /fixture disk failed/);
  await flush();
  // The outcome write commits while the later deletion is still in progress.
  env.database.pending.shift()(); await flush();
  assert.equal([...env.database.stores.outbox.values()][0].msg.failed.error, "forbidden");
  assert.equal(results.length, 0);
  env.transport.disconnect(); env.database.failure = true;
  await env.commit(); await discarded; await flush();
  assert.deepEqual(results.map(result => result.status), ["rejected"]);
  assert.equal((await promise).error, "forbidden");
  assert.equal(env.core.captures()[0].status, "rejected");
  assert.equal(env.sent.filter(frame => frame.t === "capture_complete").length, 1);
  env.database.failure = false;
  const removed = env.core.discardCapture(id);
  await flush(); await env.commit(); await removed;
  assert.equal(results.at(-1).error, "discarded");
  assert.equal(env.database.stores.outbox.size, 0);
});

test("capture queue and receipt observers cannot mutate another observer or the original caller result", async () => {
  const env = await environment({ scopes: [descriptor] }), queues = [], results = [];
  env.core.bus.on("capture_queue", queue => {
    if (queue[0]) { queue[0].data.note = "changed by observer"; queue[0].capture_id = "wrong"; }
    queue.length = 0;
  });
  env.core.bus.on("capture_queue", queue => queues.push(plain(queue)));
  env.core.bus.on("upload_event", result => {
    result.status = "rejected"; result.capture_id = "wrong";
    if (result.blob) result.blob.id = "changed by observer";
  });
  env.core.bus.on("upload_event", result => results.push(plain(result)));
  const { promise, completion, id } = await captureAwaitingAck(env);
  assert.equal(queues[0][0].capture_id, id); assert.equal(queues[0][0].data.note, "original");
  assert.equal([...env.database.stores.outbox.values()][0].msg.data.note, "original");
  env.transport.receive({ t: "ack", cid: completion.cid, seq: 17 });
  await env.commit(); await env.commit();
  const result = await promise;
  assert.equal(result.status, "accepted"); assert.equal(result.capture_id, id); assert.equal(result.blob.id, completion.blob);
  assert.deepEqual(results, [plain(result)]);
  assert.deepEqual(queues.at(-1), []);
});

test("capture completion uses original scope and generation after upload and reload", async () => {
  const first = await environment({ scopes: [{ ...descriptor, operations: ["capture"] }] });
  void first.core.uploadEvent(new Blob(["capture bytes"]), { data: { type: "notebook.observation", session: "uninterpreted" }, scope: descriptor.id });
  await flush();
  assert.equal(first.sent.some(frame => frame.t === "capture_complete"), false);
  await first.commit(); // original blob + semantic input become durable
  await until(() => first.database.pending.length > 0 && first.blobs.calls.some(call => call.path.endsWith("/complete")));
  await first.commit(); // blob upload receipt becomes durable before completion
  const original = first.sent.find(frame => frame.t === "capture_complete");
  assert.ok(original, JSON.stringify({ calls: first.blobs.calls, pending: first.database.pending.length, captures: first.core.captures() }));
  assert.equal(original.expected_generations[descriptor.id], "original");
  assert.equal(original.blob, "b_aaaaaaaaaaaaaaaaaaaa");
  const second = await environment({ database: first.database, localStorage: first.localStorage, scopes: [{ ...descriptor, generation: "new", operations: ["capture"] }] });
  const replay = second.sent.find(frame => frame.t === "capture_complete");
  assert.deepEqual(replay, original);
  second.transport.receive({ t: "ack", cid: replay.cid, error: "stale_generation", message: "The scope changed." });
  await flush(); await second.commit();
  const capture = second.core.captures()[0];
  assert.equal(capture.status, "rejected");
  assert.equal(capture.expected_generations[descriptor.id], "original");
  capture.blob.id = "b_" + "b".repeat(20);
  capture.blob.url = "https://view-only.invalid/annotation";
  capture.blob.retention.reasons.push("view annotation");
  assert.equal(second.core.captures()[0].blob.id, original.blob, "Public metadata is an independent snapshot");
  assert.equal(second.core.captures()[0].blob.retention.reasons.includes("view annotation"), false);
  const retry = second.core.retryCapture(capture.capture_id);
  await flush(); await second.commit();
  const retried = second.sent.filter(frame => frame.t === "capture_complete").at(-1);
  assert.deepEqual(retried, original, "retry cannot replace the original identity or captured generation");
  second.transport.receive({ t: "ack", cid: retried.cid, error: "stale_generation", message: "The scope changed." });
  await flush(); await second.commit();
  assert.equal((await retry).status, "rejected");
});

test("a lost upload completion resumes the original session after reload without new bytes or identities", async () => {
  const blobs = blobService(); blobs.dropComplete = 1;
  const originalScope = { ...descriptor, operations: ["capture"] };
  const first = await environment({ scopes: [originalScope], blobs });
  void first.core.uploadEvent(new Blob(["reviewed bytes"]), { data: { submission_id: "review-1", answer: "original" }, scope: descriptor.id });
  await flush(); await first.commit();
  await until(() => blobs.calls.some(call => call.path.endsWith("/complete")));
  const original = [...first.database.stores.outbox.values()].find(item => item.msg.t === "upload_event");
  assert.equal(original.msg.uploaded, undefined);
  first.transport.disconnect();
  const second = await environment({ database: first.database, localStorage: first.localStorage, blobs,
    scopes: [{ ...originalScope, generation: "new" }] });
  await until(() => second.database.pending.length > 0 && blobs.calls.filter(call => call.path.endsWith("/complete")).length === 2);
  await second.commit();
  const starts = blobs.calls.filter(call => call.path === "/uploads");
  assert.equal(starts.length, 2);
  assert.deepEqual(starts[0].body, starts[1].body);
  assert.equal(starts[0].body.cid, original.cid);
  assert.equal(blobs.calls.filter(call => call.path.endsWith("/content")).length, 1);
  const event = second.sent.find(frame => frame.t === "capture_complete");
  assert.equal(event.cid, original.msg.event_cid);
  assert.equal(event.data.capture_id, original.cid);
  assert.equal(event.data.submission_id, "review-1");
  assert.equal(event.data.answer, "original");
  assert.equal(event.expected_generations[descriptor.id], "original");
});

test("pinning persists its original guarded command and replays a lost pin receipt before semantic delivery", async () => {
  const blobs = blobService(); blobs.dropPin = 1;
  const originalScope = { ...descriptor, operations: ["capture", "blob.pin"] };
  const first = await environment({ scopes: [originalScope], blobs });
  void first.core.uploadEvent(new Blob(["evidence"]), { data: { submission_id: "review-2" }, keep: true, scope: descriptor.id });
  await flush(); await first.commit();
  await until(() => first.database.pending.length > 0 && blobs.calls.some(call => call.path.endsWith("/complete")));
  const original = [...first.database.stores.outbox.values()].find(item => item.msg.t === "upload_event");
  assert.equal(original.msg.pin.expected_generations[descriptor.id], "original");
  assert.notEqual(original.msg.pin.cid, original.cid);
  await first.commit();
  await until(() => blobs.calls.some(call => call.path.endsWith("/pin")));
  assert.equal(first.sent.some(frame => frame.t === "capture_complete"), false);
  const uploaded = [...first.database.stores.outbox.values()].find(item => item.cid === original.cid);
  assert.ok(uploaded.msg.uploaded);
  assert.equal(uploaded.msg.pinned, undefined);
  first.transport.disconnect();
  blobs.rejectPin = true; // Rotation cannot invalidate an already committed pin receipt.
  const second = await environment({ database: first.database, localStorage: first.localStorage, blobs,
    scopes: [{ ...originalScope, generation: "new" }] });
  await until(() => second.database.pending.length > 0 && blobs.calls.filter(call => call.path.endsWith("/pin")).length === 2);
  assert.equal(second.sent.some(frame => frame.t === "capture_complete"), false, "Pin receipt must be durable before event delivery");
  await second.commit();
  const pinCalls = blobs.calls.filter(call => call.path.endsWith("/pin"));
  assert.deepEqual(pinCalls[0].body, original.msg.pin);
  assert.deepEqual(pinCalls[1].body, original.msg.pin);
  assert.equal(blobs.calls.filter(call => call.path === "/uploads").length, 1);
  const event = second.sent.find(frame => frame.t === "capture_complete");
  assert.equal(event.cid, original.msg.event_cid);
  assert.equal(event.expected_generations[descriptor.id], "original");
  assert.deepEqual([...second.core.captures()[0].blob.retention.reasons], ["pinned"]);
});

test("an interrupted completion body stays queued and resumes after reload instead of claiming rejection", async () => {
  const blobs = blobService(); blobs.dropCompleteBody = 1;
  const first = await environment({ blobs });
  void first.core.uploadEvent(new Blob(["reviewed bytes"]), { data: { submission_id: "partial-response" } });
  await flush(); await first.commit();
  await until(() => blobs.calls.some(call => call.path.endsWith("/complete")));
  await flush(); await first.commit();
  const capture = first.core.captures()[0];
  assert.equal(capture.status, "queued");
  assert.equal(capture.error, undefined);
  first.transport.disconnect();
  const second = await environment({ database: first.database, localStorage: first.localStorage, blobs });
  await until(() => second.database.pending.length > 0 && blobs.calls.filter(call => call.path.endsWith("/complete")).length === 2);
  await second.commit();
  const event = second.sent.find(frame => frame.t === "capture_complete");
  assert.equal(event.data.capture_id, capture.capture_id);
  assert.equal(event.data.submission_id, "partial-response");
  const starts = blobs.calls.filter(call => call.path === "/uploads");
  assert.deepEqual(starts[0].body, starts[1].body);
  assert.equal(blobs.calls.filter(call => call.path.endsWith("/content")).length, 1);
});

test("a stale pin rejects the retained capture and retry keeps the original pin guards", async () => {
  const blobs = blobService(); blobs.rejectPin = true;
  const env = await environment({ blobs, scopes: [{ ...descriptor, operations: ["capture", "blob.pin"] }] });
  const input = { data: { submission_id: "review-3", answer: "reviewed" }, keep: true, scope: descriptor.id };
  const outcome = env.core.uploadEvent(new Blob(["reviewed"]), input);
  input.data.answer = "new draft";
  await flush(); await env.commit();
  await until(() => env.database.pending.length > 0 && blobs.calls.some(call => call.path.endsWith("/complete")));
  await env.commit(); await env.commit();
  assert.equal((await outcome).error, "stale_generation");
  const capture = env.core.captures()[0];
  assert.equal(capture.data.answer, "reviewed");
  assert.equal(capture.status, "rejected");
  env.transport.receive({ t: "scopes", scopes: [{ ...descriptor, generation: "new", operations: ["capture", "blob.pin"] }] });
  const retried = env.core.retryCapture(capture.capture_id);
  await flush(); await env.commit(); await env.commit();
  assert.equal((await retried).error, "stale_generation");
  const pins = blobs.calls.filter(call => call.path.endsWith("/pin"));
  assert.equal(pins.length, 2);
  assert.deepEqual(pins[0].body, pins[1].body);
  assert.equal(pins[1].body.expected_generations[descriptor.id], "original");
  assert.equal(env.sent.some(frame => frame.t === "capture_complete"), false);
});

test("standalone uploads also commit before I/O and reuse one CID after a lost completion", async () => {
  const blobs = blobService(); blobs.dropComplete = 1;
  const first = await environment({ blobs });
  void first.core.upload(new Blob(["standalone"]), { name: "proof.txt" });
  await flush();
  assert.equal(blobs.calls.length, 0);
  await first.commit();
  await until(() => blobs.calls.some(call => call.path.endsWith("/complete")));
  const original = [...first.database.stores.outbox.values()].find(item => item.msg.t === "upload");
  first.transport.disconnect();
  const second = await environment({ database: first.database, localStorage: first.localStorage, blobs });
  const delivered = [];
  second.core.bus.on("upload", result => delivered.push(result));
  await until(() => second.database.pending.length > 0 && blobs.calls.filter(call => call.path.endsWith("/complete")).length === 2);
  await second.commit(); // upload receipt
  assert.equal(delivered.length, 0);
  await second.commit(); // queue removal before reporting success
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].cid, original.cid);
  assert.equal(second.core.pendingWork().captures, 0);
  assert.deepEqual(blobs.calls.filter(call => call.path === "/uploads").map(call => call.body.cid), [original.cid, original.cid]);
  assert.equal(blobs.calls.filter(call => call.path.endsWith("/content")).length, 1);
});

test("an upload reply during a pending discard cannot recreate the capture or start pinning", async () => {
  const blobs = blobService(); let release;
  blobs.beforeComplete = () => new Promise(resolve => { release = resolve; });
  const first = await environment({ blobs });
  const result = first.core.uploadEvent(new Blob(["discarded bytes"]), { data: { submission_id: "discarded-review" }, keep: true });
  await flush(); await first.commit();
  await until(() => release !== undefined);
  const id = first.core.captures()[0].capture_id;
  const discarded = first.core.discardCapture(id);
  await flush(); // Delete is queued, but its transaction has not committed.
  release(); await flush(); // HTTP completion arrives inside that interval.
  await first.commit(); await discarded; await first.commit();
  assert.equal((await result).error, "discarded");
  assert.equal(first.database.stores.outbox.size, 0);
  assert.equal(blobs.calls.some(call => call.path.endsWith("/pin")), false);
  assert.equal(first.sent.some(frame => frame.t === "capture_complete"), false);
  first.transport.disconnect();
  const second = await environment({ database: first.database, localStorage: first.localStorage, blobs });
  assert.equal(second.core.captures().length, 0);
  assert.equal(second.sent.some(frame => frame.t === "capture_complete"), false);
});

test("capture IDs belong to the runtime and reviewed inputs retain separate application correlation", async () => {
  const env = await environment(), queued = [], results = [];
  env.core.bus.on("capture_queue", values => queued.push(...values));
  env.core.bus.on("upload_event", result => results.push(result));
  for (const options of [
    { cid: "page-chosen-command", data: { submission_id: "review-1" } },
    { data: {}, unrecognized: true },
    { data: [], name: "invalid.txt" },
    { data: {}, keep: "yes" },
  ]) await assert.rejects(env.core.uploadEvent(new Blob(["evidence"]), options), error => error.code === "bad_request");
  assert.equal(env.database.pending.length, 0); assert.equal(env.core.captures().length, 0); assert.equal(queued.length, 0);

  const saving = env.core.uploadEvent(new Blob(["evidence"]), { data: { submission_id: "review-1", text: "reviewed input" } });
  await flush(); await env.commit();
  await until(() => env.database.pending.length > 0 && env.blobs.calls.some(call => call.path.endsWith("/complete")));
  await env.commit();
  const capture = env.core.captures()[0]; assert.notEqual(capture.capture_id, "review-1");
  assert.equal(capture.data.submission_id, "review-1"); assert.equal(queued[0].capture_id, capture.capture_id);
  const completion = env.sent.find(frame => frame.t === "capture_complete");
  assert.equal(completion.data.submission_id, "review-1"); assert.equal(completion.data.capture_id, capture.capture_id);
  env.transport.receive({ t: "ack", cid: completion.cid, seq: 7 }); await flush(); await env.commit(); await env.commit();
  const result = await saving; assert.equal(result.status, "accepted"); assert.equal(result.capture_id, capture.capture_id);
  assert.equal(results[0].capture_id, capture.capture_id); assert.equal(results[0].data, undefined);
});

test("identical conversation inputs keep distinct IDs and exact echo reconciliation", async () => {
  const env = await environment();
  const first = env.core.conversation.send("same text"), second = env.core.conversation.send("same text");
  await flush(); await env.commit();
  const sent = env.sent.filter(message => message.kind === "instruction");
  assert.equal(sent.length, 2); assert.notEqual(sent[0].cid, sent[1].cid);
  sent.forEach((message, index) => {
    env.transport.receive({ t: "ack", cid: message.cid, seq: index + 1 });
    env.transport.receive({ t: "instruction_echo", cid: message.cid, device: env.core.device.id,
      message_id: `message-${index}`, text: message.text, ts: index + 1 });
  });
  await commitAck(env);
  assert.equal((await first).status, "accepted"); assert.equal((await second).status, "accepted");
  const entries = env.core.conversation.entries();
  assert.equal(entries.length, 2); assert.equal(entries[0].message_id, "message-0");
  assert.equal(entries[1].message_id, "message-1");
  assert.equal(entries.every(entry => entry.status === "accepted"), true);
});

test("transcript observers see acknowledgements and stable echo identity through independent snapshots", async () => {
  const env = await environment(), changes = [];
  env.core.bus.on("transcript", entry => {
    if (!entry) return;
    changes.push({ status: entry.status, message_id: entry.message_id });
    entry.text = "presentation-local edit";
  });
  const pending = env.core.conversation.send("original input"); await flush(); await env.commit();
  const sent = env.sent.find(message => message.kind === "instruction");
  env.transport.receive({ t: "ack", cid: sent.cid, seq: 1 }); await commitAck(env); await pending;
  env.transport.receive({ t: "instruction_echo", cid: sent.cid, device: env.core.device.id, message_id: "persistent-message", text: sent.text, ts: 1 });
  assert.deepEqual(changes, [
    { status: "queued", message_id: undefined }, { status: "accepted", message_id: undefined },
    { status: "accepted", message_id: "persistent-message" },
  ]);
  assert.equal(env.core.conversation.entries()[0].text, "original input");
});

test("replies require service-issued identity and timestamps before transcript or adapter delivery", async () => {
  const env = await environment(), errors = [], displayed = [], replies = [];
  env.core.bus.on("error", error => errors.push(error));
  env.core.bus.on("say", message => { displayed.push(message.message_id); message.text = "presentation-local edit"; });
  env.core.bus.on("reply", message => replies.push(message));
  for (const message of [
    { text: "missing identity", ts: 10 },
    { text: "missing timestamp", message_id: "reply-1" },
    { text: "empty identity", message_id: "", ts: 10 },
    { text: "invalid timestamp", message_id: "reply-1", ts: -1 },
    { text: 42, message_id: "reply-1", ts: 10 },
  ]) env.transport.receive({ t: "say", ...message });
  assert.equal(errors.length, 5); assert.ok(errors.every(error => error.code === "invalid_response"));
  assert.equal(env.core.conversation.entries().length, 0); assert.equal(replies.length, 0); assert.equal(displayed.length, 0);
  for (const message_id of ["reply-1", "reply-2"]) env.transport.receive({ t: "say", message_id, ts: 0, text: "same reply" });
  env.transport.receive({ t: "say", message_id: "reply-1", ts: 0, text: "same reply" });
  env.transport.receive({ t: "say", message_id: "audio-only", ts: 1, text: "explicit audio", present: false });
  assert.deepEqual(JSON.parse(JSON.stringify(env.core.conversation.entries())).map(entry => ({ id: entry.message_id, ts: entry.ts, text: entry.text })), [
    { id: "reply-1", ts: 0, text: "same reply" }, { id: "reply-2", ts: 0, text: "same reply" },
  ]);
  assert.equal(replies.length, 4); assert.equal(replies[0].text, "same reply"); assert.equal(replies[3].present, false);
  assert.deepEqual(displayed, ["reply-1", "reply-2", "reply-1"]);
});

test("delayed rejection retains recoverable text and its identity across reload", async () => {
  const env = await environment(), results = [];
  env.core.bus.on("conversation_result", result => results.push(result));
  const promise = env.core.conversation.send("keep this text");
  await flush(); await env.commit(); await env.settle();
  const queued = await promise; assert.equal(queued.status, "queued");
  env.transport.receive({ t: "ack", cid: queued.cid, error: "stale_generation", message: "Compose against current work" });
  await commitAck(env); await env.settle(); await env.commit();
  assert.deepEqual(results.map(result => result.status), ["queued", "rejected"]);
  const reloaded = await environment({ database: env.database, localStorage: env.localStorage });
  assert.equal(reloaded.sent.filter(message => message.kind === "instruction").length, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(reloaded.core.conversation.entries())).map(entry => ({ cid: entry.cid, status: entry.status, text: entry.text })),
    [{ cid: queued.cid, status: "rejected", text: "keep this text" }]);
});

test("unsaved conversation input is rejected without claiming a queued transcript", async () => {
  const env = await environment(); env.database.failure = true;
  const promise = env.core.conversation.send("not durably saved");
  await flush(); await env.commit();
  const result = await promise;
  assert.equal(result.status, "rejected"); assert.equal(result.error, "storage_unavailable");
  assert.equal(typeof result.cid, "string"); assert.equal(env.core.conversation.entries().length, 0);
  assert.equal(env.sent.some(message => message.kind === "instruction"), false);
});
