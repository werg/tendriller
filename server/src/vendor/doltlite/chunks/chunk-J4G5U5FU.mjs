import {
  createSigningIdentity
} from "./chunk-CZMLHZUQ.mjs";
import {
  assertCanonicalCbor,
  bytesToHex,
  exportEd25519PrivateKey,
  hexToBytes,
  importEd25519PrivateKey,
  importEd25519PublicKey
} from "./chunk-MAGRVNAE.mjs";
import {
  encodeCanonicalCbor
} from "./chunk-HYFY2E3E.mjs";

// packages/peer-session/src/checkpoint-lifecycle.ts
var states = /* @__PURE__ */ new WeakMap();
function state(store) {
  let value = states.get(store);
  if (value === void 0) {
    value = { users: 0, checkpoint: false, retired: false };
    states.set(store, value);
  }
  return value;
}
function useDeviceStore(store) {
  const value = state(store);
  if (value.retired) throw Object.assign(new Error("DEVICE_RETIRED_BY_CHECKPOINT"), { code: "DEVICE_RETIRED_BY_CHECKPOINT" });
  if (value.checkpoint) throw Object.assign(new Error("CHECKPOINT_SOURCE_IN_USE"), { code: "CHECKPOINT_SOURCE_IN_USE" });
  value.users++;
  let released = false;
  return () => {
    if (!released) {
      released = true;
      value.users--;
    }
  };
}
function reserveCheckpointStore(store) {
  const value = state(store);
  if (value.users !== 0 || value.checkpoint) throw Object.assign(new Error("CHECKPOINT_SOURCE_IN_USE"), { code: "CHECKPOINT_SOURCE_IN_USE" });
  value.checkpoint = true;
  return () => {
    value.checkpoint = false;
  };
}
function retireDeviceStore(store) {
  state(store).retired = true;
}

// packages/peer-session/src/checkpoint-codec.ts
var PBKDF2_ITERATIONS = 6e5;
var encoder = new TextEncoder();
function fail(code, message) {
  return Object.assign(new Error(message), { code });
}
async function deriveAesKey(secret, salt, usage, iterations = PBKDF2_ITERATIONS) {
  if (secret instanceof Uint8Array) {
    if (secret.byteLength !== 32) throw fail("CHECKPOINT_KEY_INVALID", "Raw checkpoint encryption key must be exactly 32 bytes.");
    const copy = new Uint8Array(secret.byteLength);
    copy.set(secret);
    return crypto.subtle.importKey("raw", copy, { name: "AES-GCM" }, false, [...usage]);
  }
  if (typeof secret !== "string" || secret.length < 12) {
    throw fail("CHECKPOINT_KEY_INVALID", "Checkpoint passphrase must be at least 12 characters.");
  }
  const baseKey = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "PBKDF2" }, false, ["deriveKey"]);
  const saltCopy = new Uint8Array(salt.byteLength);
  saltCopy.set(salt);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: saltCopy, iterations },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    [...usage]
  );
}
function validateMetadata(metadata2, outbox) {
  if (typeof metadata2.createdAt !== "string" || !Number.isFinite(Date.parse(metadata2.createdAt)) || [metadata2.applicationId, metadata2.deviceId].some((id) => id !== null && (typeof id !== "string" || !/^[a-f0-9]{64}$/u.test(id))) || typeof metadata2.manifestSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(metadata2.manifestSha256) || outbox.length > 1024) throw fail("CHECKPOINT_CORRUPT", "Invalid checkpoint metadata.");
  const seen = /* @__PURE__ */ new Set();
  for (const entry of outbox) {
    if (!entry || typeof entry.operationId !== "string" || !entry.operationId || entry.operationId.length > 512 || [...entry.operationId].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) || seen.has(entry.operationId) || typeof entry.createdAt !== "string" || !Number.isFinite(Date.parse(entry.createdAt)) || entry.command !== void 0 && (typeof entry.command !== "string" || !entry.command || entry.command.length > 128) || entry.payloadHash !== void 0 && (typeof entry.payloadHash !== "string" || !/^[a-f0-9]{64}$/u.test(entry.payloadHash)) || entry.status !== void 0 && (typeof entry.status !== "string" || entry.status.length > 128)) throw fail("CHECKPOINT_CORRUPT", "Invalid retained outbox record.");
    seen.add(entry.operationId);
  }
}

