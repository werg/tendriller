/** Agent-facing authenticated binary and metadata APIs, using the sole Contract 3 wire protocol. */
import { assertValid, validate, assertFilePath, assertPublicationEntries } from "./index.mjs";

const id = value => encodeURIComponent(String(value));
const bytesLimit = 25 * 1024 * 1024;

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
    } finally { reader.releaseLock(); }
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

/** Operates with already-authenticated JSON and raw request functions; never base64 encodes bytes. */
export function createBlobClient(json, raw) {
  const query = path => `?path=${encodeURIComponent(assertFilePath(path))}`;
  return {
    blobs: {
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
        const bytes = await boundedBytes(data);
        const sha256 = await hexSha256(bytes);
        const session = await json("/uploads", { method: "POST", body: assertValid("uploadStart", {
          cid, size: bytes.byteLength, sha256, type, ...(name === undefined ? {} : { name }),
        }), signal }, "uploadSession");
        if (session.upload_required && !["received", "completed"].includes(session.phase)) {
          await raw(`/uploads/${id(session.id)}/content`, { method: "PUT", body: bytes, signal,
            headers: { "Content-Type": "application/octet-stream" } });
        }
        const receipt = await json(`/uploads/${id(session.id)}/complete`, { method: "POST", body: {}, signal }, "uploadCompletion");
        if (receipt.blob.sha256 !== sha256 || receipt.blob.size !== bytes.byteLength)
          throw new TypeError("The upload completion did not match the original bytes");
        return receipt;
      },
      info: blobId => json(`/blobs/${id(blobId)}/info`, {}, "blobMetadata"),
      list: () => json("/blobs", {}, "blobList"),
      download: (blobId, { signal, range, disposition } = {}) => raw(
        `/blobs/${id(blobId)}${disposition === "inline" ? "?disposition=inline" : ""}`,
        { signal, headers: range ? { Range: range } : {} },
      ),
      pin: (blobId, command) => json(`/blobs/${id(blobId)}/pin`, { method: "PUT", body: assertValid("blobPin", command) }),
    },
    files: {
      snapshot: ({ signal } = {}) => json("/file-refs/snapshot", { signal }, "fileSnapshot"),
      get: (path, { signal } = {}) => json(`/file-refs${query(path)}`, { signal }, "fileHead"),
      history: (path, { signal } = {}) => json(`/file-refs/history${query(path)}`, { signal }, "fileHistory"),
      put: body => json("/file-refs", { method: "PUT", body: assertValid("fileWrite", body) }, "fileResult"),
      delete: body => json("/file-refs", { method: "DELETE", body: assertValid("fileDelete", body) }, "fileResult"),
      cleanup: body => json("/file-refs/cleanup", { method: "POST", body: assertValid("fileCleanup", body) }, "fileResult"),
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
