/** Contract 3's agent-facing immutable transfers and shared file references. */
import { assertFilePath, assertPublicationEntries, assertValid, RESOURCE_LIMITS } from "../../contract/index.mjs";
import type { Tendril } from "./tendril";
import { blobInfo } from "./blob-retention";
import { createVersion, listVersions, pointers, rollback, storeContent, type VersionFile } from "./files";
import { HttpError, intParam, json, readBody, readJson } from "./http";
import { newBlobId, randomB32, sha256Hex } from "./ids";
import { mutate, replay } from "./scopes";

export const STORAGE_V3_ROUTE = /^(?:uploads|blobs|file-refs|publications)(?:\/|$)/;

interface UploadRow {
  id: string; actor: string; cid: string; sha256: string; size: number; type: string;
  name: string | null; blob_id: string; source: "agent" | "page"; device: string | null;
  phase: string; expires_at: number;
}
interface FileRow {
  path: string; revision: number; blob_id: string | null; name: string | null;
  type: string | null; scope: string | null; updated_at: number; by_actor: string;
}
const uploadId = () => `u_${randomB32(20)}`;
const validUploadId = /^u_[a-z2-7]{20}$/;
const validBlobId = /^b_[a-z2-7]{20}$/;

function session(t: Tendril, row: UploadRow) {
  const metadata = row.phase === "completed" ? blobMetadata(t, row.blob_id) : undefined;
  const stored = t.db.one<{ size: number }>("SELECT size FROM stored_files WHERE hash=? AND status='ready'", row.sha256);
  return { id: row.id, blob_id: row.blob_id, sha256: row.sha256, size: row.size,
    phase: row.phase, upload_required: row.phase !== "completed" && row.phase !== "received" &&
      stored?.size !== row.size,
    expires_at: row.expires_at, ...(metadata ? { blob: metadata } : {}) };
}

function activeSession(t: Tendril, id: string, actor: string): UploadRow {
  if (!validUploadId.test(id)) throw new HttpError(404, "not_found", "No such upload");
  const row = t.db.one<UploadRow>("SELECT * FROM upload_sessions WHERE id=? AND actor=?", id, actor);
  if (!row) throw new HttpError(404, "not_found", "No such upload");
  if (row.expires_at <= t.now() && row.phase !== "completed") throw new HttpError(410, "upload_expired", "Upload expired; start a new transfer");
  return row;
}

function blobMetadata(t: Tendril, id: string) {
  const info = blobInfo(t, id);
  return { id: info.id, sha256: info.sha256, size: info.size,
    type: info.type || "application/octet-stream", name: info.name || undefined,
    url: `_tendril/blobs/${id}`, created_at: info.ts,
    retention: { expires_at: info.retention.expires_at, reasons: [info.retention.reason] } };
}

function fileValue(row: FileRow) {
  return { path: row.path, revision: row.revision, blob_id: row.blob_id,
    ...(row.name ? { name: row.name } : {}), ...(row.type ? { type: row.type } : {}),
    scope: row.scope, updated_at: row.updated_at, by: row.by_actor };
}

function queryPath(url: URL): string {
  const raw = url.searchParams.get("path");
  if (raw === null) throw new HttpError(400, "bad_request", "A canonical path is required");
  return assertFilePath(raw);
}

function fileHead(t: Tendril, path: string): FileRow | null {
  return t.db.one<FileRow>("SELECT * FROM file_refs WHERE path=?", path);
}

function requireBlob(t: Tendril, id: string) {
  if (!validBlobId.test(id)) throw new HttpError(400, "bad_blob", "Invalid blob ID");
  const blob = t.db.one<{ sha256: string; size: number }>("SELECT sha256,size FROM blobs WHERE id=?", id);
  if (!blob || !t.db.one("SELECT 1 AS present FROM stored_files WHERE hash=? AND status='ready'", blob.sha256))
    throw new HttpError(409, "blob_unavailable", "The referenced blob is unavailable");
  return blob;
}

