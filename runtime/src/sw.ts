import { encodePublicationPath, validPublicationPath } from "./paths";
// A publication owns an immutable page/runtime asset graph. Live APIs are never
// cached. Client-to-publication bindings survive worker restarts, so a deferred
// reload cannot mix an old executing page with a new component or runtime.
import type { PublicationManifest, PublicationAsset } from "../../contract/index.mjs";

const sw = self as unknown as ServiceWorkerGlobalScope;
const SCOPE = sw.registration.scope;
const META_CACHE = "tendril-metadata";
const META_KEY = SCOPE + "_tendril/publications";
const PREFIX = "tendril-publication:" + encodeURIComponent(SCOPE) + ":";
const SHARE_INBOX_CACHE = "tendril-share-inbox:" + encodeURIComponent(SCOPE);
const SHARE_TTL_MS = 5 * 60 * 1000;
const SHARE_MAX_FILES = 4;
const SHARE_MAX_TOTAL_BYTES = 10 * 1024 * 1024;
// Saving a release runs beside an executing page. Bound its parallel downloads so it
// never competes with the page's own boot requests for every connection.
const SAVE_CONCURRENCY = 4;
interface Registry {
  latest?: string;
  publications: Record<string, PublicationManifest>;
  clients: Record<string, string>;
  complete: string[];
}
interface RuntimeResource { url: string; sha256: string; type: string }
let registry: Registry | null = null;
// Order canonical selection requests, not publication IDs or response completion.
// A later request can intentionally observe a rollback to a lower version. These
// counters are local to this worker lifetime; an old worker's requests cannot
// complete after that worker has been terminated and restarted.
let selectionRequest = 0, savedSelectionRequest = 0;
let sequence: Promise<void> = Promise.resolve();
const queued = (task: () => Promise<void>): Promise<void> => {
  const pending = sequence.then(task, task);
  sequence = pending.catch(() => {});
  return pending;
};
const absolute = (path: string, base = SCOPE) => new URL(path, base).href;
const cacheName = (id: string) => PREFIX + id;
function runtimeBases(base: string): string[] {
  const suffix = /\/_tendril\/runtime\/[a-f0-9]{64}\/$/.exec(new URL(base, SCOPE).pathname)?.[0];
  return suffix ? [...new Set([absolute(base), absolute(suffix), absolute(suffix.slice(1))])] : [absolute(base)];
}

async function cachedRuntime(cache: Cache, bases: string[], path: string): Promise<Response | undefined> {
  for (const base of bases) {
    const saved = await cache.match(base + path);
    if (saved && !noStore(saved)) return saved;
  }
  return undefined;
}

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
const safePath = validPublicationPath;

function validManifest(value: any): value is PublicationManifest {
  if (!value || !/^[A-Za-z0-9_-]{1,128}$/.test(value.id) || !Array.isArray(value.assets) || !value.runtime) return false;
  try {
    const base = new URL(value.base, SCOPE), runtime = new URL(value.runtime.base, SCOPE), origin = new URL(SCOPE).origin;
    if (base.origin !== origin || runtime.origin !== origin || base.search || runtime.search || base.hash || runtime.hash) return false;
    if (!base.pathname.endsWith(`/_publications/${value.id}/`) || !/\/_tendril\/runtime\/[a-f0-9]{64}\/$/.test(runtime.pathname)) return false;
    if (!safePath(value.entry) || !value.assets.some((asset: any) => asset.path === value.entry && typeof asset.type === "string" && /^text\/html(?:;|$)/i.test(asset.type))) return false;
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
  const html = asset.type.split(";", 1)[0] === "text/html";
  // Immutable files usually sit in the HTTP cache already (the executing page just
  // loaded them), so read through it instead of downloading the release again. Every
  // byte is still verified against the signed manifest; a mismatching cached copy is
  // re-read from the network once. HTML carries live host configuration and is
  // always read from the network.
  for (const mode of html ? ["no-store"] as const : ["default", "reload"] as const) {
    const response = await fetch(url, { cache: mode });
    if (!response.ok || noStore(response)) throw new Error("Publication asset is unavailable: " + url);
    // HTML contains the page's generated config and runtime injection. Its manifest
    // identifies source content, while the response identifies the publication.
    if (html) {
      if (response.headers.get("X-Tendril-Publication") !== publication.id) throw new Error("Publication response mismatch");
    } else if (await digest(response) !== asset.sha256) {
      if (mode === "default") continue;
      throw new Error("Publication asset integrity mismatch");
    }
    await cache.put(url, response);
    return;
  }
}

async function bounded<T>(tasks: (() => Promise<T>)[], limit = SAVE_CONCURRENCY): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  const lane = async () => { while (next < tasks.length) { const index = next++; results[index] = await tasks[index](); } };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, lane));
  return results;
}

