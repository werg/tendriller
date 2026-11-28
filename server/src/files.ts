import { selectedApplication } from "./application";
import { peerBootstrap } from "./peers";
// Immutable signed code publication storage and serving.
import type { Tendril } from "./tendril";
import { addActivity } from "./activity";
import { HttpError, json } from "./http";
import { sha256Hex } from "./ids";
import runtimeRelease from "./runtime-release.json";
import { holdingPage, injectRuntime, type PublicationManifest } from "./inject";
import { appleTouchIcon, iconRasterRequest, rasterFavicon } from "./icon-raster";
import { allPageBases, extractAuthoredBranding } from "./page-icon";
import { MAX_FILES_PER_VERSION } from "./limits";
import { isHtmlType } from "./mime";
import { assetResponse, etagMatches, immutableObject } from "./immutable-cache";
import { brandMark } from "./brand";
import { icon, renderShell } from "./accounts/ui";
import { broadcastSummary, publicBroadcastKeys, recordPageVersion } from "./broadcasts";
import { cachedAccountEntitlements } from "./billing/entitlements";
import type { ServerTiming } from "./server-timing";
import { DEFAULT_VERSION_RETENTION } from "./billing/plans";

function scanContent(body: ArrayBuffer): number {
  const text = new TextDecoder().decode(body.slice(0, 1024 * 1024));
  let score = 0;
  if (/<input\b[^>]*type\s*=\s*["']?password\b/i.test(text)) score += 5;
  if (/<form\b[^>]*action\s*=\s*["']?https?:\/\//i.test(text)) score += 4;
  if (/(?:github|google|microsoft|paypal|bank|openai)[\s\S]{0,100}(?:sign\s*in|log\s*in|password|verify\s+account)/i.test(text)) score += 4;
  if (/(?:coinhive|cryptonight|cryptominer|stratum\+tcp)/i.test(text)) score += 5;
  return score;
}

export interface VersionFile {
  path: string;
  hash: string;
  type: string;
  size: number;
}

export interface Pointers {
  current: number | null;
  latest: number | null;
}

export function pointers(t: Tendril): Pointers {
  const z = (n: number) => (n > 0 ? n : null);
  return { current: z(t.db.get("current", 0)), latest: z(t.db.get("latest", 0)) };
}

export function fileKey(t: Tendril, hash: string): string {
  return `t/${t.tid}/files/${hash}`;
}

/** Serialize external storage effects for one content hash, across writers and GC. */
async function contentOperation<T>(t: Tendril, hash: string, operation: () => Promise<T>): Promise<T> {
  const previous = t.contentOperations.get(hash) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  t.contentOperations.set(hash, current);
  try { return await current; }
  finally { if (t.contentOperations.get(hash) === current) t.contentOperations.delete(hash); }
}

/** Called in the transaction that creates a durable reference to content. */
export function assertStoredContent(t: Tendril, files: Iterable<Pick<VersionFile, 'hash' | 'size'>>): void {
  for (const file of files) {
    const stored = t.db.one<{ size: number; status: string }>('SELECT size,status FROM stored_files WHERE hash=?', file.hash);
    if (!stored || stored.status !== 'ready' || stored.size !== file.size)
      throw new HttpError(409, 'content_unavailable', 'File content changed during preparation; upload the publication again');
  }
}

/** Reserve deletion synchronously; references cannot be added while R2 is awaited. Returns freed bytes. */
export async function deleteUnreferencedContent(t: Tendril, hash: string, olderThan?: number): Promise<number> {
  return contentOperation(t, hash, async () => {
    const file = t.transaction(() => {
      const stored = t.db.one<{ size: number; created_at: number; status: string }>(
        'SELECT size,created_at,status FROM stored_files WHERE hash=?',
        hash,
      );
      if (!stored || stored.status !== 'ready' || (olderThan !== undefined && stored.created_at >= olderThan)) return null;
      if (t.db.one('SELECT 1 AS present FROM version_files WHERE hash=? LIMIT 1', hash)) return null;
      t.db.run("UPDATE stored_files SET status='deleting' WHERE hash=?", hash);
      return stored;
    });
    if (!file) return 0;
    // On failure the reservation remains. Another upload or a later GC pass can
    // recover it without allowing a publication to refer to uncertain bytes.
    await t.env.FILES.delete(fileKey(t, hash));
    t.db.run("DELETE FROM stored_files WHERE hash=? AND status='deleting'", hash);
    await t.releaseGlobalBytes(file.size);
    return file.size;
  });
}

/**
 * Evict the oldest non-current host publication version and immediately garbage-collect
 * any content-addressed blobs that are no longer referenced. Never touches `servedVersion(t)`.
 */
export async function pruneOldestNonCurrentVersion(t: Tendril): Promise<{ prunedVersion: number | null; freedBytes: number }> {
  const current = servedVersion(t);
  const pruned = t.transaction(() => {
    const oldest = t.db.one<{ version: number }>(
      "SELECT version FROM versions WHERE version != ? ORDER BY version ASC LIMIT 1",
      current,
    );
    if (!oldest) return null;
    const hashes = t.db.all<{ hash: string }>(
      "SELECT DISTINCT hash FROM version_files WHERE version = ?",
      oldest.version,
    ).map((r) => r.hash);
    t.db.run("DELETE FROM version_files WHERE version = ?", oldest.version);
    t.db.run("DELETE FROM versions WHERE version = ?", oldest.version);
    t.db.run("DELETE FROM trusted_versions WHERE version = ?", oldest.version);
    return { version: oldest.version, hashes };
  });
  if (!pruned) return { prunedVersion: null, freedBytes: 0 };
  let freedBytes = 0;
  for (const hash of pruned.hashes) {
    freedBytes += await deleteUnreferencedContent(t, hash);
  }
  return { prunedVersion: pruned.version, freedBytes };
}

/** Stores the bytes content-addressed in R2 (skipped if already present), pruning oldest non-current versions under storage pressure. */
export async function storeContent(
  t: Tendril,
  body: ArrayBuffer,
  type: string,
  options?: { pageLimit?: number | null },
): Promise<{ hash: string; size: number }> {
  const hash = await sha256Hex(body);
  const pageLimit = options && 'pageLimit' in options
    ? options.pageLimit
    : await (() => {
        const owner = t.db.get<string | null>("owner_account", null);
        return owner
          ? cachedAccountEntitlements(t.env, owner).then(e => e.quotas.pageStorageBytes, () => undefined)
          : Promise.resolve(undefined);
      })();
  const resolvedPageLimit = pageLimit ?? undefined;

  for (;;) {
    try {
      await contentOperation(t, hash, async () => {
        const riskScore = scanContent(body);
        const reserved = t.reserveStoredFile(hash, body.byteLength, riskScore, resolvedPageLimit);
        let globalReserved = false;
        let uploaded = false;
        const key = fileKey(t, hash);
        try {
          if (reserved) {
            await t.reserveGlobalBytes(body.byteLength);
            globalReserved = true;
          }
          const head = await retryPublicationStorage(() => t.env.FILES.head(key));
          if (!head) {
            await retryPublicationStorage(() => t.env.FILES.put(key, body, { httpMetadata: { contentType: type } }));
            uploaded = true;
          }
          t.db.run("UPDATE stored_files SET status='ready' WHERE hash=?", hash);
        } catch (err) {
          if (reserved) {
            t.db.run("DELETE FROM stored_files WHERE hash = ?", hash);
            if (uploaded) { try { await t.env.FILES.delete(key); } catch { /* orphan sweep can retry */ } }
            if (globalReserved) await t.releaseGlobalBytes(body.byteLength);
          }
          throw err;
        }
      });
      return { hash, size: body.byteLength };
    } catch (err) {
      if (err instanceof HttpError && err.status === 413 && (err.code === "quota" || err.code === "quota_exceeded")) {
        const { prunedVersion } = await pruneOldestNonCurrentVersion(t);
        if (prunedVersion !== null) continue;
      }
      throw err;
    }
  }
}

async function retryPublicationStorage<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (!/\(10001\)\s*$/.test(String(error))) throw error;
      if (attempt === 3) throw new HttpError(503, 'storage_unavailable', 'File storage is temporarily unavailable. Retry the same publication.');
      await new Promise(resolve => setTimeout(resolve, 100 * 2 ** attempt));
    }
  }
}

export function versionFiles(t: Tendril, version: number): VersionFile[] {
  return t.db.all<VersionFile>("SELECT path, hash, type, size FROM version_files WHERE version = ? ORDER BY path", version);
}

export function versionFile(t: Tendril, version: number, path: string): VersionFile | null {
  return publicationIndex(t, version)?.files.get(path) ?? null;
}

interface PublicationIndex {
  riskScore: number;
  entry: string;
  runtime: { id: string; version: string; features: PublicationManifest["runtime"]["features"] };
  files: ReadonlyMap<string, VersionFile>;
  assets: PublicationManifest["assets"];
}

/**
 * One retained version's row and file map, read once per live object. Versions
 * and their file lists are immutable once committed; pruning deletes rows, which
 * discards this memo through its declared table dependencies.
 */
function publicationIndex(t: Tendril, version: number): PublicationIndex | null {
  if (!(version > 0)) return null;
  return t.db.cached(`files:publication:${version}`, () => {
    const row = t.db.one<{ risk_score: number; entry: string; runtime_id: string; runtime_version: string; runtime_features: string }>(
      "SELECT risk_score, entry, runtime_id, runtime_version, runtime_features FROM versions WHERE version = ?", version);
    if (!row) return null;
    const list = versionFiles(t, version);
    return Object.freeze({
      riskScore: row.risk_score ?? 0,
      entry: row.entry ?? "index.html",
      runtime: Object.freeze({ id: row.runtime_id, version: row.runtime_version, features: JSON.parse(row.runtime_features) }),
      files: new Map(list.map(file => [file.path, Object.freeze(file)])),
      assets: Object.freeze(list.map(file => Object.freeze({ path: file.path, sha256: file.hash, type: file.type, size: file.size }))) as PublicationManifest["assets"],
    });
  }, ["versions", "version_files"]);
}

/** Creates version latest+1 from a complete signed file map and selects it atomically. */
export async function createVersion(t: Tendril, files: Map<string, VersionFile>, message: string | null, by: string | null,
  options: { entry: string; beforeCommit: () => Promise<void>; commit: (version: number) => void }): Promise<number> {
  const entry = options.entry;
  if (!files.has(entry) || !isHtmlType(files.get(entry)!.type)) throw new HttpError(400, "bad_publication", "The publication requires its declared HTML entry");
  if (files.size > MAX_FILES_PER_VERSION) throw new HttpError(413, "too_many_files", `At most ${MAX_FILES_PER_VERSION} files per version`);
  let riskScore = 0;
  const riskFlags: string[] = [];
  for (const file of files.values()) {
    const scan = t.db.one<{ risk_score: number }>("SELECT risk_score FROM stored_files WHERE hash = ?", file.hash);
    if (scan) riskScore += scan.risk_score;
    if (/\.(?:exe|dll|apk|dmg|msi|bat|scr)$/i.test(file.path) && file.size > 256 * 1024) {
      riskScore += 5;
      riskFlags.push("large_executable");
    }
  }
  if (riskScore >= 5) riskFlags.push("static_screening");
  const owner = t.db.get<string | null>("owner_account", null);
  const [account, ent] = await Promise.all([
    owner ? t.env.ACCOUNTS.prepare("SELECT created_at FROM accounts WHERE id = ?").bind(owner).first<{ created_at: number }>() : Promise.resolve(null),
    owner ? cachedAccountEntitlements(t.env, owner).catch(() => null) : Promise.resolve(null),
  ]);
  const retentionCap = ent?.quotas.versionRetention ?? DEFAULT_VERSION_RETENTION;
  const shouldHold = riskScore >= 5 && !!account && account.created_at > t.now() - 7 * 24 * 60 * 60_000;
  if (shouldHold) {
    await t.hold("High static screening score on young account");
  }
  await options.beforeCommit();
  // Extract authored <link rel="icon"> and <meta name="theme-color"> from entry HTML once at publish time
  // so manifest.webmanifest, /dashboard, and icon rasterization share one canonical SSOT.
  let authoredBranding: ReturnType<typeof extractAuthoredBranding> | null = null;
  try {
    const entryFile = files.get(entry);
    if (entryFile && t.env.FILES) {
      const obj = await t.env.FILES.get(fileKey(t, entryFile.hash), { range: { offset: 0, length: 65536 } });
      if (obj) {
        const htmlHead = await obj.text();
        authoredBranding = extractAuthoredBranding(htmlHead, files, allPageBases(t));
      }
    }
  } catch { /* non-fatal; falls back to meta/generated icon */ }
  const publishedAt = t.now();
  const prunedHashes = new Set<string>();
  const n = t.transaction(() => {
    assertStoredContent(t, files.values());
    const next = t.db.get<number>("latest", 0) + 1;
    t.db.run("INSERT INTO versions (version, created_at, runtime_id, runtime_version, runtime_features, message, by, risk_score, risk_flags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      next, publishedAt, runtimeRelease.id, runtimeRelease.version, JSON.stringify(runtimeRelease.features), message, by, riskScore, JSON.stringify(riskFlags));
    for (const f of files.values()) {
      t.db.run("INSERT INTO version_files (version, path, hash, type, size) VALUES (?, ?, ?, ?, ?)", next, f.path, f.hash, f.type, f.size);

    }
    t.db.run("UPDATE versions SET entry=? WHERE version=?", entry, next);
    t.db.set("latest", next);
    t.db.set("current", next);
    if (authoredBranding) {
      if (authoredBranding.icon) t.db.set("authored_icon", authoredBranding.icon);
      else t.db.del("authored_icon");
      if (authoredBranding.themeColor) t.db.set("authored_theme_color", authoredBranding.themeColor);
      else t.db.del("authored_theme_color");
    }
    options.commit(next);
    addActivity(t, {
      kind: "version",
      summary: `Version ${next} pushed (${files.size} file${files.size === 1 ? "" : "s"})${message ? `: ${message}` : ""}`,
      by,
      source: "server",
    });
    if (retentionCap !== null && retentionCap >= 1) {
      const stale = t.db.all<{ version: number }>(
        "SELECT version FROM versions WHERE version != ? ORDER BY version DESC LIMIT -1 OFFSET ?",
        next,
        Math.max(0, retentionCap - 1),
      );
      for (const old of stale) {
        for (const row of t.db.all<{ hash: string }>("SELECT DISTINCT hash FROM version_files WHERE version = ?", old.version)) {
          prunedHashes.add(row.hash);
        }
        t.db.run("DELETE FROM version_files WHERE version = ?", old.version);
        t.db.run("DELETE FROM versions WHERE version = ?", old.version);
        t.db.run("DELETE FROM trusted_versions WHERE version = ?", old.version);
      }
    }
    return next;
  });
  // Immediately garbage-collect blobs that belonged only to pruned versions so
  // old JS bundles never linger in R2 or eat into account/page storage quotas.
  for (const hash of prunedHashes) {
    await deleteUnreferencedContent(t, hash).catch(() => {});
  }
  t.afterCommit(() => recordPageVersion(t.env, t.tid, n, runtimeRelease.id, runtimeRelease.version, publishedAt));
  return n;
}

/** Only a verified signed publication transaction selects the current code version. */
export function servedVersion(t: Tendril): number { return t.db.get<number>('current', 0); }

export function listVersions(t: Tendril) {
  const rows = t.db.all(
    "SELECT v.version, v.created_at, v.message, v.by, (SELECT COUNT(*) FROM version_files f WHERE f.version = v.version) AS files FROM versions v ORDER BY v.version DESC",
  );
  return rows.map((r) => {
    const out: Record<string, unknown> = { version: r.version, created_at: r.created_at, message: r.message ?? null, files: r.files };
    if (r.by) out.by = r.by;
    return out;
  });
}

/** The actual immutable URLs used by this publication, including its runtime. */
export function publicationManifest(t: Tendril, version: number, base: string): PublicationManifest {
  if (version > 0) {
    const index = publicationIndex(t, version);
    if (!index) throw new HttpError(404, "publication_not_found", "The publication is no longer retained");
    return { id: String(version), base: `${base}_publications/${version}/`, entry: index.entry, assets: index.assets as PublicationManifest["assets"],
      runtime: { ...index.runtime, base: `/_tendril/runtime/${index.runtime.id}/` } };
  }
  return { id: "0", base, entry: "index.html", assets: [],
    runtime: { id: runtimeRelease.id, version: runtimeRelease.version, features: runtimeRelease.features as PublicationManifest["runtime"]["features"], base: `/_tendril/runtime/${runtimeRelease.id}/` } };
}

/** Injected documents keyed by their complete input tag; bounded per live object. */
const injectedHtml = new WeakMap<Tendril, Map<string, string>>();
const MAX_INJECTED_DOCUMENTS = 8;
const MAX_INJECTED_BYTES = 2 * 1024 * 1024;

function rememberInjected(t: Tendril, tag: string, html: string): void {
  if (html.length > MAX_INJECTED_BYTES) return;
  let map = injectedHtml.get(t);
  if (!map) injectedHtml.set(t, map = new Map());
  if (!map.has(tag) && map.size >= MAX_INJECTED_DOCUMENTS) map.delete(map.keys().next().value!);
  map.set(tag, html);
}

/** Serve exact published bytes and their pinned runtime. */
export async function servePageFile(t: Tendril, req: Request, base: string, rest: string,
  role: "owner" | "guest" | "display", accountId: string | null, linkId: string | null = null, timing?: ServerTiming): Promise<Response> {
  const application = selectedApplication(t);
  // A display link has no peer-introduction permission. Application capabilities
  // remain independently authenticated by Chronolog after connection setup.
  const introductions = () => role !== "display" ? peerBootstrap(t) : undefined;
  const pinned = /^_publications\/([1-9][0-9]*)\/(.*)$/.exec(rest);
  let version = pinned ? Number(pinned[1]) : servedVersion(t);
  const index = Number.isSafeInteger(version) ? publicationIndex(t, version) : null;
  if (pinned) {
    if (!index) throw new HttpError(404, "publication_not_found", "The publication is no longer retained");
    rest = pinned[2];
  }
  const risk = index?.riskScore ?? 0;
  if (risk >= 5 && role !== "owner") {
    throw new HttpError(403, 'publication_restricted', 'This publication requires owner review');
  }
  if (risk >= 5 && role === "owner" && accountId &&
    !t.db.one("SELECT 1 AS x FROM trusted_versions WHERE account_id = ? AND version = ?", accountId, version)) {
    const html = renderShell({
      title: "Review this version",
      brand: brandMark("/_tendril/brand/", base),
      nav: `<a class="nav-link" href="${base}_tendril/manage">Page settings</a>`,
      footer: "",
      themeToggle: false,
      body: `<section class="card danger"><span class="eyebrow" style="color:var(--danger)">${icon("shield")} Security review</span><h1>Review this page before opening it</h1><p class="lead">This version asks for passwords, sends data elsewhere, or contains another risky pattern. Tendriller never asks for passwords. Continue only if you trust the agent that made it.</p><form method="post" action="${base}_tendril/trust-version"><input type="hidden" name="version" value="${version}"><div class="actions"><button type="submit">Continue to page</button><a class="button secondary" href="${base}_tendril/manage">Page settings</a></div></form></section>`,
    });
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'" } });
  }

  const defaultEntry = index?.entry ?? "index.html";
  let path = rest === "" ? defaultEntry : rest;
  let file = index?.files.get(path) ?? null;
  if (!file && index && (rest === "" || rest.endsWith("/"))) {
    path = (rest === "" ? "" : rest) + "index.html";
    file = index.files.get(path) ?? null;
  }
  const headers = new Headers({ "Cache-Control": pinned ? "private, max-age=31536000, immutable" : "private, no-cache", "X-Tendril-Version": String(version), "X-Tendril-Publication": String(version), "X-Content-Type-Options": "nosniff" });
  const branding = () => ({ name: t.db.get("name", "Tendril"), shortName: t.db.get<string | null>("short_name", null),
    themeColor: t.db.get<string | null>("theme_color", null), icon: t.db.get<string | null>("icon", null) });

  const linkView = linkId ? t.db.get<string | null>(`link_view:${linkId}`, null) : null;

  if (!file) {
    if (rest === "") {
      headers.set("Content-Type", "text/html; charset=utf-8");
      headers.delete("X-Tendril-Publication");
      headers.set("Cache-Control", "no-store");
      const html = injectRuntime(holdingPage(t.db.get("name", "Tendril")), { id: t.tid, base, version, application, peerBootstrap: introductions(), documentPath: null, features: t.features(), publication: null, viewerRole: role, ...(linkView ? { defaultView: linkView } : {}), branding: branding() });
      return new Response(html, { headers });
    }
    return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" } });
  }

  headers.set("Content-Type", file.type);
  if (!isHtmlType(file.type)) {
    headers.set("ETag", `"${file.hash}"`);
    if (etagMatches(req.headers.get("If-None-Match"), headers.get("ETag")!)) return new Response(null, { status: 304, headers });
    // Admission, publication retention, risk review, and file membership have all
    // been checked. Cache only verified source bytes.
    const obj = await readStored(t, file, req, timing);
    if (!obj) return new Response("File content missing", { status: 500 });
    headers.set("Content-Length", String(file.size));
    return assetResponse(req, new Response(obj.body, { headers }));
  }

  // The authored publication is immutable; its injected resident addresses are
  // current host configuration. Reloading may refresh them without changing
  // the publication or adding a discovery poll to a running application.
  // Every injected input is metadata, so a revalidation is answered before any
  // byte read, and an unchanged document is rendered once per live object.
  headers.set("Cache-Control", "private, no-cache");
  const metaStart = Date.now();
  const [broadcastKeys, bcSummary, appleIcon] = await Promise.all([
    publicBroadcastKeys(t.env).then(r => r.keys).catch(() => []),
    broadcastSummary(t.env).catch(() => ({ latestSeq: 0, activeCount: 0, criticalCount: 0 })),
    appleTouchIcon(t, base, new URL(base, req.url).href, { background: true }).catch(() => null),
  ]);
  timing?.add("meta", Date.now() - metaStart);
  const pubManifest = publicationManifest(t, version, base);
  const rasterIcon = rasterFavicon(t, base);
  const brand = branding();
  const rasterReq = iconRasterRequest(t, role);
  const peers = introductions();
  const features = t.features();
  const config = {
    id: t.tid, base, version, application, peerBootstrap: peers, documentPath: path, features, publication: pubManifest,
    broadcastKeys,
    ...(bcSummary.activeCount > 0 ? { broadcastLatestSeq: bcSummary.latestSeq } : {}),
    viewerRole: role,
    ...(linkView ? { defaultView: linkView } : {}),
    branding: { ...brand, appleIcon, rasterIcon },
    iconRaster: rasterReq,
  };
  // The tag covers the authored bytes (by hash) and every injected value.
  const htmlTag = `W/"${(await sha256Hex(`${file.hash}|${JSON.stringify(config)}`)).slice(0, 24)}"`;
  headers.set("ETag", htmlTag);
  headers.set("Link", `<${pubManifest.runtime.base}tendril.js>; rel=preload; as=script`);
  if (etagMatches(req.headers.get("If-None-Match"), htmlTag)) return new Response(null, { status: 304, headers });
  const remembered = injectedHtml.get(t)?.get(htmlTag);
  if (remembered !== undefined) {
    timing?.add("html", 0, "memo");
    return new Response(req.method === "HEAD" ? null : remembered, { headers });
  }
  const obj = await readStored(t, file, req, timing);
  if (!obj) return new Response("File content missing", { status: 500 });
  if (req.method === 'HEAD') return new Response(null, { headers });
  const rawHtml = await obj.text();
  const html = injectRuntime(rawHtml, config);
  rememberInjected(t, htmlTag, html);
  return new Response(html, { headers });
}

async function readStored(t: Tendril, file: VersionFile, req: Request, timing?: ServerTiming) {
  const start = Date.now();
  try {
    return await immutableObject(t.env, fileKey(t, file.hash), {
      head: req.method === 'HEAD', sha256: file.hash, expectedBytes: file.size, context: t.ctx,
    });
  } finally { timing?.add("bytes", Date.now() - start); }
}

export function filesResponse(t: Tendril, version: number) {
  return json({ version: version > 0 ? version : null, files: versionFiles(t, version) });
}
