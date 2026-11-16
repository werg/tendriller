// In-memory implementation of the public page transfer protocol. It never
// reads page assets or invents uploaded content; every byte arrives by PUT.
import { createHash, randomBytes } from "node:crypto";
import { assertValid, RESOURCE_LIMITS } from "@tendriller/core/contract";

const id = prefix => prefix + [...randomBytes(20)].map(byte => "abcdefghijklmnopqrstuvwxyz234567"[byte & 31]).join("");
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const failure = (status, code, message) => Object.assign(new Error(message), { status, code });
const result = (status, body, headers) => ({ status, body, headers });

async function bytes(req, limit) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw failure(413, "too_large", "Request exceeds the preview transfer limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function createPreviewStorage({ role, verifyDevice, scopes, matchesContext, now = Date.now, maxBytes = 5 * 1024 * 1024 }) {
  const blobs = new Map(), contents = new Map(), uploads = new Map(), intents = new Map(), pins = new Map();
  let closed = false;
  const open = () => { if (closed) throw failure(503, "preview_closed", "Preview is closed"); };
  const metadata = blob => structuredClone(blob.metadata);
  const session = row => ({ id: row.id, blob_id: row.blob_id, sha256: row.sha256, size: row.size,
    phase: row.phase, upload_required: row.phase !== "completed" && !contents.has(row.sha256), expires_at: row.expires_at,
    ...(row.phase === "completed" ? { blob: metadata(blobs.get(row.blob_id)) } : {}) });
  const active = (uploadId, device) => {
    open();
    const row = uploads.get(uploadId);
    if (!row || row.device !== device) throw failure(404, "not_found", "No such upload");
    if (row.phase !== "completed" && row.expires_at <= now()) throw failure(410, "upload_expired", "Upload expired");
    return row;
  };
  const blob = blobId => {
    const value = blobs.get(blobId);
    if (!value) throw failure(404, "not_found", "No such blob");
    return value;
  };
  const api = {
    blobs,
    close() { closed = true; },
    start(value, device) {
      open();
      const input = assertValid("uploadStart", value);
      if (input.size > maxBytes) throw failure(413, "too_large", "Upload exceeds the preview transfer limit");
      const key = `${device}:${input.cid}`;
      const intent = JSON.stringify({ sha256: input.sha256, size: input.size, type: input.type, name: input.name ?? null });
      const prior = intents.get(key);
      if (prior) {
        if (prior.intent !== intent) throw failure(409, "command_conflict", "Upload CID belongs to different bytes or metadata");
        const row = active(prior.id, device);
        if (row.phase === "aborted") throw failure(409, "upload_closed", "The original upload was aborted");
        return session(row);
      }
      const unfinished = [...uploads.values()].filter(row => !["completed", "aborted"].includes(row.phase) && row.expires_at > now());
      if (unfinished.length >= RESOURCE_LIMITS.upload_sessions_per_page ||
          unfinished.filter(row => row.device === device).length >= RESOURCE_LIMITS.upload_sessions_per_actor)
        throw failure(429, "upload_quota", "Too many unfinished uploads");
      const stored = contents.get(input.sha256);
      if (stored && stored.length !== input.size) throw failure(422, "digest_mismatch", "Known content has a different size");
      const row = { ...input, device, id: id("u_"), blob_id: id("b_"), phase: stored ? "ready" : "reserved",
        expires_at: now() + RESOURCE_LIMITS.upload_expiry_seconds * 1000 };
      uploads.set(row.id, row); intents.set(key, { id: row.id, intent });
      return session(row);
    },
    put(uploadId, device, data, type) {
      const row = active(uploadId, device);
      if (["completed", "aborted"].includes(row.phase)) throw failure(409, "upload_closed", "Upload is closed");
      if (type !== "application/octet-stream") throw failure(415, "content_type", "Upload content must be application/octet-stream");
      if (data.length !== row.size || digest(data) !== row.sha256) throw failure(422, "digest_mismatch", "Content does not match reserved size and SHA-256");
      contents.set(row.sha256, Buffer.from(data)); row.phase = "received";
    },
    complete(uploadId, device) {
      const row = active(uploadId, device);
      if (row.phase === "aborted") throw failure(409, "upload_closed", "Upload was aborted");
      const data = contents.get(row.sha256);
      if (!data || data.length !== row.size) throw failure(409, "upload_incomplete", "Upload content is not ready");
      if (!blobs.has(row.blob_id)) blobs.set(row.blob_id, { data, device, metadata: {
        id: row.blob_id, sha256: row.sha256, size: row.size, type: row.type,
        ...(row.name === undefined ? {} : { name: row.name }), url: `_tendril/blobs/${row.blob_id}`,
        created_at: now(), retention: { expires_at: now() + 30 * 86400000, reasons: ["page_default"] },
      } });
      row.phase = "completed";
      return assertValid("uploadCompletion", { status: "completed", blob: metadata(blobs.get(row.blob_id)) });
    },
    async handle(req, url) {
      const path = url.pathname, method = req.method === "HEAD" ? "GET" : req.method;
      if (!/^\/_tendril\/(?:uploads|blobs)(?:\/|$)/.test(path)) return null;
      open();
      const isUpload = path.startsWith("/_tendril/uploads");
      const device = verifyDevice(req.headers);
      if (isUpload && !device) throw failure(401, "device_required", "Register this device before uploading");
      if (method !== "GET" && role() === "display") throw failure(403, "forbidden", "Display devices cannot upload");
      if (path === "/_tendril/uploads" && method === "POST")
        return result(201, api.start(JSON.parse((await bytes(req, 4096)).toString()), device));
      const upload = /^\/_tendril\/uploads\/(u_[a-z2-7]{20})(?:\/(content|complete))?$/.exec(path);
      if (upload) {
        const row = active(upload[1], device);
        if (!upload[2] && method === "GET") return result(200, session(row));
        if (!upload[2] && method === "DELETE") {
          if (row.phase !== "completed") row.phase = "aborted";
          return result(200, { ok: true });
        }
        if (upload[2] === "content" && method === "PUT") {
          api.put(row.id, device, await bytes(req, maxBytes), req.headers["content-type"]);
          return result(204, null);
        }
        if (upload[2] === "complete" && method === "POST") {
          await bytes(req, 4096);
          return result(200, api.complete(row.id, device));
        }
      }
      if (path === "/_tendril/blobs" && method === "GET") {
        const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 100;
        const after = url.searchParams.get("after");
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000 ||
            (after !== null && !/^b_[a-z2-7]{20}$/.test(after))) throw failure(400, "bad_request", "Invalid blob list cursor or limit");
        const values = [...blobs.keys()].sort().filter(key => after === null || key > after);
        const ids = values.slice(0, limit);
        return result(200, { blobs: ids.map(key => metadata(blobs.get(key))), cursor: values.length > limit ? ids.at(-1) : null });
      }
      const found = /^\/_tendril\/blobs\/(b_[a-z2-7]{20})(?:\/(info|pin))?$/.exec(path);
      if (found) {
        const stored = blob(found[1]);
        if (found[2] === "info" && method === "GET") return result(200, metadata(stored));
        if (found[2] === "pin" && method === "PUT") {
          if (role() !== "owner") throw failure(403, "forbidden", "Only owners can pin captures");
          if (!device) throw failure(401, "device_required", "Register this device before pinning captures");
          const input = assertValid("blobPin", JSON.parse((await bytes(req, 4096)).toString()));
          open();
          const key = `${device}:${input.cid}`, intent = JSON.stringify({ id: found[1], ...input });
          const prior = pins.get(key);
          if (prior) {
            if (prior.intent !== intent) throw failure(409, "command_conflict", "Command CID belongs to a different pin intent");
            return result(200, structuredClone(prior.value));
          }
          if (!matchesContext(scopes(), input, "blob.pin", [])) throw failure(409, "stale_generation", "Pin scope generation changed");
          stored.metadata.retention = { expires_at: input.keep ? null : now() + 30 * 86400000,
            reasons: [input.keep ? "pinned" : "page_default"] };
          const value = metadata(stored); pins.set(key, { intent, value });
          return result(200, value);
        }
        if (!found[2] && method === "GET") {
          let data = stored.data, status = 200;
          const filename = encodeURIComponent(new TextDecoder().decode(new TextEncoder().encode(stored.metadata.name || stored.metadata.id)))
            .replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
          const headers = {
            "content-type": stored.metadata.type, "accept-ranges": "bytes", "content-length": data.length,
            "cache-control": "private, max-age=31536000, immutable", "x-content-type-options": "nosniff",
            "content-disposition": `${url.searchParams.get("disposition") === "inline" ? "inline" : "attachment"}; filename*=UTF-8''${filename}`,
            "content-security-policy": "default-src 'none'; sandbox",
          };
          if (req.headers.range) {
            const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
            if (!range || (!range[1] && !range[2])) throw failure(416, "bad_range", "Invalid byte range");
            const start = range[1] ? Number(range[1]) : Math.max(0, data.length - Number(range[2]));
            const end = range[1] ? (range[2] ? Math.min(Number(range[2]), data.length - 1) : data.length - 1) : data.length - 1;
            if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= data.length)
              throw failure(416, "bad_range", "Byte range is outside this blob");
            headers["content-range"] = `bytes ${start}-${end}/${data.length}`;
            data = data.subarray(start, end + 1); headers["content-length"] = data.length; status = 206;
          }
          return result(status, req.method === "HEAD" ? null : data, headers);
        }
      }
      throw failure(404, "not_found", "No such storage route");
    },
  };
  return api;
}
