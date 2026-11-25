import {
  CONTENT_CHUNK_BYTES,
  MAX_CONTENT_BYTES,
  putContentBytes,
  readContentBytes
} from "./chunk-7JXKVFZF.mjs";
import {
  check,
  decodeRecord,
  encodeRecord,
  equalRecord,
  recordDigest,
  signRecord,
  verifyRecord
} from "./chunk-CZMLHZUQ.mjs";
import {
  awaitOwnedTask
} from "./chunk-KSC4KBWO.mjs";
import {
  ProtocolError,
  integerMap,
  protocolInvariant,
  utf8
} from "./chunk-MAGRVNAE.mjs";
import {
  assertCanonicalCbor,
  bytesToHex,
  concatBytes,
  encodeCanonicalCbor,
  sha256
} from "./chunk-HYFY2E3E.mjs";

// packages/crypto/src/hpke.ts
var HPKE_SUITE = "DHKEM(X25519,HKDF-SHA256)/HKDF-SHA256/AES-256-GCM";
var KEM_ID = Uint8Array.of(0, 32);
var KDF_ID = Uint8Array.of(0, 1);
var AEAD_ID = Uint8Array.of(0, 2);
var KEM_SUITE_ID = concatBytes(utf8("KEM"), KEM_ID);
var HPKE_SUITE_ID = concatBytes(utf8("HPKE"), KEM_ID, KDF_ID, AEAD_ID);
var HPKE_VERSION = utf8("HPKE-v1");
var HASH_SIZE = 32;
var X25519 = { name: "X25519" };
function source(value) {
  return Uint8Array.from(value).buffer;
}
function i2osp(value, length) {
  protocolInvariant(Number.isSafeInteger(value) && value >= 0 && value < 2 ** (8 * length), "INTEGER_OUT_OF_RANGE", "Integer does not fit HPKE field");
  const result = new Uint8Array(length);
  let remainder = value;
  for (let index = length - 1; index >= 0; index -= 1) {
    result[index] = remainder & 255;
    remainder = Math.floor(remainder / 256);
  }
  return result;
}
async function hmac(keyBytes, data) {
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    source(keyBytes),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return new Uint8Array(await globalThis.crypto.subtle.sign("HMAC", key, source(data)));
}
async function hkdfExtract(salt, ikm) {
  return hmac(salt.length === 0 ? new Uint8Array(HASH_SIZE) : salt, ikm);
}
async function hkdfExpand(prk, info, length) {
  protocolInvariant(length <= 255 * HASH_SIZE, "INTEGER_OUT_OF_RANGE", "HKDF output is too long");
  let previous = new Uint8Array();
  const blocks = [];
  for (let counter = 1; blocks.reduce((sum, block) => sum + block.length, 0) < length; counter += 1) {
    previous = await hmac(prk, concatBytes(previous, info, Uint8Array.of(counter)));
    blocks.push(previous);
  }
  return concatBytes(...blocks).slice(0, length);
}
async function labeledExtract(suiteId, salt, label, ikm) {
  return hkdfExtract(salt, concatBytes(HPKE_VERSION, suiteId, utf8(label), ikm));
}
async function labeledExpand(suiteId, prk, label, info, length) {
  return hkdfExpand(prk, concatBytes(i2osp(length, 2), HPKE_VERSION, suiteId, utf8(label), info), length);
}
async function generateX25519KeyPair(extractable = true) {
  const pair = await globalThis.crypto.subtle.generateKey(X25519, extractable, ["deriveBits"]);
  return {
    publicKey: pair.publicKey,
    privateKey: pair.privateKey,
    publicKeyBytes: new Uint8Array(await globalThis.crypto.subtle.exportKey("raw", pair.publicKey))
  };
}
async function importX25519PublicKey(raw) {
  protocolInvariant(raw.length === 32, "INVALID_KEY", "X25519 public key must contain 32 bytes");
  try {
    return await globalThis.crypto.subtle.importKey("raw", source(raw), X25519, true, []);
  } catch {
    throw new ProtocolError("INVALID_KEY", "Unable to import X25519 public key");
  }
}
async function importX25519PrivateKey(pkcs8, extractable = true) {
  try {
    return await globalThis.crypto.subtle.importKey("pkcs8", source(pkcs8), X25519, extractable, ["deriveBits"]);
  } catch {
    throw new ProtocolError("INVALID_KEY", "Unable to import X25519 private key");
  }
}
async function exportX25519PrivateKey(privateKey) {
  try {
    return new Uint8Array(await globalThis.crypto.subtle.exportKey("pkcs8", privateKey));
  } catch {
    throw new ProtocolError("INVALID_KEY", "X25519 private key is not extractable");
  }
}
async function dh(privateKey, publicKey) {
  try {
    const bits = await globalThis.crypto.subtle.deriveBits({ name: "X25519", public: publicKey }, privateKey, 256);
    const result = new Uint8Array(bits);
    protocolInvariant(result.some((byte) => byte !== 0), "INVALID_KEY", "X25519 produced the prohibited all-zero shared secret");
    return result;
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    throw new ProtocolError("INVALID_KEY", "X25519 key agreement failed");
  }
}
async function extractAndExpand(dhValue, kemContext) {
  const eaePrk = await labeledExtract(KEM_SUITE_ID, new Uint8Array(), "eae_prk", dhValue);
  return labeledExpand(KEM_SUITE_ID, eaePrk, "shared_secret", kemContext, HASH_SIZE);
}
async function keySchedule(sharedSecret, info) {
  const pskIdHash = await labeledExtract(HPKE_SUITE_ID, new Uint8Array(), "psk_id_hash", new Uint8Array());
  const infoHash = await labeledExtract(HPKE_SUITE_ID, new Uint8Array(), "info_hash", info);
  const keyScheduleContext = concatBytes(Uint8Array.of(0), pskIdHash, infoHash);
  const secret = await labeledExtract(HPKE_SUITE_ID, sharedSecret, "secret", new Uint8Array());
  return {
    key: await labeledExpand(HPKE_SUITE_ID, secret, "key", keyScheduleContext, 32),
    nonce: await labeledExpand(HPKE_SUITE_ID, secret, "base_nonce", keyScheduleContext, 12),
    exporterSecret: await labeledExpand(HPKE_SUITE_ID, secret, "exp", keyScheduleContext, HASH_SIZE)
  };
}
async function aesGcmSeal(keyBytes, nonce, plaintext, aad) {
  const key = await globalThis.crypto.subtle.importKey("raw", source(keyBytes), "AES-GCM", false, ["encrypt"]);
  return new Uint8Array(await globalThis.crypto.subtle.encrypt(
    { name: "AES-GCM", iv: source(nonce), additionalData: source(aad), tagLength: 128 },
    key,
    source(plaintext)
  ));
}
async function aesGcmOpen(keyBytes, nonce, ciphertext, aad) {
  try {
    const key = await globalThis.crypto.subtle.importKey("raw", source(keyBytes), "AES-GCM", false, ["decrypt"]);
    return new Uint8Array(await globalThis.crypto.subtle.decrypt(
      { name: "AES-GCM", iv: source(nonce), additionalData: source(aad), tagLength: 128 },
      key,
      source(ciphertext)
    ));
  } catch {
    throw new ProtocolError("INVALID_SIGNATURE", "HPKE ciphertext authentication failed");
  }
}
async function senderContext(recipientPublicKeyBytes, info) {
  const recipientPublicKey = await importX25519PublicKey(recipientPublicKeyBytes);
  const ephemeral = await generateX25519KeyPair(false);
  const sharedSecret = await extractAndExpand(
    await dh(ephemeral.privateKey, recipientPublicKey),
    concatBytes(ephemeral.publicKeyBytes, recipientPublicKeyBytes)
  );
  try {
    return { encapsulatedKey: ephemeral.publicKeyBytes, context: await keySchedule(sharedSecret, info) };
  } finally {
    sharedSecret.fill(0);
  }
}
async function recipientContext(recipientPrivateKey, recipientPublicKeyBytes, encapsulatedKey, info) {
  protocolInvariant(recipientPublicKeyBytes.length === 32 && encapsulatedKey.length === 32, "INVALID_KEY", "HPKE X25519 keys must contain 32 bytes");
  const ephemeralPublicKey = await importX25519PublicKey(encapsulatedKey);
  const sharedSecret = await extractAndExpand(
    await dh(recipientPrivateKey, ephemeralPublicKey),
    concatBytes(encapsulatedKey, recipientPublicKeyBytes)
  );
  try {
    return await keySchedule(sharedSecret, info);
  } finally {
    sharedSecret.fill(0);
  }
}
function clearContext(context) {
  context.key.fill(0);
  context.nonce.fill(0);
  context.exporterSecret.fill(0);
}
async function hpkeSealBase(recipientPublicKeyBytes, plaintext, info, aad) {
  const { encapsulatedKey, context } = await senderContext(recipientPublicKeyBytes, info);
  try {
    return { encapsulatedKey, ciphertext: await aesGcmSeal(context.key, context.nonce, plaintext, aad) };
  } finally {
    clearContext(context);
  }
}
async function hpkeOpenBase(recipientPrivateKey, recipientPublicKeyBytes, encapsulatedKey, ciphertext, info, aad) {
  const context = await recipientContext(recipientPrivateKey, recipientPublicKeyBytes, encapsulatedKey, info);
  try {
    return await aesGcmOpen(context.key, context.nonce, ciphertext, aad);
  } finally {
    clearContext(context);
  }
}
async function hpkeSendExportBase(recipientPublicKeyBytes, info, exporterContext, length) {
  const { encapsulatedKey, context } = await senderContext(recipientPublicKeyBytes, info);
  try {
    return { encapsulatedKey, exportedSecret: await labeledExpand(HPKE_SUITE_ID, context.exporterSecret, "sec", exporterContext, length) };
  } finally {
    clearContext(context);
  }
}
async function hpkeReceiveExportBase(recipientPrivateKey, recipientPublicKeyBytes, encapsulatedKey, info, exporterContext, length) {
  const context = await recipientContext(recipientPrivateKey, recipientPublicKeyBytes, encapsulatedKey, info);
  try {
    return await labeledExpand(HPKE_SUITE_ID, context.exporterSecret, "sec", exporterContext, length);
  } finally {
    clearContext(context);
  }
}

