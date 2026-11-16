// Node-only CLI binary transfer plumbing. The trusted Worker never imports this module.
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, existsSync, lstatSync, readFileSync, writeFileSync, renameSync, unlinkSync, linkSync } from "node:fs";
import { dirname, basename, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform, Readable } from "node:stream";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const validBlobId = id => /^b_[a-z2-7]{20}$/.test(id);
const atomicJson = (path, value) => {
  const tmp = path + "." + randomUUID() + ".tmp";
  try {
    writeFileSync(tmp, JSON.stringify(value) + "\n", { mode: 0o600, flag: "wx" });
    renameSync(tmp, path);
  } finally { try { unlinkSync(tmp); } catch {} }
};
function readReceipt(path) {
  if (!path || !existsSync(path)) return null;
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value.cid !== "string" || typeof value.sha256 !== "string") throw new Error("Invalid transfer resume record");
  return value;
}
function enforceSize(size, cap) {
  if (!Number.isSafeInteger(size) || size < 0 || size > cap) throw new Error(`File size ${size} exceeds effective upload limit ${cap}`);
}
/** The CID, digest, name and type form one immutable upload intent. */
export async function uploadBlob(api, bytes, { type = "application/octet-stream", name, cid, resumeFile, maxBytes = 5 * 1024 * 1024, signal } = {}) {
  const payload = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  enforceSize(payload.length, maxBytes);
  const sha256 = digest(payload);
  const saved = readReceipt(resumeFile);
  if (saved && (saved.sha256 !== sha256 || saved.size !== payload.length || saved.type !== type || saved.name !== (name ?? null))) {
    throw new Error("Resume record belongs to different bytes or metadata; choose a new transfer record");
  }
  const identity = saved?.cid || cid || randomUUID();
  if (saved && cid && cid !== identity) throw new Error("Resume record CID differs from requested CID");
  const save = state => { if (resumeFile) atomicJson(resumeFile, { cid: identity, sha256, size: payload.length, type, name: name ?? null, ...state }); };
  save(saved || { phase: "starting" });
  if (saved?.phase === "completed") return saved.completion;
  const session = await api.post("/uploads", { cid: identity, sha256, size: payload.length, type, ...(name === undefined ? {} : { name }) }, { signal });
  const uploadId = saved?.upload_id || session.id;
  if (saved?.upload_id && saved.upload_id !== session.id) throw new Error("Server changed a previously acknowledged upload ID");
  save({ phase: "started", upload_id: uploadId });
  if (session.upload_required && session.phase !== "received" && session.phase !== "completed") {
    const response = await api.raw(`/uploads/${encodeURIComponent(uploadId)}/content`, {
      method: "PUT", body: payload, headers: { "content-type": "application/octet-stream" }, raw: true, signal,
    });
    await response.arrayBuffer();
    save({ phase: "received", upload_id: uploadId });
  }
  const completion = await api.post(`/uploads/${encodeURIComponent(uploadId)}/complete`, {}, { signal });
  if (completion?.status !== "completed" || completion.blob?.sha256 !== sha256 || completion.blob.size !== payload.length)
    throw new Error("Upload completion did not attest the submitted exact bytes");
  save({ phase: "completed", upload_id: uploadId, completion });
  return completion;
}
export async function blobInfo(api, id) {
  if (!validBlobId(id)) throw new TypeError("Invalid blob ID");
  const blob = await api.get(`/blobs/${id}/info`);
  if (blob.id !== id || !/^[0-9a-f]{64}$/.test(blob.sha256) || !Number.isSafeInteger(blob.size) || blob.size < 0)
    throw new Error("The server returned invalid blob metadata");
  return blob;
}
/** Stream verified bytes to a sibling temporary path; a partial read never replaces a local file. */
export async function downloadBlob(api, id, destination, { overwrite = false, signal } = {}) {
  const meta = await blobInfo(api, id);
  if (!destination || typeof destination !== "string") throw new TypeError("Select an explicit local download destination");
  const target = resolve(destination);
  // Do not follow an attacker-created parent directory symlink during writes.
  // Remote names are never used to construct this destination.
  for (let parent = dirname(target), previous = ""; parent !== previous; previous = parent, parent = dirname(parent)) {
    if (existsSync(parent) && lstatSync(parent).isSymbolicLink()) throw new Error("Refusing a symlink download destination parent");
  }
  if (existsSync(target)) {
    if (lstatSync(target).isSymbolicLink()) throw new Error("Refusing a symlink download destination");
    if (!overwrite) throw new Error("Destination exists; pass --overwrite deliberately");
    if (!lstatSync(target).isFile()) throw new Error("Download destination must be a file");
  }
  const tmp = join(dirname(target), `.${basename(target)}.${randomUUID()}.partial`);
  let actualSize = 0;
  const hash = createHash("sha256");
  try {
    const response = await api.raw(`/blobs/${id}`, { raw: true, signal });
    if (!response.body) throw new Error("Server sent no binary body");
    const verify = new Transform({
      transform(chunk, _enc, callback) {
        actualSize += chunk.length;
        if (actualSize > meta.size) return callback(new Error("Download larger than the declared blob size"));
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body), verify, createWriteStream(tmp, { flags: "wx", mode: 0o600 }), { signal });
    if (actualSize !== meta.size || hash.digest("hex") !== meta.sha256) throw new Error("Downloaded bytes do not match verified blob size/hash");
    if (overwrite) {
      if (existsSync(target) && lstatSync(target).isSymbolicLink()) throw new Error("Destination became a symlink during download");
      renameSync(tmp, target);
    } else {
      linkSync(tmp, target); // atomic create-only; rename would overwrite an existing file
    }
    return { blob: meta, path: target };
  } finally { try { unlinkSync(tmp); } catch {} }
}
