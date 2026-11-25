import {
  awaitOwnedTask
} from "./chunk-KSC4KBWO.mjs";

// packages/peer-session/src/content-bytes.ts
var CONTENT_CHUNK_BYTES = 65536;
var MAX_CONTENT_BYTES = 128 * 1024 * 1024;
async function putContentBytes(content, bytes, options = {}) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_CONTENT_BYTES) throw new Error("CONTENT_RANGE_INVALID");
  const signal = options.signal ?? new AbortController().signal;
  signal.throwIfAborted();
  const staging = content.stage({ bytes: bytes.byteLength, ...options.mediaType === void 0 ? {} : { mediaType: options.mediaType } });
  let upload;
  try {
    upload = await awaitOwnedTask(signal, () => staging);
    for (let offset = 0; offset < bytes.byteLength; offset += CONTENT_CHUNK_BYTES) {
      signal.throwIfAborted();
      const chunk = Uint8Array.from(bytes.subarray(offset, offset + CONTENT_CHUNK_BYTES));
      await awaitOwnedTask(signal, () => upload.write(offset / CONTENT_CHUNK_BYTES, chunk));
    }
    const reference = await awaitOwnedTask(signal, () => upload.commit());
    signal.throwIfAborted();
    return reference;
  } catch (error) {
    void staging.then((value) => value.discard()).catch(() => void 0);
    throw error;
  }
}
async function readContentBytes(content, reference, options) {
  if (!Number.isSafeInteger(options?.maxBytes) || options.maxBytes < 0 || options.maxBytes > MAX_CONTENT_BYTES) throw new Error("CONTENT_READ_LIMIT_INVALID");
  if (reference === null || typeof reference !== "object" || !Number.isSafeInteger(reference.bytes) || reference.bytes < 0 || reference.bytes > MAX_CONTENT_BYTES) throw new Error("CONTENT_REFERENCE_INVALID");
  if (reference.bytes > options.maxBytes) throw new Error("CONTENT_READ_LIMIT_EXCEEDED");
  options.signal?.throwIfAborted();
  const result = new Uint8Array(reference.bytes);
  const signal = options.signal ?? new AbortController().signal;
  const iterator = content.read({ ...reference }, { signal })[Symbol.asyncIterator]();
  let offset = 0, chunks = 0;
  try {
    for (; ; ) {
      const next = await awaitOwnedTask(signal, () => iterator.next());
      if (next.done) break;
      const chunk = next.value;
      signal.throwIfAborted();
      if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0 || chunk.byteLength > CONTENT_CHUNK_BYTES || ++chunks > MAX_CONTENT_BYTES / CONTENT_CHUNK_BYTES || offset + chunk.byteLength > result.byteLength) throw new Error("CONTENT_CHUNK_SIZE_INVALID");
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    signal.throwIfAborted();
    if (offset !== result.byteLength) throw new Error("CONTENT_INCOMPLETE");
    return result;
  } finally {
    void iterator.return?.().catch(() => void 0);
  }
}

export {
  CONTENT_CHUNK_BYTES,
  MAX_CONTENT_BYTES,
  putContentBytes,
  readContentBytes
};
