import {
  HPKE_SUITE,
  MAX_CONTENT_CHUNKS,
  MAX_CONTENT_ENCRYPTED_CHUNK_BYTES,
  MAX_CONTENT_MANIFEST_BYTES,
  MAX_SIGNAL_BYTES,
  assertContentManifest,
  assertContentReference,
  assertContentRetention,
  generateX25519KeyPair,
  hpkeReceiveExportBase,
  hpkeSendExportBase
} from "./chunk-MNRPZTZP.mjs";
import {
  CONTENT_CHUNK_BYTES
} from "./chunk-7JXKVFZF.mjs";
import {
  check,
  decodeRecord,
  encodeRecord,
  recordDigest,
  signRecord,
  verifyRecord
} from "./chunk-CZMLHZUQ.mjs";
import {
  awaitOwnedTask
} from "./chunk-KSC4KBWO.mjs";
import {
  assertCanonicalCbor,
  bytesToHex as bytesToHex2,
  hexToBytes
} from "./chunk-MAGRVNAE.mjs";
import {
  bytesToHex,
  encodeCanonicalCbor,
  sha256
} from "./chunk-HYFY2E3E.mjs";

// packages/peer-session/src/network-content.ts
var CONTENT_NETWORK_LIMITS = Object.freeze({
  pending: 4,
  active: 4,
  timeoutMs: 3e4,
  chunkBytes: MAX_CONTENT_ENCRYPTED_CHUNK_BYTES,
  chunkBase64Characters: 4 * Math.ceil(MAX_CONTENT_ENCRYPTED_CHUNK_BYTES / 3),
  messageBytes: MAX_CONTENT_MANIFEST_BYTES + 4096
});
function fields(value, keys) {
  check(Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)), "CONTENT_WIRE_INVALID");
}
function base64(bytes) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return btoa(binary);
}
function decoded(value) {
  check(value.length > 0 && value.length <= CONTENT_NETWORK_LIMITS.chunkBase64Characters && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value), "CONTENT_WIRE_CHUNK_INVALID");
  const binary = atob(value);
  check(binary.length <= CONTENT_NETWORK_LIMITS.chunkBytes && btoa(binary) === value, "CONTENT_WIRE_CHUNK_INVALID");
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
function assertContentWireMessage(input) {
  check(input !== null && typeof input === "object" && !Array.isArray(input), "CONTENT_WIRE_INVALID");
  const value = input;
  check(typeof value.id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value.id), "CONTENT_WIRE_INVALID");
  switch (value.type) {
    case "manifest-request":
    case "retain-request":
      fields(value, ["type", "id", "reference"]);
      assertContentReference(value.reference);
      break;
    case "chunk-request":
      fields(value, ["type", "id", "reference", "index"]);
      assertContentReference(value.reference);
      check(Number.isSafeInteger(value.index) && Number(value.index) >= 0 && Number(value.index) < MAX_CONTENT_CHUNKS && Number(value.index) < Math.ceil(value.reference.bytes / CONTENT_CHUNK_BYTES), "CONTENT_WIRE_CHUNK_INVALID");
      break;
    case "manifest-response":
      fields(value, ["type", "id", "manifest"]);
      if (value.manifest !== null) assertContentManifest(value.manifest);
      break;
    case "chunk-response":
      fields(value, ["type", "id", "bytes"]);
      check(value.bytes === null || typeof value.bytes === "string", "CONTENT_WIRE_CHUNK_INVALID");
      if (typeof value.bytes === "string") decoded(value.bytes);
      break;
    case "retain-response":
      fields(value, ["type", "id", "receipt"]);
      assertContentRetention(value.receipt);
      break;
    case "error":
      fields(value, ["type", "id", "code"]);
      check(["CONTENT_UNAVAILABLE", "CONTENT_FORBIDDEN", "CONTENT_BUSY"].includes(String(value.code)), "CONTENT_WIRE_INVALID");
      break;
    case "cancel":
      fields(value, ["type", "id"]);
      break;
    default:
      throw new Error("CONTENT_WIRE_INVALID");
  }
  check(encodeRecord(input).length <= CONTENT_NETWORK_LIMITS.messageBytes, "CONTENT_WIRE_LIMIT");
}
function createNetworkContent(options) {
  options.signal.throwIfAborted();
  check(/^[0-9a-f]{64}$/u.test(options.peerId), "CONTENT_PEER_INVALID");
  const lifetime = new AbortController(), signal = AbortSignal.any([options.signal, lifetime.signal]);
  const pending = /* @__PURE__ */ new Map(), active = /* @__PURE__ */ new Map();
  const local = options.content.source();
  const allowed = () => {
    signal.throwIfAborted();
    check(options.authorize() === true, "CONTENT_FORBIDDEN");
  };
  const close = () => {
    if (lifetime.signal.aborted) return;
    lifetime.abort(new Error("CONTENT_NETWORK_CLOSED"));
    options.signal.removeEventListener("abort", close);
    detach();
    for (const waiter of pending.values()) {
      waiter.cleanup();
      waiter.reject(signal.reason);
    }
    pending.clear();
    for (const controller of active.values()) controller.abort(signal.reason);
    active.clear();
  };
  const send = async (message) => {
    allowed();
    assertContentWireMessage(message);
    try {
      await awaitOwnedTask(signal, () => options.send(message));
      allowed();
    } catch (error) {
      close();
      throw error;
    }
  };
  const cancel = (id) => {
    if (!signal.aborted && options.authorize()) void send({ type: "cancel", id }).catch(() => void 0);
  };
  const request = (action, reference, input, index) => {
    allowed();
    input.signal?.throwIfAborted();
    assertContentReference(reference);
    check(pending.size < CONTENT_NETWORK_LIMITS.pending, "CONTENT_REQUEST_LIMIT");
    const id = crypto.randomUUID(), requestSignal = input.signal;
    return new Promise((resolve, reject) => {
      const finish = (error) => {
        const waiter = pending.get(id);
        if (waiter === void 0) return;
        pending.delete(id);
        waiter.cleanup();
        reject(error);
        cancel(id);
      };
      const abort = () => finish(requestSignal?.reason instanceof Error ? requestSignal.reason : new Error("CONTENT_REQUEST_ABORTED"));
      const timer = setTimeout(() => finish(new Error("CONTENT_REQUEST_TIMEOUT")), CONTENT_NETWORK_LIMITS.timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        requestSignal?.removeEventListener("abort", abort);
      };
      pending.set(id, { action, resolve, reject, cleanup });
      requestSignal?.addEventListener("abort", abort, { once: true });
      const message = action === "chunk" ? { type: "chunk-request", id, reference: { ...reference }, index } : { type: `${action}-request`, id, reference: { ...reference } };
      void send(message).catch((error) => {
        const waiter = pending.get(id);
        if (waiter !== void 0) {
          pending.delete(id);
          cleanup();
          reject(error);
        }
      });
    });
  };
  const detach = options.content.attachSource(`network:${options.peerId}:${crypto.randomUUID()}`, {
    async manifest(reference, input = {}) {
      const response = await request("manifest", reference, input);
      check(response.type === "manifest-response", "CONTENT_RESPONSE_INVALID");
      return response.manifest;
    },
    async chunk(reference, index, input = {}) {
      const response = await request("chunk", reference, input, index);
      check(response.type === "chunk-response", "CONTENT_RESPONSE_INVALID");
      if (response.bytes === null) return null;
      const bytes = decoded(response.bytes), manifest = await local.manifest(reference, input), expected = manifest?.chunks[index];
      check(expected !== void 0 && bytes.length === expected.bytes && bytesToHex(await sha256(bytes)) === expected.hash, "CONTENT_CHUNK_INVALID");
      allowed();
      input.signal?.throwIfAborted();
      return bytes;
    },
    async retained(reference, input = {}) {
      const response = await request("retain", reference, input);
      check(response.type === "retain-response", "CONTENT_RESPONSE_INVALID");
      await options.content.verifyRetention(reference, response.receipt, options.peerId);
      allowed();
      input.signal?.throwIfAborted();
      return response.receipt;
    }
  });
  options.signal.addEventListener("abort", close, { once: true });
  if (options.signal.aborted) close();
  const serve = async (message, controller) => {
    const timer = setTimeout(() => controller.abort(new Error("CONTENT_REQUEST_TIMEOUT")), CONTENT_NETWORK_LIMITS.timeoutMs);
    const requestSignal = AbortSignal.any([signal, controller.signal]);
    try {
      allowed();
      requestSignal.throwIfAborted();
      let response;
      if (message.type === "manifest-request") response = { type: "manifest-response", id: message.id, manifest: await awaitOwnedTask(requestSignal, () => local.manifest(message.reference, { signal: requestSignal })) };
      else if (message.type === "chunk-request") {
        const bytes = await awaitOwnedTask(requestSignal, () => local.chunk(message.reference, message.index, { signal: requestSignal }));
        response = { type: "chunk-response", id: message.id, bytes: bytes === null ? null : base64(bytes) };
      } else response = { type: "retain-response", id: message.id, receipt: await awaitOwnedTask(requestSignal, () => options.content.retain(message.reference, { signal: requestSignal })) };
      requestSignal.throwIfAborted();
      allowed();
      await send(response);
    } catch {
      if (!requestSignal.aborted && !signal.aborted) await send({ type: "error", id: message.id, code: options.authorize() ? "CONTENT_UNAVAILABLE" : "CONTENT_FORBIDDEN" }).catch(() => void 0);
    } finally {
      clearTimeout(timer);
      if (active.get(message.id) === controller) active.delete(message.id);
    }
  };
  return { close, async handle(message) {
    allowed();
    assertContentWireMessage(message);
    if (message.type === "cancel") {
      active.get(message.id)?.abort(new Error("CONTENT_REQUEST_CANCELLED"));
      return;
    }
    if (message.type === "manifest-request" || message.type === "chunk-request" || message.type === "retain-request") {
      check(!active.has(message.id), "CONTENT_REQUEST_DUPLICATE");
      if (active.size >= CONTENT_NETWORK_LIMITS.active) {
        await send({ type: "error", id: message.id, code: "CONTENT_BUSY" });
        return;
      }
      const controller = new AbortController();
      active.set(message.id, controller);
      void serve(message, controller).catch(() => close());
      return;
    }
    const waiter = pending.get(message.id);
    if (waiter === void 0) return;
    check(message.type === "error" || message.type === `${waiter.action}-response`, "CONTENT_RESPONSE_INVALID");
    pending.delete(message.id);
    waiter.cleanup();
    if (message.type === "error") waiter.reject(new Error(message.code));
    else waiter.resolve(message);
  } };
}

