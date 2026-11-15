// Service worker (PLAN 14.1). Scope = page base P.
// - Caches every file of the current version (from `_tendril/info`) plus tendril.js, in a cache
//   named `tendril-<id>-v<version>`; older caches of the same tendril are deleted.
// - Navigations: network first (falls back to the cache when offline or very slow).
// - Static GETs use the requesting page's version (`?v=<n>`). Cached no-cache assets
//   revalidate before use, with offline fallback; immutable assets stay cache first.
// - Live `_tendril/` routes, `/api/`, POSTs and no-store responses are never cached.
import { registerPushHandlers } from "./sw-push";

const sw = self as unknown as ServiceWorkerGlobalScope;
const SCOPE = sw.registration.scope; // ends in "/"
const META_CACHE = "tendril-meta";
const META_KEY = SCOPE + "_tendril/__meta";
const RUNTIME = "_tendril/tendril.js";
const NETWORK_TIMEOUT_MS = 6000;

interface Meta { id: string; version: number }

let meta: Meta | null = null;
const clientVersion = new Map<string, number>();

async function getMeta(): Promise<Meta | null> {
  if (meta) return meta;
  try {
    const r = await (await caches.open(META_CACHE)).match(META_KEY);
    if (r) meta = await r.json();
  } catch { /* ignore */ }
  return meta;
}

async function setMeta(m: Meta) {
  meta = m;
  const c = await caches.open(META_CACHE);
  await c.put(META_KEY, new Response(JSON.stringify(m), { headers: { "Content-Type": "application/json" } }));
}

const cacheName = (m: Meta, version = m.version) => `tendril-${m.id}-v${version}`;

function cacheDirective(response: Response, directive: string): boolean {
  return (response.headers.get("Cache-Control") || "").split(",")
    .some((part) => part.trim().split("=", 1)[0].trim().toLowerCase() === directive);
}

async function saveResponse(cache: Cache, key: string, response: Response): Promise<void> {
  // The Cache API ignores HTTP cache directives unless the worker enforces them.
  if (cacheDirective(response, "no-store")) await cache.delete(key);
  else if (response.ok) await cache.put(key, response);
}

async function cachedResponse(cache: Cache, key: string): Promise<Response | undefined> {
  const response = await cache.match(key);
  if (response && cacheDirective(response, "no-store")) {
    await cache.delete(key);
    return undefined;
  }
  return response;
}

async function withinDeadline(network: Promise<Response>): Promise<Response | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([network, new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), NETWORK_TIMEOUT_MS);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

/** Re-creates a response so it can be served for navigations (no `redirected` flag). */
async function clean(r: Response): Promise<Response> {
  if (!r.redirected) return r;
  const body = await r.blob();
  return new Response(body, { status: r.status, statusText: r.statusText, headers: r.headers });
}

let updating: Promise<void> = Promise.resolve();
function update(): Promise<void> {
  updating = updating.then(doUpdate, doUpdate).catch(() => {});
  return updating;
}

async function doUpdate(): Promise<void> {
  const res = await fetch(SCOPE + "_tendril/info", { cache: "no-store" });
  if (!res.ok) return;
  const info = await res.json();
  if (!info || !info.id) return;
  const m: Meta = { id: String(info.id), version: Number(info.version) || 0 };
  const name = cacheName(m);
  const cache = await caches.open(name);
  const files: string[] = (Array.isArray(info.files) ? info.files : []).filter((f: any) =>
    typeof f === "string" && !f.startsWith("_tendril/") && !bypass(f, new URL(SCOPE + f)));
  const tasks = ["", ...files].map(async (rel) => {
    const key = SCOPE + rel;
    const saved = rel !== "" ? await cachedResponse(cache, key) : null;
    if (saved && !cacheDirective(saved, "no-cache")) return;
    const url = rel === "" ? key : `${key}?v=${m.version}`;
    const r = await fetch(url, { cache: "no-store" });
    await saveResponse(cache, key, await clean(r));
  });
  tasks.push((async () => {
    const r = await fetch(SCOPE + RUNTIME, { cache: "no-cache" });
    await saveResponse(cache, SCOPE + RUNTIME, r);
  })());
  await Promise.allSettled(tasks);
  const prev = await getMeta();
  await setMeta(m);
  if (prev && prev.id === m.id && prev.version !== m.version) clientVersion.forEach((v, k) => { if (v === prev.version) clientVersion.delete(k); });
  const prefix = `tendril-${m.id}-v`;
  for (const k of await caches.keys()) if (k.startsWith(prefix) && k !== name) await caches.delete(k);
}

function relPath(url: URL): string | null {
  const href = url.origin + url.pathname;
  if (!href.startsWith(SCOPE)) return null;
  return href.slice(SCOPE.length);
}

function bypass(rel: string, url: URL): boolean {
  if (url.pathname.includes("/api/")) return true;
  // Match the server's decoded page path, including encoded reserved prefixes.
  try { rel = decodeURIComponent(rel); } catch { /* the server keeps malformed paths as-is */ }
  if (rel !== "_tendril" && !rel.startsWith("_tendril/")) return false;
  // Only static routes from server/src/router.ts belong in a version cache.
  // New internal endpoints are live by default, including owner/private reads.
  return !(rel === RUNTIME || rel === "_tendril/speech-worker.js" ||
    /^_tendril\/snippets\/[A-Za-z0-9_.-]+\.js$/.test(rel) ||
    /^_tendril\/speech\/(cactus\.js|cactus\.wasm|whistle\.cact)$/.test(rel) ||
    /^_tendril\/tts\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+$/.test(rel) ||
    /^_tendril\/brand\/(logo\.(png|webp)|icon-(64|180)\.png|favicon\.ico)$/.test(rel));
}