// packages/peer-session/src/checkpoint.ts
var CHECKPOINT_FORMAT = "chronolog-device-checkpoint-v1";
var DEVICE_RETIRED_KEY = "peer-session/checkpoint-retired/v1";
var MAGIC = new Uint8Array([67, 76, 67, 80, 1]);
var SALT_BYTES = 16;
var IV_BYTES = 12;
var LEGACY_PBKDF2_ITERATIONS = 1e5;
var PBKDF2_ITERATIONS2 = 6e5;
var KDF_HEADER_BYTES = 5;
var encoder2 = new TextEncoder();
var decoder = new TextDecoder("utf-8", { fatal: true });
function checkpointLimit(limits, key) {
  const value = limits?.[key] ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(value) || value < 0) throw fail2("CHECKPOINT_LIMIT_INVALID", "Invalid checkpoint budget.");
  return value;
}
function fail2(code, message) {
  return Object.assign(new Error(message), { code });
}
function checkpointAad(kdfHeader) {
  const format = encoder2.encode(CHECKPOINT_FORMAT);
  const aad = new Uint8Array(format.length + kdfHeader.length);
  aad.set(format);
  aad.set(kdfHeader, format.length);
  return aad;
}
function encodeBase64(bytes) {
  let binary = "";
  const chunk = 32768;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  }
  return btoa(binary);
}
function decodeBase64(value) {
  const binary = atob(value);
  if (btoa(binary) !== value) throw fail2("CHECKPOINT_CORRUPT", "Invalid base64 checkpoint data.");
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
async function sha256Hex(bytes) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", copy)));
}
async function manifestDigest(entries, sqlBytes, outbox) {
  const entryDigests = [];
  for (const entry of entries) entryDigests.push([entry.key, await sha256Hex(entry.value), entry.value.byteLength]);
  const sqlDigest = sqlBytes === null ? null : [await sha256Hex(sqlBytes), sqlBytes.byteLength];
  const canonical = JSON.stringify({ entries: entryDigests, sql: sqlDigest, outbox });
  return sha256Hex(encoder2.encode(canonical));
}
async function isDeviceRetired(store) {
  const raw = await store.get(DEVICE_RETIRED_KEY);
  if (raw === null) return { retired: false };
  try {
    const parsed = JSON.parse(decoder.decode(raw));
    return {
      retired: true,
      ...typeof parsed.retiredAt === "string" ? { retiredAt: parsed.retiredAt } : {},
      ...typeof parsed.manifestSha256 === "string" ? { manifestSha256: parsed.manifestSha256 } : {}
    };
  } catch {
    return { retired: true };
  }
}
async function assertDeviceNotRetired(store) {
  const status = await isDeviceRetired(store);
  if (status.retired) {
    throw fail2("DEVICE_RETIRED_BY_CHECKPOINT", "This local device store was retired when exported to a checkpoint. Resume from the restored target instance.");
  }
}
async function exportDeviceCheckpoint(store, options) {
  if (options.retireSource !== false && typeof options.persist !== "function") throw fail2("CHECKPOINT_PERSISTENCE_REQUIRED", "Durably persist the encrypted handoff before source retirement.");
  options = { ...options, secret: options.secret instanceof Uint8Array ? Uint8Array.from(options.secret) : options.secret };
  const release = reserveCheckpointStore(store);
  try {
    if (typeof store.entries !== "function") {
      throw fail2("CHECKPOINT_ENUMERATION_UNSUPPORTED", "The supplied BytesStore does not support deterministic checkpoint enumeration.");
    }
    await assertDeviceNotRetired(store);
    const rawEntries = (await store.entries()).filter((entry) => entry.key !== DEVICE_RETIRED_KEY).map((entry) => ({ key: entry.key, value: Uint8Array.from(entry.value) })).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    const seenKeys = /* @__PURE__ */ new Set();
    for (const entry of rawEntries) {
      if (typeof entry.key !== "string" || entry.key.length === 0 || entry.key.length > 4096 || [...entry.key].some((c) => c.charCodeAt(0) < 32) || seenKeys.has(entry.key)) throw fail2("CHECKPOINT_CORRUPT", "Invalid source checkpoint key.");
      seenKeys.add(entry.key);
    }
    const sqlBytes = options.sqlDatabaseBytes === void 0 || options.sqlDatabaseBytes === null ? null : Uint8Array.from(options.sqlDatabaseBytes);
    const outbox = structuredClone(options.outbox ?? []);
    if (rawEntries.length > checkpointLimit(options.limits, "maxEntries") || rawEntries.reduce((size, entry) => size + entry.value.byteLength, sqlBytes?.byteLength ?? 0) > checkpointLimit(options.limits, "maxBytes")) {
      throw fail2("CHECKPOINT_LIMIT_EXCEEDED", "Checkpoint data exceeds the bounded handoff limit.");
    }
    if (rawEntries.some((entry) => entry.value.length > checkpointLimit(options.limits, "maxValueBytes"))) throw fail2("CHECKPOINT_LIMIT_EXCEEDED", "Checkpoint value exceeds the handoff budget.");
    const createdAt = (/* @__PURE__ */ new Date()).toISOString();
    const manifestSha256 = await manifestDigest(rawEntries, sqlBytes, outbox);
    const metadata2 = Object.freeze({
      format: CHECKPOINT_FORMAT,
      applicationId: options.applicationId ?? null,
      deviceId: options.deviceId ?? null,
      createdAt,
      entryCount: rawEntries.length,
      hasSqlDatabase: sqlBytes !== null,
      outboxCount: outbox.length,
      manifestSha256
    });
    validateMetadata(metadata2, outbox);
    const plaintext = encoder2.encode(JSON.stringify({
      metadata: metadata2,
      entries: rawEntries.map((entry) => ({ key: entry.key, value: encodeBase64(entry.value) })),
      sqlDatabaseBase64: sqlBytes === null ? null : encodeBase64(sqlBytes),
      outbox
    }));
    const isRawKey = options.secret instanceof Uint8Array;
    const salt = isRawKey ? new Uint8Array(SALT_BYTES) : crypto.getRandomValues(new Uint8Array(SALT_BYTES));
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const key = await deriveAesKey(options.secret, salt, ["encrypt"]);
    const kdfHeader = new Uint8Array(isRawKey ? 0 : KDF_HEADER_BYTES);
    if (!isRawKey) {
      kdfHeader[0] = 1;
      new DataView(kdfHeader.buffer).setUint32(1, PBKDF2_ITERATIONS2);
    }
    const aad = checkpointAad(kdfHeader);
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, key, plaintext));
    const out = new Uint8Array(MAGIC.length + 1 + kdfHeader.length + SALT_BYTES + IV_BYTES + ciphertext.byteLength);
    let offset = 0;
    out.set(MAGIC, offset);
    offset += MAGIC.length;
    out[offset++] = isRawKey ? 1 : 2;
    out.set(kdfHeader, offset);
    offset += kdfHeader.length;
    out.set(salt, offset);
    offset += SALT_BYTES;
    out.set(iv, offset);
    offset += IV_BYTES;
    out.set(ciphertext, offset);
    await options.persist?.(Object.freeze({ bytes: out.slice(), metadata: metadata2 }));
    const retireSource = options.retireSource !== false;
    if (retireSource) {
      await store.put(DEVICE_RETIRED_KEY, encoder2.encode(JSON.stringify({ retiredAt: createdAt, manifestSha256 })));
      retireDeviceStore(store);
    }
    return Object.freeze({ bytes: out, metadata: metadata2, retiredSource: retireSource });
  } finally {
    release();
  }
}
async function restoreDeviceCheckpoint(targetStore, encryptedBytes, options) {
  if (typeof targetStore.entries !== "function" || typeof targetStore.putAllIfEmpty !== "function") throw fail2("CHECKPOINT_RESTORE_UNSUPPORTED", "Restore requires atomic empty-store initialization and enumeration.");
  const release = reserveCheckpointStore(targetStore);
  try {
    const headerLength = MAGIC.length + 1 + SALT_BYTES + IV_BYTES;
    if (!(encryptedBytes instanceof Uint8Array) || encryptedBytes.byteLength <= headerLength + 16) {
      throw fail2("CHECKPOINT_CORRUPT", "Encrypted checkpoint is truncated or invalid.");
    }
    for (let i = 0; i < MAGIC.length; i++) {
      if (encryptedBytes[i] !== MAGIC[i]) throw fail2("CHECKPOINT_FORMAT_UNSUPPORTED", "Unrecognized checkpoint header.");
    }
    let offset = MAGIC.length;
    const flags = encryptedBytes[offset++];
    if (flags !== 0 && flags !== 1 && flags !== 2) throw fail2("CHECKPOINT_CORRUPT", "Unrecognized checkpoint flags.");
    let iterations = LEGACY_PBKDF2_ITERATIONS;
    const kdfHeader = flags === 2 ? encryptedBytes.slice(offset, offset + KDF_HEADER_BYTES) : new Uint8Array();
    if (flags === 2) {
      if (encryptedBytes.length <= headerLength + KDF_HEADER_BYTES + 16 || kdfHeader[0] !== 1) throw fail2("CHECKPOINT_CORRUPT", "Unsupported checkpoint KDF.");
      iterations = new DataView(kdfHeader.buffer).getUint32(1);
      if (iterations < PBKDF2_ITERATIONS2 || iterations > 2e6) throw fail2("CHECKPOINT_CORRUPT", "Checkpoint KDF work factor is out of bounds.");
      offset += KDF_HEADER_BYTES;
    }
    const expectRaw = flags === 1;
    if (expectRaw !== options.secret instanceof Uint8Array) {
      throw fail2("CHECKPOINT_KEY_MISMATCH", expectRaw ? "This checkpoint requires a 32-byte raw key." : "This checkpoint requires a passphrase.");
    }
    const salt = encryptedBytes.subarray(offset, offset + SALT_BYTES);
    offset += SALT_BYTES;
    if (expectRaw && salt.some((byte) => byte !== 0)) throw fail2("CHECKPOINT_CORRUPT", "Raw-key checkpoint salt must be zero.");
    const iv = new Uint8Array(encryptedBytes.subarray(offset, offset + IV_BYTES));
    offset += IV_BYTES;
    const ciphertext = new Uint8Array(encryptedBytes.subarray(offset));
    const key = await deriveAesKey(options.secret, salt, ["decrypt"], iterations);
    const aad = checkpointAad(kdfHeader);
    let plaintext;
    try {
      plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: aad }, key, ciphertext);
    } catch {
      throw fail2("CHECKPOINT_DECRYPT_FAILED", "Checkpoint authentication or decryption failed (wrong key or tampered bytes).");
    }
    let decoded;
    try {
      decoded = JSON.parse(decoder.decode(new Uint8Array(plaintext)));
      if (decoded?.metadata?.format !== CHECKPOINT_FORMAT || !Array.isArray(decoded.entries) || decoded.entries.length > checkpointLimit(options.limits, "maxEntries") || !Array.isArray(decoded.outbox) || decoded.outbox.length > 1024 || decoded.metadata.entryCount !== decoded.entries.length || decoded.metadata.outboxCount !== decoded.outbox.length || decoded.metadata.hasSqlDatabase !== (decoded.sqlDatabaseBase64 !== null) || !(decoded.sqlDatabaseBase64 === null || typeof decoded.sqlDatabaseBase64 === "string")) throw new Error();
      validateMetadata(decoded.metadata, decoded.outbox);
      const seen = /* @__PURE__ */ new Set();
      for (const entry of decoded.entries) {
        if (!entry || typeof entry.key !== "string" || entry.key.length === 0 || entry.key.length > 4096 || [...entry.key].some((c) => c.charCodeAt(0) < 32) || typeof entry.value !== "string" || seen.has(entry.key) || entry.key === DEVICE_RETIRED_KEY) throw new Error();
        seen.add(entry.key);
      }
    } catch {
      throw fail2("CHECKPOINT_CORRUPT", "Decrypted checkpoint payload is malformed.");
    }
    let entries, sqlDatabaseBytes;
    try {
      entries = decoded.entries.map((item) => ({ key: item.key, value: decodeBase64(item.value) })).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
      sqlDatabaseBytes = decoded.sqlDatabaseBase64 === null ? null : decodeBase64(decoded.sqlDatabaseBase64);
    } catch {
      throw fail2("CHECKPOINT_CORRUPT", "Invalid encoded checkpoint data.");
    }
    if (entries.reduce((size, entry) => size + entry.value.byteLength, sqlDatabaseBytes?.byteLength ?? 0) > checkpointLimit(options.limits, "maxBytes")) throw fail2("CHECKPOINT_LIMIT_EXCEEDED", "Checkpoint data exceeds the bounded handoff limit.");
    if (entries.some((entry) => entry.value.length > checkpointLimit(options.limits, "maxValueBytes"))) throw fail2("CHECKPOINT_LIMIT_EXCEEDED", "Checkpoint value exceeds the handoff budget.");
    const actualDigest = await manifestDigest(entries, sqlDatabaseBytes, decoded.outbox);
    if (actualDigest !== decoded.metadata.manifestSha256) {
      throw fail2("CHECKPOINT_INTEGRITY_MISMATCH", "Checkpoint manifest SHA-256 verification failed.");
    }
    if (!await targetStore.putAllIfEmpty(entries)) throw fail2("CHECKPOINT_TARGET_NOT_EMPTY", "Restore requires a fresh target; existing identity is never overwritten.");
    if (typeof targetStore.entries === "function") {
      const readback = [...await targetStore.entries()].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
      const readbackDigest = await manifestDigest(readback, sqlDatabaseBytes, decoded.outbox);
      if (readbackDigest !== actualDigest) {
        throw fail2("CHECKPOINT_RESTORE_VERIFICATION_FAILED", "Restored store contents did not match the checkpoint manifest.");
      }
    }
    return Object.freeze({
      metadata: Object.freeze(decoded.metadata),
      sqlDatabaseBytes,
      outbox: Object.freeze(decoded.outbox),
      restoredEntries: entries.length
    });
  } finally {
    release();
  }
}
function generateCheckpointKey() {
  return crypto.getRandomValues(new Uint8Array(32));
}
function encodeCheckpointKeyHex(key) {
  if (key.byteLength !== 32) throw fail2("CHECKPOINT_KEY_INVALID", "Checkpoint key must be 32 bytes.");
  return bytesToHex(key);
}
function decodeCheckpointKeyHex(hex) {
  if (typeof hex !== "string" || !/^[0-9a-f]{64}$/iu.test(hex)) {
    throw fail2("CHECKPOINT_KEY_INVALID", "Checkpoint key must be 64 hexadecimal characters.");
  }
  return hexToBytes(hex.toLowerCase());
}

