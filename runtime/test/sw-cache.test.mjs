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
const cacheName = id => `tendril-publication:${encodeURIComponent(scope)}:${id}`;
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
  resources.set(runtimeBase + "manifest.json", () => json({ id: hash, version: "0.2.0-rc.1", assets: [{ path: "tendril.js", preload: true, sha256: sha(`runtime-${runtimeId}`), type: "text/javascript" }], resources: onDemand }));
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
async function worker(net, stores = new Map(), clients = new Map(), { beforePut, timers = { setTimeout, clearTimeout } } = {}) {
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
  runInNewContext(built.outputFiles[0].text, { URL, Response, Request, Headers, crypto: webcrypto, caches, fetch: net.fetch, ...timers,
    self: { registration: { scope }, skipWaiting() {}, addEventListener(type, fn) { listeners.set(type, fn); },
      clients: { async claim() {}, async matchAll() { return [...clients].map(([id, url]) => ({ id, url, postMessage(data) { sent.push({ id, data }); } })); },
        async get(id) { return { id, url: clients.get(id) ?? scope, postMessage(data) { sent.push({ id, data }); } }; } } },
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
    async announce(clientId, publication, replies, documentPath = publication.entry) {
      const url = new URL(documentPath.split('/').map(encodeURIComponent).join('/'), publication.base).href;
      clients.set(clientId, url);
      await dispatch("message", { data: { t: "publication", publication }, source: { id: clientId, url },
        ports: replies ? [{ postMessage(value) { replies.push(structuredClone(value)); } }] : [] });
    },
    request: (path, clientId = "a", navigation = false, extra = {}) => dispatch("fetch", { request: { url: absolute(path), method: "GET", headers: new Headers(), mode: navigation ? "navigate" : "cors", ...extra }, clientId: navigation ? "" : clientId, replacesClientId: navigation ? clientId : "", resultingClientId: navigation ? clientId : "" }),
    refresh: clientId => dispatch("message", { data: { t: "publication_refresh" }, source: { id: clientId, url: scope }, ports: [] }),
  };
}

test("publication readiness waits for the complete graph and final metadata commits", { timeout: 5000 }, async () => {
  const a = release("1"), net = network(a), replies = [];
  const reached = [Promise.withResolvers(), Promise.withResolvers()];
  const proceed = [Promise.withResolvers(), Promise.withResolvers()];
  let completeWrites = 0;
  const sw = await worker(net, new Map(), new Map(), { async beforePut(name, url, response) {
    if (name !== "tendril-metadata" || !(await response.json()).complete.includes(a.publication.id)) return;
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
    // The page URL opens the latest saved release; the release URL its own.
    assert.match(await (await sw.request("", client, true)).text(), /<h1>2<\/h1>/);
    assert.match(await (await sw.request(item.publication.base, client, true)).text(), new RegExp(`<h1>${item.publication.id}</h1>`));
  }
});

test("two tabs on one publication keep both runtime URLs after a registry update", async () => {
  const old = release('1'), net = network(old), sw = await worker(net);
  await sw.install(); await sw.announce('old', old.publication);
  const manifest = structuredClone(old.publication);
  manifest.runtime.base = absolute(`/_tendril/runtime/${manifest.runtime.id}/`);
  const resources = new Map([...old.resources].map(([url, response]) => [url.replace(old.publication.runtime.base, manifest.runtime.base), response]));
  net.current = { ...old, publication: manifest, resources };
  await sw.announce('new', manifest);
  net.online = false;
  const restarted = await worker(net, sw.stores, sw.clients);
  for (const [tab, base] of [['old', old.publication.runtime.base], ['new', manifest.runtime.base]])
    assert.equal(await (await restarted.request(base + 'tendril.js', tab)).text(), 'runtime-1');
});

test("root runtime URLs remain in each offline publication graph alongside legacy scoped runtimes", async () => {
  const legacy = release('1'), root = release('2', '2', { 'model.bin': 'optional model' });
  const oldBase = root.publication.runtime.base;
  root.publication.runtime.base = new URL(`/_tendril/runtime/${root.publication.runtime.id}/`, scope).href;
  for (const [url, response] of [...root.resources]) {
    if (!url.startsWith(oldBase)) continue;
    root.resources.delete(url);
    root.resources.set(root.publication.runtime.base + url.slice(oldBase.length), response);
  }
  const net = network(legacy), sw = await worker(net), replies = [];
  await sw.install(); await sw.announce('legacy', legacy.publication);
  net.current = root;
  await sw.install(); await sw.announce('root', root.publication, replies);
  assert.deepEqual(replies, [{ t: 'publication', id: '2', status: 'ready' }]);
  const resource = root.onDemand[0].url;
  assert.ok(absolute(resource).startsWith(scope), 'optional resources retain their authenticated page scope');
  assert.equal(await (await sw.request(resource, 'root')).text(), 'optional model');
  net.online = false;
  const restarted = await worker(net, sw.stores, sw.clients);
  assert.equal(await (await restarted.request(legacy.publication.runtime.base + 'tendril.js', 'legacy')).text(), 'runtime-1');
  assert.equal(await (await restarted.request(root.publication.runtime.base + 'tendril.js', 'root')).text(), 'runtime-2');
  assert.equal(await (await restarted.request(resource, 'root')).text(), 'optional model');
});

test("active publication identity survives a worker restart and offline activation", async () => {
  const a = release("1"), b = release("2"), net = network(a), first = await worker(net);
  await first.install(); await first.announce("a", a.publication);
  net.current = b; await first.install(); await first.announce("b", b.publication);
  net.online = false;
  const restarted = await worker(net, first.stores, first.clients);
  await restarted.activate();
  assert.match(await (await restarted.request("", "a", true)).text(), /<h1>2<\/h1>/, "the page URL opens the latest release");
  assert.match(await (await restarted.request(a.publication.base, "a", true)).text(), /<h1>1<\/h1>/);
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

test("a saved release opens immediately and its navigation refreshes resident introductions for the next launch", async () => {
  const a = release("1"), documentPath = "index.html", url = a.publication.base + documentPath;
  const page = endpoint => `<!doctype html><script>window.__TENDRIL__=${JSON.stringify({
    publication: a.publication, documentPath, application: { id: "peer-history" },
    peerBootstrap: { version: 2, endpoints: [{ url: endpoint }] },
  })};</script><h1>Peer application</h1>`;
  let html = page("https://original.example/introduce");
  const headers = { "X-Tendril-Publication": "1", "Cache-Control": "private, no-cache", "Content-Type": "text/html" };
  a.resources.set(url, () => new Response(html, { headers }));
  const net = network(a), sw = await worker(net);
  await sw.install(); await sw.announce("a", a.publication);
  const cache = await sw.caches.open(cacheName("1"));
  assert.equal(await (await cache.match(url)).text(), html);
  const previous = html;
  html = page("https://replacement.example/introduce");
  const before = net.calls.length;
  assert.equal(await (await sw.request(url, "a", true)).text(), previous, "stale-while-revalidate: the saved document opens first");
  assert.deepEqual(net.calls.slice(before), [url], "refresh reuses navigation without discovery or asset fetches");
  assert.equal(await (await cache.match(url)).text(), html, "the background response refreshes the next launch");
  assert.equal(await (await sw.request(url, "a", true)).text(), html);

  net.online = false;
  const restarted = await worker(net, sw.stores, sw.clients);
  assert.equal(await (await restarted.request("", "a", true)).text(), html);
  assert.equal(await (await restarted.request(url, "a", true)).text(), html);
  assert.equal(await (await restarted.request(a.publication.base + "app.js", "a")).text(), "app-1");
});

test("a revalidation that shows changed access drops the saved document and asks the page to reload", async () => {
  const a = release("1"), net = network(a), sw = await worker(net), url = a.publication.base + "index.html";
  await sw.install(); await sw.announce("a", a.publication);
  const cache = await sw.caches.open(cacheName("1"));
  for (const status of [302, 401]) {
    await sw.announce("a", a.publication);
    assert.ok(await cache.match(url));
    net.resources.set(url, () => new Response(null, { status, headers: status === 302 ? { Location: "https://accounts.example/sign-in" } : {} }));
    assert.match(await (await sw.request(url, "a", true)).text(), /<h1>1<\/h1>/, "the saved document still opens immediately");
    assert.equal(await cache.match(url), undefined, "the saved document is dropped");
    assert.equal(JSON.stringify(sw.sent.at(-1)), JSON.stringify({ id: "a", data: { t: "navigation_stale" } }));
    assert.equal((await sw.request(url, "a", true)).status, status, "the next navigation reaches the host");
    net.resources.set(url, a.resources.get(url));
  }
});

test("saving reads immutable files through the HTTP cache and re-reads a mismatching cached copy once", async () => {
  const a = release("1"), net = network(a), fetch = net.fetch, modes = [];
  net.fetch = async (request, init) => {
    const url = typeof request === "string" ? request : request.url;
    if (url === a.publication.base + "app.js") {
      modes.push(init?.cache);
      if (init?.cache === "default") return new Response("stale http cache bytes");
    }
    return fetch(request, init);
  };
  const sw = await worker(net), replies = [];
  await sw.announce("a", a.publication, replies);
  assert.equal(replies.at(-1).status, "ready");
  assert.deepEqual(modes, ["default", "reload"]);
  assert.equal(await (await (await sw.caches.open(cacheName("1"))).match(a.publication.base + "app.js")).text(), "app-1");
});

test("navigation refresh requires a matching publication and declared document and respects no-store", async () => {
  const a = release("1"), net = network(a), sw = await worker(net), url = a.publication.base + "index.html";
  await sw.install(); await sw.announce("a", a.publication);
  const cache = await sw.caches.open(cacheName("1")), saved = await (await cache.match(url)).text();
  for (const [documentPath, publicationId, cacheControl] of [
    ["index.html", "2", "private, no-cache"],
    ["app.js", "1", "private, no-cache"],
    ["missing.html", "1", "private, no-cache"],
    ["index.html", "1", "private, no-store"],
  ]) {
    const html = `<script>window.__TENDRIL__=${JSON.stringify({ publication: a.publication, documentPath })};</script>Unsaved`;
    net.resources.set(url, () => new Response(html, { headers: { "X-Tendril-Publication": publicationId, "Cache-Control": cacheControl } }));
    assert.equal(await (await sw.request(url, "a", true)).text(), saved, "the saved document opens; the response only revalidates");
    assert.equal(await (await cache.match(url)).text(), saved);
    assert.equal(await (await cache.match(a.publication.base + "app.js")).text(), "app-1");
    assert.equal(await cache.match(a.publication.base + "missing.html"), undefined);
  }
});

test("a late network publication cannot rebind or evict a tab already given its offline publication", { timeout: 5000 }, async () => {
  const a = release("1"), b = release("2"), net = network(a), fetch = net.fetch;
  const requested = Promise.withResolvers(), arrived = Promise.withResolvers(), boundOffline = Promise.withResolvers();
  let delayed = false;
  net.fetch = async request => {
    const response = await fetch(request);
    if (delayed && (typeof request === "string" ? request : request.url) === scope) {
      requested.resolve(); await arrived.promise;
    }
    return response;
  };
  const sw = await worker(net, new Map(), new Map(), {
    async beforePut(name, url, response) {
      if (delayed && name === "tendril-metadata" && (await response.json()).clients.a === "1") boundOffline.resolve();
    },
  });
  await sw.install(); await sw.announce("a", a.publication);
  net.current = b; delayed = true;
  const navigation = sw.request("", "a", true);
  await requested.promise;
  await boundOffline.promise;
  arrived.resolve();
  assert.match(await (await navigation).text(), /<h1>1<\/h1>/);

  // The background response can save B for a future launch, while A remains
  // retained for the document that this navigation actually delivered.
  delayed = false;
  await sw.install();
  assert.equal(sw.stores.has(cacheName("1")), true);
  assert.equal(sw.stores.has(cacheName("2")), true);
  net.online = false;
  const restarted = await worker(net, sw.stores, sw.clients);
  assert.match(await (await restarted.request("", "a", true)).text(), /<h1>2<\/h1>/, "a reload of the page URL opens the latest release");
  assert.match(await (await restarted.request(a.publication.base, "a", true)).text(), /<h1>1<\/h1>/);
  assert.match(await (await restarted.request("", "fresh", true)).text(), /<h1>2<\/h1>/);
  assert.equal(await (await restarted.request(a.publication.base + "lazy.js", "a")).text(), "lazy-1");
});

test("cleanup removes a publication only after all its clients leave", async () => {
  const a = release("1"), b = release("2"), net = network(a), sw = await worker(net);
  await sw.install(); await sw.announce("a", a.publication);
  net.current = b; await sw.install(); await sw.announce("b", b.publication);
  sw.clients.delete("a"); await sw.install();
  assert.equal(sw.stores.has(cacheName("1")), false);
  assert.equal(sw.stores.has(cacheName("2")), true);
});

test("cleanup deletes orphaned publication caches after an interrupted metadata write", async () => {
  const a = release("1"), net = network(a), sw = await worker(net);
  await sw.install(); await sw.announce("a", a.publication);
  await sw.caches.open(cacheName("orphan"));
  assert.equal(sw.stores.has(cacheName("orphan")), true);
  await sw.install();
  assert.equal(sw.stores.has(cacheName("orphan")), false);
  assert.equal(sw.stores.has(cacheName("1")), true, "active publication remains retained");
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
  const paths = ["_tendril/info", "_tendril/peers/participant", "%5Ftendril/session", "_tendril/future-api", "api/private", "app.js", a.publication.base + "not-declared.js", a.publication.base + "app.js?mutable=1"];
  for (const path of paths) {
    const before = net.calls.length;
    await sw.request(path);
    await sw.request(path);
    assert.equal(net.calls.length, before + 2, `${path} must reach the network on every read`);
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

test("optional runtime modules are verified and cached only after deliberate use", async () => {
  const a = release("1"), net = network(a);
  const url = a.publication.runtime.base + "voice.mjs", manifestURL = a.publication.runtime.base + "manifest.json";
  const manifest = await a.resources.get(manifestURL)().json();
  manifest.assets.push({ path: "voice.mjs", sha256: sha("explicit voice module"), type: "text/javascript", preload: false });
  net.resources.set(manifestURL, () => json(manifest)); net.resources.set(url, () => new Response("tampered module"));
  const sw = await worker(net); await sw.install(); await sw.announce("a", a.publication);
  assert.equal(net.calls.includes(url), false, "plain page readiness does not fetch voice");
  await assert.rejects(sw.request(url, "a"), /integrity mismatch/);
  net.resources.set(url, () => new Response("explicit voice module"));
  assert.equal(await (await sw.request(url, "a")).text(), "explicit voice module");
  net.online = false;
  assert.equal(await (await sw.request(url, "a")).text(), "explicit voice module");
});

test("nested logical filenames are encoded exactly and offline navigation never substitutes another page", async () => {
  const a = release("1"), path = "notes & charts/reading ? # 100%.html";
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  a.publication.assets.push({ path, sha256: sha("nested authored page"), type: "text/html" });
  a.resources.set(a.publication.base + encoded, () => new Response("nested authored page", { headers: { "X-Tendril-Publication": "1" } }));
  const net = network(a), sw = await worker(net); await sw.install(); await sw.announce("a", a.publication);
  assert.ok(net.calls.includes(a.publication.base + encoded)); net.online = false;
  assert.equal(await (await sw.request(encoded, "a", true)).text(), "nested authored page");
  assert.equal((await sw.request("missing.html", "a", true)).status, 503);
});

test("offline root navigation uses the declared HTML entry even when index.html also exists", async () => {
  for (const entry of ["app.html", "pages/home.html"]) {
    const a = release("1");
    a.publication.entry = entry;
    const entryHtml = `<!doctype html><script>window.__TENDRIL__=${JSON.stringify({ publication: a.publication })};</script><h1>declared: ${entry}</h1>`;
    a.publication.assets.push({ path: entry, sha256: sha(entryHtml), type: "text/html" });
    a.resources.set(new URL(entry, a.publication.base).href, () => new Response(entryHtml, { headers: { "X-Tendril-Publication": "1" } }));
    a.html = entryHtml;
    const net = network(a), initial = await worker(net);
    await initial.install(); await initial.announce("a", a.publication);
    net.online = false;
    // A worker restart, a PWA launch at the root, and an explicit publication
    // root all use the same authored entry, not a coincidental index.html.
    const resumed = await worker(net, initial.stores, initial.clients);
    assert.equal(await (await resumed.request("", "a", true)).text(), entryHtml);
    assert.equal(await (await resumed.request(a.publication.base, "a", true)).text(), entryHtml);
    assert.equal((await (await resumed.request("index.html", "a", true)).text()).includes("<h1>1</h1>"), true);
    assert.equal((await resumed.request("pages/", "a", true)).status, 503,
      "explicit nested directory navigation must not borrow the publication entry");
  }
});

test("nested document announcements keep the canonical root across offline worker restart", async () => {
  const a = release("1"), entry = "app.html", documentPath = "notes #1?/café 100%/help.html";
  const entryHtml = "<h1>Canonical root</h1>", documentHtml = "<h1>Nested help</h1>";
  a.publication.entry = entry;
  const encode = path => path.split('/').map(encodeURIComponent).join('/');
  for (const [path, body] of [[entry, entryHtml], [documentPath, documentHtml]]) {
    a.publication.assets.push({ path, sha256: sha(body), type: "text/html" });
    a.resources.set(new URL(encode(path), a.publication.base).href,
      () => new Response(body, { headers: { "X-Tendril-Publication": "1" } }));
  }
  a.html = entryHtml;
  const net = network(a), initial = await worker(net);
  await initial.install();
  await initial.announce("root", a.publication);
  await initial.announce("nested", a.publication, undefined, documentPath);
  net.online = false;
  const restarted = await worker(net, initial.stores, initial.clients);
  assert.equal(await (await restarted.request("", "root", true)).text(), entryHtml);
  assert.equal(await (await restarted.request(a.publication.base, "nested", true)).text(), entryHtml);
  assert.equal(await (await restarted.request(encode(documentPath), "nested", true)).text(), documentHtml);
  assert.equal(await (await restarted.request(a.publication.base + encode(documentPath), "nested", true)).text(), documentHtml);
  assert.equal((await restarted.request(encode(documentPath.slice(0, documentPath.lastIndexOf('/') + 1)), "nested", true)).status, 503);
});

test("pinned and ordinary directory navigation resolves only declared index files with equivalent URL encoding", async () => {
  const a = release("1"), b = release("2"), directory = "notes & charts/question ? # 100%/";
  const encode = path => path.split("/").map(encodeURIComponent).join("/");
  for (const item of [a, b]) for (const path of ["docs/index.html", directory + "index.html"]) {
    const body = `${item.publication.id}: ${path}`;
    item.publication.assets.push({ path, sha256: sha(body), type: "text/html" });
    item.resources.set(item.publication.base + encode(path), () => new Response(body, { headers: { "X-Tendril-Publication": item.publication.id } }));
  }
  const net = network(a), sw = await worker(net); await sw.install(); await sw.announce("a", a.publication);
  net.current = b; await sw.install(); await sw.announce("b", b.publication); net.online = false;
  for (const [client, item] of [["a", a], ["b", b]]) {
    for (const base of ["", item.publication.base]) {
      // Ordinary page URLs open the latest saved release; release URLs their own.
      const id = base ? item.publication.id : b.publication.id;
      assert.equal(await (await sw.request(base + "docs/", client, true)).text(), `${id}: docs/index.html`);
      for (const path of [encode(directory), encode(directory + "index.html").replace(/%[0-9A-F]{2}/g, part => part.toLowerCase())])
        assert.equal(await (await sw.request(base + path, client, true)).text(), `${id}: ${directory}index.html`);
      for (const path of ["missing/", "docs", "docs/missing.html", "bad%escape/"])
        assert.equal((await sw.request(base + path, client, true)).status, 503, `No implicit page fallback for ${path}`);
    }
  }
  // An explicit publication pin takes precedence over the current client binding.
  assert.equal(await (await sw.request(a.publication.base + "docs/", "b", true)).text(), "1: docs/index.html");
});

test("a delayed older navigation cannot rewind latest, while a later intentional rollback can", { timeout: 5000 }, async () => {
  const a = release("1"), b = release("2"), net = network(a), originalFetch = net.fetch;
  const requested = Promise.withResolvers(), resume = Promise.withResolvers();
  let holdFirst = true;
  net.fetch = async request => {
    const response = await originalFetch(request);
    if ((typeof request === 'string' ? request : request.url) === scope && holdFirst) {
      holdFirst = false; requested.resolve(); await resume.promise;
    }
    return response;
  };
  const sw = await worker(net);
  await sw.install(); await sw.announce('a', a.publication);
  const old = sw.request('', 'old', true); await requested.promise;
  net.current = b;
  // Stale-while-revalidate: the saved latest (1) opens; its revalidation selects 2.
  assert.match(await (await sw.request('', 'new', true)).text(), /<h1>1<\/h1>/);
  assert.match(await (await sw.request('', 'next', true)).text(), /<h1>2<\/h1>/);
  resume.resolve(); assert.match(await (await old).text(), /<h1>1<\/h1>/);
  net.online = false;
  assert.match(await (await sw.request('', 'fresh', true)).text(), /<h1>2<\/h1>/, 'late old response does not become latest');
  // A pin has no selection request and cannot promote even when issued last.
  net.online = true;
  await sw.request(a.publication.base + 'index.html', 'pinned', true);
  net.online = false;
  assert.match(await (await sw.request('', 'fresh', true)).text(), /<h1>2<\/h1>/);
  net.online = true; net.current = a;
  await sw.request('', 'rollback', true);
  net.online = false;
  const restarted = await worker(net, sw.stores, sw.clients);
  assert.match(await (await restarted.request('', 'fresh', true)).text(), /<h1>1<\/h1>/, 'intentional rollback persists across worker restart');
});

test("a newer discovery selection fences an older delayed navigation save", { timeout: 5000 }, async () => {
  const a = release('1'), b = release('2'), net = network(a), originalFetch = net.fetch;
  const requested = Promise.withResolvers(), resume = Promise.withResolvers();
  let delayed = false;
  net.fetch = async request => {
    const response = await originalFetch(request);
    if (delayed && (typeof request === 'string' ? request : request.url) === scope) {
      delayed = false; requested.resolve(); await resume.promise;
    }
    return response;
  };
  const sw = await worker(net); await sw.install(); await sw.announce('a', a.publication);
  delayed = true; const old = sw.request('', 'old', true); await requested.promise;
  net.current = b; await sw.activate();
  resume.resolve(); await old;
  net.online = false;
  assert.match(await (await sw.request('', 'fresh', true)).text(), /<h1>2<\/h1>/);
});

test("explicit publication refresh and reload navigations prefer fresh network HTML and fall back offline", async () => {
  const a = release('1'), b = release('2'), net = network(a), sw = await worker(net);
  await sw.install(); await sw.announce('a', a.publication);
  net.current = b;
  // Normal navigation uses SWR (serves cached 1 immediately)
  assert.match(await (await sw.request('', 'swr', true)).text(), /<h1>1<\/h1>/);
  // Reset back to 1 cached and switch server to 2 to test reload + publication_refresh
  net.current = a; await sw.announce('a', a.publication);
  net.current = b;
  // Explicit reload (cache: "reload") bypasses SWR and serves publication 2 immediately
  assert.match(await (await sw.request('', 'a', true, { cache: 'reload' })).text(), /<h1>2<\/h1>/);
  // Explicit publication_refresh signal also bypasses SWR even without cache: "reload"
  net.current = a; await sw.announce('b', a.publication);
  net.current = b;
  await sw.refresh('b');
  assert.match(await (await sw.request('', 'b', true)).text(), /<h1>2<\/h1>/);
  // When offline, reload falls back cleanly to the saved publication
  net.online = false;
  assert.match(await (await sw.request('', 'b', true, { cache: 'reload' })).text(), /<h1>2<\/h1>/);
});
