import { SignalError } from './signals.mjs';

export const HOSTED_SIGNAL_PROTOCOL = 'tendriller.signals.v1';
export const HOSTED_SIGNAL_LIMITS = Object.freeze({ payloadBytes: 32 * 1024, frameBytes: 36 * 1024,
  defaultTtlMs: 5000, maxTtlMs: 30_000, futureSkewMs: 5000, subscriptions: 16,
  queuedSignals: 128, queuedBytes: 512 * 1024, pendingRequests: 32, inFlightFrames: 64,
  jsonValues: 4096, latestKeys: 256, sendsPerSecond: 50, connections: 32 });
const fail = (code, message) => new SignalError(code, message);
const bytes = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const plain = value => value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const optionsOnly = (value, names) => {
  if (!plain(value) || Object.keys(value).some(key => !names.includes(key)))
    throw fail('signal_options_invalid', 'Signals have no durable retry or replay options');
};
export function signalTopic(value) {
  if (typeof value !== 'string' || !value || new TextEncoder().encode(value).byteLength > 256 ||
      [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))
    throw fail('signal_topic_invalid', 'A signal topic must have 1–256 UTF-8 bytes and no control characters');
  return value;
}
export function signalPayload(value) {
  const seen = new Set();
  let values = 0;
  const copy = (item, depth) => {
    if (++values > HOSTED_SIGNAL_LIMITS.jsonValues || depth > 32) throw fail('signal_payload_invalid', 'Signal payload is too complex');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return Object.is(item, -0) ? 0 : item;
    if (typeof item !== 'object' || seen.has(item))
      throw fail('signal_payload_invalid', 'Signal payload must contain finite JSON values');
    seen.add(item);
    try {
      if (Array.isArray(item)) {
        if (Reflect.ownKeys(item).length !== item.length + 1) throw fail('signal_payload_invalid', 'Signal arrays cannot have additional properties');
        const result = [];
        for (let index = 0; index < item.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(item, index);
          if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw fail('signal_payload_invalid', 'Signal arrays must contain ordinary values');
          result.push(copy(descriptor.value, depth + 1));
        }
        return result;
      }
      if (!plain(item) || Reflect.ownKeys(item).length !== Object.keys(item).length)
        throw fail('signal_payload_invalid', 'Signal objects must have ordinary enumerable JSON properties');
      const result = Object.create(null);
      for (const key of Object.keys(item)) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!('value' in descriptor)) throw fail('signal_payload_invalid', 'Signal payloads cannot evaluate accessors');
        result[key] = copy(descriptor.value, depth + 1);
      }
      return result;
    } finally { seen.delete(item); }
  };
  const encoded = JSON.stringify(copy(value, 0));
  if (encoded.length > HOSTED_SIGNAL_LIMITS.payloadBytes || new TextEncoder().encode(encoded).byteLength > HOSTED_SIGNAL_LIMITS.payloadBytes)
    throw fail('signal_frame_too_large', 'Signal payload exceeds 32 KiB');
  return JSON.parse(encoded);
}
export function validateHostedSignal(value, scope) {
  if (!plain(value) || Object.keys(value).some(key => !['scope', 'authorId', 'sessionId', 'sequence', 'topic', 'payload', 'issuedAtMs', 'expiresAtMs'].includes(key)) ||
      typeof value.scope !== 'string' || !value.scope || value.scope.length > 200 ||
      typeof value.authorId !== 'string' || !value.authorId || value.authorId.length > 200 ||
      typeof value.sessionId !== 'string' || !value.sessionId || value.sessionId.length > 80 ||
      !Number.isSafeInteger(value.sequence) || value.sequence < 1 || !Number.isSafeInteger(value.issuedAtMs) || value.issuedAtMs < 0 ||
      !Number.isSafeInteger(value.expiresAtMs) || value.expiresAtMs <= value.issuedAtMs || value.expiresAtMs - value.issuedAtMs > HOSTED_SIGNAL_LIMITS.maxTtlMs)
    throw fail('signal_frame_invalid', 'Invalid authenticated signal envelope');
  if (scope !== undefined && value.scope !== scope) throw fail('signal_scope_mismatch', 'Signal belongs to another hosted page');
  return { scope: value.scope, authorId: value.authorId, sessionId: value.sessionId, sequence: value.sequence,
    topic: signalTopic(value.topic), payload: signalPayload(value.payload), issuedAtMs: value.issuedAtMs, expiresAtMs: value.expiresAtMs };
}

