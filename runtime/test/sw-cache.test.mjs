import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { createHash, webcrypto } from "node:crypto";
import { build } from "esbuild";

// Run the actual compiled service worker against browser-like Cache and Client
// APIs. Each test controls publication, clients, connectivity and worker restart.
const built = await build({ entryPoints: [new URL("../src/sw.ts", import.meta.url).pathname], bundle: true, format: "iife", platform: "browser", write: false });
const scope = "https://page.example/t/page/s/key/";
const absolute = path => new URL(path, scope).href;
const sha = value => createHash("sha256").update(value).digest("hex");
const cacheName = id => `tendril-v2-publication:${encodeURIComponent(scope)}:${id}`;
const json = value => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
function release(id, runtimeId = id, lazyResources = {}) {
  const hash = sha(`runtime-${runtimeId}`), base = absolute(`_publications/${id}/`), runtimeBase = absolute(`_tendril/runtime/${hash}/`);
  const sources = { "index.html": `source-${id}`, "app.js": `app-${id}`, "lazy.js": `lazy-${id}`, "styles.css": `style-${id}` };
  const assets = Object.entries(sources).map(([path, body]) => ({ path, sha256: sha(body), type: path.endsWith("html") ? "text/html" : path.endsWith("css") ? "text/css" : "text/javascript" }));
  const publication = { id, base, entry: "index.html", runtime: { id: hash, version: "0.2.0-rc.1", base: runtimeBase }, assets };
  const html = `<!doctype html><script>window.__TENDRIL__=${JSON.stringify({ publication })};</script><h1>${id}</h1>`;
  const resources = new Map(Object.entries(sources).map(([path, body]) => [new URL(path, base).href, () => new Response(path === "index.html" ? html : body, { headers: { "X-Tendril-Publication": id } })]));
  const onDemand = Object.entries(lazyResources).map(([name, body]) => ({ url: `_tendril/assets/${sha(body)}/${name}`, sha256: sha(body), type: "application/octet-stream" }));
  for (const [name, body] of Object.entries(lazyResources)) resources.set(absolute(`_tendril/assets/${sha(body)}/${name}`), () => new Response(body));
  resources.set(runtimeBase + "manifest.json", () => json({ id: hash, version: "0.2.0-rc.1", assets: [{ path: "tendril.js", sha256: sha(`runtime-${runtimeId}`), type: "text/javascript" }], resources: onDemand }));
  resources.set(runtimeBase + "tendril.js", () => new Response(`runtime-${runtimeId}`));
  return { publication, resources, html, onDemand };
}

function network(first) {
  let current = first, online = true;
  const resources = new Map(first.resources), calls = [];
  return {
    calls, resources,
    set current(value) { current = value; for (const pair of value.resources) resources.set(...pair); },
    set online(value) { online = value; },
    async fetch(request) {
      const url = typeof request === "string" ? request : request.url;
      calls.push(url);
      if (!online) throw new TypeError("offline");
      if (url === scope + "_tendril/info") return json({ id: "page", publication: current.publication });
      if (url === scope) return new Response(current.html);
      return resources.get(url)?.() || json({ live: calls.length });
    },
  };
}
async function worker(net, stores = new Map(), clients = new Map(), { beforePut } = {}) {
  const listeners = new Map(), sent = [], background = [];
  const key = request => typeof request === "string" ? request : request.url;
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const entries = stores.get(name);
      return {
        async match(request) { return entries.get(key(request))?.clone(); },
        async put(request, response) { await beforePut?.(name, key(request), response.clone()); entries.set(key(request), response.clone()); },
        async delete(request) { return entries.delete(key(request)); },
        async keys() { return [...entries.keys()].map(url => new Request(url)); },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
  };
  runInNewContext(built.outputFiles[0].text, { URL, Response, Request, Headers, crypto: webcrypto, caches, fetch: net.fetch, setTimeout, clearTimeout,
    self: { registration: { scope }, skipWaiting() {}, addEventListener(type, fn) { listeners.set(type, fn); },
      clients: { async claim() {}, async matchAll() { return [...clients].map(([id, url]) => ({ id, url, postMessage(data) { sent.push({ id, data }); } })); } } },
  });
  async function dispatch(type, properties = {}) {
    const pending = []; let response;
    listeners.get(type)({ ...properties, waitUntil(promise) { pending.push(promise); background.push(promise); }, respondWith(promise) { response = promise; } });
    const result = response === undefined && type === "fetch" ? await net.fetch(properties.request) : await response;
    await Promise.all(pending);
    return result;
  }
  return { stores, clients, sent, caches,
    install: () => dispatch("install"), activate: () => dispatch("activate"),
    async announce(clientId, publication, replies) {
      clients.set(clientId, scope);
      await dispatch("message", { data: { t: "publication", publication }, source: { id: clientId, url: scope },
        ports: replies ? [{ postMessage(value) { replies.push(structuredClone(value)); } }] : [] });
    },
    request: (path, clientId = "a", navigation = false) => dispatch("fetch", { request: { url: absolute(path), method: "GET", headers: new Headers(), mode: navigation ? "navigate" : "cors" }, clientId: navigation ? "" : clientId, replacesClientId: navigation ? clientId : "", resultingClientId: navigation ? clientId : "" }),
  };
}

