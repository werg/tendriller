import { SignalError } from './signals.mjs';

export const HOSTED_SIGNAL_PROTOCOL = 'tendriller.signals.v1';
export const SIGNAL_LIMITS = Object.freeze({ payloadBytes: 16 * 1024, frameBytes: 20 * 1024,
  ttlMs: 30_000, futureSkewMs: 2_000, requestTimeoutMs: 10_000, pendingSends: 32,
  subscriptions: 16, pendingMessages: 64, pendingBytes: 256 * 1024, latestKeys: 256,
  connections: 64, messagesPerSecond: 50, authorizations: 8 });
const fail = (code, message) => { throw new SignalError(code, message); };
const bytes = value => new TextEncoder().encode(value).byteLength;
const aborted = signal => signal?.reason ?? new DOMException('Aborted', 'AbortError');
const plain = value => value !== null && typeof value === 'object' &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));

export function validateSignalTopic(topic) {
  if (typeof topic !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(topic))
    fail('invalid_signal', 'Expected a bounded signal topic');
  return topic;
}

/** Snapshot strict JSON without invoking getters, toJSON or lossy conversions. */
function snapshot(payload) {
  let nodes = 0;
  const visit = (value, depth) => {
    if (++nodes > 4096 || depth > 32) fail('invalid_signal', 'Signal JSON is too complex');
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
    if (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)) return value;
    if (!value || typeof value !== 'object' || Object.getOwnPropertySymbols(value).length ||
        !Array.isArray(value) && !plain(value)) fail('invalid_signal', 'Signals require plain JSON values');
    const keys = Object.keys(value);
    if (Object.getOwnPropertyNames(value).length !== keys.length + (Array.isArray(value) ? 1 : 0))
      fail('invalid_signal', 'Signal JSON must have enumerable data properties');
    if (Array.isArray(value) && (keys.length !== value.length || keys.some((key, i) => key !== String(i))))
      fail('invalid_signal', 'Signals require dense JSON arrays');
    const copy = Array.isArray(value) ? [] : Object.create(null);
    for (const key of keys) {
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (!property || !Object.hasOwn(property, 'value')) fail('invalid_signal', 'Signal accessors are not allowed');
      copy[key] = visit(property.value, depth + 1);
    }
    return copy;
  };
  const encoded = JSON.stringify(visit(payload, 0));
  if (bytes(encoded) > SIGNAL_LIMITS.payloadBytes) fail('signal_too_large', 'Signal payload exceeds 16 KiB');
  return JSON.parse(encoded);
}

/** TTL begins at authoring, before any transport or authorization work. */
export function createSignalInput(topic, payload, { ttlMs = 5_000 } = {}, now = Date.now()) {
  validateSignalTopic(topic);
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > SIGNAL_LIMITS.ttlMs ||
      !Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(now + ttlMs))
    fail('invalid_signal', 'Signal TTL must be between 1 and 30000 milliseconds');
  return { topic, payload: snapshot(payload), issuedAtMs: now, expiresAtMs: now + ttlMs };
}

export function validateSignalInput(value, now = Date.now()) {
  if (!plain(value) || Object.keys(value).some(key => !['topic', 'payload', 'issuedAtMs', 'expiresAtMs'].includes(key)) ||
      !Object.hasOwn(value, 'payload')) fail('invalid_signal', 'Expected a live message');
  validateSignalTopic(value.topic);
  if (!Number.isSafeInteger(value.issuedAtMs) || value.issuedAtMs < 0 || !Number.isSafeInteger(value.expiresAtMs) ||
      value.expiresAtMs <= value.issuedAtMs || value.expiresAtMs - value.issuedAtMs > SIGNAL_LIMITS.ttlMs ||
      value.issuedAtMs > now + SIGNAL_LIMITS.futureSkewMs) fail('invalid_signal', 'Invalid live message lifetime');
  if (value.expiresAtMs <= now) fail('signal_expired', 'The live message has expired');
  return { topic: value.topic, payload: snapshot(value.payload), issuedAtMs: value.issuedAtMs, expiresAtMs: value.expiresAtMs };
}

