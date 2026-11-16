// A publication owns an immutable page/runtime asset graph. Live APIs are never
// cached. Client-to-publication bindings survive worker restarts, so a deferred
// reload cannot mix an old executing page with a new component or runtime.
import { registerPushHandlers } from "./sw-push";
import type { PublicationManifest, PublicationAsset } from "../../contract/index.mjs";

const sw = self as unknown as ServiceWorkerGlobalScope;
const SCOPE = sw.registration.scope;
const META_CACHE = "tendril-v2-metadata";
const META_KEY = SCOPE + "_tendril/publications";
const PREFIX = "tendril-v2-publication:" + encodeURIComponent(SCOPE) + ":";
const NETWORK_TIMEOUT_MS = 6000;
interface Registry {
  latest?: string;
  publications: Record<string, PublicationManifest>;
  clients: Record<string, string>;
  complete: string[];
}
interface RuntimeResource { url: string; sha256: string; type: string }
let registry: Registry | null = null;
let sequence: Promise<void> = Promise.resolve();
const queued = (task: () => Promise<void>): Promise<void> => {
  const pending = sequence.then(task, task);
  sequence = pending.catch(() => {});
  return pending;
};
const absolute = (path: string, base = SCOPE) => new URL(path, base).href;
const cacheName = (id: string) => PREFIX + id;

