import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

// Exercise the actual bundled worker without launching a browser. The in-memory
// Cache API consumes/clones responses, and a fetch without respondWith goes to
// the network, as it does in the browser.
const compiled = await build({ entryPoints: [new URL("../src/sw.ts", import.meta.url).pathname],
  bundle: true, format: "iife", platform: "browser", write: false });
const scope = "https://page.example/s/key/";
const versionCache = "tendril-page-v1";
const absolute = path => new URL(path, scope).href;

function basic(response) {
  Object.defineProperty(response, "type", { value: "basic" });
  const clone = response.clone.bind(response);
  response.clone = () => basic(clone());
  return response;
}
const json = (value, init) => basic(new Response(JSON.stringify(value), init));

async function worker(network, timers = { setTimeout, clearTimeout }) {
  const listeners = new Map(), stores = new Map(), requests = [], background = [];
  let claimed = false;
  const key = request => typeof request === "string" ? request : request.url;
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const entries = stores.get(name);
      return {
        async match(request) { return entries.get(key(request))?.clone(); },
        async put(request, response) { entries.set(key(request), response.clone()); },
        async delete(request) { return entries.delete(key(request)); },
        async keys() { return [...entries.keys()].map(url => new Request(url)); },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
  };
  const fetch = async (request, init) => {
    const url = new URL(key(request));
    requests.push({ url: url.href, init });
    return network(url, init);
  };
  runInNewContext(compiled.outputFiles[0].text, {
    URL, Response, Request, Headers, caches, fetch, ...timers,
    self: {
      registration: { scope },
      addEventListener(name, callback) { listeners.set(name, callback); },
      skipWaiting() {},
      clients: { async claim() { claimed = true; } },
    },
  });
  await (await caches.open("tendril-meta")).put(absolute("_tendril/__meta"), json({ id: "page", version: 1 }));
  async function dispatch(name, properties = {}, settle = true) {
    const pending = [];
    let response;
    listeners.get(name)({ ...properties,
      waitUntil(promise) { pending.push(promise); background.push(promise); },
      respondWith(promise) { response = promise; },
    });
    const result = response === undefined && name === "fetch" ? await fetch(properties.request) : await response;
    if (settle) await Promise.all(pending);
    return result;
  }
  return {
    caches, requests,
    get claimed() { return claimed; },
    activate: () => dispatch("activate"),
    install: () => dispatch("install"),
    request: (path, { settle = true } = {}) => dispatch("fetch", { request: new Request(absolute(path)), clientId: "page" }, settle),
    drain: async () => {
      for (let offset = 0; offset < background.length;) {
        const batch = background.slice(offset);
        offset = background.length;
        await Promise.all(batch);
      }
    },
    async seed(name, path, value) { await (await caches.open(name)).put(absolute(path), value); },
    async keys(name) { return (await (await caches.open(name)).keys()).map(request => request.url); },
  };
}

test("live API reads stay fresh, including new and URL-encoded internal routes", async () => {
  let revision = 0;
  const sw = await worker(() => json({ revision }));
  const paths = ["_tendril/devices", "_tendril/focus", "_tendril/timers", "_tendril/timers/history",
    "_tendril/resume", "_tendril/decisions", "_tendril/responses", "_tendril/session",
    "_tendril/agents", "_tendril/invites", "_tendril/future-api", "%5Ftendril/devices"];
  for (const path of paths) {
    revision = 1;
    assert.deepEqual(await (await sw.request(path)).json(), { revision: 1 }, path);
    revision = 2;
    assert.deepEqual(await (await sw.request(path)).json(), { revision: 2 }, path);
  }
  assert.deepEqual(await sw.keys(versionCache), []);
});

test("legacy cached owner data cannot bypass changed access or appear offline", async () => {
  let online = true;
  const sw = await worker(() => {
    if (!online) throw new TypeError("offline");
    return json({ error: { code: "forbidden" } }, { status: 403 });
  });
  for (const path of ["_tendril/devices", "_tendril/responses"]) {
    await sw.seed(versionCache, path, json({ private: "owner data" }));
    const response = await sw.request(path);
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: { code: "forbidden" } });
    online = false;
    await assert.rejects(sw.request(path), /offline/);
    online = true;
  }
});

test("activation purges legacy live API entries even offline without deleting version assets or another scope", async () => {
  const sw = await worker(() => { throw new TypeError("offline"); });
  const privatePaths = ["_tendril/devices", "_tendril/responses?participant=old", "_tendril/session",
    "%5Ftendril/decisions", "_tendril/future-api"];
  const keptPaths = ["app.js", "_tendril/tendril.js", "_tendril/snippets/input-kit.js", "_tendril/speech/cactus.wasm"];
  const otherScope = "https://page.example/s/other/_tendril/devices";
  for (const name of [versionCache, "tendril-page-v0"]) {
    for (const path of [...privatePaths, ...keptPaths, otherScope]) await sw.seed(name, path, json({ saved: true }));
    await sw.seed(name, "legacy.js", json({ revision: -1 }, { headers: { "Cache-Control": "no-store" } }));
  }
  await sw.seed("unrelated-app", "_tendril/devices", json({ unrelated: true }));
  await sw.activate();
  assert.equal(sw.claimed, true);
  for (const name of [versionCache, "tendril-page-v0"])
    assert.deepEqual((await sw.keys(name)).sort(), [...keptPaths.map(absolute), otherScope].sort());
  assert.deepEqual(await sw.keys("tendril-meta"), [absolute("_tendril/__meta")]);
  assert.deepEqual(await sw.keys("unrelated-app"), [absolute("_tendril/devices")]);
});

