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
const scope = { type: "string", pattern: "^[A-Za-z0-9_.:-]{1,160}$" };
const expected = { type: "object", maxProperties: 128, propertyNames: scope, additionalProperties: s(160) };
const guards = { cid, expected_generations: expected, scope };
const requiredGuards = ["cid", "expected_generations"];
export const filePathSchema = {
  type: "string", minLength: 1, maxLength: RESOURCE_LIMITS.path_characters,
  pattern: "^(?!/)(?!(?:_tendril|_publications)(?:/|$))(?!.*(?:^|/)\\.{1,2}(?:/|$))(?!.*//)[^\\\\\\x00-\\x1f\\x7f]+$",
};
/** Reject unsafe or non-canonical names rather than translating them to other paths. */
export function assertFilePath(path) {
  if (typeof path !== "string" || !path || path.length > RESOURCE_LIMITS.path_characters ||
    path.normalize("NFC") !== path || !new RegExp(filePathSchema.pattern).test(path) ||
    path.split("/").some(part => !part || part === "." || part === "..")) {
    throw new TypeError("Invalid canonical shared file path");
  }
  return path;
}
const metadata = {
  id: blobIdSchema, sha256: sha256Schema,
  size: { type: "integer", minimum: 0, maximum: RESOURCE_LIMITS.blob_bytes },
  type: s(), name: { type: "string", maxLength: 200 },
  url: s(2048), created_at: n,
  retention: obj({ expires_at: { type: ["integer", "null"], minimum: 0 }, reasons: arr(s(), 32) }),
};
const blob = obj(metadata, ["id", "sha256", "size", "type"]);
const attachment = obj({ blob_id: blobIdSchema, name: { type: "string", maxLength: 200 } }, ["blob_id"]);
const file = obj({
  path: filePathSchema, revision: { type: "integer", minimum: 1 },
  blob_id: { anyOf: [blobIdSchema, { type: "null" }] },
  name: { type: "string", maxLength: 200 }, type: s(),
  scope: { anyOf: [scope, { type: "null" }] },
  updated_at: n, by: s(),
}, ["path", "revision", "blob_id"]);
const publicationFile = obj({ path: filePathSchema, blob_id: blobIdSchema, type: s() }, ["path", "blob_id", "type"]);
const transferError = obj({ code: s(), message: s(1000), retryable: bool, details: { type: "object" } }, ["code", "message"]);
export const blobSchemas = Object.freeze({
  blobId: blobIdSchema,
  blobSha256: sha256Schema,
  filePath: filePathSchema,
  blobMetadata: blob,
  blobList: obj({ blobs: arr(blob, 1000), cursor: { type: ["string", "null"] } }, ["blobs"]),
  blobAttachment: attachment,
  blobAttachments: arr(attachment, 16),
  uploadStart: obj({ cid, sha256: sha256Schema, size: metadata.size, type: s(), name: { type: "string", maxLength: 200 } }, ["cid", "sha256", "size", "type"]),
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
    name: { type: "string", maxLength: 200 }, type: s(),
  }, [...requiredGuards, "path", "expected_revision", "blob_id"]),
  fileDelete: obj({ ...guards, path: filePathSchema, expected_revision: n }, [...requiredGuards, "path", "expected_revision"]),
  fileCleanup: obj({ ...guards, path: filePathSchema, expected_revision: { type: "integer", minimum: 1 } },
    [...requiredGuards, "path", "expected_revision"]),
  fileResult: obj({ file, cursor: n }, ["file", "cursor"]),
  fileChange: obj({ cursor: n, file, cid, actor: s(), at: n }, ["cursor", "file", "cid", "actor", "at"]),
  publicationFile,
  publicationWrite: obj({
    ...guards, expected_head_revision: n, entry: filePathSchema,
    files: arr(publicationFile, RESOURCE_LIMITS.files_per_publication),
    message: { type: "string", maxLength: 2000 },
  }, [...requiredGuards, "expected_head_revision", "entry", "files"]),
  publicationRollback: obj({ ...guards, expected_head_revision: n, version: { type: "integer", minimum: 1 } },
    [...requiredGuards, "expected_head_revision", "version"]),
  publicationResultV3: obj({ version: { type: "integer", minimum: 1 }, head_revision: { type: "integer", minimum: 1 } },
    ["version", "head_revision"]),
  publicationHead: obj({ current: n, latest: n, healthy: n, head_revision: n,
    needs_republication: bool }, ["current", "latest", "healthy", "head_revision"]),
  transferDescriptor: obj({
    transfer_id: s(), phase: { enum: ["queued", "uploading", "ready", "committing", "accepted", "rejected"] },
    blob, file, error: transferError, progress: n,
  }, ["transfer_id", "phase"]),
  exportSnapshot: obj({ id: s(), expires_at: n, created_at: n, sha256: sha256Schema, size: n },
    ["id", "expires_at", "created_at"]),
  importStage: obj({ ...guards, sha256: sha256Schema, expected_head_revision: n, expected_files: { type: "object" } },
    [...requiredGuards, "sha256", "expected_head_revision", "expected_files"]),
});
