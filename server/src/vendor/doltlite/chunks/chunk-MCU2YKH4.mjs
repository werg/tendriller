// packages/records/src/bytes-store.ts
var MemoryBytesStore = class {
  #values = /* @__PURE__ */ new Map();
  #quotaBytes;
  #maxValueBytes;
  #usedBytes = 0;
  constructor(options = {}) {
    for (const limit of [options.quotaBytes, options.maxValueBytes]) {
      if (limit !== void 0 && (!Number.isSafeInteger(limit) || limit < 1)) throw new Error("BYTES_STORE_QUOTA_INVALID");
    }
    this.#quotaBytes = options.quotaBytes ?? Infinity;
    this.#maxValueBytes = options.maxValueBytes ?? Infinity;
  }
  async get(key) {
    return this.#values.get(key)?.slice() ?? null;
  }
  async put(key, bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > this.#maxValueBytes) throw new Error("BYTES_STORE_VALUE_TOO_LARGE");
    const used = this.#usedBytes - (this.#values.get(key)?.byteLength ?? 0) + bytes.byteLength;
    if (used > this.#quotaBytes) throw new Error("BYTES_STORE_QUOTA_EXCEEDED");
    this.#values.set(key, Uint8Array.from(bytes));
    this.#usedBytes = used;
  }
  async putMany(entries) {
    if (entries.length === 0) return;
    const staged = /* @__PURE__ */ new Map();
    for (const entry of entries) {
      if (!(entry.value instanceof Uint8Array) || entry.value.byteLength > this.#maxValueBytes) throw new Error("BYTES_STORE_VALUE_TOO_LARGE");
      staged.set(entry.key, Uint8Array.from(entry.value));
    }
    let used = this.#usedBytes;
    for (const [key, value] of staged) used = used - (this.#values.get(key)?.byteLength ?? 0) + value.byteLength;
    if (used > this.#quotaBytes) throw new Error("BYTES_STORE_QUOTA_EXCEEDED");
    for (const [key, value] of staged) this.#values.set(key, value);
    this.#usedBytes = used;
  }
  async delete(key) {
    this.#usedBytes -= this.#values.get(key)?.byteLength ?? 0;
    this.#values.delete(key);
  }
  async putAllIfEmpty(entries) {
    const captured = entries.map((entry) => ({ key: entry.key, value: Uint8Array.from(entry.value) }));
    if (new Set(captured.map((entry) => entry.key)).size !== captured.length) throw new Error("BYTES_STORE_DUPLICATE_KEY");
    if (captured.some((entry) => entry.value.byteLength > this.#maxValueBytes)) throw new Error("BYTES_STORE_VALUE_TOO_LARGE");
    const bytes = captured.reduce((sum, entry) => sum + entry.value.byteLength, 0);
    if (bytes > this.#quotaBytes) throw new Error("BYTES_STORE_QUOTA_EXCEEDED");
    if (this.#values.size !== 0) return false;
    for (const entry of captured) this.#values.set(entry.key, entry.value);
    this.#usedBytes = bytes;
    return true;
  }
  async *iterateEntries() {
    const snapshot = [...this.#values].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    for (const [key, value] of snapshot) yield { key, value: value.slice() };
  }
  async putStreamIfEmpty(entries) {
    if (this.#values.size !== 0) return false;
    const staged = /* @__PURE__ */ new Map();
    let bytes = 0;
    for await (const entry of entries) {
      if (staged.has(entry.key)) throw new Error("BYTES_STORE_DUPLICATE_KEY");
      if (!(entry.value instanceof Uint8Array) || entry.value.byteLength > this.#maxValueBytes) throw new Error("BYTES_STORE_VALUE_TOO_LARGE");
      bytes += entry.value.length;
      if (bytes > this.#quotaBytes) throw new Error("BYTES_STORE_QUOTA_EXCEEDED");
      staged.set(entry.key, Uint8Array.from(entry.value));
    }
    if (this.#values.size !== 0) return false;
    for (const [key, value] of staged) this.#values.set(key, value);
    this.#usedBytes = bytes;
    return true;
  }
  async entries() {
    return [...this.#values.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => ({ key, value: value.slice() }));
  }
};
async function writeBytesMany(store, entries) {
  if (entries.length === 0) return;
  if (entries.length === 1) {
    await store.put(entries[0].key, entries[0].value);
    return;
  }
  if (store.putMany !== void 0) {
    await store.putMany(entries);
    return;
  }
  for (const entry of entries) await store.put(entry.key, entry.value);
}

// packages/records/src/live-channel.ts
var PEER_LIVE_MESSAGE_LIMITS = Object.freeze({ frameBytes: 16448, queueFrames: 64, bufferedBytes: 65536 });
function frameLiveMessageChannel(channel) {
  channel.binaryType = "arraybuffer";
  let closed = false, reading = false, failure = null;
  let sentBytes = 0, receivedBytes = 0, sentPackets = 0, receivedPackets = 0, queuedReceiveBytes = 0, droppedPackets = 0;
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  void ready.catch(() => void 0);
  const lifetime = new AbortController(), queue = [], waiters = /* @__PURE__ */ new Set();
  const listeners = [];
  const wake = () => {
    for (const resolve of waiters) resolve();
    waiters.clear();
  };
  const stop = (error) => {
    if (closed) return;
    closed = true;
    failure = error ?? null;
    rejectReady(error ?? new Error("PEER_MESSAGE_LIVE_CLOSED"));
    for (const [type, listener] of listeners) channel.removeEventListener(type, listener);
    queue.length = 0;
    queuedReceiveBytes = 0;
    lifetime.abort(error ?? new Error("PEER_MESSAGE_LIVE_CLOSED"));
    channel.close();
    wake();
  };
  const on = (type, listener) => {
    listeners.push([type, listener]);
    channel.addEventListener(type, listener);
  };
  on("open", () => resolveReady());
  on("close", () => stop(new Error("PEER_MESSAGE_LIVE_ENDED")));
  on("error", () => stop(new Error("PEER_MESSAGE_LIVE_ERROR")));
  on("message", (event) => {
    if (closed) return;
    const value = event.data;
    if (!(value instanceof ArrayBuffer) || value.byteLength < 1 || value.byteLength > PEER_LIVE_MESSAGE_LIMITS.frameBytes) {
      stop(new Error("PEER_MESSAGE_LIVE_FRAME_INVALID"));
      return;
    }
    receivedBytes += value.byteLength;
    receivedPackets += 1;
    if (queue.length === PEER_LIVE_MESSAGE_LIMITS.queueFrames) {
      queuedReceiveBytes -= queue.shift().length;
      droppedPackets += 1;
    }
    const bytes = new Uint8Array(value.slice(0));
    queue.push(bytes);
    queuedReceiveBytes += bytes.length;
    wake();
  });
  if (channel.readyState === "open") resolveReady();
  else if (channel.readyState !== "connecting") stop(new Error("PEER_MESSAGE_LIVE_CLOSED"));
  async function* read(signal) {
    if (reading) throw new Error("PEER_MESSAGE_LIVE_READER_EXISTS");
    reading = true;
    const abort = () => stop();
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (signal.aborted) return;
      for (; ; ) {
        if (failure !== null) throw failure;
        if (closed) return;
        const bytes = queue.shift();
        if (bytes === void 0) {
          await new Promise((resolve) => {
            waiters.add(resolve);
          });
          continue;
        }
        queuedReceiveBytes -= bytes.length;
        yield bytes;
      }
    } finally {
      signal.removeEventListener("abort", abort);
      stop();
    }
  }
  return {
    ready,
    signal: lifetime.signal,
    get stats() {
      return {
        sentBytes,
        receivedBytes,
        sentPackets,
        receivedPackets,
        droppedPackets,
        queuedSendBytes: channel.bufferedAmount,
        queuedReceiveBytes,
        queuedReceiveFrames: queue.length
      };
    },
    async trySend(input, options = {}) {
      options.signal?.throwIfAborted();
      if (closed) throw failure ?? new Error("PEER_MESSAGE_LIVE_CLOSED");
      if (channel.readyState !== "open") throw new Error("PEER_MESSAGE_LIVE_NOT_OPEN");
      if (!(input instanceof Uint8Array) || input.length < 1 || input.length > PEER_LIVE_MESSAGE_LIMITS.frameBytes) throw new Error("PEER_MESSAGE_LIVE_FRAME_TOO_LARGE");
      if (channel.bufferedAmount + input.length > PEER_LIVE_MESSAGE_LIMITS.bufferedBytes) return false;
      channel.send(input.slice().buffer);
      sentBytes += input.length;
      sentPackets += 1;
      return true;
    },
    frames(signal) {
      return { [Symbol.asyncIterator]() {
        const controller = new AbortController();
        const iterator = read(signal === void 0 ? controller.signal : AbortSignal.any([controller.signal, signal]));
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
    },
    async close() {
      stop();
    }
  };
}

// packages/records/src/message-channel.ts
var PEER_MESSAGE_LIMITS = Object.freeze({
  frameBytes: 1048576 + 65536,
  packetBytes: 16 * 1024,
  queueBytes: 4 * 1024 * 1024,
  queueFrames: 16,
  bufferedBytes: 256 * 1024
});
var HEADER = 16;
var HELLO = 1;
var DATA = 2;
var CREDIT = 3;
function framePeerMessageChannels(channels, options = {}) {
  const reliable = frameMessageChannel(channels.reliable, options);
  let live;
  try {
    live = frameLiveMessageChannel(channels.live);
  } catch (error) {
    void reliable.close();
    channels.live.close();
    throw error;
  }
  const signal = AbortSignal.any([reliable.signal, live.signal]);
  const close = async () => {
    await Promise.all([reliable.close(), live.close()]);
  };
  signal.addEventListener("abort", () => {
    void close();
  }, { once: true });
  if (signal.aborted) void close();
  const ready = Promise.all([reliable.ready, live.ready]).then(() => void 0);
  void ready.catch(() => void 0);
  return {
    ready,
    signal,
    live,
    get stats() {
      const a = reliable.stats, b = live.stats;
      return {
        sentBytes: a.sentBytes + b.sentBytes,
        receivedBytes: a.receivedBytes + b.receivedBytes,
        sentPackets: a.sentPackets + b.sentPackets,
        receivedPackets: a.receivedPackets + b.receivedPackets,
        queuedSendBytes: a.queuedSendBytes + b.queuedSendBytes,
        queuedReceiveBytes: a.queuedReceiveBytes + b.queuedReceiveBytes,
        queuedReceiveFrames: a.queuedReceiveFrames + b.queuedReceiveFrames
      };
    },
    send: (bytes, sendOptions) => reliable.send(bytes, sendOptions),
    frames: (input) => reliable.frames(input),
    close
  };
}
function frameMessageChannel(channel, options = {}) {
  const maximum = options.maxFrameBytes ?? PEER_MESSAGE_LIMITS.frameBytes;
  const windowBytes = options.queueBytes ?? PEER_MESSAGE_LIMITS.queueBytes;
  const windowFrames = options.queueFrames ?? PEER_MESSAGE_LIMITS.queueFrames;
  const timeoutMs = options.sendTimeoutMs ?? 3e4;
  const helloTimeoutMs = options.helloTimeoutMs ?? 1e4;
  if (![maximum, windowBytes, windowFrames, timeoutMs, helloTimeoutMs].every(Number.isSafeInteger) || maximum < 1 || maximum > PEER_MESSAGE_LIMITS.frameBytes || windowBytes < maximum || windowBytes > PEER_MESSAGE_LIMITS.queueBytes || windowFrames < 1 || windowFrames > PEER_MESSAGE_LIMITS.queueFrames || timeoutMs < 1 || timeoutMs > 12e4 || helloTimeoutMs < 1 || helloTimeoutMs > 12e4) throw new Error("PEER_MESSAGE_BOUNDS_INVALID");
  channel.binaryType = "arraybuffer";
  channel.bufferedAmountLowThreshold = PEER_MESSAGE_LIMITS.bufferedBytes / 2;
  let closed = false, failure = null, opened = false, greeted = false, reading = false;
  let remoteMaximum = 0, remoteWindow = 0, remoteFrames = 0, creditBytes = 0, creditFrames = 0;
  let queuedSendBytes = 0, queuedSendFrames = 0, reservedBytes = 0, reservedFrames = 0;
  let assembling = null, received = 0;
  let sentBytes = 0, receivedBytes = 0, sentPackets = 0, receivedPackets = 0;
  const lifetime = new AbortController();
  const queue = [], waiters = /* @__PURE__ */ new Set();
  let tail = Promise.resolve();
  let helloTimer;
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  void ready.catch(() => void 0);
  const wake = () => {
    for (const resolve of waiters) resolve();
    waiters.clear();
  };
  const wait = () => new Promise((resolve) => {
    waiters.add(resolve);
  });
  const assertOpen = () => {
    if (closed) throw failure ?? new Error("PEER_MESSAGE_CONNECTION_CLOSED");
  };
  const listeners = [];
  const stop = (error) => {
    if (closed) return;
    closed = true;
    failure = error ?? null;
    clearTimeout(helloTimer);
    rejectReady(error ?? new Error("PEER_MESSAGE_CONNECTION_CLOSED"));
    for (const [type, listener] of listeners) channel.removeEventListener(type, listener);
    queue.length = 0;
    assembling = null;
    reservedBytes = 0;
    reservedFrames = 0;
    lifetime.abort(error ?? new Error("PEER_MESSAGE_CONNECTION_CLOSED"));
    channel.close();
    wake();
  };
  const fail = (error) => stop(error instanceof Error ? error : new Error(String(error)));
  const packet = (kind, a, b, c = 0, payload) => {
    assertOpen();
    const bytes = new Uint8Array(HEADER + (payload?.length ?? 0)), fields = new DataView(bytes.buffer);
    bytes.set([67, 82, 1, kind]);
    fields.setUint32(4, a);
    fields.setUint32(8, b);
    fields.setUint32(12, c);
    if (payload !== void 0) bytes.set(payload, HEADER);
    channel.send(bytes.buffer);
    sentPackets += 1;
  };
  const open = () => {
    if (opened || closed) return;
    try {
      packet(HELLO, maximum, windowBytes, windowFrames);
      opened = true;
      if (greeted) resolveReady();
      else helloTimer = setTimeout(() => fail(new Error("PEER_MESSAGE_HELLO_TIMEOUT")), helloTimeoutMs);
    } catch (error) {
      fail(error);
    }
  };
  const on = (type, listener) => {
    listeners.push([type, listener]);
    channel.addEventListener(type, listener);
  };
  on("open", open);
  on("bufferedamountlow", wake);
  on("close", () => fail(new Error(assembling === null ? "PEER_MESSAGE_CONNECTION_ENDED" : "PEER_MESSAGE_FRAME_TRUNCATED")));
  on("error", () => fail(new Error("PEER_MESSAGE_CHANNEL_ERROR")));
  on("message", (event) => {
    if (closed) return;
    try {
      const value = event.data;
      if (!(value instanceof ArrayBuffer) || value.byteLength < HEADER || value.byteLength > PEER_MESSAGE_LIMITS.packetBytes) throw new Error("PEER_MESSAGE_PACKET_INVALID");
      const bytes = new Uint8Array(value), fields = new DataView(value), kind = bytes[3];
      if (bytes[0] !== 67 || bytes[1] !== 82 || bytes[2] !== 1) throw new Error("PEER_MESSAGE_PROTOCOL_INVALID");
      const a = fields.getUint32(4), b = fields.getUint32(8), c = fields.getUint32(12);
      receivedPackets += 1;
      if (kind === HELLO) {
        if (greeted || bytes.length !== HEADER || a < 1 || a > PEER_MESSAGE_LIMITS.frameBytes || b < a || b > PEER_MESSAGE_LIMITS.queueBytes || c < 1 || c > PEER_MESSAGE_LIMITS.queueFrames) throw new Error("PEER_MESSAGE_HELLO_INVALID");
        greeted = true;
        remoteMaximum = a;
        remoteWindow = b;
        remoteFrames = c;
        creditBytes = b;
        creditFrames = c;
        if (opened) {
          clearTimeout(helloTimer);
          resolveReady();
        }
        wake();
        return;
      }
      if (!greeted) throw new Error("PEER_MESSAGE_HELLO_REQUIRED");
      if (kind === CREDIT) {
        if (bytes.length !== HEADER || a < 1 || b !== 1 || c !== 0 || creditBytes + a > remoteWindow || creditFrames + 1 > remoteFrames) {
          throw new Error("PEER_MESSAGE_CREDIT_INVALID");
        }
        creditBytes += a;
        creditFrames += 1;
        wake();
        return;
      }
      const length = bytes.length - HEADER;
      if (kind !== DATA || c !== 0 || a < 1 || a > maximum || b !== received || length < 1 || length > a - b || assembling !== null && assembling.length !== a) throw new Error("PEER_MESSAGE_FRAGMENT_INVALID");
      if (assembling === null) {
        if (reservedBytes + a > windowBytes || reservedFrames + 1 > windowFrames) throw new Error("PEER_MESSAGE_RECEIVE_CREDIT_EXCEEDED");
        assembling = new Uint8Array(a);
        reservedBytes += a;
        reservedFrames += 1;
      }
      assembling.set(bytes.subarray(HEADER), b);
      received += length;
      receivedBytes += length;
      if (received === a) {
        queue.push(assembling);
        assembling = null;
        received = 0;
        wake();
      }
    } catch (error) {
      fail(error);
    }
  });
  if (channel.readyState === "open") queueMicrotask(open);
  else if (channel.readyState !== "connecting") stop(new Error("PEER_MESSAGE_CONNECTION_CLOSED"));
  return {
    ready,
    signal: lifetime.signal,
    get stats() {
      return {
        sentBytes,
        receivedBytes,
        sentPackets,
        receivedPackets,
        queuedSendBytes,
        queuedReceiveBytes: reservedBytes,
        queuedReceiveFrames: reservedFrames
      };
    },
    send(input, sendOptions = {}) {
      if (closed) return Promise.reject(failure ?? new Error("PEER_MESSAGE_CONNECTION_CLOSED"));
      if (sendOptions.signal?.aborted === true) return Promise.reject(sendOptions.signal.reason);
      if (!(input instanceof Uint8Array) || input.length < 1 || input.length > maximum) return Promise.reject(new Error("PEER_MESSAGE_FRAME_TOO_LARGE"));
      if (queuedSendBytes + input.length > windowBytes || queuedSendFrames + 1 > windowFrames) return Promise.reject(new Error("PEER_MESSAGE_SEND_BACKPRESSURE"));
      const bytes = input.slice();
      queuedSendBytes += bytes.length;
      queuedSendFrames += 1;
      const task = tail.then(async () => {
        let dispatched = false;
        const assertSending = () => {
          assertOpen();
          sendOptions.signal?.throwIfAborted();
        };
        const cancelled = () => {
          wake();
        };
        sendOptions.signal?.addEventListener("abort", cancelled, { once: true });
        const timeout = setTimeout(() => fail(new Error("PEER_MESSAGE_SEND_TIMEOUT")), timeoutMs);
        try {
          await ready;
          assertSending();
          if (bytes.length > remoteMaximum) throw new Error("PEER_MESSAGE_REMOTE_FRAME_TOO_LARGE");
          while (creditBytes < bytes.length || creditFrames === 0) {
            assertSending();
            await wait();
          }
          assertSending();
          for (let offset = 0; offset < bytes.length; offset += PEER_MESSAGE_LIMITS.packetBytes - HEADER) {
            while (channel.bufferedAmount > PEER_MESSAGE_LIMITS.bufferedBytes - PEER_MESSAGE_LIMITS.packetBytes) {
              assertSending();
              await wait();
            }
            assertSending();
            if (!dispatched) {
              creditBytes -= bytes.length;
              creditFrames -= 1;
              dispatched = true;
            }
            const part = bytes.subarray(offset, offset + PEER_MESSAGE_LIMITS.packetBytes - HEADER);
            packet(DATA, bytes.length, offset, 0, part);
            sentBytes += part.length;
          }
        } catch (error) {
          if (dispatched || sendOptions.signal?.aborted !== true || error !== sendOptions.signal.reason) fail(error);
          throw error;
        } finally {
          clearTimeout(timeout);
          sendOptions.signal?.removeEventListener("abort", cancelled);
        }
      }).finally(() => {
        queuedSendBytes -= bytes.length;
        queuedSendFrames -= 1;
      });
      tail = task.catch(() => void 0);
      return task;
    },
    async *frames(signal) {
      if (reading) throw new Error("PEER_MESSAGE_READER_EXISTS");
      reading = true;
      const abort = () => stop();
      signal?.addEventListener("abort", abort, { once: true });
      try {
        if (signal?.aborted === true) return;
        await ready;
        for (; ; ) {
          if (failure !== null) throw failure;
          if (closed) return;
          const frame = queue.shift();
          if (frame === void 0) {
            await wait();
            continue;
          }
          yield frame;
          if (!closed) {
            reservedBytes -= frame.length;
            reservedFrames -= 1;
            packet(CREDIT, frame.length, 1);
          }
        }
      } finally {
        signal?.removeEventListener("abort", abort);
        stop();
      }
    },
    async close() {
      stop();
      await tail;
    }
  };
}

export {
  MemoryBytesStore,
  writeBytesMany,
  PEER_LIVE_MESSAGE_LIMITS,
  PEER_MESSAGE_LIMITS,
  framePeerMessageChannels
};