export async function handleStorageV3(t: Tendril, req: Request, url: URL, actor: string, rest: string,
  source: "agent" | "page" = "agent", device: string | null = null): Promise<Response> {
  const method = req.method === "HEAD" ? "GET" : req.method;
  if (rest === "uploads" && method === "POST") {
    const input = assertValid("uploadStart", await readJson(req, 4096));
    if (input.size > t.blobLimit()) throw new HttpError(413, "too_large", "Upload exceeds this page's effective transfer limit", { limit: t.blobLimit() });
    const row = t.transaction(() => {
      const prior = t.db.one<UploadRow>("SELECT * FROM upload_sessions WHERE actor=? AND cid=?", actor, input.cid);
      if (prior) {
        if (prior.sha256 !== input.sha256 || prior.size !== input.size || prior.type !== input.type ||
            prior.name !== (input.name ?? null)) throw new HttpError(409, "command_conflict", "Upload ID belongs to different bytes or metadata");
        return prior;
      }
      const active = t.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM upload_sessions WHERE phase!='completed' AND expires_at>?", t.now())?.n ?? 0;
      const own = t.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM upload_sessions WHERE actor=? AND phase!='completed' AND expires_at>?", actor, t.now())?.n ?? 0;
      if (active >= RESOURCE_LIMITS.upload_sessions_per_page || own >= RESOURCE_LIMITS.upload_sessions_per_actor)
        throw new HttpError(429, "upload_quota", "Too many unfinished uploads");
      const stored = t.db.one<{ size: number }>("SELECT size FROM stored_files WHERE hash=? AND status='ready'", input.sha256);
      if (stored && stored.size !== input.size)
        throw new HttpError(409, "blob_size_conflict", "The existing blob's stored size differs from the upload intent");
      const ready = !!stored;
      const next: UploadRow = { id: uploadId(), actor, cid: input.cid, sha256: input.sha256,
        size: input.size, type: input.type, name: input.name ?? null, blob_id: newBlobId(), source, device,
        phase: ready ? "ready" : "reserved", expires_at: t.now() + RESOURCE_LIMITS.upload_expiry_seconds * 1000 };
      t.db.run("INSERT INTO upload_sessions(id,actor,cid,sha256,size,type,name,blob_id,source,device,phase,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        next.id, next.actor, next.cid, next.sha256, next.size, next.type, next.name,
        next.blob_id, next.source, next.device, next.phase, next.expires_at);
      return next;
    });
    return json(session(t, row), 201);
  }
  const upload = /^uploads\/(u_[a-z2-7]{20})(?:\/(content|complete))?$/.exec(rest);
  if (upload) {
    const row = activeSession(t, upload[1], actor);
    if (!upload[2] && method === "GET") return json(session(t, row));
    if (!upload[2] && method === "DELETE") {
      if (row.phase !== "completed") t.db.run("UPDATE upload_sessions SET phase='aborted' WHERE id=?", row.id);
      return json({ ok: true });
    }
    if (upload[2] === "content" && method === "PUT") {
      if (row.phase === "completed" || row.phase === "aborted") throw new HttpError(409, "upload_closed", "Upload is closed");
      if (req.headers.get("Content-Type") !== "application/octet-stream") throw new HttpError(415, "content_type", "Upload content must be application/octet-stream");
      const body = await readBody(req, t.blobLimit());
      if (body.byteLength !== row.size || await sha256Hex(body) !== row.sha256)
        throw new HttpError(422, "digest_mismatch", "Content does not match reserved size and SHA-256");
      await storeContent(t, body, row.type, hash => {
        const current = t.db.one<UploadRow>("SELECT * FROM upload_sessions WHERE id=?", row.id);
        if (!current || current.phase === "aborted" || current.phase === "completed" || current.expires_at <= t.now())
          throw new HttpError(409, "upload_closed", "Upload closed while content was in transit");
        if (!t.db.one("SELECT 1 AS present FROM blobs WHERE id=?", row.blob_id))
          t.db.run("INSERT INTO blobs(id,sha256,type,size,name,ts,device,source,pinned) VALUES(?,?,?,?,?,?,?,?,0)",
            row.blob_id, hash, row.type, row.size, row.name, t.now(), row.device, row.source);
        t.db.run("UPDATE upload_sessions SET phase='received' WHERE id=? AND phase!='completed'", row.id);
      });
      return new Response(null, { status: 204 });
    }
    if (upload[2] === "complete" && method === "POST") {
      if (row.phase === "aborted") throw new HttpError(409, "upload_closed", "Upload was aborted");
      const blob = t.transaction(() => {
        const current = t.db.one<UploadRow>("SELECT * FROM upload_sessions WHERE id=?", row.id);
        if (!current || current.phase === "aborted" || (current.phase !== "completed" && current.expires_at <= t.now()))
          throw new HttpError(409, "upload_closed", "Upload is closed");
        if (!t.db.one("SELECT 1 AS present FROM stored_files WHERE hash=? AND size=? AND status='ready'", row.sha256, row.size))
          throw new HttpError(409, "upload_incomplete", "Upload content is not ready with the reserved size");
        if (!t.db.one("SELECT 1 AS present FROM blobs WHERE id=?", row.blob_id))
          t.db.run("INSERT INTO blobs(id,sha256,type,size,name,ts,device,source,pinned) VALUES(?,?,?,?,?,?,?,?,0)",
            row.blob_id, row.sha256, row.type, row.size, row.name, t.now(), row.device, row.source);
        t.db.run("UPDATE upload_sessions SET phase='completed' WHERE id=?", row.id);
        return blobMetadata(t, row.blob_id);
      });
      return json({ status: "completed", blob });
    }
  }
  if (rest === "blobs" && method === "GET") {
    const rows = t.db.all<{ id: string }>("SELECT id FROM blobs ORDER BY ts,id LIMIT 1000");
    return json({ blobs: rows.map(row => blobMetadata(t, row.id)), cursor: null });
  }
  const blob = /^blobs\/(b_[a-z2-7]{20})(?:\/(info|pin))?$/.exec(rest);
  if (blob) {
    if (blob[2] === "info" && method === "GET") return json(blobMetadata(t, blob[1]));
    if (!blob[2] && method === "GET") return t.getBlob(blob[1], req.headers.get("Range"), req.method === "HEAD");
    if (blob[2] === "pin" && method === "PUT") {
      const input = assertValid("blobPin", await readJson(req, 4096));
      const result = mutate(t, actor, input, { operations: ["blob.pin"] }, { id: blob[1], keep: input.keep }, () => {
        requireBlob(t, blob[1]);
        t.db.run("UPDATE blobs SET pinned=? WHERE id=?", input.keep ? 1 : 0, blob[1]);
        return blobMetadata(t, blob[1]);
      });
      return json(result);
    }
  }
  if (rest === "file-refs/snapshot" && method === "GET") {
    const rows = t.db.all<FileRow>("SELECT * FROM file_refs WHERE blob_id IS NOT NULL ORDER BY path LIMIT ?", RESOURCE_LIMITS.shared_files);
    const cursor = t.db.one<{ cursor: number }>("SELECT COALESCE(MAX(cursor),0) AS cursor FROM file_ref_changes")?.cursor ?? 0;
    return json({ files: rows.map(fileValue), cursor });
  }
  if (rest === "file-refs/history" && method === "GET") {
    const path = queryPath(url);
    const rows = t.db.all<FileRow>("SELECT path,revision,blob_id,name,type,scope,updated_at,by_actor FROM file_ref_changes WHERE path=? ORDER BY cursor DESC LIMIT ?",
      path, RESOURCE_LIMITS.file_history + 1);
    return json({ path, versions: rows.map(fileValue) });
  }
  if (rest === "file-refs" && method === "GET") {
    const row = fileHead(t, queryPath(url));
    if (!row || !row.blob_id) throw new HttpError(404, "not_found", "No such shared file");
    return json(fileValue(row));
  }
  if (rest === "file-refs" && (method === "PUT" || method === "DELETE")) {
    const input = assertValid(method === "PUT" ? "fileWrite" : "fileDelete", await readJson(req, 4096));
    const put = method === "PUT" ? input as typeof input & { blob_id: string; name?: string; type?: string } : null;
    const result = mutate(t, actor, input, { paths: [["files", input.path]], operations: ["file.write"] }, input, () => {
      const current = fileHead(t, input.path);
      if ((current?.revision ?? 0) !== input.expected_revision)
        throw new HttpError(409, "file_conflict", "Shared file changed; capture its current revision", { current: current?.revision ?? 0 });
      if (!current && (t.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM file_refs")?.n ?? 0) >= RESOURCE_LIMITS.shared_file_paths)
        throw new HttpError(429, "resource_quota", "Shared file path limit reached");
      if (put && !current?.blob_id &&
          (t.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM file_refs WHERE blob_id IS NOT NULL")?.n ?? 0) >= RESOURCE_LIMITS.shared_files)
        throw new HttpError(429, "resource_quota", "Active shared file limit reached");
      if (put) requireBlob(t, put.blob_id);
      const next = input.expected_revision + 1, now = t.now();
      const blobId = put?.blob_id ?? null;
      const name = put?.name ?? null;
      const type = put?.type ?? null;
      t.db.run("INSERT INTO file_refs(path,revision,blob_id,name,type,scope,updated_at,by_actor) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET revision=excluded.revision,blob_id=excluded.blob_id,name=excluded.name,type=excluded.type,scope=excluded.scope,updated_at=excluded.updated_at,by_actor=excluded.by_actor",
        input.path, next, blobId, name, type, input.scope ?? null, now, actor);
      t.db.run("INSERT INTO file_ref_changes(path,revision,blob_id,name,type,scope,updated_at,by_actor,cid) VALUES(?,?,?,?,?,?,?,?,?)",
        input.path, next, blobId, name, type, input.scope ?? null, now, actor, input.cid);
      const cursor = t.db.one<{ cursor: number }>("SELECT last_insert_rowid() AS cursor")!.cursor;
      return { file: fileValue(fileHead(t, input.path)!), cursor };
    });
    return json(result);
  }
  if (rest === "file-refs/changes" && method === "GET") {
    const after = intParam(url, "after", 0, 0, Number.MAX_SAFE_INTEGER);
    const rows = t.db.all<FileRow & { cursor: number; cid: string }>("SELECT * FROM file_ref_changes WHERE cursor>? ORDER BY cursor LIMIT 100", after);
    return json({ changes: rows.map(row => ({ cursor: row.cursor, file: fileValue(row), cid: row.cid, actor: row.by_actor, at: row.updated_at })),
      cursor: rows.at(-1)?.cursor ?? after });
  }
  if (rest === "publications" && method === "GET") {
    const head = pointers(t);
    return json({ current: head.current ?? 0, latest: head.latest ?? 0, healthy: head.healthy ?? 0,
      head_revision: t.db.get<number>("publication_head_revision", 0), needs_republication: false,
      versions: listVersions(t) });
  }
  const publication = /^publications\/([1-9][0-9]*)$/.exec(rest);
  if (publication && method === "GET") {
    const version = Number(publication[1]);
    const row = t.db.one<{ entry: string }>("SELECT entry FROM versions WHERE version=?", version);
    if (!row) throw new HttpError(404, "not_found", "No such publication");
    const files = t.db.all<{ path: string; blob_id: string; type: string }>(
      "SELECT f.path, b.blob_id, f.type FROM version_files f JOIN publication_blobs b ON b.version=f.version AND b.path=f.path WHERE f.version=? ORDER BY f.path", version);
    return json({ version, entry: row.entry, files });
  }
  if (rest === "publications" && method === "POST") {
    const input = assertValid("publicationWrite", await readJson(req, 2 * 1024 * 1024));
    assertPublicationEntries(input.files, input.entry);
    const targets = { operations: ["publication.publish"], paths: input.files.map(file => ["publications", file.path]) };
    const prior = replay<{ version: number; head_revision: number }>(t, actor, input, targets, input);
    if (prior.found) return json(prior.result);
    if (t.db.get<string>("mode", "interactive") !== "dashboard" && !t.db.get<number>("latest", 0)) {
      const facts = t.presenceFacts();
      if (!facts.agentSocket && !facts.longPollHeld && !facts.webhook)
        throw new HttpError(428, "listener_required", "Attach a verified agent receiver before launching an interactive page");
    }
    const files = new Map<string, VersionFile>();
    for (const file of input.files) {
      const blob = requireBlob(t, file.blob_id);
      files.set(file.path, { path: file.path, hash: blob.sha256, size: blob.size, type: file.type });
    }
    let receipt: { version: number; head_revision: number } | null = null;
    try {
      await createVersion(t, files, input.message ?? null, actor, {
        expectedHeadRevision: input.expected_head_revision,
        commit(version) {
          receipt = mutate(t, actor, input, targets, input, () => {
            for (const file of input.files) {
              const blob = requireBlob(t, file.blob_id);
              if (blob.sha256 !== files.get(file.path)?.hash) throw new HttpError(409, "blob_changed", "A publication blob changed during preparation");
              t.db.run("INSERT INTO publication_blobs(version,path,blob_id) VALUES(?,?,?)", version, file.path, file.blob_id);
            }
            t.db.run("UPDATE versions SET entry=? WHERE version=?", input.entry, version);
            const head_revision = input.expected_head_revision + 1;
            t.db.set("publication_head_revision", head_revision);
            return { version, head_revision };
          });
        },
      });
    } catch (error) {
      const accepted = replay<{ version: number; head_revision: number }>(t, actor, input, targets, input);
      if (accepted.found) return json(accepted.result);
      throw error;
    }
    if (!receipt) throw new HttpError(500, "publication_receipt", "Publication committed without a receipt");
    return json(receipt);
  }
  if (rest === "publications/rollback" && method === "POST") {
    const input = assertValid("publicationRollback", await readJson(req, 4096));
    const result = mutate(t, actor, input, { operations: ["publication.publish"] }, input, () => {
      const current = t.db.get<number>("publication_head_revision", 0);
      if (current !== input.expected_head_revision)
        throw new HttpError(409, "publication_conflict", "The publication head changed", { head_revision: current });
      const version = rollback(t, input.version, actor, null);
      const head_revision = current + 1;
      t.db.set("publication_head_revision", head_revision);
      return { version, head_revision };
    });
    return json(result);
  }
  throw new HttpError(404, "not_found", `No Contract 3 storage route ${rest}`);
}
