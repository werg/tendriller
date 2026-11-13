// Files, versions, health and serving (PROTOCOL sections 4 and 5).
import type { Tendril } from "./tendril";
import { addActivity } from "./activity";
import { addEvent } from "./events";
import { HttpError, json } from "./http";
import { sha256Hex } from "./ids";
import { holdingPage, injectRuntime } from "./inject";
import { HEALTH_TIMEOUT, MAX_FILES_PER_VERSION } from "./limits";
import { isHtmlType } from "./mime";

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
  const key = fileKey(t, hash);
  const head = await t.env.FILES.head(key);
  if (!head) await t.env.FILES.put(key, body, { httpMetadata: { contentType: type } });
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
export function createVersion(t: Tendril, files: Map<string, VersionFile>, message: string | null, by: string | null): number {
  if (files.size > MAX_FILES_PER_VERSION) throw new HttpError(413, "too_many_files", `At most ${MAX_FILES_PER_VERSION} files per version`);
  const n = t.db.get<number>("latest", 0) + 1;
  t.db.run("INSERT INTO versions (version, created_at, status, message, by) VALUES (?, ?, 'pending', ?, ?)", n, t.now(), message, by);
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
export async function servePageFile(t: Tendril, req: Request, base: string, rest: string): Promise<Response> {
  const url = new URL(req.url);
  const vq = Number(url.searchParams.get("v"));
  let version = servedVersion(t);
  if (rest !== "" && Number.isInteger(vq) && vq > 0 && t.db.one("SELECT 1 AS x FROM versions WHERE version = ?", vq)) version = vq;

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