// packages/peer-session/src/network-wire.ts
var APPLICATION_NETWORK_LIMITS = Object.freeze({
  messageBytes: 32 * 1024 * 1024,
  fragmentBytes: 48 * 1024,
  queuedMessages: 8,
  queuedBytes: 32 * 1024 * 1024,
  pendingRequests: 4,
  incomingRequests: 4,
  rangeCommands: 32,
  rangeBytes: 4 * 1024 * 1024,
  peers: 8
});
function networkError(code) {
  return new Error(code);
}
function requireNetwork(value, code) {
  if (!value) throw networkError(code);
}
function interruptible(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
function timeout(milliseconds, message) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(networkError(message)), milliseconds);
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}
var ApplicationMessageWire = class {
  #connection;
  #signal;
  #timeoutMs;
  #authorize;
  #outgoing = 0;
  #incoming = 0;
  #pending = 0;
  #pendingBytes = 0;
  #sentBytes = 0;
  #receivedBytes = 0;
  #tail = Promise.resolve();
  constructor(connection, signal, timeoutMs, authorize = () => {
  }) {
    this.#connection = connection;
    this.#signal = signal;
    this.#timeoutMs = timeoutMs;
    this.#authorize = authorize;
  }
  get stats() {
    return { sentBytes: this.#sentBytes, receivedBytes: this.#receivedBytes };
  }
  send(value, authorize) {
    this.#signal.throwIfAborted();
    requireNetwork(this.#pending < APPLICATION_NETWORK_LIMITS.queuedMessages, "APPLICATION_NETWORK_BACKPRESSURE");
    const bytes = encodeRecord(value);
    requireNetwork(bytes.length > 0 && bytes.length <= APPLICATION_NETWORK_LIMITS.messageBytes && this.#pendingBytes + bytes.length <= APPLICATION_NETWORK_LIMITS.queuedBytes, "APPLICATION_NETWORK_BACKPRESSURE");
    this.#pending++;
    this.#pendingBytes += bytes.length;
    const queued = timeout(this.#timeoutMs, "APPLICATION_NETWORK_WRITE_TIMEOUT");
    const signal = AbortSignal.any([this.#signal, queued.signal]);
    const task = this.#tail.then(async () => {
      signal.throwIfAborted();
      authorize?.();
      requireNetwork(this.#outgoing < Number.MAX_SAFE_INTEGER, "APPLICATION_NETWORK_SEQUENCE_EXHAUSTED");
      const id = ++this.#outgoing;
      for (let offset = 0; offset < bytes.length; offset += APPLICATION_NETWORK_LIMITS.fragmentBytes) {
        signal.throwIfAborted();
        this.#authorize();
        authorize?.();
        const fragment = bytes.subarray(offset, offset + APPLICATION_NETWORK_LIMITS.fragmentBytes);
        const frame = encodeCanonicalCbor([1n, BigInt(id), BigInt(offset), BigInt(bytes.length), fragment]);
        await interruptible(this.#connection.send(frame, { signal }), signal);
        this.#sentBytes += frame.length;
      }
    }).finally(() => {
      queued.cancel();
      this.#pending--;
      this.#pendingBytes -= bytes.length;
    });
    this.#tail = task.catch(() => void 0);
    return task;
  }
  async *messages() {
    let body = null, offset = 0;
    let assembly;
    const iterator = this.#connection.frames(this.#signal)[Symbol.asyncIterator]();
    try {
      while (!this.#signal.aborted) {
        const signal = assembly === void 0 ? this.#signal : AbortSignal.any([this.#signal, assembly.signal]);
        const next = await interruptible(iterator.next(), signal);
        if (next.done) {
          requireNetwork(body === null, "APPLICATION_NETWORK_TRUNCATED");
          return;
        }
        const bytes = next.value;
        requireNetwork(
          bytes instanceof Uint8Array && bytes.length > 0 && bytes.length <= APPLICATION_NETWORK_LIMITS.fragmentBytes + 128,
          "APPLICATION_NETWORK_FRAME_LIMIT"
        );
        this.#receivedBytes += bytes.length;
        const frame = assertCanonicalCbor(bytes);
        requireNetwork(Array.isArray(frame) && frame.length === 5 && frame[0] === 1n && typeof frame[1] === "bigint" && typeof frame[2] === "bigint" && typeof frame[3] === "bigint" && frame[4] instanceof Uint8Array, "APPLICATION_NETWORK_FRAME_INVALID");
        const [id, position, total] = [Number(frame[1]), Number(frame[2]), Number(frame[3])], chunk = frame[4];
        requireNetwork(
          Number.isSafeInteger(id) && id === this.#incoming + 1 && Number.isSafeInteger(position) && position === offset && Number.isSafeInteger(total) && total > 0 && total <= APPLICATION_NETWORK_LIMITS.messageBytes && chunk.length > 0 && chunk.length <= APPLICATION_NETWORK_LIMITS.fragmentBytes && offset + chunk.length <= total,
          "APPLICATION_NETWORK_FRAME_INVALID"
        );
        if (body === null) {
          body = new Uint8Array(total);
          assembly = timeout(this.#timeoutMs, "APPLICATION_NETWORK_READ_TIMEOUT");
        }
        requireNetwork(body.length === total, "APPLICATION_NETWORK_FRAME_INVALID");
        body.set(chunk, offset);
        offset += chunk.length;
        if (offset === total) {
          const complete = body;
          body = null;
          offset = 0;
          this.#incoming++;
          assembly?.cancel();
          assembly = void 0;
          yield decodeRecord(complete);
        }
      }
    } finally {
      assembly?.cancel();
      void iterator.return?.().catch(() => void 0);
    }
  }
};

// packages/peer-session/src/secure-channel.ts
var APPLICATION_CHANNEL_SUITE = `${HPKE_SUITE}/peer-record-v1`;
var APPLICATION_CHANNEL_LIMITS = Object.freeze({ overheadBytes: 22, records: 2 ** 24, plaintextBytes: 2 ** 32 });
var DOMAIN = "chronolog/peer-channel/v1";
var EXPORT_CONTEXT = encodeRecord({ domain: DOMAIN, layout: ["reliable-key:32", "reliable-nonce:12", "live-key:32", "live-nonce:12"] });
var HEADER = 6;
var TAG = 16;
var limit = (live) => live ? MAX_SIGNAL_BYTES : APPLICATION_NETWORK_LIMITS.fragmentBytes + 128;
var source = (bytes) => Uint8Array.from(bytes).buffer;
var context = (sender, receiver) => encodeRecord({ domain: DOMAIN, suite: APPLICATION_CHANNEL_SUITE, sender, receiver });
var RecordCipher = class {
  #key;
  #baseNonce;
  #live;
  #sequence = 0;
  #bytes = 0;
  constructor(key, nonce, live) {
    this.#key = key;
    this.#baseNonce = nonce;
    this.#live = live;
  }
  #nonce(sequence) {
    const nonce = this.#baseNonce.slice(), view = new DataView(nonce.buffer);
    view.setUint32(8, view.getUint32(8) ^ sequence);
    return nonce;
  }
  #budget(length) {
    requireNetwork(this.#key !== void 0, "APPLICATION_CHANNEL_CLOSED");
    requireNetwork(
      this.#sequence < APPLICATION_CHANNEL_LIMITS.records && this.#bytes + length <= APPLICATION_CHANNEL_LIMITS.plaintextBytes,
      "APPLICATION_CHANNEL_KEY_EXHAUSTED"
    );
  }
  async seal(input) {
    requireNetwork(input instanceof Uint8Array && input.length > 0 && input.length <= limit(this.#live), "APPLICATION_CHANNEL_FRAME_LIMIT");
    this.#budget(input.length);
    const sequence = ++this.#sequence, header = Uint8Array.of(1, this.#live ? 2 : 1, 0, 0, 0, 0);
    new DataView(header.buffer).setUint32(2, sequence);
    this.#bytes += input.length;
    const encrypted = new Uint8Array(await crypto.subtle.encrypt({
      name: "AES-GCM",
      iv: source(this.#nonce(sequence)),
      additionalData: source(header),
      tagLength: 128
    }, this.#key, source(input)));
    const result = new Uint8Array(header.length + encrypted.length);
    result.set(header);
    result.set(encrypted, HEADER);
    return result;
  }
  async open(input) {
    requireNetwork(
      input instanceof Uint8Array && input.length > HEADER + TAG && input.length <= limit(this.#live) + HEADER + TAG,
      "APPLICATION_CHANNEL_FRAME_LIMIT"
    );
    requireNetwork(input[0] === 1 && input[1] === (this.#live ? 2 : 1), "APPLICATION_CHANNEL_FRAME_INVALID");
    const sequence = new DataView(input.buffer, input.byteOffset, HEADER).getUint32(2);
    requireNetwork(sequence > 0 && sequence <= APPLICATION_CHANNEL_LIMITS.records, "APPLICATION_CHANNEL_SEQUENCE_INVALID");
    if (this.#live && sequence <= this.#sequence) return null;
    requireNetwork(this.#live || sequence === this.#sequence + 1, "APPLICATION_CHANNEL_SEQUENCE_INVALID");
    this.#budget(input.length - HEADER - TAG);
    let plaintext;
    try {
      plaintext = new Uint8Array(await crypto.subtle.decrypt({
        name: "AES-GCM",
        iv: source(this.#nonce(sequence)),
        additionalData: source(input.subarray(0, HEADER)),
        tagLength: 128
      }, this.#key, source(input.subarray(HEADER))));
    } catch {
      throw new Error("APPLICATION_CHANNEL_AUTHENTICATION_FAILED");
    }
    this.#sequence = sequence;
    this.#bytes += plaintext.length;
    return plaintext;
  }
  clear() {
    this.#key = void 0;
    this.#baseNonce.fill(0);
  }
};
async function direction(secret, usage) {
  requireNetwork(secret.length === 88, "APPLICATION_CHANNEL_KEY_INVALID");
  try {
    const reliable = await crypto.subtle.importKey("raw", source(secret.subarray(0, 32)), "AES-GCM", false, [usage]);
    const live = await crypto.subtle.importKey("raw", source(secret.subarray(44, 76)), "AES-GCM", false, [usage]);
    return { reliable: new RecordCipher(reliable, secret.slice(32, 44), false), live: new RecordCipher(live, secret.slice(76, 88), true) };
  } finally {
    secret.fill(0);
  }
}
function clear(value) {
  value?.reliable.clear();
  value?.live.clear();
}
var ApplicationSecureChannel = class {
  connection;
  #signal;
  #receiver;
  #outbound;
  #inbound;
  #hello = false;
  #preparing = false;
  #sending = false;
  #closed = false;
  #reliableBusy = false;
  #liveBusy = false;
  #onAbort = () => this.clear();
  constructor(raw, signal) {
    this.#signal = AbortSignal.any([signal, raw.signal]);
    const lifetime = this.#signal, channel = this;
    const live = raw.live === void 0 ? void 0 : {
      signal: AbortSignal.any([lifetime, raw.live.signal]),
      async trySend(frame, options = {}) {
        const signal2 = options.signal === void 0 ? lifetime : AbortSignal.any([lifetime, options.signal]);
        channel.#open();
        signal2.throwIfAborted();
        requireNetwork(channel.#sending && channel.#outbound !== void 0, "APPLICATION_PEER_AUTHENTICATION_REQUIRED");
        if (channel.#liveBusy) return false;
        channel.#liveBusy = true;
        try {
          const encrypted = await channel.#outbound.live.seal(frame);
          channel.#open();
          signal2.throwIfAborted();
          return await raw.live.trySend(encrypted, { signal: signal2 });
        } finally {
          channel.#liveBusy = false;
        }
      },
      async *frames(signal2) {
        const lifetime2 = signal2 === void 0 ? channel.#signal : AbortSignal.any([channel.#signal, signal2]);
        for await (const frame of raw.live.frames(lifetime2)) {
          channel.#open();
          lifetime2.throwIfAborted();
          requireNetwork(channel.#inbound !== void 0, "APPLICATION_PEER_AUTHENTICATION_REQUIRED");
          const plaintext = await channel.#inbound.live.open(frame);
          channel.#open();
          lifetime2.throwIfAborted();
          if (plaintext !== null) yield plaintext;
        }
      },
      close: () => raw.live.close()
    };
    this.connection = {
      signal: lifetime,
      ...live === void 0 ? {} : { live },
      async send(frame, options = {}) {
        const signal2 = options.signal === void 0 ? lifetime : AbortSignal.any([lifetime, options.signal]);
        channel.#open();
        signal2.throwIfAborted();
        requireNetwork(!channel.#reliableBusy, "APPLICATION_NETWORK_BACKPRESSURE");
        channel.#reliableBusy = true;
        try {
          const bytes = channel.#sending ? await channel.#outbound.reliable.seal(frame) : frame;
          channel.#open();
          signal2.throwIfAborted();
          await raw.send(bytes, { signal: signal2 });
        } catch (error) {
          if (channel.#sending) {
            channel.clear();
            void raw.close().catch(() => void 0);
          }
          throw error;
        } finally {
          channel.#reliableBusy = false;
        }
      },
      async *frames(signal2) {
        const lifetime2 = signal2 === void 0 ? channel.#signal : AbortSignal.any([channel.#signal, signal2]);
        for await (const frame of raw.frames(lifetime2)) {
          channel.#open();
          lifetime2.throwIfAborted();
          const plaintext = channel.#inbound === void 0 ? frame : await channel.#inbound.reliable.open(frame);
          channel.#open();
          lifetime2.throwIfAborted();
          yield plaintext;
        }
      },
      close: async () => {
        channel.clear();
        await raw.close();
      }
    };
    lifetime.addEventListener("abort", this.#onAbort, { once: true });
    if (lifetime.aborted) this.clear();
  }
  #open() {
    this.#signal.throwIfAborted();
    requireNetwork(!this.#closed, "APPLICATION_CHANNEL_CLOSED");
  }
  async hello() {
    this.#open();
    requireNetwork(!this.#hello, "APPLICATION_NETWORK_HANDSHAKE_ORDER");
    this.#hello = true;
    const receiver = await generateX25519KeyPair(false);
    this.#open();
    this.#receiver = receiver;
    return { suite: APPLICATION_CHANNEL_SUITE, receiverKey: bytesToHex2(receiver.publicKeyBytes) };
  }
  async prepare(peerReceiverKey, sender, receiver) {
    this.#open();
    requireNetwork(!this.#preparing, "APPLICATION_NETWORK_HANDSHAKE_ORDER");
    this.#preparing = true;
    const exported = await hpkeSendExportBase(hexToBytes(peerReceiverKey), context(sender, receiver), EXPORT_CONTEXT, 88);
    try {
      this.#open();
      const outbound = await direction(exported.exportedSecret, "encrypt");
      if (this.#closed || this.#signal.aborted) {
        clear(outbound);
        this.#open();
      }
      this.#outbound = outbound;
      return bytesToHex2(exported.encapsulatedKey);
    } finally {
      exported.exportedSecret.fill(0);
    }
  }
  /** Called only when every public proof fragment has been dispatched. */
  enableSending() {
    this.#open();
    requireNetwork(this.#outbound !== void 0 && !this.#sending, "APPLICATION_NETWORK_HANDSHAKE_ORDER");
    this.#sending = true;
  }
  async accept(encapsulatedKey, sender, receiver) {
    this.#open();
    requireNetwork(this.#receiver !== void 0 && this.#inbound === void 0, "APPLICATION_NETWORK_HANDSHAKE_ORDER");
    const key = this.#receiver;
    this.#receiver = void 0;
    const secret = await hpkeReceiveExportBase(key.privateKey, key.publicKeyBytes, hexToBytes(encapsulatedKey), context(sender, receiver), EXPORT_CONTEXT, 88);
    try {
      this.#open();
      const inbound = await direction(secret, "decrypt");
      if (this.#closed || this.#signal.aborted) {
        clear(inbound);
        this.#open();
      }
      this.#inbound = inbound;
    } finally {
      secret.fill(0);
    }
  }
  clear() {
    if (this.#closed) return;
    this.#closed = true;
    this.#receiver = void 0;
    this.#signal.removeEventListener("abort", this.#onAbort);
    clear(this.#outbound);
    clear(this.#inbound);
    this.#outbound = void 0;
    this.#inbound = void 0;
  }
};

// packages/peer-session/src/network.ts
var tracked = /* @__PURE__ */ new WeakMap();
function applicationPeerDiagnostics(session) {
  return [...tracked.get(session)?.values() ?? []].map((snapshot) => snapshot());
}
async function connectApplicationPeer(session, options) {
  check(session.status.connectedPeers < 8, "SESSION_PEER_LIMIT");
  const lifetime = new AbortController(), signal = AbortSignal.any([lifetime.signal, session.signal, options.connection.signal, ...options.signal === void 0 ? [] : [options.signal]]);
  const secure = new ApplicationSecureChannel(options.connection, signal);
  const wire = new ApplicationMessageWire(secure.connection, signal, options.handshakeTimeoutMs ?? 3e4);
  const iterator = wire.messages()[Symbol.asyncIterator](), localNonce = crypto.randomUUID(), connectionId = crypto.randomUUID();
  const timeout2 = setTimeout(() => lifetime.abort(new Error("PEER_HANDSHAKE_TIMEOUT")), options.handshakeTimeoutMs ?? 3e4);
  let authenticated = false, stopping, stopFacts, signalRoute, contentLink;
  let sentLiveBytes = 0, receivedLiveBytes = 0;
  const liveDiagnostics = () => signalRoute === void 0 ? {} : { sentLiveBytes, receivedLiveBytes, signalRejections: signalRoute.diagnostics };
  const pending = /* @__PURE__ */ new Map();
  const close = () => stopping ??= (async () => {
    lifetime.abort(new Error("PEER_CLOSED"));
    stopFacts?.();
    signalRoute?.close();
    contentLink?.close();
    secure.clear();
    for (const value of pending.values()) {
      clearTimeout(value.timer);
      value.reject(signal.reason);
    }
    ;
    pending.clear();
    if (authenticated) {
      authenticated = false;
      tracked.get(session)?.delete(connectionId);
      session.setConnectedPeers(tracked.get(session)?.size ?? 0);
    }
    ;
    await options.connection.close();
    void iterator.return?.();
  })();
  signal.addEventListener("abort", () => {
    void close().catch(() => void 0);
  }, { once: true });
  try {
    await wire.send({ kind: "hello", value: await signRecord("peer-hello", { applicationId: session.applicationId, nonce: localNonce, authority: session.authority.bundle(), channel: await secure.hello() }, session.device.identity) });
    const next = await iterator.next();
    check(!next.done, "PEER_HELLO_MISSING");
    const hello = next.value;
    check(hello.kind === "hello", "PEER_HELLO_INVALID");
    await verifyRecord("peer-hello", hello.value);
    check(hello.value.payload.applicationId === session.applicationId && typeof hello.value.payload.nonce === "string" && hello.value.payload.nonce.length <= 128 && (options.peerIdentity === void 0 || options.peerIdentity === hello.value.signer), "PEER_SCOPE_MISMATCH");
    await session.mergeAuthority(hello.value.payload.authority);
    check(session.authority.grant(hello.value.signer) !== null, "PEER_MEMBER_REQUIRED");
    const localContext = { applicationId: session.applicationId, identity: session.device.identity.publicKey, nonce: localNonce }, peerContext = { applicationId: session.applicationId, identity: hello.value.signer, nonce: hello.value.payload.nonce };
    const encapsulatedKey = await secure.prepare(hello.value.payload.channel.receiverKey, localContext, peerContext);
    await wire.send({ kind: "proof", value: await signRecord("peer-proof", { applicationId: session.applicationId, localNonce, peerNonce: hello.value.payload.nonce, encapsulatedKey }, session.device.identity) });
    secure.enableSending();
    const proofNext = await iterator.next();
    check(!proofNext.done, "PEER_PROOF_MISSING");
    const proof = proofNext.value;
    check(proof.kind === "proof", "PEER_PROOF_INVALID");
    await verifyRecord("peer-proof", proof.value, hello.value.signer);
    check(proof.value.payload.applicationId === session.applicationId && proof.value.payload.localNonce === hello.value.payload.nonce && proof.value.payload.peerNonce === localNonce, "PEER_PROOF_CONTEXT_INVALID");
    await secure.accept(proof.value.payload.encapsulatedKey, peerContext, localContext);
    clearTimeout(timeout2);
    const connections = tracked.get(session) ?? /* @__PURE__ */ new Map();
    check(connections.size < 8, "SESSION_PEER_LIMIT");
    tracked.set(session, connections);
    authenticated = true;
    connections.set(connectionId, () => ({ connectionId, peerId: hello.value.signer, kind: "unknown", sentReliableBytes: wire.stats.sentBytes, receivedReliableBytes: wire.stats.receivedBytes, ...liveDiagnostics() }));
    session.setConnectedPeers(connections.size);
    if (secure.connection.live !== void 0 && session.authority.grant(hello.value.signer)?.reader) {
      const live = secure.connection.live;
      signalRoute = session.signals.attachRoute({ async trySend(frame, input) {
        const accepted = await live.trySend(frame, input);
        if (accepted) sentLiveBytes = Math.min(Number.MAX_SAFE_INTEGER, sentLiveBytes + frame.length);
        return accepted;
      } });
      void (async () => {
        try {
          for await (const frame of live.frames(signal)) {
            if (!session.authority.grant(hello.value.signer)?.reader) break;
            receivedLiveBytes = Math.min(Number.MAX_SAFE_INTEGER, receivedLiveBytes + frame.length);
            await signalRoute?.receive(frame);
          }
        } catch {
        }
      })();
    }
    contentLink = createNetworkContent({ content: session.content, peerId: hello.value.signer, signal, authorize: () => session.authority.grant(hello.value.signer)?.reader === true && session.authority.grant(session.device.identity.publicKey)?.reader === true, send: (message) => wire.send({ kind: "content", message }, () => check(session.authority.grant(hello.value.signer)?.reader === true && session.authority.grant(session.device.identity.publicKey)?.reader === true, "CONTENT_FORBIDDEN")) });
    let flushing = false, dirty = false;
    const publish = async () => {
      dirty = true;
      if (flushing) return;
      flushing = true;
      try {
        while (dirty && !signal.aborted) {
          dirty = false;
          await wire.send({ kind: "facts", requestId: "", facts: session.exportFacts() });
        }
      } finally {
        flushing = false;
      }
    };
    stopFacts = session.onFacts(() => {
      void publish().catch(() => close());
    });
    void (async () => {
      try {
        while (!signal.aborted) {
          const incoming = await iterator.next();
          if (incoming.done) break;
          const message = incoming.value;
          check(session.authority.grant(hello.value.signer) !== null, "PEER_REVOKED");
          if (message.kind === "facts") {
            check(typeof message.requestId === "string" && message.requestId.length <= 128, "PEER_REQUEST_INVALID");
            await session.mergeFacts(message.facts);
            for (const envelope of message.facts.envelopes) {
              try {
                await session.retain(envelope.payload.proposalId, { author: envelope.payload.author, envelopeDigest: await recordDigest(envelope) });
              } catch (error) {
                if (!(error instanceof Error) || !["RETENTION_SUBJECT_MISSING", "RETENTION_SUBJECT_INVALID"].includes(error.message)) throw error;
              }
            }
            if (message.requestId !== "") await wire.send({ kind: "ack", requestId: message.requestId });
          } else if (message.kind === "content") await contentLink.handle(message.message);
          else if (message.kind === "ack") {
            const waiter = pending.get(message.requestId);
            if (waiter !== void 0) {
              pending.delete(message.requestId);
              clearTimeout(waiter.timer);
              waiter.resolve();
            }
          } else throw new Error("PEER_MESSAGE_INVALID");
        }
      } catch (error) {
        lifetime.abort(error);
      } finally {
        await close();
      }
    })();
    await publish();
    const completion = signal.aborted ? Promise.resolve() : new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    return { peerIdentity: hello.value.signer, signal, completion, get stats() {
      return { ...wire.stats, ...liveDiagnostics() };
    }, close, synchronize() {
      check(!signal.aborted && pending.size < 4, "PEER_REQUEST_LIMIT");
      const requestId = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error("PEER_SYNC_TIMEOUT"));
          void close();
        }, 3e4);
        pending.set(requestId, { resolve, reject, timer });
        void wire.send({ kind: "facts", requestId, facts: session.exportFacts() }).catch((error) => {
          clearTimeout(timer);
          pending.delete(requestId);
          reject(error);
        });
      });
    } };
  } catch (error) {
    await close();
    throw error;
  } finally {
    clearTimeout(timeout2);
  }
}
export {
  applicationPeerDiagnostics,
  connectApplicationPeer
};