// packages/crypto/src/epoch.ts
function source2(value) {
  return Uint8Array.from(value).buffer;
}
function payloadAad(epoch, associatedData) {
  return encodeCanonicalCbor(integerMap([[0, 1n], [1, epoch], [2, associatedData]]));
}
async function encryptEpochPayload(contentKey, epoch, plaintext, associatedData) {
  protocolInvariant(contentKey.length === 32, "INVALID_KEY", "Epoch content key must contain 32 bytes");
  const key = await globalThis.crypto.subtle.importKey("raw", source2(contentKey), "AES-GCM", false, ["encrypt"]);
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await globalThis.crypto.subtle.encrypt(
    { name: "AES-GCM", iv: source2(nonce), additionalData: source2(payloadAad(epoch, associatedData)), tagLength: 128 },
    key,
    source2(plaintext)
  ));
  return { epoch, nonce, ciphertext };
}
async function decryptEpochPayload(contentKey, payload, associatedData) {
  protocolInvariant(contentKey.length === 32, "INVALID_KEY", "Epoch content key must contain 32 bytes");
  protocolInvariant(payload.nonce.length === 12, "SCHEMA_INVALID", "Epoch payload nonce must contain 12 bytes");
  try {
    const key = await globalThis.crypto.subtle.importKey("raw", source2(contentKey), "AES-GCM", false, ["decrypt"]);
    return new Uint8Array(await globalThis.crypto.subtle.decrypt(
      { name: "AES-GCM", iv: source2(payload.nonce), additionalData: source2(payloadAad(payload.epoch, associatedData)), tagLength: 128 },
      key,
      source2(payload.ciphertext)
    ));
  } catch {
    throw new ProtocolError("INVALID_SIGNATURE", "Epoch payload authentication failed");
  }
}

