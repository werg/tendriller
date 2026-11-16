import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { webcrypto, createHash } from "node:crypto";
import { build } from "esbuild";
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
async function environment({ database = new Database(), localStorage = storage(), scopes = [], state = {}, rev = 1, online = true, blobs = blobService(), configuration = {} } = {}) {
  const timers = new Map(); let next = 0;
  const clock = { setTimeout(fn, ms) { const id = ++next; timers.set(id, { fn, ms }); return id; }, clearTimeout(id) { timers.delete(id); }, setInterval() { return ++next; }, clearInterval() {} };
  const window = new EventTarget(), document = Object.assign(new EventTarget(), { visibilityState: "hidden", readyState: "complete", currentScript: { src: "https://fixture.test/runtime/tendril.js" } });
  const navigations = [];
  const globals = { window, document, localStorage, sessionStorage: storage(), indexedDB: database.indexedDB,
    crypto: webcrypto, Blob, URL, Headers, Response, Uint8Array, ArrayBuffer, TextEncoder, URLSearchParams, structuredClone, Event, CustomEvent: class extends Event { constructor(type, options) { super(type, options); this.detail = options?.detail; } },
    location: { href: "https://fixture.test/page/?review=1#draft", origin: "https://fixture.test", host: "fixture.test", pathname: "/page/", protocol: "https:", search: "?review=1", hash: "#draft", assign(url) { navigations.push(url); }, reload() {} },
    navigator: { onLine: online, userAgent: "Fixture", language: "en", userActivation: { isActive: false } }, screen: { width: 800, height: 600 },
    console: { log() {}, info() {}, warn() {}, error() {} }, queueMicrotask, ...clock,
    fetch: blobs.fetch,
  };
  runInNewContext(built.outputFiles[0].text, globals);
  const transport = globals.Runtime.createFixtureTransport(), sent = [];
  window.__TENDRIL_TRANSPORT__ = transport.socket;
  transport.onSend((frame, reply) => {
    sent.push(structuredClone(frame));
    if (frame.t === "hello" && online) reply({ t: "welcome", state, scopes, rev, role: "owner", pending: false, transcript: [] });
  });
  const core = globals.Runtime.createCore({ id: "page", base: "/page/", version: 1, documentPath: null, ws: "wss://fixture.test/page/_tendril/ws", preview: true, features: {push:false,vapid:null,shared_by:"Fixture",speech:null}, ...configuration });
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
const descriptor = { id: "opaque-scope", generation: "original", paths: [["notebook"]], operations: [] };

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
    scopes: [{ ...descriptor, generation: "new" }], state: { notebook: { draft: "current" } } });
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
  env.transport.receive({ t: "ack", cid: completion.cid, seq: 7 }); await flush(); await env.commit();
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
