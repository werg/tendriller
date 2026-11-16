/** Agent-to-browser shared-file commands, intentionally compare-and-swap only. */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, existsSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { uploadBlob, downloadBlob } from "./blobs.mjs";

export function assertRemotePath(path) {
  if (typeof path !== "string" || !path || path.length > 512 || path !== path.normalize("NFC") ||
    /^\//.test(path) || /[\\\x00-\x1f\x7f]/.test(path) ||
    path.split("/").some(x => !x || x === "." || x === "..") ||
    /^(?:_tendril|_publications)(?:\/|$)/.test(path)) throw new TypeError("Invalid canonical shared file path");
  return path;
}
function sha(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function storeRecord(file, object) {
  if (!file) return;
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, JSON.stringify(object) + "\n", { mode: 0o600, flag: "wx" }); renameSync(temporary, file); }
  finally { try { unlinkSync(temporary); } catch {} }
}
function restoreRecord(file) {
  if (!file || !existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8"));
}
const uri = path => `/file-refs?path=${encodeURIComponent(assertRemotePath(path))}`;

export async function readFileHead(api, path) {
  try { return await api.get(uri(path)); }
  catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}
export async function listSharedFiles(api) { return api.get("/file-refs/snapshot"); }
export async function fileHistory(api, path) { return api.get(`/file-refs/history?path=${encodeURIComponent(assertRemotePath(path))}`); }

/** Save original file intent and CAS guard before the first upload request. */
export async function putSharedFile(api, remotePath, sourceBytes, {
  localName = null, type, expectedRevision, expectedGenerations = {}, scope,
  cid, resumeFile, maxBytes = 5 * 1024 * 1024,
} = {}) {
  const path = assertRemotePath(remotePath);
  const bytes = Buffer.from(sourceBytes);
  const digest = sha(bytes);
  const saved = restoreRecord(resumeFile);
  if (saved && (saved.path !== path || saved.sha256 !== digest || saved.type !== type ||
    saved.localName !== localName || JSON.stringify(saved.expected_generations) !== JSON.stringify(expectedGenerations) ||
    saved.scope !== (scope ?? null))) throw new Error("The saved file operation does not match this intent; use a new resume record");
  const revision = saved?.expected_revision ?? (expectedRevision === undefined
    ? (await readFileHead(api, path))?.revision ?? 0 : expectedRevision);
  if (!Number.isSafeInteger(revision) || revision < 0) throw new TypeError("Expected revision must be a nonnegative integer");
  if (saved && expectedRevision !== undefined && expectedRevision !== revision)
    throw new Error("Resume record has a different original expected revision");
  const commandCid = saved?.cid ?? cid ?? randomUUID();
  if (saved && cid && cid !== commandCid) throw new Error("Resume record has a different command CID");
  const record = saved || {
    path, sha256: digest, type, localName, cid: commandCid, expected_revision: revision,
    expected_generations: structuredClone(expectedGenerations), scope: scope ?? null,
    upload_cid: randomUUID(), phase: "pending_upload",
  };
  storeRecord(resumeFile, record);
  if (record.phase === "accepted") return record.result;
  const upload = await uploadBlob(api, bytes, { type, name:localName || undefined,
    cid:record.upload_cid, resumeFile:resumeFile && `${resumeFile}.upload.json`, maxBytes });
  const body = {
    cid:commandCid, expected_generations:record.expected_generations,
    ...(scope ? { scope } : {}), path, expected_revision:revision, blob_id:upload.blob.id,
    ...(localName ? { name:localName } : {}), ...(type ? { type } : {}),
  };
  storeRecord(resumeFile, { ...record, phase:"uploaded", blob_id:upload.blob.id });
  // On a 409, never replace the original revision/CID. Preserve the uploaded handle and command.
  const result = await api.put("/file-refs", body);
  storeRecord(resumeFile, { ...record, phase:"accepted", blob_id:upload.blob.id, result });
  return result;
}
export async function deleteSharedFile(api, remotePath, {
  expectedRevision, expectedGenerations = {}, scope, cid = randomUUID(),
} = {}) {
  const path = assertRemotePath(remotePath);
  const revision = expectedRevision === undefined ? (await readFileHead(api, path))?.revision ?? 0 : expectedRevision;
  if (!Number.isSafeInteger(revision) || revision <= 0) throw new Error("Delete requires an existing exact revision");
  return api.del("/file-refs", { json:{cid,expected_generations:expectedGenerations,...(scope ? {scope}:{}),path,expected_revision:revision} });
}
export async function getSharedFile(api, remotePath, destination, {overwrite = false,signal} = {}) {
  const head = await readFileHead(api, remotePath);
  if (!head || !head.blob_id) throw new Error("The shared file does not exist or is deleted");
  const downloaded = await downloadBlob(api, head.blob_id, destination, { overwrite, signal });
  return { file:head, ...downloaded };
}