async function savePublication(publication: PublicationManifest, selection?: number): Promise<void> {
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
  await bounded([
    ...publication.assets.map(asset => () => saveAsset(cache, absolute(encodePublicationPath(asset.path), absolute(publication.base)), asset, publication)),
    ...runtime.assets.filter((asset: PublicationAsset & { preload?: boolean }) => asset.preload === true).map((asset: PublicationAsset) => () => saveAsset(cache, absolute(encodePublicationPath(asset.path), absolute(publication.runtime.base)), asset, publication)),
  ]);
  if (!meta.complete.includes(publication.id)) meta.complete.push(publication.id);
  if (selection !== undefined && selection >= savedSelectionRequest) {
    savedSelectionRequest = selection; meta.latest = publication.id;
  }
  await writeRegistry(meta);
}

async function update(): Promise<void> {
  const selection = ++selectionRequest;
  const response = await fetch(SCOPE + "_tendril/info", { cache: "no-store" });
  if (!response.ok) return;
  const info = await response.json();
  await savePublication(info.publication, selection);
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

/** A navigation answer that means this device's saved document must not be reused:
 * the host now redirects (sign-in), refuses access, or no longer serves the page. */
function accessChanged(response: Response): boolean {
  return response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400) || [401, 403, 404, 410].includes(response.status);
}
function offlinePage(): Response {
  return new Response('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Offline</title><main style="font:1.2rem system-ui;padding:2rem"><h1>No connection</h1><p>This page has not been saved on this device yet. It will load when the connection is back.</p></main>', { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

async function navigate(event: FetchEvent): Promise<Response> {
  const meta = await readRegistry();
  const requested = new URL(event.request.url);
  let relative: string | undefined;
  try { relative = decodeURIComponent(requested.pathname.slice(new URL(SCOPE).pathname.length)); }
  catch { /* Malformed paths cannot select a saved file. */ }
  const pinned = relative === undefined ? null : /^_publications\/([A-Za-z0-9_-]+)\/(.*)$/.exec(relative);
  const pin = pinned?.[1];
  const replaced = (event as FetchEvent & { replacesClientId?: string }).replacesClientId;
  // The page URL opens the latest complete release, also offline; the tab's own
  // release is the fallback. Only an explicit /_publications/ID/ URL pins.
  const prior = pin || [meta.latest, meta.clients[replaced || event.clientId]].find(id => id && meta.complete.includes(id));
  const publication = prior && meta.complete.includes(prior) ? meta.publications[prior] : undefined;
  const path = pinned ? pinned[2] : relative;
  const filename = path === "" ? publication?.entry : path?.endsWith("/") ? path + "index.html" : path;
  const declared = safePath(filename) ? publication?.assets.find(asset => asset.path === filename && asset.type.split(";", 1)[0] === "text/html") : undefined;
  // Ordinary file routing: an offline nested URL must never show another entry page.
  const savedURL = publication && declared ? absolute(encodePublicationPath(declared.path), absolute(publication.base)) : undefined;
  const saved = publication && savedURL ? await (await caches.open(cacheName(publication.id))).match(savedURL) : undefined;
  let networkPublicationId: string | undefined;
  const selection = pin ? undefined : ++selectionRequest;
  const network = fetch(event.request).then(async response => {
    if (response.ok && !noStore(response)) {
      const text = await response.clone().text();
      const config = /window\.__TENDRIL__\s*=\s*(\{[\s\S]*?\})\s*;/.exec(text);
      if (config) {
        try {
          const { publication: current, documentPath } = JSON.parse(config[1]);
          if (validManifest(current)) {
            networkPublicationId = current.id;
            const document = safePath(documentPath) && current.assets.find(asset =>
              asset.path === documentPath && asset.type.split(";", 1)[0] === "text/html");
            // The source graph is immutable, but a fetched document carries
            // current host configuration. Retain this exact response for the
            // next offline launch without re-fetching its unchanged assets.
            const refreshed = document && response.headers.get("X-Tendril-Publication") === current.id
              ? { url: absolute(encodePublicationPath(document.path), absolute(current.base)), response: response.clone() } : null;
            event.waitUntil(queued(async () => {
              const next = await readRegistry();
              next.publications[current.id] = current;
              await writeRegistry(next);
              if (refreshed) await (await caches.open(cacheName(current.id))).put(refreshed.url, refreshed.response);
              await savePublication(current, selection);
            }).catch(() => {}));
          }
        } catch { /* A non-page navigation has no runtime configuration. */ }
      }
    }
    return response;
  });
  const selectNetwork = (response: Response): Response => {
    // A response that arrives after the offline deadline may refresh caches,
    // but only the document delivered to this client can change its binding.
    const id = networkPublicationId;
    if (event.resultingClientId && id) event.waitUntil(queued(async () => {
      const next = await readRegistry();
      next.clients[event.resultingClientId] = id;
      await writeRegistry(next);
    }).catch(() => {}));
    return response;
  };
  if (!saved) { try { return selectNetwork(await network); } catch { return offlinePage(); } }
  // Stale-while-revalidate: a saved, complete release opens immediately (online or
  // offline) and the network response only refreshes caches for the NEXT launch.
  // Staleness window: one launch. The delivered document carries the host
  // configuration of the previous successful navigation (peer bootstrap, role,
  // broadcast sequence), and a newer release is picked up by the page's publication
  // watch (automatic switch or update prompt) or by the next launch. Host APIs still
  // authenticate every request; if this revalidation shows that access changed (a
  // sign-in redirect, refusal or removed page), the saved document is dropped and the
  // page is told to reload, so the next navigation goes to the network.
  const bound = event.resultingClientId, savedId = publication!.id;
  event.waitUntil(network.then(async response => {
    if (!accessChanged(response) || !savedURL) return;
    await queued(async () => {
      await (await caches.open(cacheName(savedId))).delete(savedURL);
      const next = await readRegistry();
      next.complete = next.complete.filter(id => id !== savedId);
      await writeRegistry(next);
    });
    const client = bound ? await sw.clients.get(bound) : undefined;
    client?.postMessage({ t: "navigation_stale" });
  }).catch(() => {}));
  if (bound) await queued(async () => {
    const next = await readRegistry();
    next.clients[bound] = savedId;
    await writeRegistry(next);
  });
  return saved;
}

async function recoverAssetFromClients(
  url: string,
  expected: { sha256?: string; type?: string; path?: string; publicationId?: string },
): Promise<Response | null> {
  try {
    const clients = await sw.clients.matchAll({ type: "window", includeUncontrolled: false });
    for (const client of clients) {
      if (!client.url.startsWith(SCOPE)) continue;
      const result = await new Promise<{ ok?: boolean; bytes?: ArrayBuffer; type?: string } | null>(resolve => {
        const channel = new MessageChannel();
        const timer = setTimeout(() => { channel.port1.close(); resolve(null); }, 4000);
        channel.port1.onmessage = ev => {
          clearTimeout(timer);
          channel.port1.close();
          resolve(ev.data && typeof ev.data === "object" ? ev.data : null);
        };
        try {
          client.postMessage({ t: "p2p_asset_request", url, ...expected }, [channel.port2]);
        } catch {
          clearTimeout(timer);
          channel.port1.close();
          resolve(null);
        }
      });
      if (!result?.ok || !(result.bytes instanceof ArrayBuffer)) continue;
      const res = new Response(result.bytes, {
        status: 200,
        headers: {
          "Content-Type": result.type || expected.type || "application/octet-stream",
          "X-Tendril-Source": "p2p",
        },
      });
      if (expected.sha256 && await digest(res) !== expected.sha256) continue;
      return res;
    }
  } catch { /* best-effort P2P fallback */ }
  return null;
}

async function staticAsset(event: FetchEvent): Promise<Response> {
  const url = event.request.url;
  const meta = await readRegistry();
  const ids = [meta.clients[event.clientId], meta.latest, ...Object.keys(meta.publications)].filter((id): id is string => !!id);
  const resources: { cache: Cache; asset: RuntimeResource }[] = [];
  let matchedPubAsset: { cache: Cache; publicationId: string; asset: PublicationAsset } | null = null;
  for (const id of new Set(ids)) {
    const publication = meta.publications[id];
    if (!publication) continue;
    const pageBase = absolute(publication.base), bases = runtimeBases(publication.runtime.base);
    const cache = await caches.open(cacheName(id));
    if (url.startsWith(pageBase)) {
      const hit = await cache.match(url);
      if (hit && !noStore(hit)) return hit;
      if (!matchedPubAsset) {
        const asset = publication.assets.find(a => absolute(encodePublicationPath(a.path), pageBase) === url);
        if (asset) matchedPubAsset = { cache, publicationId: id, asset };
      }
    }
    const runtimeBase = bases.find(base => url.startsWith(base));
    if (runtimeBase) {
      const hit = await cachedRuntime(cache, bases, url.slice(runtimeBase.length));
      if (hit) return hit;
    }
    const manifest = await cachedRuntime(cache, bases, "manifest.json");
    if (manifest) {
      const declared = await manifest.json();
      const optional = runtimeBase && declared.assets.find((asset: PublicationAsset) => absolute(encodePublicationPath(asset.path), runtimeBase) === url);
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
  // Try host first; on 404/410 (pruned historical publication asset) or offline failure,
  // attempt SHA-256-verified P2P recovery from active page clients before failing.
  let networkResponse: Response | null = null;
  let networkError: unknown = null;
  try {
    networkResponse = await fetch(event.request);
    if (networkResponse.ok || (networkResponse.status !== 404 && networkResponse.status !== 410)) {
      return networkResponse;
    }
  } catch (err) { networkError = err; }
  const pubMatch = /\/_publications\/([A-Za-z0-9_-]+)\/(.*)$/.exec(new URL(url).pathname);
  if (matchedPubAsset || pubMatch) {
    const recovered = await recoverAssetFromClients(url, {
      sha256: matchedPubAsset?.asset.sha256,
      type: matchedPubAsset?.asset.type,
      path: matchedPubAsset?.asset.path ?? (pubMatch ? decodeURIComponent(pubMatch[2]) : undefined),
      publicationId: matchedPubAsset?.publicationId ?? pubMatch?.[1],
    });
    if (recovered) {
      if (matchedPubAsset) await matchedPubAsset.cache.put(url, recovered.clone()).catch(() => {});
      return recovered;
    }
  }
  if (networkResponse) return networkResponse;
  throw networkError;
}

async function sweepShareInbox(): Promise<void> {
  try {
    const cache = await caches.open(SHARE_INBOX_CACHE);
    const keys = await cache.keys();
    const now = Date.now();
    for (const req of keys) {
      if (!req.url.endsWith("/meta.json")) continue;
      const res = await cache.match(req);
      if (!res) continue;
      try {
        const meta = await res.json() as { expiresAt?: number; files?: Array<{ index: number }> };
        if (typeof meta.expiresAt === "number" && meta.expiresAt < now) {
          const base = req.url.slice(0, -"/meta.json".length);
          await cache.delete(req);
          for (const f of meta.files ?? []) await cache.delete(`${base}/file-${f.index}`);
        }
      } catch {
        await cache.delete(req);
      }
    }
  } catch { /* ignore */ }
}

async function handleShareTarget(request: Request): Promise<Response> {
  try {
    const form = await request.formData();
    const title = String(form.get("title") ?? "").slice(0, 500);
    const text = String(form.get("text") ?? "").slice(0, 8000);
    const sharedUrl = String(form.get("url") ?? "").slice(0, 2048);
    const rawFiles = form.getAll("files").filter((v): v is File => typeof File !== "undefined" && v instanceof File && v.size > 0);
    const idBytes = crypto.getRandomValues(new Uint8Array(12));
    const shareId = [...idBytes].map(b => b.toString(16).padStart(2, "0")).join("");
    const base = `${SCOPE}_tendril/share-inbox/${shareId}`;
    const cache = await caches.open(SHARE_INBOX_CACHE);
    const savedFiles: Array<{ name: string; type: string; index: number }> = [];
    let totalBytes = 0;
    for (const file of rawFiles) {
      if (savedFiles.length >= SHARE_MAX_FILES) break;
      if (totalBytes + file.size > SHARE_MAX_TOTAL_BYTES) continue;
      totalBytes += file.size;
      const idx = savedFiles.length;
      savedFiles.push({ name: file.name || `shared-${idx}`, type: file.type || "application/octet-stream", index: idx });
      await cache.put(`${base}/file-${idx}`, new Response(file, { headers: { "Content-Type": file.type || "application/octet-stream" } }));
    }
    await cache.put(`${base}/meta.json`, new Response(JSON.stringify({
      title, text, url: sharedUrl, files: savedFiles, expiresAt: Date.now() + SHARE_TTL_MS,
    }), { headers: { "Content-Type": "application/json" } }));
    const dest = new URL(SCOPE);
    dest.searchParams.set("_shared", shareId);
    return Response.redirect(dest.href, 303);
  } catch {
    return Response.redirect(SCOPE, 303);
  }
}

sw.addEventListener("install", event => { sw.skipWaiting(); event.waitUntil(queued(update).catch(() => {})); });
sw.addEventListener("activate", event => { event.waitUntil(sw.clients.claim().then(() => Promise.all([queued(update), sweepShareInbox()])).catch(() => {})); });
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
  const url = new URL(request.url);
  if (url.origin !== new URL(SCOPE).origin) return;
  if (request.method === "POST" && url.href === `${SCOPE}_tendril/share-target`) {
    event.respondWith(handleShareTarget(request));
    return;
  }
  if (request.method !== "GET" || request.headers.has("range")) return;
  if (request.mode === "navigate" && url.href.startsWith(SCOPE)) event.respondWith(navigate(event));
  else if (!url.search && !url.hash && (/\/_publications\/[A-Za-z0-9_-]+\//.test(url.pathname) || /\/_tendril\/(runtime|assets)\/[a-f0-9]{64}\//.test(url.pathname))) event.respondWith(staticAsset(event));
});

interface PushEventLike extends ExtendableEvent {
  data?: { json(): unknown; text(): string } | null;
}
interface NotificationEventLike extends ExtendableEvent {
  notification: Notification & { data?: { url?: string } };
}
sw.addEventListener("push", rawEvent => {
  const event = rawEvent as PushEventLike;
  let payload: { title?: string; body?: string; tag?: string; url?: string; badge?: number } = {};
  try {
    if (event.data) payload = event.data.json() as typeof payload;
  } catch {
    try { payload = { body: event.data?.text() }; } catch { /* ignore */ }
  }
  const title = typeof payload.title === "string" && payload.title.trim() ? payload.title.trim().slice(0, 120) : "Tendriller";
  const body = typeof payload.body === "string" ? payload.body.slice(0, 500) : "";
  const tag = typeof payload.tag === "string" && payload.tag.trim() ? payload.tag.trim().slice(0, 64) : undefined;
  let targetUrl = SCOPE;
  if (typeof payload.url === "string" && payload.url) {
    try {
      const resolved = new URL(payload.url, SCOPE);
      if (resolved.origin === new URL(SCOPE).origin && resolved.href.startsWith(SCOPE)) targetUrl = resolved.href;
    } catch { /* fallback to SCOPE */ }
  }
  const nav = sw.navigator as Navigator & { setAppBadge?: (count?: number) => Promise<void> };
  const tasks: Promise<unknown>[] = [
    sw.registration.showNotification(title, {
      body,
      icon: `${SCOPE}_tendril/icon.svg`,
      ...(tag ? { tag } : {}),
      data: { url: targetUrl },
    }),
  ];
  if (typeof payload.badge === "number" && Number.isFinite(payload.badge) && payload.badge > 0 && typeof nav?.setAppBadge === "function") {
    tasks.push(nav.setAppBadge(Math.min(999, Math.floor(payload.badge))).catch(() => {}));
  }
  event.waitUntil(Promise.all(tasks));
});

sw.addEventListener("notificationclick", rawEvent => {
  const event = rawEvent as NotificationEventLike;
  event.notification.close();
  let targetUrl = SCOPE;
  const rawUrl = event.notification.data?.url;
  if (typeof rawUrl === "string" && rawUrl) {
    try {
      const resolved = new URL(rawUrl, SCOPE);
      if (resolved.origin === new URL(SCOPE).origin && resolved.href.startsWith(SCOPE)) targetUrl = resolved.href;
    } catch { /* fallback to SCOPE */ }
  }
  const nav = sw.navigator as Navigator & { clearAppBadge?: () => Promise<void> };
  event.waitUntil((async () => {
    try { await nav?.clearAppBadge?.(); } catch { /* ignore */ }
    const clients = await sw.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of clients) {
      if (client.url.startsWith(SCOPE)) {
        if ("navigate" in client && client.url !== targetUrl) {
          try { await (client as WindowClient).navigate(targetUrl); } catch { /* ignore */ }
        }
        return (client as WindowClient).focus();
      }
    }
    return sw.clients.openWindow(targetUrl);
  })());
});