/** A live socket port. It owns only bounded volatile requests and subscriber queues. */
export function createHostedSignals(host) {
  const clock = host.now ?? Date.now, subscribers = new Set(), pending = new Map();
  let closed = false, wire = null, lastDelivery = 0, observedTime = 0;
  const now = () => {
    const current = clock();
    if (!Number.isSafeInteger(current) || current < 0) throw fail('signal_clock_invalid', 'Signals need a valid wall clock');
    observedTime = Math.max(observedTime, current);
    return observedTime;
  };
  const online = () => !closed && host.connected();
  const unavailable = () => fail('signal_disconnected', 'Signals require a live authenticated connection; nothing was queued');
  const request = (message, expiresAt, signal) => {
    const rejected = error => ({ dispatched: false, promise: Promise.reject(error) });
    if (signal?.aborted) return rejected(signal.reason);
    if (!online()) return rejected(unavailable());
    let remaining;
    try { remaining = expiresAt - now(); } catch (error) { return rejected(error); }
    if (remaining <= 0) return rejected(fail('signal_expired', 'Live request expired before dispatch'));
    if (pending.size >= HOSTED_SIGNAL_LIMITS.pendingRequests) return rejected(fail('signal_backpressure', 'Too many pending live requests'));
    const attempt = { dispatched: false, promise: undefined };
    attempt.promise = new Promise((resolve, reject) => {
      const cid = 'signal_' + crypto.randomUUID();
      let settled = false;
      const finish = (success, value, release = true) => {
        if (release) pending.delete(cid);
        if (settled) return;
        settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        success ? resolve(value) : reject(value);
      };
      // Cancellation/expiry cannot retract bytes already in a socket buffer.
      // Keep their bounded slot until the host replies or the connection ends.
      const abort = () => finish(false, signal.reason, false);
      const timer = setTimeout(() => finish(false, fail('signal_expired', 'Live request expired'), false), remaining);
      pending.set(cid, { finish }); signal?.addEventListener('abort', abort, { once: true });
      try { attempt.dispatched = host.send({ ...message, cid }); if (!attempt.dispatched) finish(false, unavailable()); }
      catch (error) { finish(false, error); }
    });
    return attempt;
  };
  const unsubscribeWire = () => {
    if (subscribers.size || wire === null) return;
    const dispatched = wire.dispatched;
    wire = null;
    if (dispatched && online()) host.send({ t: 'signal_unsubscribe' });
  };
  const finish = (subscriber, error) => {
    if (!subscriber.active) return;
    subscriber.active = false; subscriber.error = error; subscriber.queue.length = 0; subscriber.bytes = 0; subscriber.latest.clear();
    subscribers.delete(subscriber); subscriber.signal?.removeEventListener('abort', subscriber.abort);
    const waiting = subscriber.waiting; subscriber.waiting = null;
    if (waiting) error ? waiting.reject(error) : waiting.resolve({ done: true, value: undefined });
    unsubscribeWire();
  };
  const disconnect = () => {
    wire = null; lastDelivery = 0;
    const error = unavailable();
    for (const value of [...pending.values()]) value.finish(false, error);
    for (const subscriber of [...subscribers]) finish(subscriber, error);
  };
  const offDisconnect = host.onDisconnect(disconnect);
  const offMessage = host.onMessage(message => {
    if (message?.t !== 'signal' && message?.t !== 'signal_ack') return;
    try {
      if (!Number.isSafeInteger(message.delivery) || message.delivery < 1) throw fail('signal_frame_invalid', 'Invalid signal delivery credit');
      if (message.delivery <= lastDelivery) return;
      lastDelivery = message.delivery;
      // Transport credit only: this is never an application acknowledgement.
      if (online()) host.send({ t: 'signal_credit', through: message.delivery });
      if (message.t === 'signal_ack') {
        if (message.cid && pending.has(message.cid)) {
          const error = message.error;
          pending.get(message.cid).finish(!error, error ? fail(String(message.code || error?.code || error), message.message || 'Live request rejected') : message);
        }
        return;
      }
      const value = validateHostedSignal(message.signal, host.scope);
      const receivedAt = now();
      if (value.issuedAtMs > receivedAt + HOSTED_SIGNAL_LIMITS.futureSkewMs) throw fail('signal_clock_invalid', 'Signal dispatch time is too far in the future');
      if (value.expiresAtMs <= receivedAt) return;
      const size = bytes(value), key = JSON.stringify([value.authorId, value.sessionId, value.topic]);
      for (const subscriber of [...subscribers]) {
        if (subscriber.topics && !subscriber.topics.has(value.topic)) continue;
        subscriber.queue = subscriber.queue.filter(item => item.value.expiresAtMs > now());
        subscriber.bytes = subscriber.queue.reduce((sum, item) => sum + item.size, 0);
        if (subscriber.mode === 'latest') {
          for (const [identity, floor] of subscriber.latest) if (floor.until <= receivedAt) subscriber.latest.delete(identity);
          const previous = subscriber.latest.get(key);
          if (previous && value.sequence <= previous.sequence) continue;
          if (!previous && subscriber.latest.size >= HOSTED_SIGNAL_LIMITS.latestKeys) {
            finish(subscriber, fail('signal_subscription_overflow', 'Too many protected latest-value identities')); continue;
          }
          // Keep the floor after consumption and short-TTL expiry: an older
          // sequence may still be live for the full admitted lifetime.
          subscriber.latest.set(key, { sequence: value.sequence, until: Math.min(Number.MAX_SAFE_INTEGER,
            Math.max(previous?.until ?? 0, value.expiresAtMs + HOSTED_SIGNAL_LIMITS.maxTtlMs + HOSTED_SIGNAL_LIMITS.futureSkewMs)) });
          const index = subscriber.queue.findIndex(item => item.key === key);
          if (index >= 0) { subscriber.bytes -= subscriber.queue[index].size; subscriber.queue.splice(index, 1); }
        }
        if (subscriber.queue.length >= HOSTED_SIGNAL_LIMITS.queuedSignals || subscriber.bytes + size > HOSTED_SIGNAL_LIMITS.queuedBytes) {
          finish(subscriber, fail('signal_subscription_overflow', 'Live subscriber queue overflowed')); continue;
        }
        if (subscriber.waiting) {
          const waiting = subscriber.waiting; subscriber.waiting = null;
          waiting.resolve({ done: false, value: structuredClone(value) });
        } else { subscriber.queue.push({ value, size, key }); subscriber.bytes += size; }
      }
    } catch (error) { for (const subscriber of [...subscribers]) finish(subscriber, error); }
  });
  return {
    get connected() { return online(); },
    async send(topic, payload, options = {}) {
      optionsOnly(options, ['ttlMs', 'signal']);
      const issuedAtMs = now(), ttlMs = options.ttlMs ?? HOSTED_SIGNAL_LIMITS.defaultTtlMs;
      if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > HOSTED_SIGNAL_LIMITS.maxTtlMs) throw fail('signal_ttl_invalid', 'ttlMs must be from 1 to 30000');
      options.signal?.throwIfAborted();
      if (!online()) throw unavailable();
      const expiresAtMs = issuedAtMs + ttlMs;
      if (!Number.isSafeInteger(expiresAtMs)) throw fail('signal_clock_invalid', 'Signal expiry exceeds the supported clock range');
      const reply = await request({ t: 'signal_send', topic: signalTopic(topic), payload: signalPayload(payload), issuedAtMs, expiresAtMs }, expiresAtMs, options.signal).promise;
      if (expiresAtMs <= now()) throw fail('signal_expired', 'Signal expired before dispatch completed');
      return validateHostedSignal(reply.signal, host.scope);
    },
    subscribe(options = {}) {
      optionsOnly(options, ['topics', 'mode', 'signal']);
      if (options.signal?.aborted) return {
        [Symbol.asyncIterator]() { return this; },
        next: () => Promise.resolve({ done: true, value: undefined }),
        return: () => Promise.resolve({ done: true, value: undefined }),
      };
      if (!online()) throw unavailable();
      if (options.mode !== undefined && options.mode !== 'all' && options.mode !== 'latest') throw fail('signal_mode_invalid', 'Unknown live delivery mode');
      if (options.topics !== undefined && (!Array.isArray(options.topics) || options.topics.length > 128)) throw fail('signal_topic_filter_invalid', 'At most 128 topic filters are allowed');
      const topics = options.topics === undefined ? undefined : new Set(options.topics.map(signalTopic));
      const deadline = now() + 5000;
      if (subscribers.size >= HOSTED_SIGNAL_LIMITS.subscriptions) throw fail('signal_subscription_limit', 'At most 16 live subscriptions are allowed');
      const subscriber = { active: true, queue: [], latest: new Map(), bytes: 0, topics, mode: options.mode ?? 'all', signal: options.signal, waiting: null, error: null,
        abort: () => finish(subscriber) };
      subscribers.add(subscriber); options.signal?.addEventListener('abort', subscriber.abort, { once: true });
      if (wire === null) {
        const opening = request({ t: 'signal_subscribe' }, deadline);
        wire = opening;
        void opening.promise.catch(error => { if (wire === opening) for (const value of [...subscribers]) finish(value, error); });
      }
      return {
        [Symbol.asyncIterator]() { return this; },
        next() {
          if (subscriber.waiting) return Promise.reject(fail('signal_frame_invalid', 'Pull a live iterator one item at a time'));
          if (subscriber.error) return Promise.reject(subscriber.error);
          while (subscriber.queue.length) {
            const item = subscriber.queue.shift(); subscriber.bytes -= item.size;
            if (item.value.expiresAtMs > now()) return Promise.resolve({ done: false, value: structuredClone(item.value) });
          }
          if (!subscriber.active) return Promise.resolve({ done: true, value: undefined });
          return new Promise((resolve, reject) => { subscriber.waiting = { resolve, reject }; });
        },
        return() { finish(subscriber); return Promise.resolve({ done: true, value: undefined }); },
        throw(error) { finish(subscriber, error); return Promise.reject(error); },
      };
    },
    close() { if (closed) return; disconnect(); closed = true; offMessage(); offDisconnect(); },
  };
}

