/** Contract 3 immutable blobs, shared-file CAS and page publication wire schemas.
 * No server-only imports: this module is shared by the Worker, browser and CLI. */
import { RESOURCE_LIMITS } from "./limits.mjs";
const s = (maxLength = 200) => ({ type: "string", minLength: 1, maxLength });
const n = { type: "integer", minimum: 0 };
const bool = { type: "boolean" };
const obj = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const arr = (items, maxItems) => ({ type: "array", items, ...(maxItems === undefined ? {} : { maxItems }) });
export const blobIdSchema = { type: "string", pattern: "^b_[a-z2-7]{20}$" };
export const sha256Schema = { type: "string", pattern: "^[a-f0-9]{64}$" };
export const uploadIdSchema = { type: "string", pattern: "^u_[a-z2-7]{20}$" };
const cid = { type: "string", pattern: "^[A-Za-z0-9_.:-]{1,200}$" };
const scope = { type: "string", pattern: "^(?!(?:__proto__|constructor|prototype)$)[A-Za-z0-9_.:-]{1,160}$" };
const expected = { type: "object", maxProperties: 128, propertyNames: scope, additionalProperties: s(160) };
const guards = { cid, expected_generations: expected, scope };
const requiredGuards = ["cid", "expected_generations"];
/** A lone surrogate cannot be represented faithfully in a URL or UTF-8 name. */
export function isWellFormedUnicode(value) {
  for (const point of value) {
    const code = point.charCodeAt(0);
    if (point.length === 1 && code >= 0xd800 && code <= 0xdfff) return false;
  }
  return true;
}
export const blobNameSchema = { type: "string", maxLength: 200, "x-well-formed-unicode": true };
export const filePathSchema = {
  type: "string", minLength: 1, maxLength: RESOURCE_LIMITS.path_characters,
  "x-canonical-nfc": true, "x-well-formed-unicode": true,
  pattern: "^(?!/)(?!.*\\/$)(?!(?:_tendril|_publications)(?:/|$))(?!.*(?:^|/)\\.{1,2}(?:/|$))(?!.*//)[^\\\\\\x00-\\x1f\\x7f]+$",
};
/** Reject unsafe or non-canonical names rather than translating them to other paths. */
export function assertFilePath(path) {
  if (typeof path !== "string" || !path || path.length > RESOURCE_LIMITS.path_characters ||
    !isWellFormedUnicode(path) || path.normalize("NFC") !== path || !new RegExp(filePathSchema.pattern).test(path) ||
    path.split("/").some(part => !part || part === "." || part === "..")) {
    throw new TypeError("Invalid canonical shared file path");
  }
  return path;
}
const metadata = {
  id: blobIdSchema, sha256: sha256Schema,
  size: { type: "integer", minimum: 0, maximum: RESOURCE_LIMITS.blob_bytes },
  type: { ...s(), pattern: "^[^\\x00-\\x1f\\x7f]+$" }, name: blobNameSchema,
  url: s(2048), created_at: n,
  retention: obj({ expires_at: { type: ["integer", "null"], minimum: 0 }, reasons: arr(s(), 32) }, ["expires_at", "reasons"]),
};
const blob = obj(metadata, ["id", "sha256", "size", "type", "url", "created_at", "retention"]);
const attachment = obj({ blob_id: blobIdSchema, name: blobNameSchema }, ["blob_id"]);
const file = obj({
  path: filePathSchema, revision: { type: "integer", minimum: 1 },
  blob_id: { anyOf: [blobIdSchema, { type: "null" }] },
  name: blobNameSchema, type: metadata.type,
  scope: { anyOf: [scope, { type: "null" }] },
  updated_at: n, by: s(),
}, ["path", "revision", "blob_id"]);
const publicationFile = obj({ path: filePathSchema, blob_id: blobIdSchema, type: metadata.type }, ["path", "blob_id", "type"]);
const fileChange = obj({ cursor: n, file, cid, actor: s(), at: n }, ["cursor", "file", "cid", "actor", "at"]);
export const blobSchemas = Object.freeze({
  blobId: blobIdSchema,
  blobSha256: sha256Schema,
  filePath: filePathSchema,
  blobMetadata: blob,
  blobList: obj({ blobs: arr(blob, 1000), cursor: { type: ["string", "null"] } }, ["blobs", "cursor"]),
  blobAttachment: attachment,
  blobAttachments: arr(attachment, 16),
  uploadStart: obj({ cid, sha256: sha256Schema, size: metadata.size, type: metadata.type, name: blobNameSchema }, ["cid", "sha256", "size", "type"]),
  uploadSession: obj({
    id: uploadIdSchema, blob_id: blobIdSchema, sha256: sha256Schema, size: metadata.size,
    phase: { enum: ["reserved", "ready", "receiving", "received", "completed", "aborted", "expired"] },
    upload_required: bool, expires_at: n, blob,
  }, ["id", "blob_id", "sha256", "size", "phase", "upload_required", "expires_at"]),
  uploadCompletion: obj({ status: { const: "completed" }, blob }, ["status", "blob"]),
  blobPin: obj({ ...guards, keep: bool }, [...requiredGuards, "keep"]),
  fileHead: file,
  fileSnapshot: obj({ files: arr(file, RESOURCE_LIMITS.shared_files), cursor: n }, ["files", "cursor"]),
  fileHistory: obj({ path: filePathSchema, versions: arr(file, RESOURCE_LIMITS.file_history + 1) }, ["path", "versions"]),
  fileWrite: obj({
    ...guards, path: filePathSchema, expected_revision: n, blob_id: blobIdSchema,
    name: blobNameSchema, type: metadata.type,
  }, [...requiredGuards, "path", "expected_revision", "blob_id"]),
  fileDelete: obj({ ...guards, path: filePathSchema, expected_revision: n }, [...requiredGuards, "path", "expected_revision"]),
  fileResult: obj({ file, cursor: n }, ["file", "cursor"]),
  fileChange,
  fileChanges: obj({ changes: arr(fileChange, 100), cursor: n }, ["changes", "cursor"]),
  publicationFile,
  publicationWrite: obj({
    ...guards, expected_head_revision: n, entry: filePathSchema,
    files: arr(publicationFile, RESOURCE_LIMITS.files_per_publication),
    message: { type: "string", maxLength: 2000 },
  }, [...requiredGuards, "expected_head_revision", "entry", "files"]),
  publicationRollback: obj({ ...guards, expected_head_revision: n, version: { type: "integer", minimum: 1 } },
    [...requiredGuards, "expected_head_revision", "version"]),
  publicationReceipt: obj({ version: { type: "integer", minimum: 1 }, head_revision: { type: "integer", minimum: 1 } },
    ["version", "head_revision"]),
  publicationList: obj({ current: n, latest: n, healthy: n, head_revision: n, served: n,
    versions: arr(obj({ version: { type: "integer", minimum: 1 }, created_at: n,
      status: { enum: ["pending", "healthy", "failed"] }, message: { type: ["string", "null"] },
      files: n, errors: arr({}), by: s() }, ["version", "created_at", "status", "message", "files"])) },
    ["current", "latest", "healthy", "head_revision", "served", "versions"]),
  publicationDetails: obj({ version: { type: "integer", minimum: 1 }, entry: filePathSchema,
    files: arr(obj({ ...publicationFile.properties, sha256: sha256Schema, size: metadata.size },
      ["path", "blob_id", "type", "sha256", "size"]), RESOURCE_LIMITS.files_per_publication) }, ["version", "entry", "files"]),
});