test("version, runtime, snippet, speech and brand files still load from cache offline", async () => {
  let online = true;
  const sw = await worker(url => {
    if (!online) throw new TypeError("offline");
    return basic(new Response(url.pathname, { headers: { "Cache-Control": "no-cache" } }));
  });
  const assets = ["app.js", "styles.css", "_tendril/tendril.js", "_tendril/speech-worker.js", "_tendril/axe.min.js",
    "_tendril/snippets/input-kit.js", "_tendril/speech/cactus.js", "_tendril/speech/cactus.wasm",
    "_tendril/speech/whistle.cact", "_tendril/tts/index.js", "_tendril/tts/dist/worker.js",
    "_tendril/brand/icon-64.png", "_tendril/brand/favicon.ico"];
  for (const path of assets) assert.equal(await (await sw.request(path)).text(), new URL(absolute(path)).pathname);
  online = false;
  for (const path of assets) assert.equal(await (await sw.request(path)).text(), new URL(absolute(path)).pathname);
  assert.deepEqual((await sw.keys(versionCache)).sort(), assets.map(absolute).sort());
});

test("no-cache app edits revalidate before use and survive offline, while immutable assets stay cache first", async () => {
  let revision = 1, online = true;
  const sw = await worker(url => {
    if (!online) throw new TypeError("offline");
    return json({ revision }, { headers: { "Cache-Control": url.pathname.endsWith("fixed.js") ? "public, max-age=31536000, immutable" : "no-cache" } });
  });
  assert.deepEqual(await (await sw.request("app.js")).json(), { revision: 1 });
  assert.deepEqual(await (await sw.request("fixed.js")).json(), { revision: 1 });
  revision = 2;
  assert.deepEqual(await (await sw.request("app.js")).json(), { revision: 2 });
  assert.equal(new URL(sw.requests.at(-1).url).searchParams.get("v"), "1", "revalidation keeps the loaded page version");
  assert.equal(sw.requests.at(-1).init.cache, "no-cache");
  assert.deepEqual(await (await sw.request("fixed.js")).json(), { revision: 1 });
  assert.equal(sw.requests.filter(request => new URL(request.url).pathname.endsWith("fixed.js")).length, 1);
  assert.deepEqual(await (await sw.request("fixed.js?v=2")).json(), { revision: 2 });
  assert.deepEqual(await (await sw.request("fixed.js")).json(), { revision: 1 });
  online = false;
  assert.deepEqual(await (await sw.request("app.js")).json(), { revision: 2 });
  assert.deepEqual(await (await sw.request("fixed.js")).json(), { revision: 1 });
  await assert.rejects(sw.request("fixed.js?v=2"), /offline/);
});

test("a stalled no-cache revalidation falls back by the deadline and saves the late response", { timeout: 5000 }, async () => {
  let release, fireDeadline, scheduled;
  const started = new Promise(resolve => { scheduled = resolve; });
  const late = new Promise(resolve => { release = resolve; });
  const timers = {
    setTimeout(callback, delay) { fireDeadline = callback; scheduled(delay); return 1; },
    clearTimeout() {},
  };
  let slow = false;
  const sw = await worker(() => slow ? late : json({ revision: 1 }, { headers: { "Cache-Control": "no-cache" } }), timers);
  assert.deepEqual(await (await sw.request("app.js")).json(), { revision: 1 });
  slow = true;
  const pending = sw.request("app.js", { settle: false });
  assert.equal(await started, 6000);
  fireDeadline();
  assert.deepEqual(await (await pending).json(), { revision: 1 });
  release(json({ revision: 2 }, { headers: { "Cache-Control": "no-cache" } }));
  await sw.drain();
  const saved = await (await sw.caches.open(versionCache)).match(absolute("app.js"));
  assert.deepEqual(await saved.json(), { revision: 2 });
});

test("no-store responses are excluded from ordinary reads and version prefetch", async () => {
  let revision = 0;
  const sw = await worker(url => {
    if (url.pathname.endsWith("_tendril/info")) return json({ id: "page", version: 1, files: ["private.js", "legacy.js", "_tendril/devices", "%5Ftendril/responses"] });
    if (url.pathname.endsWith("_tendril/tendril.js")) return basic(new Response("runtime"));
    if (url.pathname.endsWith("devices") || url.pathname.endsWith("responses")) return json({ private: "owner data" });
    return json({ revision }, { headers: { "Cache-Control": "private, no-store" } });
  });
  for (const path of ["private.js", "legacy.js"])
    await sw.seed(versionCache, path, json({ revision: -1 }, { headers: { "Cache-Control": "no-store" } }));
  assert.deepEqual(await (await sw.request("private.js")).json(), { revision: 0 });
  revision++;
  assert.deepEqual(await (await sw.request("private.js")).json(), { revision: 1 });
  await sw.install();
  assert.deepEqual(await sw.keys(versionCache), [absolute("_tendril/tendril.js")]);
});