/** Explicit agent connection; it never registers a conversational wake listener. */
export async function connectHostedSignals({ api, token, socket = (url, protocols) => new WebSocket(url, protocols), signal }) {
  signal?.throwIfAborted();
  const url = new URL(api.replace(/\/+$/, '') + '/signals/socket');
  if (!['https:', 'http:'].includes(url.protocol)) throw fail('signal_options_invalid', 'Signals need an HTTP service URL');
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = socket(url.href, token === undefined ? [HOSTED_SIGNAL_PROTOCOL] : [HOSTED_SIGNAL_PROTOCOL, token]);
  const messages = new Set(), disconnects = new Set();
  let connected = false, ended = false, scope;
  const service = createHostedSignals({ get scope() { return scope; }, connected: () => connected, send(message) {
    if (!connected || ws.readyState !== 1) return false;
    ws.send(JSON.stringify(message)); return true;
  }, onMessage(listener) { messages.add(listener); return () => messages.delete(listener); },
  onDisconnect(listener) { disconnects.add(listener); return () => disconnects.delete(listener); } });
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const close = () => {
    if (ended) return;
    ended = true; connected = false;
    for (const listener of [...disconnects]) listener();
    service.close(); signal?.removeEventListener('abort', abort);
    ws.removeEventListener('message', onMessage); ws.removeEventListener('error', onError); ws.removeEventListener('close', onClose);
    ws.close();
  };
  const abort = () => { rejectReady(signal.reason); close(); };
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { rejectReady(fail('signal_disconnected', 'Live connection timed out')); close(); }, 5000);
  function onMessage(event) {
    try {
      if (typeof event.data !== 'string' || event.data.length > HOSTED_SIGNAL_LIMITS.frameBytes || new TextEncoder().encode(event.data).byteLength > HOSTED_SIGNAL_LIMITS.frameBytes)
        throw fail('signal_frame_too_large', 'Invalid live frame');
      const message = JSON.parse(event.data);
      if (message.t === 'signal_ready') { if (scope !== undefined || typeof message.scope !== 'string' || !message.scope || message.scope.length > 200) throw fail('signal_frame_invalid', 'Invalid live greeting'); scope = message.scope; connected = true; resolveReady(); }
      else for (const listener of [...messages]) listener(message);
    } catch (error) { rejectReady(error); close(); }
  }
  function onError() { rejectReady(fail('signal_disconnected', 'Live connection failed')); close(); }
  function onClose() { rejectReady(fail('signal_disconnected', 'Live connection closed')); close(); }
  ws.addEventListener('message', onMessage); ws.addEventListener('error', onError); ws.addEventListener('close', onClose);
  if (signal?.aborted) abort();
  else if (ws.readyState === 3) onClose();
  try { await ready; return { get connected() { return service.connected; }, send: (...args) => service.send(...args), subscribe: (...args) => service.subscribe(...args), close }; }
  catch (error) { close(); throw error; }
  finally { clearTimeout(timer); }
}