// packages/peer-session/src/checkpoint-stream.ts
var STREAM_CHECKPOINT_FORMAT = "chronolog-device-checkpoint-v2";
var MAGIC2 = Uint8Array.of(67, 76, 67, 80, 2);
var BLOCK = 65536;
var MAX_FRAME = 2 * 1024 * 1024;
var text = new TextEncoder();
var utf8 = new TextDecoder("utf-8", { fatal: true });
var fail3 = (code) => Object.assign(new Error(code), { code });
function budget(limits, name) {
  const value = limits?.[name] ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(value) || value < 0) throw fail3("CHECKPOINT_LIMIT_INVALID");
  return value;
}
function keyValid(key) {
  if (typeof key !== "string" || key.length === 0 || key.length > 4096 || [...key].some((c) => c.charCodeAt(0) < 32) || key === DEVICE_RETIRED_KEY) throw fail3("CHECKPOINT_CORRUPT");
}
function outboxRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !["operationId", "command", "payloadHash", "createdAt", "status"].includes(key))) throw fail3("CHECKPOINT_CORRUPT");
  validateMetadata({
    format: STREAM_CHECKPOINT_FORMAT,
    applicationId: null,
    deviceId: null,
    createdAt: "1970-01-01T00:00:00.000Z",
    entryCount: 0,
    hasSqlDatabase: false,
    outboxCount: 1,
    manifestSha256: "0".repeat(64)
  }, [value]);
}
function sizeValid(size) {
  if (!Number.isSafeInteger(size) || size < 0) throw fail3("CHECKPOINT_CORRUPT");
}
function join(...parts) {
  const out = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
function uint(value) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
}
async function chain(previous, frame) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", join(previous, frame)));
}
function jsonFrame(kind, value) {
  return join(Uint8Array.of(kind), text.encode(JSON.stringify(value)));
}
function nonce(header, index) {
  if (index >= 2 ** 32) throw fail3("CHECKPOINT_LIMIT_EXCEEDED");
  return join(header.subarray(27, 35), uint(index));
}
function metadata(options, count, digest, createdAt) {
  return {
    format: STREAM_CHECKPOINT_FORMAT,
    applicationId: options.applicationId ?? null,
    deviceId: options.deviceId ?? null,
    createdAt,
    entryCount: count,
    hasSqlDatabase: options.sqlDatabase !== void 0,
    outboxCount: options.outbox?.length ?? 0,
    manifestSha256: bytesToHex(digest)
  };
}
async function exportDeviceCheckpointStream(store, options) {
  if (store.iterateEntries === void 0) throw fail3("CHECKPOINT_ENUMERATION_UNSUPPORTED");
  const maxBytes = budget(options.limits, "maxBytes"), maxEntries = budget(options.limits, "maxEntries"), maxValue = budget(options.limits, "maxValueBytes");
  const release = reserveCheckpointStore(store);
  try {
    await assertDeviceNotRetired(store);
    const secret = options.secret instanceof Uint8Array ? Uint8Array.from(options.secret) : options.secret;
    const outbox = structuredClone(options.outbox ?? []), createdAt = (/* @__PURE__ */ new Date()).toISOString();
    let digest = new Uint8Array(32), index = 0, count = 0, total = 0;
    validateMetadata(metadata(options, 0, digest, createdAt), outbox);
    for (const record of outbox) outboxRecord(record);
    const header = join(
      MAGIC2,
      Uint8Array.of(secret instanceof Uint8Array ? 1 : 0),
      Uint8Array.of(1),
      uint(secret instanceof Uint8Array ? 0 : 6e5),
      secret instanceof Uint8Array ? new Uint8Array(16) : crypto.getRandomValues(new Uint8Array(16)),
      crypto.getRandomValues(new Uint8Array(8))
    );
    const key = await deriveAesKey(secret, header.subarray(11, 27), ["encrypt"]);
    let tag = new Uint8Array(16);
    await options.sink.write(header);
    const write = async (frame, hash = true) => {
      if (frame.length > MAX_FRAME) throw fail3("CHECKPOINT_LIMIT_EXCEEDED");
      const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce(header, index++), additionalData: join(header, tag) }, key, join(frame)));
      tag = encrypted.slice(-16);
      await options.sink.write(join(uint(encrypted.length), encrypted));
      if (hash) digest = await chain(digest, frame);
    };
    for await (const entry of store.iterateEntries()) {
      if (entry.key === DEVICE_RETIRED_KEY) continue;
      keyValid(entry.key);
      if (++count > maxEntries || entry.value.length > maxValue || total + entry.value.length > maxBytes) throw fail3("CHECKPOINT_LIMIT_EXCEEDED");
      total += entry.value.length;
      await write(jsonFrame(1, { key: entry.key, bytes: entry.value.length }));
      for (let offset = 0; offset < entry.value.length; offset += BLOCK) await write(join(Uint8Array.of(2), entry.value.subarray(offset, offset + BLOCK)));
    }
    if (options.sqlDatabase !== void 0) {
      const sql = options.sqlDatabase;
      sizeValid(sql.bytes);
      if (total + sql.bytes > maxBytes) throw fail3("CHECKPOINT_LIMIT_EXCEEDED");
      await write(jsonFrame(3, { bytes: sql.bytes }));
      let size = 0;
      for await (const part of sql.chunks) {
        size += part.length;
        if (size > sql.bytes) throw fail3("CHECKPOINT_CORRUPT");
        for (let offset = 0; offset < part.length; offset += BLOCK) await write(join(Uint8Array.of(4), part.subarray(offset, offset + BLOCK)));
      }
      if (size !== sql.bytes) throw fail3("CHECKPOINT_CORRUPT");
    }
    for (const record of outbox) await write(jsonFrame(6, record));
    const result = Object.freeze(metadata({ ...options, outbox }, count, digest, createdAt));
    await write(jsonFrame(5, { metadata: result }), false);
    await options.sink.commit(result);
    const retireSource = options.retireSource !== false;
    if (retireSource) {
      await store.put(DEVICE_RETIRED_KEY, text.encode(JSON.stringify({ retiredAt: createdAt, manifestSha256: result.manifestSha256 })));
      retireDeviceStore(store);
    }
    return { metadata: result, retiredSource: retireSource };
  } catch (error) {
    try {
      await options.sink.abort?.(error);
    } catch {
    }
    throw error;
  } finally {
    release();
  }
}
var StreamReader = class {
  #iterator;
  #part = new Uint8Array();
  #offset = 0;
  constructor(source) {
    this.#iterator = source[Symbol.asyncIterator]();
  }
  async read(size, eof = false) {
    const bytes = new Uint8Array(size);
    let offset = 0;
    while (offset < size) {
      if (this.#offset === this.#part.length) {
        const next = await this.#iterator.next();
        if (next.done === true) {
          if (eof && offset === 0) return null;
          throw fail3("CHECKPOINT_CORRUPT");
        }
        if (!(next.value instanceof Uint8Array)) throw fail3("CHECKPOINT_CORRUPT");
        this.#part = next.value;
        this.#offset = 0;
        continue;
      }
      const length = Math.min(size - offset, this.#part.length - this.#offset);
      bytes.set(this.#part.subarray(this.#offset, this.#offset + length), offset);
      offset += length;
      this.#offset += length;
    }
    return bytes;
  }
  async close() {
    await this.#iterator.return?.();
  }
};
async function restoreDeviceCheckpointStream(target, source, options) {
  if (target.putStreamIfEmpty === void 0 || target.iterateEntries === void 0) throw fail3("CHECKPOINT_RESTORE_UNSUPPORTED");
  const maxBytes = budget(options.limits, "maxBytes"), maxEntries = budget(options.limits, "maxEntries"), maxValue = budget(options.limits, "maxValueBytes");
  const release = reserveCheckpointStore(target), reader = new StreamReader(source);
  let result, sqlDatabaseBytes = null;
  try {
    const header = await reader.read(35);
    if (!MAGIC2.every((byte, index2) => header[index2] === byte)) throw fail3("CHECKPOINT_FORMAT_UNSUPPORTED");
    const raw = header[5] === 1, iterations = new DataView(header.buffer).getUint32(7);
    if (header[5] !== 0 && !raw || header[6] !== 1 || (raw ? iterations !== 0 || header.subarray(11, 27).some((byte) => byte !== 0) : iterations < 6e5 || iterations > 2e6)) throw fail3("CHECKPOINT_CORRUPT");
    if (raw !== options.secret instanceof Uint8Array) throw fail3("CHECKPOINT_KEY_MISMATCH");
    const secret = options.secret instanceof Uint8Array ? Uint8Array.from(options.secret) : options.secret;
    const key = await deriveAesKey(secret, header.subarray(11, 27), ["decrypt"], iterations);
    let tag = new Uint8Array(16), digest = new Uint8Array(32), entrySum = 0n, index = 0, count = 0, total = 0, sqlSeen = false;
    const nextFrame = async () => {
      const lengthBytes = await reader.read(4), length = new DataView(lengthBytes.buffer).getUint32(0);
      if (length < 17 || length > MAX_FRAME + 16) throw fail3("CHECKPOINT_CORRUPT");
      const encrypted = await reader.read(length);
      let frame;
      try {
        frame = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce(header, index++), additionalData: join(header, tag) }, key, encrypted));
      } catch {
        throw fail3("CHECKPOINT_DECRYPT_FAILED");
      }
      tag = encrypted.slice(-16);
      if (frame[0] !== 5) digest = await chain(digest, frame);
      return frame;
    };
    const outbox = [];
    const entries = async function* () {
      for (; ; ) {
        const frame = await nextFrame();
        if (frame[0] === 5) {
          result = { metadata: JSON.parse(utf8.decode(frame.subarray(1))).metadata, outbox };
          if (result.metadata?.format !== STREAM_CHECKPOINT_FORMAT) throw fail3("CHECKPOINT_CORRUPT");
          validateMetadata(result.metadata, result.outbox);
          if (result.metadata.entryCount !== count || result.metadata.hasSqlDatabase !== sqlSeen || result.metadata.outboxCount !== result.outbox.length || result.metadata.manifestSha256 !== bytesToHex(digest)) throw fail3("CHECKPOINT_INTEGRITY_MISMATCH");
          if (await reader.read(1, true) !== null) throw fail3("CHECKPOINT_CORRUPT");
          if (sqlSeen) await options.sqlSink?.commit(result.metadata);
          return;
        }
        if (frame[0] === 6) {
          if (outbox.length >= 1024) throw fail3("CHECKPOINT_CORRUPT");
          const record = JSON.parse(utf8.decode(frame.subarray(1)));
          outboxRecord(record);
          outbox.push(record);
          continue;
        }
        if (frame[0] !== 1 && frame[0] !== 3 || sqlSeen || outbox.length !== 0) throw fail3("CHECKPOINT_CORRUPT");
        const entry = JSON.parse(utf8.decode(frame.subarray(1)));
        sizeValid(entry.bytes);
        total += entry.bytes;
        if (total > maxBytes) throw fail3("CHECKPOINT_LIMIT_EXCEEDED");
        const sql = frame[0] === 3;
        if (sql) sqlSeen = true;
        else {
          keyValid(entry.key);
          if (++count > maxEntries) throw fail3("CHECKPOINT_LIMIT_EXCEEDED");
        }
        if ((!sql || options.sqlSink === void 0) && entry.bytes > maxValue) throw fail3("CHECKPOINT_LIMIT_EXCEEDED");
        const value = sql && options.sqlSink !== void 0 ? null : new Uint8Array(entry.bytes);
        let entryDigest = await chain(new Uint8Array(32), jsonFrame(1, { key: entry.key, bytes: entry.bytes }));
        let offset = 0;
        while (offset < entry.bytes) {
          const part = await nextFrame();
          if (part[0] !== (sql ? 4 : 2) || part.length <= 1 || part.length > BLOCK + 1 || offset + part.length - 1 > entry.bytes || !sql && part.length - 1 !== Math.min(BLOCK, entry.bytes - offset)) throw fail3("CHECKPOINT_CORRUPT");
          if (value === null) await options.sqlSink.write(part.subarray(1));
          else value.set(part.subarray(1), offset);
          entryDigest = await chain(entryDigest, part);
          offset += part.length - 1;
        }
        if (sql) sqlDatabaseBytes = value;
        else {
          entrySum = (entrySum + BigInt("0x" + bytesToHex(entryDigest))) % (1n << 256n);
          yield { key: entry.key, value };
        }
      }
    };
    if (!await target.putStreamIfEmpty(entries())) throw fail3("CHECKPOINT_TARGET_NOT_EMPTY");
    if (result === void 0) throw fail3("CHECKPOINT_CORRUPT");
    let readbackSum = 0n, readbackCount = 0;
    for await (const entry of target.iterateEntries()) {
      let readback = await chain(new Uint8Array(32), jsonFrame(1, { key: entry.key, bytes: entry.value.length }));
      for (let offset = 0; offset < entry.value.length; offset += BLOCK) readback = await chain(readback, join(Uint8Array.of(2), entry.value.subarray(offset, offset + BLOCK)));
      readbackSum = (readbackSum + BigInt("0x" + bytesToHex(readback))) % (1n << 256n);
      readbackCount++;
    }
    if (readbackSum !== entrySum || readbackCount !== count) throw fail3("CHECKPOINT_RESTORE_VERIFICATION_FAILED");
    return { metadata: Object.freeze(result.metadata), outbox: Object.freeze(result.outbox), restoredEntries: count, sqlDatabaseBytes };
  } catch (error) {
    try {
      await options.sqlSink?.abort?.(error);
    } catch {
    }
    throw error;
  } finally {
    try {
      await reader.close();
    } finally {
      release();
    }
  }
}