test("publication readiness waits for the complete graph and final metadata commits", { timeout: 5000 }, async () => {
  const a = release("1"), net = network(a), replies = [];
  const reached = [Promise.withResolvers(), Promise.withResolvers()];
  const proceed = [Promise.withResolvers(), Promise.withResolvers()];
  let completeWrites = 0;
  const sw = await worker(net, new Map(), new Map(), { async beforePut(name, url, response) {
    if (name !== "tendril-v2-metadata" || !(await response.json()).complete.includes(a.publication.id)) return;
    const stage = completeWrites++;
    reached[stage].resolve();
    await proceed[stage].promise;
  } });
  const pending = sw.announce("a", a.publication, replies);
  await reached[0].promise;
  assert.ok(await (await sw.caches.open(cacheName("1"))).match(a.publication.base + "index.html"));
  assert.deepEqual(replies, [], "visible asset bytes do not acknowledge an uncommitted graph");
  proceed[0].resolve();
  await reached[1].promise;
  assert.deepEqual(replies, [], "cleanup metadata must also be committed before acknowledgement");
  proceed[1].resolve();
  await pending;
  assert.deepEqual(replies, [{ t: "publication", id: "1", status: "ready" }]);
  net.online = false;
  const restarted = await worker(net, sw.stores, sw.clients);
  assert.match(await (await restarted.request(a.publication.base + "index.html", "a", true)).text(), /<h1>1<\/h1>/);
});

test("publication readiness reports graph validation and saving failures", async () => {
  const a = release("1"), net = network(a), sw = await worker(net), replies = [];
  await sw.announce("a", { ...a.publication, entry: "../outside.html" }, replies);
  assert.deepEqual(replies, [{ t: "publication", id: "1", status: "error", error: {
    code: "invalid_publication", message: "A client and valid publication manifest are required.",
  } }]);
  assert.equal(net.calls.length, 0);
  replies.length = 0;
  net.resources.set(a.publication.base + "app.js", () => new Response("changed bytes"));
  await sw.announce("a", a.publication, replies);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].id, "1");
  assert.equal(replies[0].status, "error");
  assert.equal(replies[0].error.code, "publication_save_failed");
  assert.match(replies[0].error.message, /integrity mismatch/);
  net.online = false;
  assert.equal((await sw.request(a.publication.base + "index.html", "a", true)).status, 503);
});

test("open A and newly published B keep complete independent asset graphs offline", async () => {
  const a = release("1"), b = release("2"), net = network(a), sw = await worker(net);
  await sw.install(); await sw.announce("a", a.publication);
  net.current = b;
  await sw.install(); await sw.announce("b", b.publication);
  assert.equal(sw.stores.has(cacheName("1")), true, "active A must survive publication B");
  net.online = false;
  for (const [client, item] of [["a", a], ["b", b]]) {
    for (const [file, value] of [["app.js", "app-"], ["lazy.js", "lazy-"], ["styles.css", "style-"]])
      assert.equal(await (await sw.request(item.publication.base + file, client)).text(), value + item.publication.id);
    assert.equal(await (await sw.request(item.publication.runtime.base + "tendril.js", client)).text(), `runtime-${item.publication.id}`);
    assert.match(await (await sw.request("", client, true)).text(), new RegExp(`<h1>${item.publication.id}</h1>`));
  }
});

test("active publication identity survives a worker restart and offline activation", async () => {
  const a = release("1"), b = release("2"), net = network(a), first = await worker(net);
  await first.install(); await first.announce("a", a.publication);
  net.current = b; await first.install(); await first.announce("b", b.publication);
  net.online = false;
  const restarted = await worker(net, first.stores, first.clients);
  await restarted.activate();
  assert.match(await (await restarted.request("", "a", true)).text(), /<h1>1<\/h1>/);
  assert.match(await (await restarted.request("", "b", true)).text(), /<h1>2<\/h1>/);
});

test("reloading pinned A online cannot rewind the latest publication for a new offline tab", async () => {
  const a = release("1"), b = release("2"), net = network(a), sw = await worker(net);
  await sw.install(); await sw.announce("a", a.publication);
  net.current = b; await sw.install(); await sw.announce("b", b.publication);
  assert.match(await (await sw.request(a.publication.base + "index.html", "a", true)).text(), /<h1>1<\/h1>/);
  net.online = false;
  assert.match(await (await sw.request("", "fresh", true)).text(), /<h1>2<\/h1>/);
  assert.match(await (await sw.request(a.publication.base + "index.html", "a", true)).text(), /<h1>1<\/h1>/);
});