async function purgeLiveResponses(): Promise<void> {
  // Older workers cached live API responses. Remove only this page's entries;
  // shared metadata and other page scopes must survive an offline activation.
  for (const name of await caches.keys()) {
    if (name === META_CACHE || !name.startsWith("tendril-")) continue;
    const cache = await caches.open(name);
    for (const request of await cache.keys()) {
      const url = new URL(request.url), rel = relPath(url);
      if (rel === null) continue;
      const saved = await cache.match(request);
      if (bypass(rel, url) || (saved && cacheDirective(saved, "no-store"))) await cache.delete(request);
    }
  }
}

function offlinePage(): Response {
  return new Response(
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Offline</title>' +
      '<main style="font:1.2rem system-ui;padding:2rem"><h1>No connection</h1><p>This page has not been saved on this device yet. It will load when the connection is back.</p></main>',
    { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

async function navigate(e: FetchEvent, rel: string): Promise<Response> {
  const m = await getMeta();
  const cache = m ? await caches.open(cacheName(m)) : null;
  const cached = cache ? (await cachedResponse(cache, SCOPE + rel)) || (rel === "" || rel === "index.html" ? await cachedResponse(cache, SCOPE) : undefined) : undefined;
  const net = fetch(e.request).then(async (r) => {
    if (cache && cacheDirective(r, "no-store")) e.waitUntil(cache.delete(SCOPE + rel));
    if (r.ok && !r.redirected) {
      // Learn which version this page will run, so its subresources match.
      try {
        const text = await r.clone().text();
        const v = /window\.__TENDRIL__\s*=\s*\{[^<]*?"version"\s*:\s*(\d+)/.exec(text);
        if (v && e.resultingClientId) clientVersion.set(e.resultingClientId, Number(v[1]));
        if (v && m && Number(v[1]) === m.version && cache) await saveResponse(cache, SCOPE + rel, r.clone());
        else if (v && (!m || Number(v[1]) !== m.version)) e.waitUntil(update());
      } catch { /* ignore */ }
    }
    return r;
  });
  if (!cached) {
    try { return await net; } catch { return offlinePage(); }
  }
  try {
    const r = await withinDeadline(net);
    if (r) return r;
  } catch { /* offline */ }
  if (e.resultingClientId && m) clientVersion.set(e.resultingClientId, m.version);
  return cached;
}

async function subresource(e: FetchEvent, rel: string): Promise<Response> {
  const url = new URL(e.request.url);
  // Explicit queries identify separate resources (including a requested version).
  // They must neither reuse nor replace the query-less version cache entry.
  if (url.search) return fetch(e.request);
  const m = await getMeta();
  const want = clientVersion.get(e.clientId) ?? m?.version;
  if (!m || want !== m.version) {
    if (want != null && rel !== RUNTIME && !rel.startsWith("_tendril/")) url.searchParams.set("v", String(want));
    return fetch(url.href === e.request.url ? e.request : url.href);
  }
  const cache = await caches.open(cacheName(m));
  const key = SCOPE + rel;
  const hit = await cachedResponse(cache, key);
  const revalidate = hit && cacheDirective(hit, "no-cache");
  if (hit && !revalidate) {
    if (rel === RUNTIME) e.waitUntil(fetch(e.request, { cache: "no-cache" }).then((r) => saveResponse(cache, key, r)).catch(() => {}));
    return hit;
  }
  if (!rel.startsWith("_tendril/")) url.searchParams.set("v", String(m.version));
  const net = fetch(url.href === e.request.url ? e.request : url.href, revalidate ? { cache: "no-cache" } : undefined).then((r) => {
    if (r.type === "basic") e.waitUntil(saveResponse(cache, key, r.clone()).catch(() => {}));
    return r;
  });
  if (!hit) return net;
  // A slow connection must not strand a saved page. Let a late revalidation
  // refresh its cache, while this request falls back within the same deadline
  // as navigation. Live APIs never reach this path.
  e.waitUntil(net.then(() => {}).catch(() => {}));
  try { return (await withinDeadline(net)) ?? hit; }
  catch { return hit; }
}

sw.addEventListener("install", (e) => {
  sw.skipWaiting();
  e.waitUntil(update().catch(() => {}));
});

sw.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    await purgeLiveResponses().catch(() => {});
    await Promise.all([sw.clients.claim(), update().catch(() => {})]);
  })());
});

sw.addEventListener("message", (e: ExtendableMessageEvent) => {
  const d = e.data;
  if (d && d.t === "update") {
    const src = e.source as Client | null;
    if (src && src.id && typeof d.version === "number") clientVersion.set(src.id, d.version);
    e.waitUntil(update());
  }
});

sw.addEventListener("fetch", (e: FetchEvent) => {
  const req = e.request;
  if (req.method !== "GET" || req.headers.has("range")) return;
  const url = new URL(req.url);
  const rel = relPath(url);
  if (rel === null || bypass(rel, url)) return;
  if (req.mode === "navigate") e.respondWith(navigate(e, rel));
  else e.respondWith(subresource(e, rel));
});

registerPushHandlers(sw);