// packages/peer-session/src/content.ts
var MAX_CONTENT_CHUNKS = MAX_CONTENT_BYTES / CONTENT_CHUNK_BYTES;
var MAX_CONTENT_ENCRYPTED_CHUNK_BYTES = CONTENT_CHUNK_BYTES * 2 + 1024;
var MAX_CONTENT_MANIFEST_BYTES = 256 * 1024;
var digest = (value) => typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
var stageId = (value) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value);
function object(value, keys) {
  check(value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)), "CONTENT_SHAPE_INVALID");
}
function assertReferenceBody(value) {
  object(value, ["profile", "applicationId", "epoch", "bytes", "mediaType"]);
  check(value.profile === "authored-content-v1" && digest(value.applicationId) && Number.isSafeInteger(value.epoch) && Number(value.epoch) >= 0 && Number.isSafeInteger(value.bytes) && Number(value.bytes) >= 0 && Number(value.bytes) <= MAX_CONTENT_BYTES && typeof value.mediaType === "string" && value.mediaType.length > 0 && value.mediaType.length <= 256 && /^[\x20-\x7e]+$/u.test(value.mediaType), "CONTENT_REFERENCE_INVALID");
}
function assertContentReference(value) {
  object(value, ["profile", "applicationId", "id", "epoch", "bytes", "mediaType"]);
  check(digest(value.id), "CONTENT_REFERENCE_INVALID");
  const { id: _id, ...body2 } = value;
  assertReferenceBody(body2);
}
function assertContentManifest(value) {
  object(value, ["stageId", "reference", "chunks"]);
  check(stageId(value.stageId), "CONTENT_MANIFEST_INVALID");
  assertReferenceBody(value.reference);
  check(Array.isArray(value.chunks) && value.chunks.length <= MAX_CONTENT_CHUNKS && value.chunks.length === Math.ceil(value.reference.bytes / CONTENT_CHUNK_BYTES), "CONTENT_MANIFEST_INVALID");
  for (const chunk of value.chunks) {
    object(chunk, ["hash", "bytes"]);
    check(digest(chunk.hash) && Number.isSafeInteger(chunk.bytes) && Number(chunk.bytes) > 0 && Number(chunk.bytes) <= MAX_CONTENT_ENCRYPTED_CHUNK_BYTES, "CONTENT_MANIFEST_INVALID");
  }
  check(encodeRecord(value).length <= MAX_CONTENT_MANIFEST_BYTES, "CONTENT_MANIFEST_INVALID");
}
function assertContentRetention(value) {
  object(value, ["payload", "signer", "signature"]);
  check(digest(value.signer) && typeof value.signature === "string" && /^[0-9a-f]{128}$/u.test(value.signature), "CONTENT_RETENTION_INVALID");
  object(value.payload, ["reference", "peer", "storageId"]);
  assertContentReference(value.payload.reference);
  check(value.payload.peer === value.signer && typeof value.payload.storageId === "string" && value.payload.storageId.length > 0 && value.payload.storageId.length <= 256, "CONTENT_RETENTION_INVALID");
}
function body(reference) {
  const { id: _id, ...rest } = reference;
  return rest;
}
function envelope(bytes, epoch, plaintextBytes) {
  check(bytes.length > 0 && bytes.length <= MAX_CONTENT_ENCRYPTED_CHUNK_BYTES, "CONTENT_CHUNK_INVALID");
  const value = decodeRecord(bytes);
  object(value, ["epoch", "nonce", "ciphertext"]);
  check(value.epoch === BigInt(epoch) && value.nonce instanceof Uint8Array && value.nonce.length === 12 && value.ciphertext instanceof Uint8Array && value.ciphertext.length === plaintextBytes + 16, "CONTENT_CHUNK_INVALID");
  return value;
}
var ApplicationContent = class {
  #sources = /* @__PURE__ */ new Map();
  #reads = /* @__PURE__ */ new Map();
  #lifetime = new AbortController();
  #prefix;
  #options;
  #tail = Promise.resolve();
  constructor(options) {
    check(typeof options.storageId === "string" && options.storageId.length > 0 && options.storageId.length <= 256, "CONTENT_STORAGE_ID_INVALID");
    this.#options = options;
    this.#prefix = `content/${options.authority.descriptor.applicationId}`;
  }
  #reader() {
    this.#lifetime.signal.throwIfAborted();
    check(this.#options.authority.grant(this.#options.identity.publicKey)?.reader, "CONTENT_READER_REQUIRED");
  }
  #reference(input) {
    assertContentReference(input);
    check(input.applicationId === this.#options.authority.descriptor.applicationId, "CONTENT_SCOPE_INVALID");
    return { ...input };
  }
  #serial(work) {
    const task = this.#tail.then(() => {
      this.#lifetime.signal.throwIfAborted();
      return work();
    });
    this.#tail = task.catch(() => void 0);
    return task;
  }
  #readScope(reference, options) {
    this.#reader();
    options.signal?.throwIfAborted();
    const controller = new AbortController();
    let reads = this.#reads.get(reference.id);
    if (reads === void 0) {
      reads = /* @__PURE__ */ new Set();
      this.#reads.set(reference.id, reads);
    }
    reads.add(controller);
    const signal = AbortSignal.any([this.#lifetime.signal, controller.signal, ...options.signal === void 0 ? [] : [options.signal]]);
    signal.throwIfAborted();
    return { signal, release: () => {
      reads.delete(controller);
      if (reads.size === 0) this.#reads.delete(reference.id);
    } };
  }
  attachSource(id, source3) {
    this.#lifetime.signal.throwIfAborted();
    check(typeof id === "string" && id.length > 0 && id.length <= 256 && this.#sources.size < 8 && !this.#sources.has(id), "CONTENT_SOURCE_LIMIT");
    this.#sources.set(id, source3);
    let detached = false;
    return () => {
      if (!detached) {
        detached = true;
        this.#sources.delete(id);
      }
    };
  }
  async stage(options) {
    this.#reader();
    const id = crypto.randomUUID(), epoch = this.#options.authority.currentMembership.epoch;
    const reference = { profile: "authored-content-v1", applicationId: this.#options.authority.descriptor.applicationId, epoch, bytes: options.bytes, mediaType: options.mediaType ?? "application/octet-stream" };
    assertReferenceBody(reference);
    check(this.#options.authority.epochKey(epoch) !== null, "CONTENT_KEY_MISSING");
    await this.#serial(() => this.#options.store.put(`${this.#prefix}/stage/${id}`, encodeRecord({ stageId: id, reference, committed: null, discarded: false })));
    return this.resumeUpload(id);
  }
  async resumeUpload(id) {
    this.#reader();
    check(stageId(id), "CONTENT_STAGE_INVALID");
    const key = `${this.#prefix}/stage/${id}`;
    const readStage = async () => {
      this.#reader();
      const raw = await this.#options.store.get(key);
      check(raw !== null, "CONTENT_STAGE_MISSING");
      const stage = decodeRecord(raw);
      object(stage, ["stageId", "reference", "committed", "discarded"]);
      assertReferenceBody(stage.reference);
      check(stage.stageId === id && stage.reference.applicationId === this.#options.authority.descriptor.applicationId && typeof stage.discarded === "boolean", "CONTENT_STAGE_INVALID");
      if (stage.committed !== null) {
        assertContentReference(stage.committed);
        check(equalRecord(body(stage.committed), stage.reference), "CONTENT_STAGE_INVALID");
      }
      check(!stage.discarded, "CONTENT_STAGE_DISCARDED");
      return stage;
    };
    const first = await readStage(), count = Math.ceil(first.reference.bytes / CONTENT_CHUNK_BYTES);
    return {
      id,
      write: (index, input) => {
        check(input instanceof Uint8Array && input.length <= CONTENT_CHUNK_BYTES, "CONTENT_CHUNK_SIZE_INVALID");
        const bytes = input.slice();
        return this.#serial(async () => {
          const stage = await readStage();
          check(stage.committed === null && Number.isSafeInteger(index) && index >= 0 && index < count && bytes.length === Math.min(CONTENT_CHUNK_BYTES, stage.reference.bytes - index * CONTENT_CHUNK_BYTES), "CONTENT_CHUNK_SIZE_INVALID");
          const epochKey = this.#options.authority.epochKey(stage.reference.epoch);
          check(epochKey !== null, "CONTENT_KEY_MISSING");
          const aad = encodeRecord([this.#prefix, id, index]), existing = await this.#options.store.get(`${key}/chunk/${index}`);
          if (existing !== null) {
            const plaintext = await decryptEpochPayload(epochKey, envelope(existing, stage.reference.epoch, bytes.length), aad);
            check(equalRecord(plaintext, bytes), "CONTENT_CHUNK_CONFLICT");
            return;
          }
          const encrypted = encodeRecord(await encryptEpochPayload(epochKey, BigInt(stage.reference.epoch), bytes, aad));
          await this.#options.store.put(`${key}/chunk/${index}`, encrypted);
        });
      },
      progress: () => this.#serial(async () => {
        const stage = await readStage(), missingChunks = [];
        let storedBytes = 0;
        for (let index = 0; index < count; index++) {
          const chunk = await this.#options.store.get(`${key}/chunk/${index}`);
          if (chunk === null) missingChunks.push(index);
          else {
            envelope(chunk, stage.reference.epoch, Math.min(CONTENT_CHUNK_BYTES, stage.reference.bytes - index * CONTENT_CHUNK_BYTES));
            storedBytes += Math.min(CONTENT_CHUNK_BYTES, stage.reference.bytes - index * CONTENT_CHUNK_BYTES);
          }
        }
        return { bytes: stage.reference.bytes, storedBytes, missingChunks };
      }),
      commit: () => this.#serial(async () => {
        const stage = await readStage();
        if (stage.committed !== null) return structuredClone(stage.committed);
        const chunks = [];
        const epochKey = this.#options.authority.epochKey(stage.reference.epoch);
        check(epochKey !== null, "CONTENT_KEY_MISSING");
        for (let index = 0; index < count; index++) {
          const bytes = await this.#options.store.get(`${key}/chunk/${index}`);
          check(bytes !== null, "CONTENT_INCOMPLETE");
          await decryptEpochPayload(epochKey, envelope(bytes, stage.reference.epoch, Math.min(CONTENT_CHUNK_BYTES, stage.reference.bytes - index * CONTENT_CHUNK_BYTES)), encodeRecord([this.#prefix, id, index]));
          const hash = bytesToHex(await sha256(bytes));
          await this.#options.store.put(`${this.#prefix}/chunk/${hash}`, bytes);
          chunks.push({ hash, bytes: bytes.length });
        }
        const manifest = { stageId: id, reference: stage.reference, chunks };
        const reference = { ...stage.reference, id: await recordDigest(manifest) };
        await this.#options.store.put(`${this.#prefix}/manifest/${reference.id}`, encodeRecord(manifest));
        await this.#options.store.put(key, encodeRecord({ ...stage, committed: reference }));
        return reference;
      }),
      discard: () => this.#serial(async () => {
        const raw = await this.#options.store.get(key);
        if (raw === null) return;
        const stage = decodeRecord(raw);
        await this.#options.store.put(key, encodeRecord({ ...stage, discarded: true }));
        for (let index = 0; index < count; index++) await this.#remove(`${key}/chunk/${index}`);
      })
    };
  }
  async #remove(key) {
    if (this.#options.store.delete !== void 0) await this.#options.store.delete(key);
    else await this.#options.store.put(key, new Uint8Array());
  }
  async #validateManifest(manifest, reference) {
    assertContentManifest(manifest);
    check(equalRecord(manifest.reference, body(reference)) && await recordDigest(manifest) === reference.id, "CONTENT_MANIFEST_INVALID");
  }
  async #manifest(reference, signal, localOnly = false) {
    signal.throwIfAborted();
    this.#reader();
    const raw = await awaitOwnedTask(signal, () => this.#options.store.get(`${this.#prefix}/manifest/${reference.id}`));
    if (raw !== null && raw.length > 0) {
      check(raw.length <= MAX_CONTENT_MANIFEST_BYTES, "CONTENT_MANIFEST_INVALID");
      const manifest = decodeRecord(raw);
      await this.#validateManifest(manifest, reference);
      signal.throwIfAborted();
      return manifest;
    }
    if (localOnly) return null;
    let failure;
    for (const source3 of [...this.#sources.values()]) {
      try {
        const candidate = await awaitOwnedTask(signal, () => source3.manifest(reference, { signal }));
        if (candidate === null) continue;
        assertContentManifest(candidate);
        const manifest = structuredClone(candidate);
        await this.#validateManifest(manifest, reference);
        await this.#serial(async () => {
          signal.throwIfAborted();
          this.#reader();
          await this.#options.store.put(`${this.#prefix}/manifest/${reference.id}`, encodeRecord(manifest));
        });
        return manifest;
      } catch (error) {
        signal.throwIfAborted();
        failure = error;
      }
    }
    if (failure !== void 0) throw failure instanceof Error ? failure : new Error("CONTENT_SOURCE_FAILED", { cause: failure });
    throw new Error("CONTENT_MANIFEST_MISSING");
  }
  async #chunk(reference, manifest, index, signal, localOnly = false) {
    signal.throwIfAborted();
    this.#reader();
    const descriptor = manifest.chunks[index];
    check(descriptor !== void 0, "CONTENT_CHUNK_INDEX_INVALID");
    const valid = async (bytes) => {
      check(bytes instanceof Uint8Array && bytes.length === descriptor.bytes && bytes.length <= MAX_CONTENT_ENCRYPTED_CHUNK_BYTES && bytesToHex(await sha256(bytes)) === descriptor.hash, "CONTENT_CHUNK_INVALID");
      envelope(bytes, reference.epoch, Math.min(CONTENT_CHUNK_BYTES, reference.bytes - index * CONTENT_CHUNK_BYTES));
    };
    const stored = await awaitOwnedTask(signal, () => this.#options.store.get(`${this.#prefix}/chunk/${descriptor.hash}`));
    if (stored !== null && stored.length > 0) {
      await valid(stored);
      signal.throwIfAborted();
      return stored;
    }
    if (localOnly) return null;
    let failure;
    for (const source3 of [...this.#sources.values()]) {
      try {
        const candidate = await awaitOwnedTask(signal, () => source3.chunk(reference, index, { signal }));
        if (candidate === null) continue;
        check(candidate instanceof Uint8Array && candidate.length <= MAX_CONTENT_ENCRYPTED_CHUNK_BYTES, "CONTENT_CHUNK_INVALID");
        const bytes = candidate.slice();
        await valid(bytes);
        await this.#serial(async () => {
          signal.throwIfAborted();
          this.#reader();
          await this.#options.store.put(`${this.#prefix}/chunk/${descriptor.hash}`, bytes);
        });
        return bytes.slice();
      } catch (error) {
        signal.throwIfAborted();
        failure = error;
      }
    }
    if (failure !== void 0) throw failure instanceof Error ? failure : new Error("CONTENT_SOURCE_FAILED", { cause: failure });
    throw new Error("CONTENT_CHUNK_MISSING");
  }
  async *read(input, options = {}) {
    const reference = this.#reference(input), scope = this.#readScope(reference, options);
    try {
      const manifest = await this.#manifest(reference, scope.signal);
      check(manifest !== null, "CONTENT_MANIFEST_MISSING");
      const key = this.#options.authority.epochKey(reference.epoch);
      check(key !== null, "CONTENT_KEY_MISSING");
      for (let index = 0; index < manifest.chunks.length; index++) {
        const bytes = await this.#chunk(reference, manifest, index, scope.signal);
        check(bytes !== null, "CONTENT_CHUNK_MISSING");
        const plaintext = await decryptEpochPayload(key, envelope(bytes, reference.epoch, Math.min(CONTENT_CHUNK_BYTES, reference.bytes - index * CONTENT_CHUNK_BYTES)), encodeRecord([this.#prefix, manifest.stageId, index]));
        scope.signal.throwIfAborted();
        this.#reader();
        yield plaintext;
      }
    } finally {
      scope.release();
    }
  }
  async #receipt(reference, signal) {
    const receipt = await signRecord("content-retention", { reference, peer: this.#options.identity.publicKey, storageId: this.#options.storageId }, this.#options.identity);
    signal.throwIfAborted();
    this.#reader();
    return receipt;
  }
  /** Transfer/check the entire encrypted object before claiming local retention. */
  async retain(input, options = {}) {
    const reference = this.#reference(input), scope = this.#readScope(reference, options);
    try {
      const manifest = await this.#manifest(reference, scope.signal);
      check(manifest !== null, "CONTENT_MANIFEST_MISSING");
      for (let index = 0; index < manifest.chunks.length; index++) await this.#chunk(reference, manifest, index, scope.signal);
      return await this.#receipt(reference, scope.signal);
    } finally {
      scope.release();
    }
  }
  async verifyRetention(input, receipt, expectedPeer) {
    const reference = this.#reference(input);
    assertContentRetention(receipt);
    check(equalRecord(receipt.payload.reference, reference) && (expectedPeer === void 0 || receipt.signer === expectedPeer) && this.#options.authority.grant(receipt.signer)?.reader, "CONTENT_RETENTION_INVALID");
    await verifyRecord("content-retention", receipt, expectedPeer);
  }
  /** Ask attached sources to retain the object; these signed availability facts are not finality. */
  async retention(input, options = {}) {
    const reference = this.#reference(input), scope = this.#readScope(reference, options);
    try {
      const receipts = new Map((await this.retained(reference)).map((receipt) => [receipt.signer, receipt]));
      for (const source3 of [...this.#sources.values()]) {
        if (source3.retained === void 0) continue;
        const receipt = await awaitOwnedTask(scope.signal, () => source3.retained(reference, { signal: scope.signal }));
        await this.verifyRetention(reference, receipt);
        if (receipt.signer === this.#options.identity.publicKey || receipt.payload.storageId === this.#options.storageId) continue;
        check(receipts.size < 8 || receipts.has(receipt.signer), "CONTENT_RETENTION_LIMIT");
        receipts.set(receipt.signer, structuredClone(receipt));
        await this.#serial(async () => {
          scope.signal.throwIfAborted();
          const stored = new Map((await this.retained(reference)).map((value) => [value.signer, value]));
          check(stored.size < 8 || stored.has(receipt.signer), "CONTENT_RETENTION_LIMIT");
          stored.set(receipt.signer, structuredClone(receipt));
          await this.#options.store.put(`${this.#prefix}/retentions/${reference.id}`, encodeRecord([...stored.values()]));
        });
      }
      scope.signal.throwIfAborted();
      return await this.retained(reference);
    } finally {
      scope.release();
    }
  }
  async retained(input) {
    this.#reader();
    const reference = this.#reference(input);
    const raw = await this.#options.store.get(`${this.#prefix}/retentions/${reference.id}`);
    if (raw === null || raw.length === 0) return [];
    check(raw.length <= 16 * 1024, "CONTENT_RETENTION_LIMIT");
    const receipts = decodeRecord(raw);
    check(Array.isArray(receipts) && receipts.length <= 8, "CONTENT_RETENTION_LIMIT");
    for (const receipt of receipts) await this.verifyRetention(reference, receipt);
    return receipts.filter((receipt) => receipt.signer !== this.#options.identity.publicKey && receipt.payload.storageId !== this.#options.storageId);
  }
  async discard(input) {
    this.#reader();
    const reference = this.#reference(input);
    for (const read of this.#reads.get(reference.id) ?? []) read.abort(new Error("CONTENT_DISCARDED"));
    await this.#serial(async () => {
      const manifest = await this.#manifest(reference, this.#lifetime.signal, true);
      await this.#remove(`${this.#prefix}/manifest/${reference.id}`);
      await this.#remove(`${this.#prefix}/retentions/${reference.id}`);
      for (const chunk of manifest?.chunks ?? []) await this.#remove(`${this.#prefix}/chunk/${chunk.hash}`);
    });
  }
  /** Serve only verified local bytes. Serving never recursively consults remote sources. */
  source() {
    return {
      manifest: async (input, options = {}) => {
        const reference = this.#reference(input), scope = this.#readScope(reference, options);
        try {
          return await this.#manifest(reference, scope.signal, true);
        } finally {
          scope.release();
        }
      },
      chunk: async (input, index, options = {}) => {
        const reference = this.#reference(input), scope = this.#readScope(reference, options);
        try {
          const manifest = await this.#manifest(reference, scope.signal, true);
          check(Number.isSafeInteger(index) && index >= 0 && index < Math.ceil(reference.bytes / CONTENT_CHUNK_BYTES), "CONTENT_CHUNK_INDEX_INVALID");
          return manifest === null ? null : await this.#chunk(reference, manifest, index, scope.signal, true);
        } finally {
          scope.release();
        }
      },
      retained: async (input, options = {}) => {
        const reference = this.#reference(input), scope = this.#readScope(reference, options);
        try {
          const manifest = await this.#manifest(reference, scope.signal, true);
          check(manifest !== null, "CONTENT_MANIFEST_MISSING");
          for (let index = 0; index < manifest.chunks.length; index++) check(await this.#chunk(reference, manifest, index, scope.signal, true) !== null, "CONTENT_INCOMPLETE");
          return await this.#receipt(reference, scope.signal);
        } finally {
          scope.release();
        }
      }
    };
  }
  putBytes(bytes, options) {
    return putContentBytes(this, bytes, options);
  }
  readBytes(reference, options) {
    return readContentBytes(this, reference, options);
  }
  async close() {
    this.#lifetime.abort(new Error("CONTENT_CLOSED"));
    this.#sources.clear();
    await this.#tail;
  }
};

// packages/signals/src/payload.ts
function assertSignalTopic(topic) {
  if (typeof topic !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(topic) || topic.length > 128) throw new Error("SIGNAL_TOPIC_INVALID");
}
function canonicalSignalPayload(payload) {
  let nodes = 0;
  const visit = (value, depth) => {
    if (depth > 32 || ++nodes > 4096) throw new Error("SIGNAL_PAYLOAD_TOO_COMPLEX");
    if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new Error("SIGNAL_PAYLOAD_INVALID");
      return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
      if (Reflect.ownKeys(value).length !== value.length + 1) throw new Error("SIGNAL_PAYLOAD_INVALID");
      const entries = [];
      for (let i = 0; i < value.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, i);
        if (descriptor === void 0 || !("value" in descriptor) || !descriptor.enumerable) throw new Error("SIGNAL_PAYLOAD_INVALID");
        entries.push(visit(descriptor.value, depth + 1));
      }
      return `[${entries.join(",")}]`;
    }
    if (typeof value !== "object" || value === null || Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null || Reflect.ownKeys(value).length !== Object.keys(value).length) throw new Error("SIGNAL_PAYLOAD_INVALID");
    return `{${Object.keys(value).sort().map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!("value" in descriptor)) throw new Error("SIGNAL_PAYLOAD_INVALID");
      return `${JSON.stringify(key)}:${visit(descriptor.value, depth + 1)}`;
    }).join(",")}}`;
  };
  const result = visit(payload, 0);
  if (new TextEncoder().encode(result).length > 16384) throw new Error("SIGNAL_FRAME_TOO_LARGE");
  return result;
}

// packages/signals/src/index.ts
var SIGNAL_DOMAIN = "chronolog/signal/v1";
var SIGNAL_STREAM_DOMAIN = "chronolog/signal/v2";
var MAX_SIGNAL_BYTES = 16384;
var SignalError = class extends Error {
  constructor(code, message = code) {
    super(message);
    this.code = code;
    this.name = "SignalError";
  }
  code;
};
var SignalChannel = class {
  #options;
  #authorId;
  #session = crypto.getRandomValues(new Uint8Array(32));
  #sessions = /* @__PURE__ */ new Map();
  #subscriptions = /* @__PURE__ */ new Set();
  #routes = /* @__PURE__ */ new Set();
  /** Detached callbacks retain their quota until the actual operation settles. */
  #retiring = /* @__PURE__ */ new Set();
  #lifetime = new AbortController();
  #ttl;
  #skew;
  #maxSessions;
  #maxSequences;
  #maxRemembered;
  #maxSends;
  #maxReceives;
  #maxRoutes;
  #maxSubscriptions;
  #maxQueuedSignals;
  #maxQueuedBytes;
  #maxRetainedLatest;
  #sendTimeout;
  #verifyKeys = /* @__PURE__ */ new Map();
  #retainedLatest = /* @__PURE__ */ new Map();
  #sequence = 0;
  #sendTail = Promise.resolve();
  #pendingSends = 0;
  #pendingReceives = 0;
  #remembered = 0;
  #observedTime = 0;
  #lastPruneAt = 0;
  constructor(options) {
    if (typeof options.scope !== "string" || options.scope.length === 0 || new TextEncoder().encode(options.scope).length > 256 || !(options.identity.publicKeyBytes instanceof Uint8Array) || options.identity.publicKeyBytes.length !== 32 || typeof options.authorize !== "function") throw new SignalError("SIGNAL_CONFIGURATION_INVALID");
    const credential = typeof options.credential === "function" ? options.credential : credentialBytes(options.credential);
    this.#options = {
      ...options,
      identity: { ...options.identity, publicKeyBytes: options.identity.publicKeyBytes.slice() },
      ...credential === void 0 ? {} : { credential }
    };
    this.#authorId = bytesToHex(options.identity.publicKeyBytes);
    this.#ttl = bound(options.maxTtlMs ?? 3e4, 1, 6e4);
    this.#skew = bound(options.maxClockSkewMs ?? 2e3, 0, 1e4);
    this.#maxSessions = bound(options.maxSessions ?? 1024, 1, 65536);
    this.#maxSequences = bound(options.maxSequencesPerSession ?? 1024, 1, 65536);
    this.#maxRemembered = bound(options.maxRememberedSignals ?? 8192, 1, 1048576);
    this.#maxSends = bound(options.maxPendingSends ?? 32, 1, 1024);
    this.#maxReceives = bound(options.maxPendingReceives ?? 32, 1, 1024);
    this.#maxRoutes = bound(options.maxRoutes ?? 64, 1, 1024);
    this.#maxSubscriptions = bound(options.maxSubscriptions ?? 16, 1, 1024);
    this.#maxQueuedSignals = bound(options.maxQueuedSignals ?? 64, 1, 4096);
    this.#maxQueuedBytes = bound(options.maxQueuedBytes ?? 262144, 1, 16777216);
    this.#maxRetainedLatest = bound(options.maxRetainedLatest ?? 128, 0, 4096);
    this.#sendTimeout = bound(options.sendTimeoutMs ?? 1e4, 1, 12e4);
    if (options.trySend !== void 0) this.attachRoute({ trySend: options.trySend });
  }
  get delivery() {
    return this.#options.relay === true ? "application" : "neighbors";
  }
  attachRoute(transport) {
    this.#assertOpen();
    if (typeof transport.trySend !== "function") throw new SignalError("SIGNAL_TRANSPORT_INVALID");
    if (this.#routes.size + this.#retiring.size >= this.#maxRoutes) throw new SignalError("SIGNAL_ROUTE_QUOTA_EXCEEDED");
    const route = {
      trySend: transport.trySend.bind(transport),
      lifetime: new AbortController(),
      busy: false,
      retired: false,
      rejections: { total: 0, clockSkew: 0, expired: 0, unauthorized: 0, duplicate: 0, capacity: 0 },
      ...transport.close === void 0 ? {} : { close: transport.close.bind(transport) }
    };
    this.#routes.add(route);
    return {
      receive: (frame) => this.#enqueueReceive(frame, route),
      close: () => this.#detach(route),
      get diagnostics() {
        return { ...route.rejections };
      }
    };
  }
  send(topic, payload, options = {}) {
    try {
      if (typeof options !== "object" || options === null) throw new SignalError("SIGNAL_OPTIONS_INVALID");
      this.#assertOpen();
      options.signal?.throwIfAborted();
      if (this.#routes.size === 0 && this.#options.localEcho !== true) throw new SignalError("SIGNAL_ROUTE_UNAVAILABLE");
      const routes = [...this.#routes];
      if (this.#pendingSends >= this.#maxSends) throw new SignalError("SIGNAL_BACKPRESSURE");
      assertSignalTopic(topic);
      const encodedPayload = canonicalSignalPayload(payload);
      const stream = options.stream === void 0 ? void 0 : checkedStream(options.stream);
      const ttlMs = bound(options.ttlMs ?? Math.min(5e3, this.#ttl), 1, this.#ttl, "SIGNAL_TTL_INVALID");
      const issuedAtMs = this.#now(), expiresAtMs = issuedAtMs + ttlMs;
      if (!Number.isSafeInteger(expiresAtMs)) throw new SignalError("SIGNAL_CLOCK_INVALID");
      const expiry = new AbortController();
      const timer = setTimeout(() => expiry.abort(new SignalError("SIGNAL_SEND_TIMEOUT")), Math.min(ttlMs, this.#sendTimeout));
      const signal = AbortSignal.any([this.#lifetime.signal, expiry.signal, ...options.signal === void 0 ? [] : [options.signal]]);
      this.#pendingSends += 1;
      let started = false;
      const task = this.#sendTail.then(() => {
        signal.throwIfAborted();
        started = true;
        const operation = (async () => {
          const configured = this.#options.credential;
          const credential = credentialBytes(typeof configured === "function" ? await configured(topic, { signal }) : configured);
          const authorization = { scope: this.#options.scope, authorId: this.#options.identity.publicKeyBytes.slice(), topic, credential: credential ?? null, ...stream === void 0 ? {} : { stream } };
          await this.#authorize(authorization, signal);
          if (this.#sequence >= Number.MAX_SAFE_INTEGER) throw new SignalError("SIGNAL_SEQUENCE_EXHAUSTED");
          const sequence = ++this.#sequence;
          const fields = [
            stream === void 0 ? 1n : 2n,
            stream === void 0 ? SIGNAL_DOMAIN : SIGNAL_STREAM_DOMAIN,
            this.#options.scope,
            this.#options.identity.publicKeyBytes,
            credential ?? null,
            this.#session,
            BigInt(sequence),
            BigInt(issuedAtMs),
            BigInt(expiresAtMs),
            topic,
            encodedPayload,
            ...stream === void 0 ? [] : [JSON.stringify(stream)]
          ];
          const signature = new Uint8Array(await crypto.subtle.sign(
            "Ed25519",
            this.#options.identity.privateKey,
            encodeCanonicalCbor(fields).slice().buffer
          ));
          const frame = encodeCanonicalCbor([...fields, signature]);
          if (frame.length > MAX_SIGNAL_BYTES) throw new SignalError("SIGNAL_FRAME_TOO_LARGE");
          const value = {
            scope: this.#options.scope,
            authorId: this.#authorId,
            sessionId: bytesToHex(this.#session),
            sequence,
            topic,
            payload: JSON.parse(encodedPayload),
            issuedAtMs,
            expiresAtMs,
            ...stream === void 0 ? {} : { stream }
          };
          await this.#authorize(authorization, signal);
          this.#assertFresh(value);
          if (!this.#remember(value)) throw new SignalError("SIGNAL_BACKPRESSURE");
          const local = this.#options.localEcho === true;
          if (local) {
            this.#deliver(value, frame.length);
            if (routes.length > 0) void this.#dispatch({ value, authorization, frame }, routes, signal, false).catch(() => void 0);
          }
          if (!local && !await this.#dispatch({ value, authorization, frame }, routes, signal, true)) {
            this.#forget(value);
            throw new SignalError("SIGNAL_BACKPRESSURE");
          }
          return structuredClone(value);
        })().finally(() => {
          clearTimeout(timer);
          this.#pendingSends -= 1;
        });
        return interrupted(operation, signal);
      }).finally(() => {
        if (!started) {
          clearTimeout(timer);
          this.#pendingSends -= 1;
        }
      });
      this.#sendTail = task.catch(() => void 0);
      return interrupted(task, signal);
    } catch (error) {
      return Promise.reject(error);
    }
  }
  /** Standalone receive validates and delivers without inferring a relay source. */
  receive(frame) {
    return this.#enqueueReceive(frame);
  }
  #enqueueReceive(input, route) {
    try {
      this.#assertOpen();
      if (!(input instanceof Uint8Array) || input.byteLength > MAX_SIGNAL_BYTES) throw new SignalError("SIGNAL_FRAME_TOO_LARGE");
      if (route?.lifetime.signal.aborted === true) throw new SignalError("SIGNAL_ROUTE_CLOSED");
      if (this.#pendingReceives >= this.#maxReceives) return Promise.resolve(this.#reject(route, "capacity"));
      const frame = input.slice();
      const routes = [...this.#routes].filter((attached) => attached !== route);
      this.#pendingReceives += 1;
      const expiry = new AbortController();
      const timer = setTimeout(() => expiry.abort(new SignalError("SIGNAL_RECEIVE_TIMEOUT")), this.#ttl);
      const signal = AbortSignal.any([this.#lifetime.signal, expiry.signal, ...route === void 0 ? [] : [route.lifetime.signal]]);
      const operation = (async () => {
        signal.throwIfAborted();
        const verified = await this.#verify(frame, signal, route);
        if (verified === null || !this.#remember(verified.value, route)) return null;
        this.#deliver(verified.value, frame.length);
        if (this.#options.relay === true) await this.#dispatch(verified, routes, signal, false);
        return structuredClone(verified.value);
      })().finally(() => {
        clearTimeout(timer);
        this.#pendingReceives -= 1;
      });
      return interrupted(operation, signal);
    } catch (error) {
      return Promise.reject(error);
    }
  }
  async #verify(bytes, signal, route) {
    const frame = assertCanonicalCbor(bytes, {
      maxBytes: MAX_SIGNAL_BYTES,
      maxDepth: 2,
      maxArrayItems: 13,
      maxMapItems: 0,
      maxTextBytes: MAX_SIGNAL_BYTES,
      maxBlobBytes: 1024
    });
    if (!Array.isArray(frame) || !(frame.length === 12 && frame[0] === 1n && frame[1] === SIGNAL_DOMAIN || frame.length === 13 && frame[0] === 2n && frame[1] === SIGNAL_STREAM_DOMAIN) || frame[2] !== this.#options.scope || !(frame[3] instanceof Uint8Array) || frame[3].length !== 32 || frame[4] !== null && (!(frame[4] instanceof Uint8Array) || frame[4].length > 1024) || !(frame[5] instanceof Uint8Array) || frame[5].length !== 32 || typeof frame[6] !== "bigint" || typeof frame[7] !== "bigint" || typeof frame[8] !== "bigint" || typeof frame[9] !== "string" || typeof frame[10] !== "string" || !(frame[frame.length - 1] instanceof Uint8Array) || frame[frame.length - 1].length !== 64) throw new SignalError("SIGNAL_FRAME_INVALID");
    assertSignalTopic(frame[9]);
    const stream = frame.length === 13 ? decodeStream(frame[11]) : void 0;
    const payload = JSON.parse(frame[10]);
    if (canonicalSignalPayload(payload) !== frame[10]) throw new SignalError("SIGNAL_PAYLOAD_INVALID");
    const value = {
      scope: this.#options.scope,
      authorId: bytesToHex(frame[3]),
      sessionId: bytesToHex(frame[5]),
      sequence: Number(frame[6]),
      issuedAtMs: Number(frame[7]),
      expiresAtMs: Number(frame[8]),
      topic: frame[9],
      payload,
      ...stream === void 0 ? {} : { stream }
    };
    this.#assertClockFields(value);
    let key = this.#verifyKeys.get(value.authorId);
    if (key === void 0) {
      key = await crypto.subtle.importKey("raw", frame[3].slice().buffer, "Ed25519", false, ["verify"]);
      if (this.#verifyKeys.size >= 256) {
        const oldest = this.#verifyKeys.keys().next().value;
        if (oldest !== void 0) this.#verifyKeys.delete(oldest);
      }
      this.#verifyKeys.set(value.authorId, key);
    }
    if (!await crypto.subtle.verify("Ed25519", key, frame[frame.length - 1].slice().buffer, encodeCanonicalCbor(frame.slice(0, -1)).slice().buffer)) {
      throw new SignalError("SIGNAL_SIGNATURE_INVALID");
    }
    const credential = frame[4];
    const authorization = { scope: value.scope, authorId: frame[3].slice(), topic: value.topic, credential: credential?.slice() ?? null, ...stream === void 0 ? {} : { stream } };
    if (!await this.#allowed(authorization, signal)) return this.#reject(route, "unauthorized");
    const now = this.#now();
    if (value.issuedAtMs > now + this.#skew) return this.#reject(route, "clockSkew");
    if (value.expiresAtMs <= now) return this.#reject(route, "expired");
    return { value, authorization, frame: bytes };
  }
  async #allowed(input, signal) {
    signal.throwIfAborted();
    const allowed = await this.#options.authorize(structuredClone(input), { signal });
    signal.throwIfAborted();
    return allowed;
  }
  async #authorize(input, signal) {
    if (!await this.#allowed(input, signal)) throw new SignalError("SIGNAL_UNAUTHORIZED");
  }
  async #dispatch(verified, eligible, signal, required) {
    const attached = eligible.filter((route) => !route.lifetime.signal.aborted);
    if (required && attached.length === 0) throw new SignalError("SIGNAL_ROUTE_UNAVAILABLE");
    const routes = attached.filter((route) => !route.busy);
    if (routes.length === 0) return false;
    const attempts = routes.map((route) => {
      route.busy = true;
      let handedOff = false, settled = false;
      const deadline = new AbortController();
      const timer = setTimeout(() => {
        const reason = new SignalError("SIGNAL_SEND_TIMEOUT");
        deadline.abort(reason);
        if (handedOff && !settled) this.#detach(route, true, reason);
      }, Math.max(1, Math.min(this.#sendTimeout, verified.value.expiresAtMs - this.#now())));
      const lifetime = AbortSignal.any([signal, route.lifetime.signal, deadline.signal]);
      const operation = (async () => {
        await this.#authorize(verified.authorization, lifetime);
        this.#assertFresh(verified.value);
        handedOff = true;
        const result = await route.trySend(verified.frame.slice(), { signal: lifetime });
        if (typeof result !== "boolean") {
          throw new SignalError("SIGNAL_TRANSPORT_RESULT_INVALID");
        }
        return result;
      })().catch((error) => {
        if (handedOff && (!lifetime.aborted || error !== lifetime.reason)) this.#detach(route, true, error);
        throw error;
      }).finally(() => {
        settled = true;
        route.busy = false;
        this.#retiring.delete(route);
        clearTimeout(timer);
      });
      return interrupted(operation, lifetime);
    });
    if (required) {
      const refused = new Error("Signal dispatch refused");
      try {
        return await Promise.any(attempts.map(async (attempt) => {
          if (!await attempt) throw refused;
          return true;
        }));
      } catch (error) {
        if (error instanceof AggregateError) {
          const failures = error.errors.filter((value) => value !== refused);
          if (failures.length === 0) return false;
          if (failures.length === 1) throw failures[0];
        }
        throw new SignalError("SIGNAL_SEND_FAILED");
      }
    }
    return (await Promise.allSettled(attempts)).some((result) => result.status === "fulfilled" && result.value);
  }
  #pruneRemembered(now) {
    this.#lastPruneAt = now;
    for (const [id, progress] of this.#sessions) {
      for (const [sequence, expiresAtMs] of progress.seen) if (expiresAtMs <= now) {
        progress.seen.delete(sequence);
        this.#remembered -= 1;
      }
      if (progress.seen.size === 0) this.#sessions.delete(id);
    }
  }
  #reject(route, reason) {
    if (route !== void 0) {
      route.rejections.total = Math.min(Number.MAX_SAFE_INTEGER, route.rejections.total + 1);
      route.rejections[reason] = Math.min(Number.MAX_SAFE_INTEGER, route.rejections[reason] + 1);
    }
    return null;
  }
  #remember(value, route) {
    const now = this.#now();
    const key = `${value.authorId}/${value.sessionId}`;
    let previous = this.#sessions.get(key);
    const existingExpiry = previous?.seen.get(value.sequence);
    if (existingExpiry !== void 0) {
      if (existingExpiry > now) {
        this.#reject(route, "duplicate");
        return false;
      }
      previous.seen.delete(value.sequence);
      this.#remembered -= 1;
      if (previous.seen.size === 0) {
        this.#sessions.delete(key);
        previous = void 0;
      }
    }
    if (now - this.#lastPruneAt >= 1e3 || previous === void 0 && this.#sessions.size >= this.#maxSessions || (previous?.seen.size ?? 0) >= this.#maxSequences || this.#remembered >= this.#maxRemembered) {
      this.#pruneRemembered(now);
      previous = this.#sessions.get(key);
    }
    if (previous === void 0 && this.#sessions.size >= this.#maxSessions || (previous?.seen.size ?? 0) >= this.#maxSequences || this.#remembered >= this.#maxRemembered) {
      this.#reject(route, "capacity");
      return false;
    }
    const progress = previous ?? { seen: /* @__PURE__ */ new Map() };
    progress.seen.set(value.sequence, value.expiresAtMs);
    this.#remembered += 1;
    this.#sessions.set(key, progress);
    return true;
  }
  #forget(value) {
    const key = `${value.authorId}/${value.sessionId}`, session = this.#sessions.get(key);
    if (session?.seen.delete(value.sequence) === true) this.#remembered -= 1;
    if (session?.seen.size === 0) this.#sessions.delete(key);
  }
  #deliver(value, bytes) {
    const now = this.#now();
    const streamKey = JSON.stringify([value.authorId, value.sessionId, value.topic, value.stream?.endpointId ?? null, value.stream?.endpointIncarnation ?? null, value.stream?.streamId ?? null, value.stream?.target ?? null]);
    if (this.#maxRetainedLatest > 0 && value.expiresAtMs > now) {
      const prior = this.#retainedLatest.get(streamKey);
      if (prior === void 0 || prior.value.sequence < value.sequence || prior.value.expiresAtMs <= now) {
        if (prior !== void 0) this.#retainedLatest.delete(streamKey);
        else if (this.#retainedLatest.size >= this.#maxRetainedLatest) {
          for (const [id, entry] of this.#retainedLatest) if (entry.value.expiresAtMs <= now) this.#retainedLatest.delete(id);
          if (this.#retainedLatest.size >= this.#maxRetainedLatest) {
            const oldest = this.#retainedLatest.keys().next().value;
            if (oldest !== void 0) this.#retainedLatest.delete(oldest);
          }
        }
        this.#retainedLatest.set(streamKey, { value: structuredClone(value), bytes });
      }
    }
    for (const subscriber of this.#subscriptions) {
      if (subscriber.topics !== null && !subscriber.topics.has(value.topic)) continue;
      if (subscriber.streams !== null && !subscriber.streams.some((selector) => matchesStream(value, selector))) continue;
      for (let index = subscriber.pending.length - 1; index >= 0; index -= 1) {
        if (subscriber.pending[index].value.expiresAtMs <= now) subscriber.bytes -= subscriber.pending.splice(index, 1)[0].bytes;
      }
      for (const [id, latest] of subscriber.latest) if (latest.retainThroughMs <= now) subscriber.latest.delete(id);
      const key = streamKey;
      if (subscriber.mode === "latest") {
        const previous = subscriber.latest.get(key);
        if (previous !== void 0 && previous.sequence >= value.sequence) continue;
        if (previous === void 0 && subscriber.latest.size >= this.#maxQueuedSignals) {
          this.#overflow(subscriber);
          continue;
        }
        subscriber.latest.set(key, { sequence: value.sequence, retainThroughMs: now + this.#ttl + this.#skew });
        const index = subscriber.pending.findIndex((item) => item.key === key);
        if (index !== -1) subscriber.bytes -= subscriber.pending.splice(index, 1)[0].bytes;
      }
      if (subscriber.pending.length >= this.#maxQueuedSignals || subscriber.bytes + bytes > this.#maxQueuedBytes) {
        this.#overflow(subscriber);
      } else {
        subscriber.pending.push({ value: structuredClone(value), bytes, key });
        subscriber.bytes += bytes;
      }
      subscriber.wake?.();
    }
  }
  #overflow(subscriber) {
    subscriber.error = new SignalError("SIGNAL_SUBSCRIPTION_OVERFLOW");
    subscriber.pending.length = 0;
    subscriber.bytes = 0;
    subscriber.latest.clear();
    subscriber.clean();
    this.#subscriptions.delete(subscriber);
    subscriber.wake?.();
  }
  subscribe(options = {}) {
    if (typeof options !== "object" || options === null) throw new SignalError("SIGNAL_OPTIONS_INVALID");
    const self = this;
    return { [Symbol.asyncIterator]() {
      const controller = new AbortController();
      const signal = options.signal === void 0 ? controller.signal : AbortSignal.any([controller.signal, options.signal]);
      const iterator = self.#subscribe({ ...options, signal });
      return {
        next: () => iterator.next(),
        async return() {
          controller.abort();
          return iterator.return();
        },
        async throw(error) {
          controller.abort();
          return iterator.throw(error);
        }
      };
    } };
  }
  async *#subscribe(options) {
    this.#assertOpen();
    if (typeof options !== "object" || options === null) throw new SignalError("SIGNAL_OPTIONS_INVALID");
    const mode = options.mode ?? "all";
    if (mode !== "all" && mode !== "latest") throw new SignalError("SIGNAL_SUBSCRIPTION_MODE_INVALID");
    if (options.topics !== void 0) {
      if (!Array.isArray(options.topics) || options.topics.length > 64) throw new SignalError("SIGNAL_TOPIC_FILTER_TOO_LARGE");
      for (const topic of options.topics) {
        if (typeof topic !== "string") throw new SignalError("SIGNAL_TOPIC_FILTER_INVALID");
        assertSignalTopic(topic);
      }
    }
    const streams = options.streams === void 0 ? null : checkedSelectors(options.streams);
    if (this.#subscriptions.size >= this.#maxSubscriptions) throw new SignalError("SIGNAL_SUBSCRIPTION_QUOTA_EXCEEDED");
    const subscriber = {
      topics: options.topics === void 0 ? null : new Set(options.topics),
      streams,
      mode,
      pending: [],
      latest: /* @__PURE__ */ new Map(),
      bytes: 0,
      error: null,
      wake: null,
      clean: () => void 0
    };
    if (options.includeLatest === true) {
      if (mode !== "latest") throw new SignalError("SIGNAL_SUBSCRIPTION_MODE_INVALID");
      const now = this.#now();
      for (const [key, entry] of this.#retainedLatest) {
        if (entry.value.expiresAtMs <= now) {
          this.#retainedLatest.delete(key);
          continue;
        }
        if (subscriber.topics !== null && !subscriber.topics.has(entry.value.topic)) continue;
        if (subscriber.streams !== null && !subscriber.streams.some((selector) => matchesStream(entry.value, selector))) continue;
        if (subscriber.pending.length >= this.#maxQueuedSignals || subscriber.bytes + entry.bytes > this.#maxQueuedBytes) break;
        subscriber.latest.set(key, { sequence: entry.value.sequence, retainThroughMs: now + this.#ttl + this.#skew });
        subscriber.pending.push({ value: structuredClone(entry.value), bytes: entry.bytes, key });
        subscriber.bytes += entry.bytes;
      }
    }
    this.#subscriptions.add(subscriber);
    const signal = options.signal;
    const abort = () => {
      subscriber.pending.length = 0;
      subscriber.bytes = 0;
      subscriber.latest.clear();
      subscriber.clean();
      this.#subscriptions.delete(subscriber);
      subscriber.wake?.();
    };
    subscriber.clean = () => signal?.removeEventListener("abort", abort);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      while (!this.#lifetime.signal.aborted && signal?.aborted !== true) {
        if (subscriber.error !== null) throw subscriber.error;
        const item = subscriber.pending.shift();
        if (item !== void 0) {
          subscriber.bytes -= item.bytes;
          if (item.value.expiresAtMs > this.#now()) yield structuredClone(item.value);
        } else {
          await new Promise((resolve) => {
            subscriber.wake = resolve;
            if (this.#lifetime.signal.aborted || signal?.aborted === true || subscriber.pending.length > 0 || subscriber.error !== null) resolve();
          });
          subscriber.wake = null;
        }
      }
    } finally {
      subscriber.clean();
      this.#subscriptions.delete(subscriber);
    }
  }
  close() {
    if (this.#lifetime.signal.aborted) return;
    this.#lifetime.abort(new SignalError("SIGNAL_CHANNEL_CLOSED"));
    for (const route of this.#routes) this.#detach(route);
    for (const subscriber of this.#subscriptions) {
      subscriber.pending.length = 0;
      subscriber.latest.clear();
      subscriber.clean();
      subscriber.wake?.();
    }
    this.#subscriptions.clear();
    this.#sessions.clear();
    this.#retainedLatest.clear();
    this.#verifyKeys.clear();
    this.#remembered = 0;
  }
  #detach(route, retire = false, reason = new SignalError("SIGNAL_ROUTE_CLOSED")) {
    if (route.busy) this.#retiring.add(route);
    this.#routes.delete(route);
    route.lifetime.abort(reason);
    if (retire && !route.retired) {
      route.retired = true;
      try {
        void Promise.resolve(route.close?.(reason)).catch(() => void 0);
      } catch {
      }
    }
  }
  #assertOpen() {
    this.#lifetime.signal.throwIfAborted();
  }
  #assertFresh(value) {
    this.#assertClock(value);
    if (value.expiresAtMs <= this.#now()) throw new SignalError("SIGNAL_EXPIRED");
  }
  #assertClockFields(value) {
    if (!Number.isSafeInteger(value.sequence) || value.sequence < 1 || !Number.isSafeInteger(value.issuedAtMs) || value.issuedAtMs < 0 || !Number.isSafeInteger(value.expiresAtMs) || value.expiresAtMs <= value.issuedAtMs || value.expiresAtMs - value.issuedAtMs > this.#ttl) {
      throw new SignalError("SIGNAL_CLOCK_INVALID");
    }
  }
  #assertClock(value) {
    this.#assertClockFields(value);
    if (value.issuedAtMs > this.#now() + this.#skew) throw new SignalError("SIGNAL_CLOCK_INVALID");
  }
  #now() {
    const now = bound(this.#options.now?.() ?? Date.now(), 0, Number.MAX_SAFE_INTEGER, "SIGNAL_CLOCK_INVALID");
    this.#observedTime = Math.max(this.#observedTime, now);
    return this.#observedTime;
  }
};
function credentialBytes(value) {
  if (value === void 0) return void 0;
  if (!(value instanceof Uint8Array) || value.length > 1024) throw new SignalError("SIGNAL_CREDENTIAL_INVALID");
  return value.slice();
}
function bound(value, minimum, maximum, code = "SIGNAL_BOUNDS_INVALID") {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new SignalError(code);
  return value;
}
function interrupted(operation, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => {
      reject(signal.reason);
      signal.removeEventListener("abort", abort);
    };
    signal.addEventListener("abort", abort, { once: true });
    void operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}
function checkedStream(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !["streamId", "endpointId", "endpointIncarnation", "target"].includes(key)) || !boundedLabel(value.streamId) || value.endpointId === void 0 !== (value.endpointIncarnation === void 0) || value.endpointId !== void 0 && !boundedLabel(value.endpointId) || value.endpointIncarnation !== void 0 && !boundedLabel(value.endpointIncarnation) || value.target !== void 0 && !boundedLabel(value.target)) throw new SignalError("SIGNAL_STREAM_INVALID");
  return {
    streamId: value.streamId,
    ...value.endpointId === void 0 ? {} : { endpointId: value.endpointId, endpointIncarnation: value.endpointIncarnation },
    ...value.target === void 0 ? {} : { target: value.target }
  };
}
function decodeStream(value) {
  if (typeof value !== "string" || value.length > 2048) throw new SignalError("SIGNAL_STREAM_INVALID");
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new SignalError("SIGNAL_STREAM_INVALID");
  }
  const stream = checkedStream(parsed);
  if (JSON.stringify(stream) !== value) throw new SignalError("SIGNAL_STREAM_INVALID");
  return stream;
}
function boundedLabel(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/u.test(value);
}
function checkedSelectors(value) {
  const keys = ["authorId", "sessionId", "streamId", "endpointId", "endpointIncarnation", "target"];
  if (!Array.isArray(value) || value.length > 64 || value.some((selector) => selector === null || typeof selector !== "object" || Array.isArray(selector) || Object.entries(selector).some(([key, item]) => !keys.includes(key) || !boundedLabel(item)))) {
    throw new SignalError("SIGNAL_STREAM_FILTER_INVALID");
  }
  return structuredClone(value);
}
function matchesStream(value, selector) {
  return (selector.authorId === void 0 || selector.authorId === value.authorId) && (selector.sessionId === void 0 || selector.sessionId === value.sessionId) && (selector.streamId === void 0 || selector.streamId === value.stream?.streamId) && (selector.endpointId === void 0 || selector.endpointId === value.stream?.endpointId) && (selector.endpointIncarnation === void 0 || selector.endpointIncarnation === value.stream?.endpointIncarnation) && (selector.target === void 0 || selector.target === value.stream?.target);
}

export {
  encryptEpochPayload,
  decryptEpochPayload,
  HPKE_SUITE,
  generateX25519KeyPair,
  importX25519PrivateKey,
  exportX25519PrivateKey,
  hpkeSealBase,
  hpkeOpenBase,
  hpkeSendExportBase,
  hpkeReceiveExportBase,
  MAX_CONTENT_CHUNKS,
  MAX_CONTENT_ENCRYPTED_CHUNK_BYTES,
  MAX_CONTENT_MANIFEST_BYTES,
  assertContentReference,
  assertContentManifest,
  assertContentRetention,
  ApplicationContent,
  MAX_SIGNAL_BYTES,
  SignalChannel
};