// packages/peer-session/src/device.ts
var DEVICE_KEY = "peer-session/device/v1";
var DEVICE_BINDING = "peer-session/device-binding/v1";
var STORAGE_BINDING = "peer-session/storage-binding/v1";
var STORAGE_OPENED = "peer-session/storage-opened/v1";
var claimed = /* @__PURE__ */ new WeakSet();
async function openApplicationDevice(options) {
  const releaseOpening = useDeviceStore(options.store);
  try {
    await assertDeviceNotRetired(options.store);
    const managedSigner = options.managedSigner && { ...options.managedSigner };
    if (managedSigner) await verifyDeviceSigner(managedSigner);
    let raw = await options.store.get(DEVICE_KEY), binding = await options.store.get(DEVICE_BINDING);
    if (raw === null && binding !== null) raw = await options.store.get(DEVICE_KEY);
    let identity, storageId;
    if (raw === null) {
      if (binding !== null) throw new Error("APPLICATION_DEVICE_KEYS_MISSING");
      if (options.create !== true) throw new Error("APPLICATION_DEVICE_NOT_FOUND");
      const candidate = managedSigner ?? await createSigningIdentity();
      const candidateStorageId = crypto.randomUUID();
      const record = managedSigner ? [2n, candidate.publicKey, candidateStorageId] : [1n, candidate.publicKey, await exportEd25519PrivateKey(candidate.privateKey), candidateStorageId];
      const entries = [
        { key: DEVICE_BINDING, value: encodeCanonicalCbor([candidate.publicKey, candidateStorageId]) },
        { key: DEVICE_KEY, value: encodeCanonicalCbor(record) }
      ];
      if (options.store.initialize !== void 0) await options.store.initialize(entries);
      else for (const entry of entries) await options.store.put(entry.key, entry.value);
      raw = await options.store.get(DEVICE_KEY);
      binding = await options.store.get(DEVICE_BINDING);
      if (raw === null) throw new Error(binding === null ? "APPLICATION_DEVICE_NOT_FOUND" : "APPLICATION_DEVICE_KEYS_MISSING");
    }
    {
      const value = assertCanonicalCbor(raw);
      if (!Array.isArray(value) || typeof value[1] !== "string" || !/^[0-9a-f]{64}$/u.test(value[1])) throw new Error("APPLICATION_DEVICE_INVALID");
      if (value[0] === 2n && value.length === 3 && validStorageId(value[2])) {
        if (managedSigner === void 0) throw new Error("APPLICATION_DEVICE_MANAGED_SIGNER_REQUIRED");
        if (managedSigner.publicKey !== value[1]) throw new Error("APPLICATION_DEVICE_KEY_MISMATCH");
        identity = managedSigner;
        storageId = value[2];
      } else if (value[0] === 1n && value.length === 4 && value[2] instanceof Uint8Array && validStorageId(value[3])) {
        if (managedSigner !== void 0) throw new Error("APPLICATION_DEVICE_STORAGE_MODE_MISMATCH");
        identity = { publicKey: value[1], privateKey: await importEd25519PrivateKey(value[2]) };
        storageId = value[3];
        await verifyDeviceSigner(identity);
      } else throw new Error("APPLICATION_DEVICE_INVALID");
      if (binding === null || !sameBytes(binding, encodeCanonicalCbor([identity.publicKey, storageId]))) throw new Error("APPLICATION_DEVICE_BINDING_INVALID");
    }
    let closed = false, storage;
    let opening, closing;
    return Object.freeze({
      identity: Object.freeze(identity),
      storageId,
      store: options.store,
      openStorage() {
        if (closed) return Promise.reject(new Error("APPLICATION_DEVICE_CLOSED"));
        return opening ??= Promise.resolve().then(async () => {
          if (closed) throw new Error("APPLICATION_DEVICE_CLOSED");
          const resource = options.openStorage === void 0 ? { store: options.store, close() {
          } } : await options.openStorage();
          let releasing;
          const acquired = Object.freeze({
            store: resource.store,
            close: () => releasing ??= Promise.resolve().then(() => resource.close())
          });
          storage = acquired;
          try {
            if (closed) throw new Error("APPLICATION_DEVICE_CLOSED");
            const expected = encodeCanonicalCbor([identity.publicKey, storageId]);
            const opened = await options.store.get(STORAGE_OPENED), retained = await acquired.store.get(STORAGE_BINDING);
            if (opened !== null && !sameBytes(opened, expected) || retained !== null && !sameBytes(retained, expected)) {
              throw new Error("APPLICATION_DATA_STORAGE_BINDING_INVALID");
            }
            if (opened !== null && retained === null) throw new Error("APPLICATION_DATA_STORAGE_MISSING");
            if (retained === null) await acquired.store.put(STORAGE_BINDING, expected);
            if (opened === null) await options.store.put(STORAGE_OPENED, expected);
            if (closed) throw new Error("APPLICATION_DEVICE_CLOSED");
            return acquired;
          } catch (error) {
            storage = void 0;
            try {
              await acquired.close();
            } catch {
            }
            throw error;
          }
        });
      },
      close() {
        if (closing !== void 0) return closing;
        closed = true;
        closing = (async () => {
          try {
            await opening?.catch(() => void 0);
            await storage?.close();
          } finally {
            await options.close?.();
          }
        })();
        return closing;
      }
    });
  } finally {
    releaseOpening();
  }
}
function claimApplicationDevice(device) {
  if (claimed.has(device)) throw new Error("APPLICATION_DEVICE_IN_USE");
  const release = useDeviceStore(device.store);
  claimed.add(device);
  return () => {
    claimed.delete(device);
    release();
  };
}
function validStorageId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}
async function verifyDeviceSigner(identity) {
  if (!/^[0-9a-f]{64}$/u.test(identity.publicKey)) throw new Error("APPLICATION_DEVICE_KEY_MISMATCH");
  const proof = new TextEncoder().encode("chronolog/device-resume/v1");
  const signature = await crypto.subtle.sign("Ed25519", identity.privateKey, proof);
  if (!await crypto.subtle.verify("Ed25519", await importEd25519PublicKey(hexToBytes(identity.publicKey)), signature, proof)) {
    throw new Error("APPLICATION_DEVICE_KEY_MISMATCH");
  }
}
function sameBytes(a, b) {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

export {
  STREAM_CHECKPOINT_FORMAT,
  exportDeviceCheckpointStream,
  restoreDeviceCheckpointStream,
  CHECKPOINT_FORMAT,
  DEVICE_RETIRED_KEY,
  isDeviceRetired,
  assertDeviceNotRetired,
  exportDeviceCheckpoint,
  restoreDeviceCheckpoint,
  generateCheckpointKey,
  encodeCheckpointKeyHex,
  decodeCheckpointKeyHex,
  openApplicationDevice,
  claimApplicationDevice,
  verifyDeviceSigner
};
