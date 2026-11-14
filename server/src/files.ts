// Files, versions, health and serving (PROTOCOL sections 4 and 5).
import type { Tendril } from "./tendril";
import { addActivity } from "./activity";
import { addEvent } from "./events";
import { HttpError, json } from "./http";
import { sha256Hex } from "./ids";
import { holdingPage, injectRuntime } from "./inject";
import { HEALTH_TIMEOUT, MAX_FILES_PER_VERSION } from "./limits";
import { isHtmlType } from "./mime";

function scanContent(body: ArrayBuffer, type: string): { score: number; urls: string[] } {
  if (!/(text|javascript|json|xml|svg)/i.test(type)) return { score: 0, urls: [] };
  const text = new TextDecoder().decode(body.slice(0, 1024 * 1024));
  let score = 0;
  if (/<input\b[^>]*type\s*=\s*["']?password\b/i.test(text)) score += 5;
  if (/<form\b[^>]*action\s*=\s*["']?https?:\/\//i.test(text)) score += 4;
  if (/(?:github|google|microsoft|paypal|bank|openai)[\s\S]{0,100}(?:sign\s*in|log\s*in|password|verify\s+account)/i.test(text)) score += 4;
  if (/(?:coinhive|cryptonight|cryptominer|stratum\+tcp)/i.test(text)) score += 5;
  const urls = [...text.matchAll(/(?:href|src|action)\s*=\s*["'](https?:\/\/[^"'\s<>]+)|(?:fetch|WebSocket)\s*\(\s*["'](https?:\/\/[^"'\s<>]+)/gi)]
    .map(m => m[1] ?? m[2]).filter(Boolean);
  return { score, urls: [...new Set(urls)].slice(0, 50) };
}

async function webRisk(t: Tendril, url: string): Promise<boolean> {
  if (!t.env.WEB_RISK_API_KEY) throw new HttpError(503, "unavailable", "URL screening is not configured");
  const hash = await sha256Hex(url);
  const cached = t.db.one<{ unsafe: number }>("SELECT unsafe FROM web_risk_cache WHERE url_hash = ? AND expires_at > ?", hash, t.now());
  if (cached) return !!cached.unsafe;
  const target = new URL("https://webrisk.googleapis.com/v1/uris:search");
  target.searchParams.set("uri", url);
  for (const type of ["MALWARE", "SOCIAL_ENGINEERING", "UNWANTED_SOFTWARE"]) target.searchParams.append("threatTypes", type);
  target.searchParams.set("key", t.env.WEB_RISK_API_KEY);
  const response = await fetch(target);
  if (!response.ok) throw new HttpError(503, "unavailable", "URL screening is unavailable");
  const result = await response.json() as { threat?: { threatTypes?: string[]; expireTime?: string } };
  const unsafe = !!result.threat?.threatTypes?.length;
  const expires = result.threat?.expireTime ? Date.parse(result.threat.expireTime) : t.now() + 60 * 60_000;
  t.db.run("INSERT OR REPLACE INTO web_risk_cache (url_hash, unsafe, expires_at) VALUES (?, ?, ?)", hash, unsafe ? 1 : 0,
    Number.isFinite(expires) ? expires : t.now() + 60 * 60_000);
  return unsafe;
}

export type VersionStatus = "pending" | "healthy" | "failed";

export interface VersionFile {
  path: string;
  hash: string;
  type: string;
  size: number;
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

/** Stores the bytes content-addressed in R2 (skipped if already present). */
export async function storeContent(t: Tendril, body: ArrayBuffer, type: string): Promise<{ hash: string; size: number }> {
  const hash = await sha256Hex(body);
  const pending = t.pendingFileWrites.get(hash);
  if (pending) {
    await pending;
    return { hash, size: body.byteLength };
  }
  const job = (async () => {
    const risk = scanContent(body, type);
    const reserved = t.reserveStoredFile(hash, body.byteLength, risk.score, risk.urls);
    let globalReserved = false;
    try {
      if (reserved) {
        await t.reserveGlobalBytes(body.byteLength);
        globalReserved = true;
      }
      const key = fileKey(t, hash);
      const head = await t.env.FILES.head(key);
      if (!head) await t.env.FILES.put(key, body, { httpMetadata: { contentType: type } });
    } catch (err) {
      if (reserved) {
        t.db.run("DELETE FROM stored_files WHERE hash = ?", hash);
        if (globalReserved) await t.releaseGlobalBytes(body.byteLength);
      }
      throw err;
    }
  })();
  t.pendingFileWrites.set(hash, job);
  try { await job; } finally { t.pendingFileWrites.delete(hash); }
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
export async function createVersion(t: Tendril, files: Map<string, VersionFile>, message: string | null, by: string | null): Promise<number> {
  if (files.size > MAX_FILES_PER_VERSION) throw new HttpError(413, "too_many_files", `At most ${MAX_FILES_PER_VERSION} files per version`);
  let riskScore = 0;
  let webRiskMatch = false;
  const riskFlags: string[] = [];
  const urls = new Set<string>();
  for (const file of files.values()) {
    const scan = t.db.one<{ risk_score: number; risk_urls: string }>("SELECT risk_score, risk_urls FROM stored_files WHERE hash = ?", file.hash);
    if (scan) {
      riskScore += scan.risk_score;
      for (const url of JSON.parse(scan.risk_urls) as string[]) urls.add(url);
    }
    if (/\.(?:exe|dll|apk|dmg|msi|bat|scr)$/i.test(file.path) && file.size > 256 * 1024) {
      riskScore += 5;
      riskFlags.push("large_executable");
    }
  }
  if (urls.size > 50) throw new HttpError(413, "too_many_urls", "Version has too many external URLs");
  for (const url of urls) {
    if (await webRisk(t, url)) { webRiskMatch = true; riskFlags.push("web_risk_match"); }
  }
  if (riskScore >= 5) riskFlags.push("static_screening");
  if (webRiskMatch) riskScore = Math.max(riskScore, 10);
  const owner = t.db.get<string | null>("owner_account", null);
  const account = owner ? await t.env.ACCOUNTS.prepare("SELECT created_at FROM accounts WHERE id = ?").bind(owner).first<{ created_at: number }>() : null;
  const shouldHold = webRiskMatch || (riskScore >= 5 && !!account && account.created_at > t.now() - 7 * 24 * 60 * 60_000);
  if (shouldHold) {
    await t.hold(webRiskMatch ? "Web Risk match" : "High static screening score on young account");
  }
  const n = t.db.get<number>("latest", 0) + 1;
  t.db.run("INSERT INTO versions (version, created_at, status, message, by, risk_score, risk_flags) VALUES (?, ?, 'pending', ?, ?, ?, ?)",
    n, t.now(), message, by, riskScore, JSON.stringify(riskFlags));
  for (const f of files.values()) {
    t.db.run("INSERT INTO version_files (version, path, hash, type, size) VALUES (?, ?, ?, ?, ?)", n, f.path, f.hash, f.type, f.size);
  }
  t.db.set("latest", n);
  t.db.set("current", n);
  addActivity(t, {
    kind: "version",
    summary: `Version ${n} pushed (${files.size} file${files.size === 1 ? "" : "s"})${message ? `: ${message}` : ""}`,
    by,
    source: "server",
  });
  t.broadcast({ t: "reload", version: n });
  return n;
}

/** The latest version's file map, the base for incremental uploads. */
export function latestFileMap(t: Tendril): Map<string, VersionFile> {
  const latest = t.db.get<number>("latest", 0);
  const map = new Map<string, VersionFile>();
  if (latest > 0) for (const f of versionFiles(t, latest)) map.set(f.path, f);
  return map;
}

/** Serving rule: current unless failed, then healthy; else current; 0 = nothing uploaded. */
export function servedVersion(t: Tendril): number {
  const current = t.db.get<number>("current", 0);
  if (current > 0 && versionStatus(t, current) !== "failed") return current;
  const healthy = t.db.get<number>("healthy", 0);
  if (healthy > 0) return healthy;
  return current;
}

export function markServed(t: Tendril, version: number): void {
  const row = t.db.one<{ status: string; first_served_at: number | null }>("SELECT status, first_served_at FROM versions WHERE version = ?", version);
  if (!row || row.status !== "pending" || row.first_served_at !== null) return;
  t.db.run("UPDATE versions SET first_served_at = ? WHERE version = ?", t.now(), version);
  t.scheduleAlarm();
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

/** Fails pending versions that were served to a device but never reported within 15 s. */
export function checkHealthTimeouts(t: Tendril): void {
  const due = t.db.all<{ version: number }>(
    "SELECT version FROM versions WHERE status = 'pending' AND first_served_at IS NOT NULL AND first_served_at <= ?",
    t.now() - HEALTH_TIMEOUT,
  );
  for (const { version } of due) failVersion(t, version, ["No health report within 15 s of being served (the page may hang)"]);
}

export function nextHealthDeadline(t: Tendril): number | null {
  const row = t.db.one<{ m: number | null }>("SELECT MIN(first_served_at) AS m FROM versions WHERE status = 'pending' AND first_served_at IS NOT NULL");
  return row?.m != null ? row.m + HEALTH_TIMEOUT : null;
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
  if (versionStatus(t, v) === "pending") t.db.run("UPDATE versions SET first_served_at = NULL WHERE version = ?", v);
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

/** Serves `P<rest>` for a page request. */
export async function servePageFile(t: Tendril, req: Request, base: string, rest: string,
  role: "owner" | "guest" | "display", accountId: string | null): Promise<Response> {
  const url = new URL(req.url);
  const vq = Number(url.searchParams.get("v"));
  let version = servedVersion(t);
  if (rest !== "" && Number.isInteger(vq) && vq > 0 && t.db.one("SELECT 1 AS x FROM versions WHERE version = ?", vq)) version = vq;
  const risk = version > 0 ? t.db.one<{ risk_score: number }>("SELECT risk_score FROM versions WHERE version = ?", version)?.risk_score ?? 0 : 0;
  if (risk >= 5 && role !== "owner") {
    version = t.db.one<{ version: number }>("SELECT MAX(version) AS version FROM versions WHERE risk_score < 5 AND status != 'failed' AND version <= ?", version)?.version ?? 0;
  }
  if (risk >= 5 && role === "owner" && accountId &&
    !t.db.one("SELECT 1 AS x FROM trusted_versions WHERE account_id = ? AND version = ?", accountId, version)) {
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Review this version · Tendriller</title></head><body><main>
      <h1>Review this page before opening it</h1><p>This version asks for passwords, sends data elsewhere, or contains another risky pattern. Tendriller never asks for passwords. Continue only if you trust the agent that made it.</p>
      <form method="post" action="${base}_tendril/trust-version"><input type="hidden" name="version" value="${version}"><button>Continue to page</button></form></main></body></html>`;
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; form-action 'self'; base-uri 'none'" } });
  }

  let path = rest === "" ? "index.html" : rest;
  let file = version > 0 ? versionFile(t, version, path) : null;
  if (!file && version > 0 && (rest === "" || rest.endsWith("/"))) {
    path = (rest === "" ? "" : rest) + "index.html";
    file = versionFile(t, version, path);
  }
  const headers = new Headers({ "Cache-Control": "no-cache", "X-Tendril-Version": String(version) });

  if (!file) {
    if (rest === "") {
      headers.set("Content-Type", "text/html; charset=utf-8");
      const html = injectRuntime(holdingPage(t.db.get("name", "Tendril")), { id: t.tid, base, version, features: t.features() });
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
    const navigational = req.headers.get("Sec-Fetch-Mode") === "navigate" || req.headers.get("Sec-Fetch-Dest") === "document";
    if (navigational || t.connectedSockets().length > 0) markServed(t, version);
    const html = injectRuntime(await obj.text(), { id: t.tid, base, version, features: t.features() });
    return new Response(req.method === "HEAD" ? null : html, { headers });
  }
  headers.set("Content-Length", String(file.size));
  return new Response(req.method === "HEAD" ? null : obj.body, { headers });
}

export function filesResponse(t: Tendril, version: number) {
  return json({ version: version > 0 ? version : null, files: versionFiles(t, version) });
}