export function validateSignalEnvelope(value) {
  if (!plain(value) || Object.keys(value).some(key => !['scope', 'authorId', 'sessionId', 'sequence', 'topic', 'payload', 'issuedAtMs', 'expiresAtMs'].includes(key)) ||
      !['scope', 'authorId', 'sessionId'].every(key => typeof value[key] === 'string' && value[key].length > 0 && value[key].length <= 256) ||
      !Number.isSafeInteger(value.sequence) || value.sequence < 1) fail('invalid_signal', 'Invalid hosted signal envelope');
  const input = validateSignalInput({ topic: value.topic, payload: value.payload,
    issuedAtMs: value.issuedAtMs, expiresAtMs: value.expiresAtMs }, value.issuedAtMs);
  return { scope: value.scope, authorId: value.authorId, sessionId: value.sessionId, sequence: value.sequence, ...input };
}

/** A bounded live port shared by the existing page socket and explicit SDK connections. */
export function createHostedSignalPort(host) {
  const readers = new Set(), operations = new Set();
  let closed = false, generation = 0, subscribed = false, updating, observedTime = 0;
  const clock = () => observedTime = Math.max(observedTime, (host.now ?? Date.now)());
  const stopAll = error => { for (const reader of [...readers]) reader.stop(error); };
  const disconnected = () => new SignalError('signal_disconnected', 'Live signal connection closed');

  // Aborting releases the caller promptly and asks the transport to release its
  // pending request. A noncooperative custom transport still occupies its slot
  // until it settles, so cancellation cannot manufacture unbounded hidden work.
  const request = (message, timeoutMs = SIGNAL_LIMITS.requestTimeoutMs, signal) => {
    if (signal?.aborted) return Promise.reject(aborted(signal));
    if (operations.size >= SIGNAL_LIMITS.pendingSends + 1)
      return Promise.reject(new SignalError('signal_backpressure', 'Too many live requests'));
    const controller = new AbortController();
    const cancel = () => controller.abort(aborted(signal));
    operations.add(controller);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => controller.abort(new SignalError('signal_timeout', 'Live request timed out; it will not be retried')), timeoutMs);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); controller.signal.removeEventListener('abort', onAbort); };
      const onAbort = () => { cleanup(); reject(aborted(controller.signal)); };
      controller.signal.addEventListener('abort', onAbort, { once: true });
      signal?.addEventListener('abort', cancel, { once: true });
      let result;
      try { result = host.request(message, { signal: controller.signal }); }
      catch (error) { result = Promise.reject(error); }
      Promise.resolve(result).then(value => { operations.delete(controller); cleanup(); resolve(value); },
        error => { operations.delete(controller); cleanup(); reject(error); });
      if (signal?.aborted) cancel();
    });
  };

  const reconcile = () => {
    const desired = readers.size > 0;
    if (closed || !host.connected() || updating || subscribed === desired) return;
    const captured = generation, change = {};
    updating = change;
    void request({ t: desired ? 'signal_subscribe' : 'signal_unsubscribe' }).then(() => {
      if (captured === generation) subscribed = desired;
    }).catch(async error => {
      if (closed || captured !== generation || !host.connected()) return;
      subscribed = false;
      stopAll(error);
      // The command may have arrived even if its ACK was lost. Attempt one
      // bounded cleanup, never a retry loop or a replay of application data.
      if (desired) {
        try { await request({ t: 'signal_unsubscribe' }); } catch { /* Connection cleanup is best effort. */ }
      }
    }).finally(() => {
      if (updating !== change) return;
      updating = undefined;
      reconcile();
    });
  };

  const offMessage = host.onMessage(value => {
    if (closed || !host.connected() || !readers.size) return;
    let message;
    try { message = validateSignalEnvelope(value); }
    catch (error) { stopAll(error); return; }
    const now = clock();
    if (message.scope !== host.scope() || message.expiresAtMs <= now || message.issuedAtMs > now + SIGNAL_LIMITS.futureSkewMs) return;
    const size = bytes(JSON.stringify(message));
    for (const reader of [...readers]) reader.push(message, size);
  });
  const offConnection = host.onConnection?.(() => {
    generation++; updating = undefined; subscribed = false;
    for (const controller of operations) controller.abort(disconnected());
    for (const reader of readers) reader.clear();
    reconcile();
  }) ?? (() => {});

  const port = {
    get connected() { return !closed && host.connected(); },
    async send(topic, payload, options = {}) {
      if (closed || !host.connected()) fail('signal_disconnected', 'Sending a signal requires a live connection');
      if (Object.keys(options).some(key => !['ttlMs', 'signal'].includes(key)))
        fail('invalid_signal', 'Signals have no durable retry or replay options');
      if (options.signal?.aborted) throw aborted(options.signal);
      if (operations.size >= SIGNAL_LIMITS.pendingSends) fail('signal_backpressure', 'Too many live signal sends');
      const input = createSignalInput(topic, payload, options, clock());
      const reply = await request({ t: 'signal_send', message: input },
        Math.min(input.expiresAtMs - input.issuedAtMs, SIGNAL_LIMITS.requestTimeoutMs), options.signal);
      const value = validateSignalEnvelope(reply.signal);
      if (value.scope !== host.scope()) fail('invalid_signal', 'Signal scope does not match this application');
      return value;
    },
    subscribe(options = {}) {
      if (closed) fail('signal_closed', 'Signal port is closed');
      if (Object.keys(options).some(key => !['topics', 'mode', 'signal'].includes(key)) ||
          options.topics !== undefined && (!Array.isArray(options.topics) || options.topics.length > 128) ||
          options.mode !== undefined && !['all', 'latest'].includes(options.mode)) fail('invalid_signal', 'Invalid live signal subscription');
      const topics = options.topics === undefined ? null : new Set(options.topics.map(validateSignalTopic));
      const mode = options.mode ?? 'all', signal = options.signal;
      if (readers.size >= SIGNAL_LIMITS.subscriptions) fail('signal_backpressure', 'Too many live signal subscriptions');
      let queue = [], queuedBytes = 0, waiter, ended = false, failure, reading = false;
      const latest = new Map();
      const wake = () => { const resolve = waiter; waiter = undefined; resolve?.(); };
      const prune = () => {
        const now = clock();
        queue = queue.filter(item => { if (item.value.expiresAtMs > now) return true; queuedBytes -= item.size; return false; });
        for (const [key, item] of latest) if (item.until <= now) latest.delete(key);
      };
      const reader = {
        stop(error) {
          if (ended) return;
          ended = true; failure = error; reader.clear(); latest.clear(); readers.delete(reader);
          signal?.removeEventListener('abort', cancel); wake(); reconcile();
        },
        clear() { queue = []; queuedBytes = 0; },
        push(message, size) {
          if (ended || topics && !topics.has(message.topic)) return;
          prune();
          const key = JSON.stringify([message.authorId, message.sessionId, message.topic]);
          if (mode === 'latest') {
            const previous = latest.get(key);
            if (previous && previous.sequence >= message.sequence) return;
            if (!previous && latest.size >= SIGNAL_LIMITS.latestKeys) {
              reader.stop(new SignalError('signal_overflow', 'Too many live signal senders; treat this as a gap')); return;
            }
            // Remember sequence after consumption and after this value expires.
            // An older value with a longer TTL must never become current again.
            const until = Math.min(Number.MAX_SAFE_INTEGER, message.expiresAtMs + SIGNAL_LIMITS.ttlMs + SIGNAL_LIMITS.futureSkewMs);
            latest.set(key, { sequence: message.sequence, until: Math.max(previous?.until ?? 0, until) });
            const index = queue.findIndex(item => item.key === key);
            if (index >= 0) queuedBytes -= queue.splice(index, 1)[0].size;
          }
          if (queue.length >= SIGNAL_LIMITS.pendingMessages || queuedBytes + size > SIGNAL_LIMITS.pendingBytes) {
            reader.stop(new SignalError('signal_overflow', 'Live subscriber fell behind; treat this as a gap')); return;
          }
          queue.push({ key, size, value: structuredClone(message) }); queuedBytes += size; wake();
        },
      };
      const cancel = () => reader.stop();
      const iterator = {
        [Symbol.asyncIterator]() { return this; },
        async next() {
          if (reading) fail('signal_reader_busy', 'A signal subscription has one reader');
          reading = true;
          try {
            while (true) {
              prune();
              if (ended) { if (failure) throw failure; return { done: true, value: undefined }; }
              if (queue.length) { const item = queue.shift(); queuedBytes -= item.size; return { done: false, value: item.value }; }
              await new Promise(resolve => { waiter = resolve; });
            }
          } finally { reading = false; }
        },
        async return() { reader.stop(); return { done: true, value: undefined }; },
      };
      if (signal?.aborted) { ended = true; return iterator; }
      readers.add(reader); signal?.addEventListener('abort', cancel, { once: true }); reconcile();
      return iterator;
    },
    close(error) {
      if (closed) return;
      const unsubscribe = host.connected() && (subscribed || updating);
      closed = true; generation++; updating = undefined;
      for (const controller of operations) controller.abort(error ?? disconnected());
      offMessage(); offConnection(); stopAll(error);
      if (host.close) host.close();
      else if (unsubscribe) void request({ t: 'signal_unsubscribe' }).catch(() => {});
    },
  };
  return Object.freeze(port);
}