async function readRegistry(): Promise<Registry> {
  if (registry) return registry;
  const response = await (await caches.open(META_CACHE)).match(META_KEY);
  registry = response ? await response.json() : { publications: {}, clients: {}, complete: [] };
  return registry!;
}
async function writeRegistry(value: Registry) {
  registry = value;
  await (await caches.open(META_CACHE)).put(META_KEY, new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } }));
}
function noStore(response: Response): boolean {
  return (response.headers.get("Cache-Control") || "").split(",").some(value => value.trim().toLowerCase() === "no-store");
}
function safePath(path: unknown): path is string {
  if (typeof path !== "string" || !path || path.startsWith("/") || /[?#\\]/.test(path)) return false;
  try { return decodeURIComponent(path).split("/").every(part => part !== ".." && part !== "." && part !== ""); }
  catch { return false; }
}
function validManifest(value: any): value is PublicationManifest {
  if (!value || !/^[A-Za-z0-9_-]{1,128}$/.test(value.id) || !Array.isArray(value.assets) || !value.runtime) return false;
  try {
    const base = new URL(value.base, SCOPE), runtime = new URL(value.runtime.base, SCOPE), origin = new URL(SCOPE).origin;
    if (base.origin !== origin || runtime.origin !== origin || base.search || runtime.search || base.hash || runtime.hash) return false;
    if (!base.pathname.endsWith(`/_publications/${value.id}/`) || !/\/_tendril\/runtime\/[a-f0-9]{64}\/$/.test(runtime.pathname)) return false;
    if (!safePath(value.entry || "index.html")) return false;
    return value.assets.every((asset: any) => safePath(asset.path) && /^[a-f0-9]{64}$/.test(asset.sha256) && typeof asset.type === "string");
  } catch { return false; }
}
async function digest(response: Response): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", await response.clone().arrayBuffer()))].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
function validResource(value: any): value is RuntimeResource {
  if (!value || !/^[a-f0-9]{64}$/.test(value.sha256) || typeof value.type !== "string" || typeof value.url !== "string") return false;
  const base = SCOPE + "_tendril/assets/" + value.sha256 + "/";
  try {
    const url = absolute(value.url);
    return url.startsWith(base) && /^[A-Za-z0-9_.-]+$/.test(url.slice(base.length));
  } catch { return false; }
}
async function saveAsset(cache: Cache, url: string, asset: PublicationAsset, publication: PublicationManifest): Promise<void> {
  const saved = await cache.match(url);
  if (saved && !noStore(saved)) return;
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok || noStore(response)) throw new Error("Publication asset is unavailable: " + url);
  // HTML contains the page's generated config and runtime injection. Its manifest
  // identifies source content, while the response identifies the publication.
  if (asset.type.split(";", 1)[0] === "text/html") {
    if (response.headers.get("X-Tendril-Publication") !== publication.id) throw new Error("Publication response mismatch");
  } else if (await digest(response) !== asset.sha256) throw new Error("Publication asset integrity mismatch");
  await cache.put(url, response);
}

async function savePublication(publication: PublicationManifest, latest = false): Promise<void> {
  if (!validManifest(publication)) throw new Error("Invalid publication manifest");
  const meta = await readRegistry();
  meta.publications[publication.id] = publication;
  await writeRegistry(meta);
  const cache = await caches.open(cacheName(publication.id));
  const runtimeURL = absolute("manifest.json", absolute(publication.runtime.base));
  const cachedManifest = await cache.match(runtimeURL);
  const runtimeResponse = cachedManifest || await fetch(runtimeURL, { cache: "no-store" });
  if (!runtimeResponse.ok || noStore(runtimeResponse)) throw new Error("Runtime manifest is unavailable");
  const runtime = await runtimeResponse.clone().json();
  const runtimeId = new URL(publication.runtime.base, SCOPE).pathname.split("/").filter(Boolean).at(-1);
  if (runtime.id !== runtimeId || runtime.version !== publication.runtime.version || !Array.isArray(runtime.assets)) throw new Error("Runtime identity mismatch");
  if (!runtime.assets.every((asset: any) => safePath(asset.path) && /^[a-f0-9]{64}$/.test(asset.sha256))) throw new Error("Invalid runtime asset manifest");
  if (!Array.isArray(runtime.resources) || !runtime.resources.every(validResource)) throw new Error("Invalid runtime resource manifest");
  await cache.put(runtimeURL, runtimeResponse);
  await Promise.all([
    ...publication.assets.map(asset => saveAsset(cache, absolute(asset.path, absolute(publication.base)), asset, publication)),
    ...runtime.assets.filter((asset: PublicationAsset & { preload?: boolean }) => asset.preload === true).map((asset: PublicationAsset) => saveAsset(cache, absolute(asset.path, absolute(publication.runtime.base)), asset, publication)),
  ]);
  if (!meta.complete.includes(publication.id)) meta.complete.push(publication.id);
  if (latest) meta.latest = publication.id;
  await writeRegistry(meta);
}

async function update(): Promise<void> {
  const response = await fetch(SCOPE + "_tendril/info", { cache: "no-store" });
  if (!response.ok) return;
  const info = await response.json();
  await savePublication(info.publication, true);
  await cleanup();
}

async function cleanup(): Promise<void> {
  const meta = await readRegistry();
  const clients = await sw.clients.matchAll({ type: "window", includeUncontrolled: true });
  const live = clients.filter(client => client.url.startsWith(SCOPE));
  const ids = new Set(live.map(client => client.id));
  for (const id of Object.keys(meta.clients)) if (!ids.has(id)) delete meta.clients[id];
  // A newly claimed tab may not yet have announced its executing publication.
  // Ask it, and retain all versions until its answer is persisted.
  let unknown = false;
  for (const client of live) if (!meta.clients[client.id]) { unknown = true; client.postMessage({ t: "publication_request" }); }
  if (!unknown) {
    const retain = new Set([meta.latest, ...Object.values(meta.clients)].filter(Boolean));
    // Sweep actual cache keys too. A prior interrupted metadata commit may leave
    // a complete but orphaned publication cache absent from meta.publications.
    // An unannounced live client pauses this sweep above, so offline drafts remain safe.
    for (const key of await caches.keys()) {
      if (key.startsWith(PREFIX) && !retain.has(key.slice(PREFIX.length))) await caches.delete(key);
    }
    for (const id of Object.keys(meta.publications)) if (!retain.has(id)) {
      delete meta.publications[id];
      meta.complete = meta.complete.filter(value => value !== id);
    }
  }
  await writeRegistry(meta);
}

async function withinDeadline(network: Promise<Response>): Promise<Response | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([network, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), NETWORK_TIMEOUT_MS); })]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
function offlinePage(): Response {
  return new Response('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Offline</title><main style="font:1.2rem system-ui;padding:2rem"><h1>No connection</h1><p>This page has not been saved on this device yet. It will load when the connection is back.</p></main>', { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

async function navigate(event: FetchEvent): Promise<Response> {
  const meta = await readRegistry();
  const requested = new URL(event.request.url);
  const pin = /\/_publications\/([A-Za-z0-9_-]+)\//.exec(requested.pathname)?.[1];
  const replaced = (event as FetchEvent & { replacesClientId?: string }).replacesClientId;
  const prior = pin || meta.clients[replaced || event.clientId] || meta.latest;
  const publication = prior && meta.complete.includes(prior) ? meta.publications[prior] : undefined;
  const savedURL = pin ? requested.origin + requested.pathname : publication && absolute(publication.entry || "index.html", absolute(publication.base));
  const saved = publication && savedURL ? await (await caches.open(cacheName(publication.id))).match(savedURL) : undefined;
  const network = fetch(event.request).then(async response => {
    if (response.ok && !noStore(response)) {
      const text = await response.clone().text();
      const config = /window\.__TENDRIL__\s*=\s*(\{[\s\S]*?\})\s*;/.exec(text);
      if (config) {
        try {
          const current = JSON.parse(config[1]).publication;
          if (validManifest(current)) {
            const id = event.resultingClientId;
            event.waitUntil(queued(async () => {
              const next = await readRegistry();
              if (id) next.clients[id] = current.id;
              next.publications[current.id] = current;
              await writeRegistry(next);
              await savePublication(current, !pin);
            }).catch(() => {}));
          }
        } catch { /* A non-page navigation has no runtime configuration. */ }
      }
    }
    return response;
  });
  if (!saved) { try { return await network; } catch { return offlinePage(); } }
  event.waitUntil(network.then(() => {}).catch(() => {}));
  try { const response = await withinDeadline(network); if (response) return response; } catch { /* offline */ }
  if (event.resultingClientId && publication) await queued(async () => {
    const next = await readRegistry();
    next.clients[event.resultingClientId] = publication.id;
    await writeRegistry(next);
  });
  return saved;
}

async function staticAsset(event: FetchEvent): Promise<Response> {
  const url = event.request.url;
  const meta = await readRegistry();
  const ids = [meta.clients[event.clientId], meta.latest, ...Object.keys(meta.publications)].filter((id): id is string => !!id);
  const resources: { cache: Cache; asset: RuntimeResource }[] = [];
  for (const id of new Set(ids)) {
    const publication = meta.publications[id];
    if (!publication) continue;
    const pageBase = absolute(publication.base), runtimeBase = absolute(publication.runtime.base);
    const cache = await caches.open(cacheName(id));
    if (url.startsWith(pageBase) || url.startsWith(runtimeBase)) {
      const hit = await cache.match(url);
      if (hit && !noStore(hit)) return hit;
    }
    const manifest = await cache.match(absolute("manifest.json", runtimeBase));
    if (manifest) {
      const declared = await manifest.json();
      const optional = declared.assets.find((asset: PublicationAsset) => absolute(asset.path, runtimeBase) === url);
      const asset = optional ? { url, sha256: optional.sha256, type: optional.type }
        : declared.resources.find((resource: RuntimeResource) => absolute(resource.url) === url);
      if (asset) resources.push({ cache, asset });
    }
  }
  if (resources.length) {
    let response: Response | undefined;
    for (const { cache } of resources) {
      const hit = await cache.match(url);
      if (hit && !noStore(hit)) { response = hit; break; }
    }
    if (!response) {
      response = await fetch(event.request);
      if (!response.ok) return response;
      if (await digest(response) !== resources[0].asset.sha256) throw new Error("Runtime resource integrity mismatch");
      if (noStore(response)) return response;
    }
    // Shared immutable resources belong to each retained graph that declares
    // them. Closing one publication cannot evict another publication's download.
    await Promise.all(resources.map(({ cache }) => cache.put(url, response!.clone())));
    return response;
  }
  // Undeclared, query-modified and live URLs are network-only. A page publication
  // must declare the full dependency graph to gain durable offline behavior.
  return fetch(event.request);
}

sw.addEventListener("install", event => { sw.skipWaiting(); event.waitUntil(queued(update).catch(() => {})); });
sw.addEventListener("activate", event => { event.waitUntil(sw.clients.claim().then(() => queued(update)).catch(() => {})); });
sw.addEventListener("message", event => {
  const data = event.data, client = event.source as Client | null;
  if (data?.t !== "publication") return;
  const id = typeof data.publication?.id === "string" ? data.publication.id : null;
  const reply = (status: "ready" | "error", error?: { code: string; message: string }) =>
    event.ports[0]?.postMessage({ t: "publication", id, status, ...(error ? { error } : {}) });
  if (!client?.id || !validManifest(data.publication)) {
    reply("error", { code: "invalid_publication", message: "A client and valid publication manifest are required." });
    return;
  }
  event.waitUntil(queued(async () => {
    const meta = await readRegistry();
    meta.clients[client.id] = data.publication.id;
    await writeRegistry(meta);
    await savePublication(data.publication);
    await cleanup();
    // Cache entries can become visible before their complete-graph metadata is
    // committed. Only this acknowledgement establishes offline readiness.
    reply("ready");
  }).catch(error => reply("error", {
    code: "publication_save_failed", message: error instanceof Error ? error.message : String(error),
  })));
});
sw.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET" || request.headers.has("range")) return;
  const url = new URL(request.url);
  if (url.origin !== new URL(SCOPE).origin) return;
  if (request.mode === "navigate" && url.href.startsWith(SCOPE)) event.respondWith(navigate(event));
  else if (!url.search && !url.hash && (/\/_publications\/[A-Za-z0-9_-]+\//.test(url.pathname) || /\/_tendril\/(runtime|assets)\/[a-f0-9]{64}\//.test(url.pathname))) event.respondWith(staticAsset(event));
});

registerPushHandlers(sw);
