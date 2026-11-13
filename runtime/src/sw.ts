// Service worker (PLAN 14.1). Scope = page base P.
// - Caches every file of the current version (from `_tendril/info`) plus tendril.js, in a cache
//   named `tendril-<id>-v<version>`; older caches of the same tendril are deleted.
// - Navigations: network first (falls back to the cache when offline or very slow).
// - Other GETs in scope: cache first for the version the requesting page loaded, else network
//   (with `?v=<n>` so the server returns that version's file); tendril.js is revalidated.
// - Never cached: `_tendril/ws`, `_tendril/info`, blobs, voice/transcribe, POSTs, `/api/`.
import { registerPushHandlers } from "./sw-push";

const sw = self as unknown as ServiceWorkerGlobalScope;
const SCOPE = sw.registration.scope; // ends in "/"
const META_CACHE = "tendril-meta";
const META_KEY = SCOPE + "_tendril/__meta";
const RUNTIME = "_tendril/tendril.js";
const NAV_TIMEOUT_MS = 6000;

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
  const files: string[] = (Array.isArray(info.files) ? info.files : []).filter((f: any) => typeof f === "string" && !f.startsWith("_tendril/"));
  const tasks = ["", ...files].map(async (rel) => {
    const key = SCOPE + rel;
    if (rel !== "" && (await cache.match(key))) return; // version files are immutable
    const url = rel === "" ? key : `${key}?v=${m.version}`;
    const r = await fetch(url, { cache: "no-store" });
    if (r.ok) await cache.put(key, await clean(r));
  });
  tasks.push((async () => {
    const r = await fetch(SCOPE + RUNTIME, { cache: "no-cache" });
    if (r.ok) await cache.put(SCOPE + RUNTIME, r);
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
  return (
    url.pathname.includes("/api/") ||
    rel.startsWith("_tendril/ws") ||
    rel.startsWith("_tendril/info") ||
    rel.startsWith("_tendril/blob") ||
    rel.startsWith("_tendril/voice") ||
    rel.startsWith("_tendril/transcribe") ||
    rel === "_tendril/sw.js"
  );
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
  const cached = cache ? (await cache.match(SCOPE + rel)) || (rel === "" || rel === "index.html" ? await cache.match(SCOPE) : undefined) : undefined;
  const net = fetch(e.request).then(async (r) => {
    if (r.ok && !r.redirected) {
      // Learn which version this page will run, so its subresources match.
      try {
        const text = await r.clone().text();
        const v = /window\.__TENDRIL__\s*=\s*\{[^<]*?"version"\s*:\s*(\d+)/.exec(text);
        if (v && e.resultingClientId) clientVersion.set(e.resultingClientId, Number(v[1]));
        if (v && m && Number(v[1]) === m.version && cache) await cache.put(SCOPE + rel, r.clone());
        else if (v && (!m || Number(v[1]) !== m.version)) e.waitUntil(update());
      } catch { /* ignore */ }
    }
    return r;
  });
  if (!cached) {
    try { return await net; } catch { return offlinePage(); }
  }
  const timeout = new Promise<Response | null>((res) => setTimeout(() => res(null), NAV_TIMEOUT_MS));
  try {
    const r = await Promise.race([net, timeout]);
    if (r) return r;
  } catch { /* offline */ }
  if (e.resultingClientId && m) clientVersion.set(e.resultingClientId, m.version);
  return cached;
}

async function subresource(e: FetchEvent, rel: string): Promise<Response> {
  const m = await getMeta();
  const want = clientVersion.get(e.clientId) ?? m?.version;
  if (!m || want !== m.version) {
    const url = new URL(e.request.url);
    if (want != null && !url.search && rel !== RUNTIME && !rel.startsWith("_tendril/")) url.searchParams.set("v", String(want));
    return fetch(url.href === e.request.url ? e.request : url.href);
  }
  const cache = await caches.open(cacheName(m));
  const key = SCOPE + rel;
  const hit = await cache.match(key);
  if (hit) {
    if (rel === RUNTIME) e.waitUntil(fetch(e.request, { cache: "no-cache" }).then((r) => (r.ok ? cache.put(key, r) : undefined)).catch(() => {}));
    return hit;
  }
  const url = new URL(e.request.url);
  const ownQuery = !!url.search;
  if (!ownQuery && !rel.startsWith("_tendril/")) url.searchParams.set("v", String(m.version));
  const r = await fetch(url.href === e.request.url ? e.request : url.href);
  // Cache only plain (query-less) requests: the cache key ignores the query.
  if (r.ok && r.type === "basic" && !ownQuery) e.waitUntil(cache.put(key, r.clone()).catch(() => {}));
  return r;
}

sw.addEventListener("install", (e) => {
  sw.skipWaiting();
  e.waitUntil(update().catch(() => {}));
});

sw.addEventListener("activate", (e) => {
  e.waitUntil(Promise.all([sw.clients.claim(), update().catch(() => {})]));
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
