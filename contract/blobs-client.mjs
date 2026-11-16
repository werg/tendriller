/** Agent-facing authenticated binary and metadata APIs, using the sole Contract 3 wire protocol. */
import { assertValid, assertFilePath, assertPublicationEntries, RESOURCE_LIMITS } from "./index.mjs";

const id = value => encodeURIComponent(String(value));
const bytesLimit = RESOURCE_LIMITS.blob_bytes;

async function boundedBytes(input, limit = bytesLimit) {
  if (input instanceof Uint8Array) {
    if (input.byteLength > limit) throw new RangeError("Blob is larger than the platform byte limit");
    return input;
  }
  if (input instanceof ArrayBuffer) return boundedBytes(new Uint8Array(input), limit);
  if (typeof Blob !== "undefined" && input instanceof Blob) {
    if (input.size > limit) throw new RangeError("Blob is larger than the platform byte limit");
    return new Uint8Array(await input.arrayBuffer());
  }
  if (input?.getReader) {
    const reader = input.getReader();
    let total = 0;
    const chunks = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
        total += chunk.byteLength;
        if (total > limit) throw new RangeError("Blob stream is larger than the platform byte limit");
        chunks.push(chunk);
      }
    } catch (error) { await reader.cancel(error).catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
    const buffer = new Uint8Array(total);
    for (let offset = 0, i = 0; i < chunks.length; i++) { buffer.set(chunks[i], offset); offset += chunks[i].length; }
    return buffer;
  }
  throw new TypeError("Blob upload expects Blob, ArrayBuffer, Uint8Array or ReadableStream<Uint8Array>");
}

async function hexSha256(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

const invalidTransfer = message => Object.assign(new TypeError(message), { code: "invalid_response" });

/** Narrow transfer primitive shared by the browser outbox and the full agent client. */
export function createUploadClient(json, raw) {
  const uploads = {
      start: (body, { signal } = {}) => json("/uploads", { method: "POST", body: assertValid("uploadStart", body), signal }, "uploadSession"),
      status: (uploadId, { signal } = {}) => json(`/uploads/${id(uploadId)}`, { signal }, "uploadSession"),
      put: async (uploadId, bytes, { signal } = {}) => {
        const data = await boundedBytes(bytes);
        const response = await raw(`/uploads/${id(uploadId)}/content`, { method: "PUT", body: data, signal,
          headers: { "Content-Type": "application/octet-stream" } });
        return response.status;
      },
      complete: (uploadId, { signal } = {}) => json(`/uploads/${id(uploadId)}/complete`, { method: "POST", body: {}, signal }, "uploadCompletion"),
      cancel: (uploadId, { signal } = {}) => json(`/uploads/${id(uploadId)}`, { method: "DELETE", signal }),
      upload: async (data, { name, type = "application/octet-stream", cid = crypto.randomUUID(), signal } = {}) => {
        signal?.throwIfAborted();
        const bytes = await boundedBytes(data);
        const sha256 = await hexSha256(bytes);
        signal?.throwIfAborted();
        const session = await uploads.start({
          cid, size: bytes.byteLength, sha256, type, ...(name === undefined ? {} : { name }),
        }, { signal });
        if (session.sha256 !== sha256 || session.size !== bytes.byteLength)
          throw invalidTransfer("The upload session does not match the original bytes");
        if (["aborted", "expired"].includes(session.phase))
          throw Object.assign(new Error("The upload is closed; review the input before creating a new transfer"), { code: "upload_closed" });
        if (session.upload_required && !["received", "completed"].includes(session.phase)) {
          await uploads.put(session.id, bytes, { signal });
        }
        const receipt = await uploads.complete(session.id, { signal });
        if (receipt.blob.id !== session.blob_id || receipt.blob.sha256 !== sha256 || receipt.blob.size !== bytes.byteLength)
          throw invalidTransfer("The upload completion did not match the original session and bytes");
        return receipt;
      },
  };
  return uploads;
}

/** Operates with already-authenticated JSON and raw request functions; never base64 encodes bytes. */
export function createBlobClient(json, raw) {
  const query = path => `?path=${encodeURIComponent(assertFilePath(path))}`;
  return {
    blobs: {
      ...createUploadClient(json, raw),
      info: blobId => json(`/blobs/${id(blobId)}/info`, {}, "blobMetadata"),
      list: ({ after, limit = 100, signal } = {}) => {
        if (after !== undefined && !/^b_[a-z2-7]{20}$/.test(after)) throw new TypeError("Blob listing requires a blob ID cursor");
        if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new TypeError("Blob listing limit must be 1..1000");
        const params = new URLSearchParams({ limit: String(limit) });
        if (after !== undefined) params.set("after", after);
        return json(`/blobs?${params}`, { signal }, "blobList");
      },
      download: (blobId, { signal, range, disposition } = {}) => raw(
        `/blobs/${id(blobId)}${disposition === "inline" ? "?disposition=inline" : ""}`,
        { signal, headers: range ? { Range: range } : {} },
      ),
      pin: (blobId, command) => json(`/blobs/${id(blobId)}/pin`, { method: "PUT", body: assertValid("blobPin", command) }, "blobMetadata"),
    },
    files: {
      snapshot: ({ signal } = {}) => json("/file-refs/snapshot", { signal }, "fileSnapshot"),
      get: (path, { signal } = {}) => json(`/file-refs${query(path)}`, { signal }, "fileHead"),
      history: (path, { signal } = {}) => json(`/file-refs/history${query(path)}`, { signal }, "fileHistory"),
      changes: ({ after = 0, limit = 100, signal } = {}) => {
        if (!Number.isSafeInteger(after) || after < 0) throw new TypeError("File changes require a nonnegative cursor");
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError("File change limit must be 1..100");
        return json(`/file-refs/changes?${new URLSearchParams({ after: String(after), limit: String(limit) })}`, { signal }, "fileChanges");
      },
      put: body => json("/file-refs", { method: "PUT", body: assertValid("fileWrite", body) }, "fileResult"),
      delete: body => json("/file-refs", { method: "DELETE", body: assertValid("fileDelete", body) }, "fileResult"),
    },
    publications: {
      list: () => json("/publications"),
      get: version => json(`/publications/${id(version)}`),
      publish: body => {
        const value = assertValid("publicationWrite", body);
        assertPublicationEntries(value.files, value.entry);
        return json("/publications", { method: "POST", body: value }, "publicationResultV3");
      },
      rollback: body => json("/publications/rollback", { method: "POST", body: assertValid("publicationRollback", body) }, "publicationResultV3"),
    },
  };
}
