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
    async announce(clientId, publication, replies, documentPath = publication.entry) {
      const url = new URL(documentPath.split('/').map(encodeURIComponent).join('/'), publication.base).href;
      clients.set(clientId, url);
      await dispatch("message", { data: { t: "publication", publication }, source: { id: clientId, url },
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

test("a successful navigation refreshes resident introductions for the next offline launch of the same publication", async () => {
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
  html = page("https://replacement.example/introduce");
  const before = net.calls.length;
  assert.equal(await (await sw.request(url, "a", true)).text(), html);
  assert.deepEqual(net.calls.slice(before), [url], "refresh reuses navigation without discovery or asset fetches");
  assert.equal(await (await cache.match(url)).text(), html);

  net.online = false;
  const restarted = await worker(net, sw.stores, sw.clients);
  assert.equal(await (await restarted.request("", "a", true)).text(), html);
  assert.equal(await (await restarted.request(url, "a", true)).text(), html);
  assert.equal(await (await restarted.request(a.publication.base + "app.js", "a")).text(), "app-1");
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
    assert.equal(await (await sw.request(url, "a", true)).text(), html);
    assert.equal(await (await cache.match(url)).text(), saved);
    assert.equal(await (await cache.match(a.publication.base + "app.js")).text(), "app-1");
    assert.equal(await cache.match(a.publication.base + "missing.html"), undefined);
  }
});

test("a late network publication cannot rebind or evict a tab already given its offline publication", { timeout: 5000 }, async () => {
  const a = release("1"), b = release("2"), net = network(a), fetch = net.fetch;
  const requested = Promise.withResolvers(), arrived = Promise.withResolvers(), boundOffline = Promise.withResolvers();
  let delayed = false, deadline;
  net.fetch = async request => {
    const response = await fetch(request);
    if (delayed && (typeof request === "string" ? request : request.url) === scope) {
      requested.resolve(); await arrived.promise;
    }
    return response;
  };
  const sw = await worker(net, new Map(), new Map(), {
    timers: { setTimeout(callback) { deadline = callback; return 1; }, clearTimeout() {} },
    async beforePut(name, url, response) {
      if (delayed && name === "tendril-v2-metadata" && (await response.json()).clients.a === "1") boundOffline.resolve();
    },
  });
  await sw.install(); await sw.announce("a", a.publication);
  net.current = b; delayed = true;
  const navigation = sw.request("", "a", true);
  await requested.promise;
  deadline();
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
  assert.match(await (await restarted.request("", "a", true)).text(), /<h1>1<\/h1>/);
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
      assert.equal(await (await sw.request(base + "docs/", client, true)).text(), `${item.publication.id}: docs/index.html`);
      for (const path of [encode(directory), encode(directory + "index.html").replace(/%[0-9A-F]{2}/g, part => part.toLowerCase())])
        assert.equal(await (await sw.request(base + path, client, true)).text(), `${item.publication.id}: ${directory}index.html`);
      for (const path of ["missing/", "docs", "docs/missing.html", "bad%escape/"])
        assert.equal((await sw.request(base + path, client, true)).status, 503, `No implicit page fallback for ${path}`);
    }
  }
  // An explicit publication pin takes precedence over the current client binding.
  assert.equal(await (await sw.request(a.publication.base + "docs/", "b", true)).text(), "1: docs/index.html");
});