test("cleanup removes a publication only after all its clients leave", async () => {
  const a = release("1"), b = release("2"), net = network(a), sw = await worker(net);
  await sw.install(); await sw.announce("a", a.publication);
  net.current = b; await sw.install(); await sw.announce("b", b.publication);
  sw.clients.delete("a"); await sw.install();
  assert.equal(sw.stores.has(cacheName("1")), false);
  assert.equal(sw.stores.has(cacheName("2")), true);
});

test("unannounced active clients prevent cleanup until their publication is known", async () => {
  const a = release("1"), b = release("2"), net = network(a), sw = await worker(net);
  await sw.install(); sw.clients.set("unknown", scope);
  net.current = b; await sw.install();
  assert.equal(sw.stores.has(cacheName("1")), true);
  assert.deepEqual(sw.sent.map(item => item.id), ["unknown"]);
  await sw.announce("unknown", b.publication);
  assert.equal(sw.stores.has(cacheName("1")), false);
});

test("live API responses and undeclared resources never gain offline cache access", async () => {
  const a = release("1"), net = network(a), sw = await worker(net);
  await sw.install(); await sw.announce("a", a.publication);
  const paths = ["_tendril/devices", "_tendril/workflows/sessions/responses", "%5Ftendril/session", "_tendril/future-api", "api/private", "app.js", a.publication.base + "not-declared.js", a.publication.base + "app.js?mutable=1"];
  for (const path of paths) {
    const first = await (await sw.request(path)).json();
    const second = await (await sw.request(path)).json();
    assert.notEqual(first.live, second.live);
  }
  net.online = false;
  for (const path of paths) await assert.rejects(sw.request(path), /offline/);
});

test("no-store and mismatched bytes never become saved publication assets", async () => {
  for (const response of [() => new Response("app-1", { headers: { "Cache-Control": "private, no-store" } }), () => new Response("unexpected source")]) {
    const a = release("1"), net = network(a), sw = await worker(net);
    net.resources.set(a.publication.base + "app.js", response);
    await sw.install();
    assert.equal(await (await sw.caches.open(cacheName("1"))).match(a.publication.base + "app.js"), undefined);
    net.online = false;
    await assert.rejects(sw.request(a.publication.base + "app.js"), /offline/);
    assert.equal((await sw.request("", "new", true)).status, 503, "incomplete graph cannot become the offline navigation target");
  }
});

test("declared lazy runtime resources retain A/B identity and cache only after use", async () => {
  const a = release("1", "1", { "model.bin": "model A", "engine.js": "shared engine" });
  const b = release("2", "2", { "model.bin": "model B", "engine.js": "shared engine" });
  const net = network(a), sw = await worker(net);
  await sw.install(); await sw.announce("a", a.publication);
  net.current = b; await sw.install(); await sw.announce("b", b.publication);
  assert.equal(net.calls.some(url => url.includes("/_tendril/assets/")), false, "install does not download optional models");
  for (const [client, item, value] of [["a", a, "model A"], ["b", b, "model B"]]) {
    assert.equal(await (await sw.request(item.onDemand[0].url, client)).text(), value);
  }
  await sw.request(a.onDemand[1].url, "a");
  sw.clients.delete("a"); await sw.install();
  assert.equal(sw.stores.has(cacheName("1")), false);
  net.online = false;
  const restarted = await worker(net, sw.stores, sw.clients);
  assert.equal(await (await restarted.request(b.onDemand[0].url, "b")).text(), "model B");
  assert.equal(await (await restarted.request(b.onDemand[1].url, "b")).text(), "shared engine", "shared resource belongs to each declaring publication");
  await assert.rejects(restarted.request(a.onDemand[0].url, "b"), /offline/);
});

test("lazy resources reject changed bytes, respect no-store, and leave undeclared routes uncached", async () => {
  const a = release("1", "1", { "model.bin": "model A" }), net = network(a), sw = await worker(net);
  await sw.install(); await sw.announce("a", a.publication);
  const url = absolute(a.onDemand[0].url);
  net.resources.set(url, () => new Response("different model"));
  await assert.rejects(sw.request(url), /integrity mismatch/);
  assert.equal(await (await sw.caches.open(cacheName("1"))).match(url), undefined);
  net.resources.set(url, () => new Response("model A", { headers: { "Cache-Control": "no-store" } }));
  assert.equal(await (await sw.request(url)).text(), "model A");
  assert.equal(await (await sw.caches.open(cacheName("1"))).match(url), undefined);
  const undeclared = `_tendril/assets/${sha("unrelated")}/private.bin`;
  assert.notEqual(await (await sw.request(undeclared)).text(), await (await sw.request(undeclared)).text());
  net.online = false;
  await assert.rejects(sw.request(url), /offline/);
  await assert.rejects(sw.request(undeclared), /offline/);
});