/** Cross-field invariants cannot be expressed by the supported schema subset. */
export function assertAttachments(attachments) {
  if (!Array.isArray(attachments) || attachments.length > 16) throw new TypeError("At most 16 attachments are allowed");
  const seen = new Set();
  for (const item of attachments) {
    const id = item?.blob_id;
    if (typeof id !== "string" || !new RegExp(blobIdSchema.pattern).test(id) || seen.has(id) ||
      (item.name !== undefined && (typeof item.name !== "string" || item.name.length > 200 || !isWellFormedUnicode(item.name))))
      throw new TypeError("Invalid or duplicate attachment");
    seen.add(id);
  }
  return attachments;
}
export function assertPublicationEntries(entries, entry) {
  if (!Array.isArray(entries) || !entries.length || entries.length > RESOURCE_LIMITS.files_per_publication)
    throw new TypeError("Invalid publication file count");
  assertFilePath(entry);
  let previous = "";
  for (const file of entries) {
    const path = assertFilePath(file?.path);
    if (path <= previous) throw new TypeError("Publication paths must be sorted and unique");
    previous = path;
    if (typeof file.blob_id !== "string" || !new RegExp(blobIdSchema.pattern).test(file.blob_id))
      throw new TypeError("Publication entry requires a valid immutable blob ID");
  }
  if (!entries.some(file => file.path === entry)) throw new TypeError("Publication entry is missing from manifest");
  if (!/\.html?$/i.test(entry) || !/^text\/html(?:;|$)/i.test(entries.find(file => file.path === entry).type))
    throw new TypeError("Publication entry must be an authored HTML file");
  return entries;
}