/** Connect explicitly. Never persist, retry or automatically reconnect SDK sends. */
export async function connectHostedSignals({ base, protocols = [HOSTED_SIGNAL_PROTOCOL],
  open = (url, values) => new WebSocket(url, values), signal, timeoutMs = 15_000 }) {
  if (signal?.aborted) throw aborted(signal);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) fail('invalid_signal', 'Invalid connection deadline');
  const url = new URL(base.replace(/\/+$/, '') + '/signals/socket');
  if (url.username || url.password || url.search || url.hash || !['http:', 'https:'].includes(url.protocol) ||
      url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    fail('invalid_signal', 'Live signals require HTTPS (HTTP is allowed on loopback)');
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return new Promise((resolve, reject) => {
    let socket, port, ready = false, closed = false, sequence = 0, scope;
    const pending = new Map(), receivers = new Set();
    const finish = error => {
      if (closed) return;
      closed = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel);
      for (const [type, listener] of listeners) socket?.removeEventListener(type, listener);
      for (const item of [...pending.values()]) item.finish(error ?? new SignalError('signal_disconnected', 'Live connection closed'));
      port?.close(error);
      try { if (socket?.readyState < 2) socket.close(1000, 'Live signal connection closed'); } catch { /* Transport is already gone. */ }
      if (!ready) reject(error ?? new SignalError('signal_disconnected', 'Signal connection closed before ready'));
    };
    const cancel = () => finish(aborted(signal));
    const request = (message, options = {}) => {
      if (!ready || closed || socket.readyState !== 1) return Promise.reject(new SignalError('signal_disconnected', 'A live connection is required'));
      if (options.signal?.aborted) return Promise.reject(aborted(options.signal));
      const cid = String(++sequence), encoded = JSON.stringify({ ...message, cid });
      if (pending.size >= SIGNAL_LIMITS.pendingSends + 1 || (socket.bufferedAmount ?? 0) + bytes(encoded) > SIGNAL_LIMITS.pendingBytes)
        return Promise.reject(new SignalError('signal_backpressure', 'Live connection is busy'));
      return new Promise((resolveRequest, rejectRequest) => {
        const abort = () => item.finish(aborted(options.signal));
        const item = { finish(error, value) {
          if (!pending.delete(cid)) return;
          options.signal?.removeEventListener('abort', abort);
          error ? rejectRequest(error) : resolveRequest(value);
        } };
        pending.set(cid, item); options.signal?.addEventListener('abort', abort, { once: true });
        try { socket.send(encoded); } catch (error) { item.finish(error); }
      });
    };
    const listeners = [['close', () => finish(new SignalError('signal_disconnected', 'Live connection closed'))],
      ['error', () => finish(new SignalError('signal_disconnected', 'Live connection failed'))],
      ['message', event => {
        if (closed) return;
        try {
          if (typeof event.data !== 'string' || bytes(event.data) > SIGNAL_LIMITS.frameBytes) fail('invalid_signal', 'Invalid live signal frame');
          const value = JSON.parse(event.data);
          if (!ready) {
            if (value?.t !== 'signal_ready' || typeof value.scope !== 'string' || !value.scope.length || value.scope.length > 256)
              fail('invalid_signal', 'Expected live signal readiness');
            scope = value.scope; ready = true; clearTimeout(timer);
            port = createHostedSignalPort({ connected: () => !closed && socket.readyState === 1, scope: () => scope, request,
              onMessage: listener => { receivers.add(listener); return () => receivers.delete(listener); }, close: () => finish() });
            resolve(port); return;
          }
          if (value?.t === 'signal') { for (const listener of receivers) listener(value.signal); }
          else if (value?.t === 'ack' && pending.has(value.cid)) pending.get(value.cid).finish(value.error
            ? new SignalError(value.error, value.message || value.error) : undefined, value);
        } catch (error) { finish(error); }
      }]];
    const timer = setTimeout(() => finish(new SignalError('signal_timeout', 'Live signal connection timed out')), timeoutMs);
    try { socket = open(url.href, protocols); } catch (error) { finish(error); return; }
    for (const [type, listener] of listeners) socket.addEventListener(type, listener);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    else if (socket.readyState > 1) finish();
  });
}
