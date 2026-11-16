import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { webcrypto } from "node:crypto";
import { build } from "esbuild";
const built = await build({ stdin: { contents: 'export { createCore } from "./core"; export { createFixtureTransport } from "./preview";', resolveDir: new URL("../src/", import.meta.url).pathname, loader: "ts" }, bundle: true, format: "iife", globalName: "Runtime", platform: "browser", write: false });
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

// The fake controls transaction completion (not the runtime's queuing policy).
// This lets tests observe the interval between a put request and durable commit.
class Database {
  stores = { outbox: new Map(), kv: new Map() };
  pending = [];
  failure = false;
  indexedDB = {
    open: () => {
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
async function environment({ database = new Database(), localStorage = storage(), scopes = [], state = {}, online = true } = {}) {
  const timers = new Map(); let next = 0;
  const clock = { setTimeout(fn) { const id = ++next; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); }, setInterval() { return ++next; }, clearInterval() {} };
  const window = new EventTarget(), document = Object.assign(new EventTarget(), { visibilityState: "hidden", readyState: "complete", currentScript: { src: "https://fixture.test/runtime/tendril.js" } });
  let stagedUpload;
  const globals = { window, document, localStorage, sessionStorage: storage(), indexedDB: database.indexedDB,
    crypto: webcrypto, Blob, URL, Headers, Response, Uint8Array, structuredClone, Event, CustomEvent: class extends Event { constructor(type, options) { super(type, options); this.detail = options?.detail; } },
    location: { href: "https://fixture.test/page/", origin: "https://fixture.test", host: "fixture.test", pathname: "/page/", protocol: "https:", reload() {} },
    navigator: { onLine: online, userAgent: "Fixture", language: "en", userActivation: { isActive: false } }, screen: { width: 800, height: 600 },
    console: { log() {}, info() {}, warn() {}, error() {} }, queueMicrotask, ...clock,
    fetch: async (url, { method = "GET", body } = {}) => {
      const path = new URL(url, "https://fixture.test").pathname;
      const uploadId = "u_aaaaaaaaaaaaaaaaaaaa", blobId = "b_aaaaaaaaaaaaaaaaaaaa";
      if (path === "/page/_tendril/uploads" && method === "POST") {
        const input = JSON.parse(body);
        stagedUpload = input;
        assert.match(input.sha256, /^[a-f0-9]{64}$/);
        assert.ok(Number.isSafeInteger(input.size));
        return json({ id: uploadId, blob_id: blobId, sha256: input.sha256, size: input.size,
          phase: "ready", upload_required: true, expires_at: Date.now() + 60_000 });
      }
      if (path === `/page/_tendril/uploads/${uploadId}/content` && method === "PUT") {
        assert.ok(stagedUpload, "upload session must be started before PUT");
        assert.equal(body.byteLength, stagedUpload.size);
        const digest = await webcrypto.subtle.digest("SHA-256", body);
        assert.equal([...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, "0")).join(""), stagedUpload.sha256);
        return json({ status: "received" });
      }
      if (path === `/page/_tendril/uploads/${uploadId}/complete` && method === "POST")
        return json({ status: "completed", blob: { id: blobId, url: `_tendril/blob/${blobId}`,
          sha256: stagedUpload.sha256, size: stagedUpload.size, type: stagedUpload.type } });
      throw new Error(`Unexpected upload test route: ${method} ${path}`);
    },
  };
  runInNewContext(built.outputFiles[0].text, globals);
  const transport = globals.Runtime.createFixtureTransport(), sent = [];
  window.__TENDRIL_TRANSPORT__ = transport.socket;
  transport.onSend((frame, reply) => {
    sent.push(structuredClone(frame));
    if (frame.t === "hello" && online) reply({ t: "welcome", state, scopes, rev: 1, role: "owner", pending: false, transcript: [], rules: [] });
  });
  const core = globals.Runtime.createCore({ id: "page", base: "/page/", version: 1, ws: "wss://fixture.test/page/_tendril/ws", preview: true, features: {push:false,vapid:null,shared_by:"Fixture",speech:null} });
  await flush();
  return { core, database, localStorage, transport, sent, window,
    async commit() { database.commit(); await flush(); },
    async settle() { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } await flush(); },
  };
}
function json(value) { return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } }); }
const descriptor = { id: "opaque-scope", generation: "original", paths: [["notebook"]], operations: [] };

test("familiar application keys cannot configure core preferences or device namespaces", async () => {
  const data = { _prefs: { audio: false, language: "de-DE", mode: "display" }, _device: { anything: { zoom: 3 } }, notebook: { session_id: "opaque" } };
  const env = await environment({ state: data });
  assert.deepEqual(JSON.parse(JSON.stringify(env.core.state.get())), data);
  assert.equal(env.core.state.mine, undefined);
  assert.equal(env.core.preferences.get().audio, true);
  assert.equal(env.core.preferences.get().mode, "interactive");
  env.core.preferences.update({ audio: false, textSize: "large" });
  assert.deepEqual(JSON.parse(JSON.stringify(env.core.state.get())), data);
  assert.equal(env.sent.some(frame => frame.t === "state"), false);
  assert.equal(env.core.pendingWork().state, 0);
  const reload = await environment({ localStorage: env.localStorage, state: data });
  assert.equal(reload.core.preferences.get().audio, false);
  assert.equal(reload.core.preferences.get().textSize, "large");
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
  assert.equal((await pending).status, "accepted");
  assert.equal((await input).status, "accepted");
  assert.equal(messages.find(frame => frame.t === "send").data.session, "application-owned");
});

test("failed durable commit never changes optimistic state or sends the command", async () => {
  const env = await environment({ scopes: [descriptor] });
  env.database.failure = true;
  const pending = env.core.state.set("notebook", { draft: "not saved" });
  const input = env.core.send({ type: "experiment.done", session: "opaque" });
  await flush(); await env.commit();
  assert.equal((await pending).error, "storage_unavailable");
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
  await flush();
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
  await first.commit(); // blob upload receipt becomes durable before completion
  const original = first.sent.find(frame => frame.t === "capture_complete");
  assert.ok(original);
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
  const retry = second.core.retryCapture(capture.capture_id);
  await flush(); await second.commit();
  const retried = second.sent.filter(frame => frame.t === "capture_complete").at(-1);
  assert.deepEqual(retried, original, "retry cannot replace the original identity or captured generation");
  second.transport.receive({ t: "ack", cid: retried.cid, error: "stale_generation", message: "The scope changed." });
  await flush(); await second.commit();
  assert.equal((await retry).status, "rejected");
});
