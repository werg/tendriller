// Files, versions, health and serving (PROTOCOL sections 4 and 5).
import type { Tendril } from "./tendril";
import { addActivity } from "./activity";
import { addEvent } from "./events";
import { HttpError, json } from "./http";
import { newBlobId, sha256Hex } from "./ids";
import runtimeRelease from "./runtime-release.json";
import { holdingPage, injectRuntime, type PublicationManifest } from "./inject";
import { MAX_FILES_PER_VERSION } from "./limits";
import { isHtmlType } from "./mime";

function scanContent(body: ArrayBuffer): number {
  const text = new TextDecoder().decode(body.slice(0, 1024 * 1024));
  let score = 0;
  if (/<input\b[^>]*type\s*=\s*["']?password\b/i.test(text)) score += 5;
  if (/<form\b[^>]*action\s*=\s*["']?https?:\/\//i.test(text)) score += 4;
  if (/(?:github|google|microsoft|paypal|bank|openai)[\s\S]{0,100}(?:sign\s*in|log\s*in|password|verify\s+account)/i.test(text)) score += 4;
  if (/(?:coinhive|cryptonight|cryptominer|stratum\+tcp)/i.test(text)) score += 5;
  return score;
}

export type VersionStatus = "pending" | "healthy" | "failed";

export interface VersionFile {
  path: string;
  hash: string;
  type: string;
  size: number;
  blob_id?: string;
}

export interface Pointers {
  current: number | null;
  latest: number | null;
  healthy: number | null;
}

export function pointers(t: Tendril): Pointers {
  const z = (n: number) => (n > 0 ? n : null);
  return { current: z(t.db.get("current", 0)), latest: z(t.db.get("latest", 0)), healthy: z(t.db.get("healthy", 0)) };
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

/** Reserve deletion synchronously; references cannot be added while R2 is awaited. */
export async function deleteUnreferencedContent(t: Tendril, hash: string, olderThan?: number): Promise<void> {
  await contentOperation(t, hash, async () => {
    const file = t.transaction(() => {
      const stored = t.db.one<{ size: number; created_at: number }>('SELECT size,created_at FROM stored_files WHERE hash=?', hash);
      if (!stored || (olderThan !== undefined && stored.created_at >= olderThan)) return null;
      if (t.db.one('SELECT 1 AS present FROM version_files WHERE hash=? LIMIT 1', hash)) return null;
      if (t.db.one('SELECT 1 AS present FROM blobs WHERE sha256=? LIMIT 1', hash)) return null;
      if (t.db.one('SELECT 1 AS present FROM file_refs f JOIN blobs b ON b.id=f.blob_id WHERE b.sha256=? LIMIT 1', hash)) return null;
      const staged = t.db.get<{ files: { hash: string }[] } | null>('staged_bundle', null);
      if (staged?.files.some(file => file.hash === hash)) return null;
      t.db.run("UPDATE stored_files SET status='deleting' WHERE hash=?", hash);
      return stored;
    });
    if (!file) return;
    // On failure the reservation remains. Another upload or a later GC pass can
    // recover it without allowing a publication to refer to uncertain bytes.
    await t.env.FILES.delete(fileKey(t, hash));
    t.db.run("DELETE FROM stored_files WHERE hash=? AND status='deleting'", hash);
    await t.releaseGlobalBytes(file.size);
  });
}

/** Stores the bytes content-addressed in R2 (skipped if already present). */
export async function storeContent(t: Tendril, body: ArrayBuffer, type: string,
  retain?: (hash: string) => void): Promise<{ hash: string; size: number }> {
  const hash = await sha256Hex(body);
  await contentOperation(t, hash, async () => {
    const riskScore = scanContent(body);
    const reserved = t.reserveStoredFile(hash, body.byteLength, riskScore);
    let globalReserved = false;
    let uploaded = false;
    const key = fileKey(t, hash);
    try {
      if (reserved) {
        await t.reserveGlobalBytes(body.byteLength);
        globalReserved = true;
      }
      const head = await t.env.FILES.head(key);
      if (!head) { await t.env.FILES.put(key, body, { httpMetadata: { contentType: type } }); uploaded = true; }
      t.transaction(() => {
        t.db.run("UPDATE stored_files SET status='ready' WHERE hash=?", hash);
        retain?.(hash);
      });
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
}

export function versionFiles(t: Tendril, version: number): VersionFile[] {
  return t.db.all<VersionFile>("SELECT path, hash, type, size FROM version_files WHERE version = ? ORDER BY path", version);
}

export function versionFile(t: Tendril, version: number, path: string): VersionFile | null {
  return t.db.one<VersionFile>("SELECT path, hash, type, size FROM version_files WHERE version = ? AND path = ?", version, path);
}

export function versionStatus(t: Tendril, version: number): VersionStatus | null {
  return t.db.one<{ status: VersionStatus }>("SELECT status FROM versions WHERE version = ?", version)?.status ?? null;
}

/** Creates version latest+1 from a full file map; makes it current; reloads pages. */
export async function createVersion(t: Tendril, files: Map<string, VersionFile>, message: string | null, by: string | null,
  options: { entry?: string; expectedHeadRevision?: number; commit?: (version: number) => void; beforeReload?: () => void } = {}): Promise<number> {
  const entry = options.entry ?? "index.html";
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
  const account = owner ? await t.env.ACCOUNTS.prepare("SELECT created_at FROM accounts WHERE id = ?").bind(owner).first<{ created_at: number }>() : null;
  const shouldHold = riskScore >= 5 && !!account && account.created_at > t.now() - 7 * 24 * 60 * 60_000;
  if (shouldHold) {
    await t.hold("High static screening score on young account");
  }
  const n = t.transaction(() => {
    assertStoredContent(t, files.values());
    if (options.expectedHeadRevision !== undefined && t.db.get<number>("publication_head_revision", 0) !== options.expectedHeadRevision)
      throw new HttpError(409, "publication_conflict", "The publication head changed; inspect it before retrying",
        { head_revision: t.db.get<number>("publication_head_revision", 0) });
    const next = t.db.get<number>("latest", 0) + 1;
    t.db.run("INSERT INTO versions (version, created_at, status, runtime_id, runtime_version, runtime_features, message, by, risk_score, risk_flags) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)",
      next, t.now(), runtimeRelease.id, runtimeRelease.version, JSON.stringify(runtimeRelease.features), message, by, riskScore, JSON.stringify(riskFlags));
    for (const f of files.values()) {
      t.db.run("INSERT INTO version_files (version, path, hash, type, size) VALUES (?, ?, ?, ?, ?)", next, f.path, f.hash, f.type, f.size);
      const blob = f.blob_id ? t.db.one<{ id: string; sha256: string; size: number }>("SELECT id,sha256,size FROM blobs WHERE id=?", f.blob_id) : null;
      if (f.blob_id && (!blob || blob.sha256 !== f.hash || blob.size !== f.size))
        throw new HttpError(409, "blob_unavailable", "Publication content no longer matches its immutable blob");
      const blobId = blob?.id ?? newBlobId();
      if (!blob) t.db.run("INSERT INTO blobs(id,sha256,type,size,name,ts,device,source,pinned) VALUES(?,?,?,?,?,?,NULL,'agent',0)",
        blobId, f.hash, f.type, f.size, f.path, t.now());
      t.db.run("INSERT INTO publication_blobs(version,path,blob_id) VALUES(?,?,?)", next, f.path, blobId);
    }
    t.db.run("UPDATE versions SET entry=? WHERE version=?", entry, next);
    t.db.set("latest", next);
    t.db.set("current", next);
    t.db.set("publication_head_revision", t.db.get<number>("publication_head_revision", 0) + 1);
    options.commit?.(next);
    addActivity(t, {
      kind: "version",
      summary: `Version ${next} pushed (${files.size} file${files.size === 1 ? "" : "s"})${message ? `: ${message}` : ""}`,
      by,
      source: "server",
    });
    return next;
  });
  options.beforeReload?.();
  t.broadcast({ t: "reload", version: n });
  return n;
}

/** Serving rule: current unless failed, then healthy; else current; 0 = nothing uploaded. */
export function servedVersion(t: Tendril): number {
  const current = t.db.get<number>("current", 0);
  if (current > 0 && versionStatus(t, current) !== "failed") return current;
  const healthy = t.db.get<number>("healthy", 0);
  if (healthy > 0) return healthy;
  return current;
}

export function reportHealth(t: Tendril, version: number, ok: boolean, errors: unknown[], device: string | null): void {
  if (versionStatus(t, version) !== "pending") return;
  if (ok) {
    t.db.run("UPDATE versions SET status = 'healthy' WHERE version = ?", version);
    if (version > t.db.get<number>("healthy", 0)) t.db.set("healthy", version);
    addEvent(t, { type: "version_healthy", data: { version }, device, wake: false });
  } else {
    failVersion(t, version, errors);
  }
}

export function failVersion(t: Tendril, version: number, errors: unknown[]): void {
  const errs = errors.slice(0, 20).map((e) => (typeof e === "string" ? e.slice(0, 4000) : e));
  t.db.run("UPDATE versions SET status = 'failed', errors = ? WHERE version = ?", JSON.stringify(errs), version);
  let rolledBackTo: number | null = null;
  const healthy = t.db.get<number>("healthy", 0);
  if (t.db.get<number>("current", 0) === version && healthy > 0) {
    t.db.set("current", healthy);
    t.db.set("publication_head_revision", t.db.get<number>("publication_head_revision", 0) + 1);
    rolledBackTo = healthy;
    t.broadcast({ t: "reload", version: healthy });
  }
  addActivity(t, {
    kind: "version_failed",
    summary: `Version ${version} failed its health check${rolledBackTo ? `; back on version ${rolledBackTo}` : ""}`,
  });
  const row = t.db.one<{ failed_event: number }>("SELECT failed_event FROM versions WHERE version = ?", version);
  if (row && !row.failed_event) {
    t.db.run("UPDATE versions SET failed_event = 1 WHERE version = ?", version);
    addEvent(t, { type: "version_failed", data: { version, errors: errs, rolled_back_to: rolledBackTo }, wake: true, cls: "page", force: true });
  }
}

/** Makes `target` (or the newest healthy version older than current) current. */
export function rollback(t: Tendril, target: number | null | undefined, by: string | null, device: string | null): number {
  const current = t.db.get<number>("current", 0);
  let v: number;
  if (target !== undefined && target !== null) {
    if (!Number.isInteger(target) || !t.db.one("SELECT 1 AS x FROM versions WHERE version = ?", target)) {
      throw new HttpError(404, "not_found", `No version ${target}`);
    }
    v = target;
  } else {
    const row = t.db.one<{ version: number }>(
      "SELECT version FROM versions WHERE status = 'healthy' AND version < ? ORDER BY version DESC LIMIT 1",
      current,
    );
    if (!row) throw new HttpError(409, "no_healthy_version", "There is no earlier healthy version to go back to");
    v = row.version;
  }
  t.db.set("current", v);
  t.db.set("publication_head_revision", t.db.get<number>("publication_head_revision", 0) + 1);
  addActivity(t, { kind: "rollback", summary: `Rolled back from version ${current} to ${v}`, by, device });
  t.broadcast({ t: "reload", version: v });
  return v;
}

export function listVersions(t: Tendril) {
  const rows = t.db.all(
    "SELECT v.version, v.created_at, v.status, v.message, v.errors, v.by, (SELECT COUNT(*) FROM version_files f WHERE f.version = v.version) AS files FROM versions v ORDER BY v.version DESC",
  );
  return rows.map((r) => {
    const out: Record<string, unknown> = { version: r.version, created_at: r.created_at, status: r.status, message: r.message ?? null, files: r.files };
    if (r.errors) out.errors = JSON.parse(r.errors);
    if (r.by) out.by = r.by;
    return out;
  });
}

/** The actual immutable URLs used by this publication, including its runtime. */
export function publicationManifest(t: Tendril, version: number, base: string, entry?: string): PublicationManifest {
  const release = version > 0
    ? t.db.one<{ runtime_id: string; runtime_version: string; runtime_features: string }>("SELECT runtime_id,runtime_version,runtime_features FROM versions WHERE version=?", version)
    : { runtime_id: runtimeRelease.id, runtime_version: runtimeRelease.version, runtime_features: JSON.stringify(runtimeRelease.features) };
  if (!release) throw new HttpError(404, "publication_not_found", "The publication is no longer retained");
  const defaultEntry = version > 0 ? t.db.one<{ entry: string }>("SELECT entry FROM versions WHERE version=?", version)?.entry ?? "index.html" : "index.html";
  return { id: String(version), base: version > 0 ? `${base}_publications/${version}/` : base, entry: entry ?? defaultEntry,
    assets: versionFiles(t, version).map(file => ({ path: file.path, sha256: file.hash, type: file.type, size: file.size })),
    runtime: { id: release.runtime_id, version: release.runtime_version, features: JSON.parse(release.runtime_features), base: `${base}_tendril/runtime/${release.runtime_id}/` } };
}

/** Keep an executing publication available during normal offline recovery. */
export function retainPublication(t: Tendril, device: string, version: number): void {
  if (version > 0 && t.db.one("SELECT 1 AS x FROM versions WHERE version=?", version))
    t.db.run("INSERT INTO publication_leases(device,version,expires_at) VALUES(?,?,?) ON CONFLICT(device,version) DO UPDATE SET expires_at=excluded.expires_at", device, version, t.now() + 30 * 86400_000);
}

/** Serves `P<rest>` for a page request. */
export async function servePageFile(t: Tendril, req: Request, base: string, rest: string,
  role: "owner" | "guest" | "display", accountId: string | null): Promise<Response> {
  const pinned = /^_publications\/([1-9][0-9]*)\/(.*)$/.exec(rest);
  let version = pinned ? Number(pinned[1]) : servedVersion(t);
  if (pinned) {
    if (!Number.isSafeInteger(version) || !t.db.one("SELECT 1 AS x FROM versions WHERE version=?", version))
      throw new HttpError(404, "publication_not_found", "The publication is no longer retained");
    rest = pinned[2];
  }
  const risk = version > 0 ? t.db.one<{ risk_score: number }>("SELECT risk_score FROM versions WHERE version = ?", version)?.risk_score ?? 0 : 0;
  if (risk >= 5 && role !== "owner") {
    if (pinned) throw new HttpError(403, "publication_restricted", "This publication requires owner review");
    version = t.db.one<{ version: number }>("SELECT MAX(version) AS version FROM versions WHERE risk_score < 5 AND status != 'failed' AND version <= ?", version)?.version ?? 0;
  }
  if (risk >= 5 && role === "owner" && accountId &&
    !t.db.one("SELECT 1 AS x FROM trusted_versions WHERE account_id = ? AND version = ?", accountId, version)) {
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Review this version · Tendriller</title><link rel="icon" href="${base}_tendril/brand/icon-64.png"><style>body{font:16px/1.6 system-ui,sans-serif;max-width:42rem;margin:2rem auto;padding:0 1.25rem}img{vertical-align:middle;margin-right:.5rem}button{padding:.7rem 1rem;background:#17654b;color:white;border:0;border-radius:.6rem;font:inherit}</style></head><body><main><p><img src="${base}_tendril/brand/icon-64.png" alt="" width="32" height="32">Tendriller</p>
      <h1>Review this page before opening it</h1><p>This version asks for passwords, sends data elsewhere, or contains another risky pattern. Tendriller never asks for passwords. Continue only if you trust the agent that made it.</p>
      <form method="post" action="${base}_tendril/trust-version"><input type="hidden" name="version" value="${version}"><button>Continue to page</button></form></main></body></html>`;
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'" } });
  }

  const defaultEntry = version > 0 ? t.db.one<{ entry: string }>("SELECT entry FROM versions WHERE version=?", version)?.entry ?? "index.html" : "index.html";
  let path = rest === "" ? defaultEntry : rest;
  let file = version > 0 ? versionFile(t, version, path) : null;
  if (!file && version > 0 && (rest === "" || rest.endsWith("/"))) {
    path = (rest === "" ? "" : rest) + "index.html";
    file = versionFile(t, version, path);
  }
  const headers = new Headers({ "Cache-Control": pinned ? "private, max-age=31536000, immutable" : "no-cache", "X-Tendril-Version": String(version), "X-Tendril-Publication": String(version), "X-Content-Type-Options": "nosniff" });

  if (!file) {
    if (rest === "") {
      headers.set("Content-Type", "text/html; charset=utf-8");
      headers.delete("X-Tendril-Publication");
      headers.set("Cache-Control", "no-store");
      const html = injectRuntime(holdingPage(t.db.get("name", "Tendril")), { id: t.tid, base, version, features: t.features(), publication: null });
      return new Response(html, { headers });
    }
    return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" } });
  }

  headers.set("Content-Type", file.type);
  if (!isHtmlType(file.type)) {
    headers.set("ETag", `"${file.hash}"`);
    if (req.headers.get("If-None-Match") === headers.get("ETag")) return new Response(null, { status: 304, headers });
  }
  const obj = await t.env.FILES.get(fileKey(t, file.hash));
  if (!obj) return new Response("File content missing", { status: 500 });

  if (isHtmlType(file.type)) {
    const html = injectRuntime(await obj.text(), { id: t.tid, base, version, features: t.features(), publication: publicationManifest(t, version, base, path) });
    return new Response(req.method === "HEAD" ? null : html, { headers });
  }
  headers.set("Content-Length", String(file.size));
  return new Response(req.method === "HEAD" ? null : obj.body, { headers });
}

export function filesResponse(t: Tendril, version: number) {
  return json({ version: version > 0 ? version : null, files: versionFiles(t, version) });
}
