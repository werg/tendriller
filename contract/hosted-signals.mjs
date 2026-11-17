import { SignalError } from './signals.mjs';

export const HOSTED_SIGNAL_PROTOCOL = 'tendriller.signals.v1';
export const SIGNAL_LIMITS = Object.freeze({ bytes: 16 * 1024, ttlMs: 30_000, futureSkewMs: 2_000,
  pending: 32, subscriptions: 64, queue: 64, latestKeys: 256, connections: 32 });
const fail = (code, message) => { throw new SignalError(code, message); };
const plain = value => value !== null && typeof value === 'object' &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const bounded = value => {
  let nodes = 0;
  function visit(item, depth) {
    if (++nodes > 4096 || depth > 32) fail('signal_too_large', 'Signal payload is too complex');
    if (item === null || typeof item === 'string' || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return;
    if (Array.isArray(item)) { for (const child of item) visit(child, depth + 1); return; }
    if (plain(item)) { for (const child of Object.values(item)) visit(child, depth + 1); return; }
    fail('invalid_signal', 'Signal payload must be a finite JSON value');
  }
  visit(value, 0);
  if (new TextEncoder().encode(JSON.stringify(value)).length > SIGNAL_LIMITS.bytes - 1024)
    fail('signal_too_large', 'Signal payload exceeds the live message limit');
};
export function validateSignalTopic(topic) {
  if (typeof topic !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(topic))
    fail('invalid_signal', 'Invalid live signal topic');
  return topic;
}
/** TTL starts when the caller authors the live message, not after connection work. */
export function createSignalInput(topic, payload, { ttlMs = 5000 } = {}, now = Date.now()) {
  validateSignalTopic(topic); bounded(payload);
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > SIGNAL_LIMITS.ttlMs)
    fail('invalid_signal', `Signal TTL must be from 1 to ${SIGNAL_LIMITS.ttlMs} milliseconds`);
  return { topic, payload: structuredClone(payload), issuedAtMs: now, expiresAtMs: now + ttlMs };
}
export function validateSignalInput(value, now = Date.now()) {
  if (!plain(value) || Object.keys(value).some(key => !['topic', 'payload', 'issuedAtMs', 'expiresAtMs'].includes(key)) ||
      !Object.hasOwn(value, 'payload')) fail('invalid_signal', 'Expected a live message');
  validateSignalTopic(value.topic); bounded(value.payload);
  if (!Number.isSafeInteger(value.issuedAtMs) || value.issuedAtMs < 0 || !Number.isSafeInteger(value.expiresAtMs) ||
      value.expiresAtMs <= value.issuedAtMs || value.expiresAtMs - value.issuedAtMs > SIGNAL_LIMITS.ttlMs ||
      value.issuedAtMs > now + SIGNAL_LIMITS.futureSkewMs) fail('invalid_signal', 'Invalid live message lifetime');
  if (value.expiresAtMs <= now) fail('signal_expired', 'The live message has expired');
  return structuredClone(value);
}
export function validateSignalEnvelope(value) {
  if (!plain(value) || Object.keys(value).some(key => !['scope', 'authorId', 'sessionId', 'sequence', 'topic', 'payload', 'issuedAtMs', 'expiresAtMs'].includes(key)) ||
      !['scope', 'authorId', 'sessionId'].every(key => typeof value[key] === 'string' && value[key].length > 0 && value[key].length <= 256) ||
      !Number.isSafeInteger(value.sequence) || value.sequence < 1) fail('invalid_response', 'Invalid signal envelope');
  validateSignalInput({ topic: value.topic, payload: value.payload, issuedAtMs: value.issuedAtMs, expiresAtMs: value.expiresAtMs }, value.issuedAtMs);
  return structuredClone(value);
}

function waitForRequest(request, signal) {
  return new Promise((resolve, reject) => {
    const cancelled = () => {
      signal.removeEventListener('abort', cancelled);
      reject(signal.reason ?? new SignalError('signal_cancelled', 'Signal send cancelled'));
    };
    signal.addEventListener('abort', cancelled, { once: true });
    request.then(value => {
      signal.removeEventListener('abort', cancelled);
      if (signal.aborted) cancelled(); else resolve(value);
    }, error => { signal.removeEventListener('abort', cancelled); reject(error); });
    if (signal.aborted) cancelled();
  });
}

/** One bounded live port for the existing browser socket and explicit SDK connections. */
export function createHostedSignalPort(host) {
  const readers = new Set();
  const lifetime = new AbortController();
  let closed = false, generation = 0, sending = 0, subscribed = false, wanted = false, updating;
  const stopAll = error => { for (const reader of [...readers]) reader.stop(error); };
  const subscription = enabled => {
    wanted = enabled;
    if (closed || !host.connected() || updating || subscribed === wanted) return;
    const captured = generation;
    const change = new AbortController(), desired = wanted;
    updating = change;
    Promise.resolve().then(() => {
      if (change.signal.aborted) throw change.signal.reason;
      return host.request({ t: desired ? 'signal_subscribe' : 'signal_unsubscribe' }, { signal: change.signal });
    })
      .then(() => { if (captured === generation) subscribed = desired; })
      .catch(error => {
        if (!closed && captured === generation && host.connected()) { subscribed = false; stopAll(error); }
      }).finally(() => {
        if (updating !== change) return;
        updating = undefined;
        subscription(wanted);
      });
  };
  const offMessage = host.onMessage(value => {
    if (closed) return;
    let message;
    try { message = validateSignalEnvelope(value); }
    catch (error) { stopAll(error); return; }
    if (message.expiresAtMs <= Date.now()) return;
    for (const reader of [...readers]) reader.push(message);
  });
  const offConnection = host.onConnection?.(() => {
    generation++;
    updating?.abort(); updating = undefined; subscribed = false;
    for (const reader of readers) reader.clear();
    if (readers.size) subscription(true);
  }) ?? (() => {});
  const port = {
    get connected() { return !closed && host.connected(); },
    async send(topic, payload, options = {}) {
      if (closed || !host.connected()) fail('signal_disconnected', 'A live connection is required');
      if (Object.keys(options).some(key => !['ttlMs', 'signal'].includes(key))) fail('invalid_signal', 'Signals have no durable retry or replay options');
      if (options.signal?.aborted) throw options.signal.reason ?? new SignalError('signal_cancelled', 'Signal send cancelled');
      if (sending >= SIGNAL_LIMITS.pending) fail('signal_overflow', 'Too many pending live sends');
      const input = createSignalInput(topic, payload, options);
      const signal = AbortSignal.any([lifetime.signal, ...(options.signal === undefined ? [] : [options.signal])]);
      sending++;
      let request;
      try {
        request = Promise.resolve(host.request({ t: 'signal_send', message: input }, { signal }));
      } catch (error) { sending--; throw error; }
      // Cancellation releases the caller immediately. A noncooperative host's
      // still-running request keeps its slot until it actually settles.
      request.then(() => { sending--; }, () => { sending--; });
      const reply = await waitForRequest(request, signal);
      return validateSignalEnvelope(reply.signal);
    },
    subscribe(options = {}) {
      if (closed) fail('signal_disconnected', 'Signal port is closed');
      if (Object.keys(options).some(key => !['topics', 'mode', 'signal'].includes(key)) ||
          options.topics !== undefined && (!Array.isArray(options.topics) || options.topics.length > 128) ||
          options.mode !== undefined && !['all', 'latest'].includes(options.mode)) fail('invalid_signal', 'Invalid signal subscription');
      const topics = options.topics === undefined ? null : new Set(options.topics.map(validateSignalTopic));
      const mode = options.mode ?? 'all', signal = options.signal;
      if (readers.size >= SIGNAL_LIMITS.subscriptions) fail('signal_overflow', 'Too many live subscriptions');
      let queue = [], waiter, ended = false, failure;
      const highWater = new Map();
      const prune = () => {
        const now = Date.now();
        queue = queue.filter(message => message.expiresAtMs > now);
        for (const [key, value] of highWater) if (value.retainUntilMs <= now) highWater.delete(key);
      };
      const key = message => JSON.stringify([message.authorId, message.sessionId, message.topic]);
      const cleanup = () => signal?.removeEventListener('abort', aborted);
      const reader = {
        stop(error) {
          if (ended) return;
          ended = true; failure = error; queue = []; highWater.clear(); cleanup();
          readers.delete(reader);
          if (!readers.size) subscription(false);
          if (waiter) { const current = waiter; waiter = undefined; error ? current.reject(error) : current.resolve({ done: true, value: undefined }); }
        },
        clear() { queue = []; },
        push(message) {
          if (ended || topics && !topics.has(message.topic)) return;
          prune();
          if (mode === 'latest') {
            const identity = key(message), previous = highWater.get(identity);
            if (previous && message.sequence <= previous.sequence) return;
            if (!previous && highWater.size >= SIGNAL_LIMITS.latestKeys) {
              reader.stop(new SignalError('signal_overflow', 'Too many active latest-value identities')); return;
            }
            // An earlier sequence can have a longer TTL than this value. The
            // host accepted it before this value's dispatch/expiry, with at
            // most the configured future skew plus maximum TTL still to run.
            const retainUntilMs = Math.min(Number.MAX_SAFE_INTEGER, message.expiresAtMs + SIGNAL_LIMITS.futureSkewMs + SIGNAL_LIMITS.ttlMs);
            highWater.set(identity, { sequence: message.sequence, retainUntilMs: Math.max(previous?.retainUntilMs ?? 0, retainUntilMs) });
          }
          if (waiter) { const current = waiter; waiter = undefined; current.resolve({ done: false, value: structuredClone(message) }); return; }
          if (mode === 'latest') {
            const index = queue.findIndex(item => key(item) === key(message));
            if (index >= 0) { queue[index] = message; return; }
            if (queue.length === SIGNAL_LIMITS.queue) queue.shift();
          } else if (queue.length === SIGNAL_LIMITS.queue) {
            reader.stop(new SignalError('signal_overflow', 'Live subscriber fell behind; this stream has no replay')); return;
          }
          queue.push(message);
        },
      };
      const aborted = () => reader.stop();
      const iterator = {
        next() {
          if (failure) return Promise.reject(failure);
          prune();
          if (queue.length) return Promise.resolve({ done: false, value: structuredClone(queue.shift()) });
          if (ended) return Promise.resolve({ done: true, value: undefined });
          if (waiter) return Promise.reject(new SignalError('signal_concurrent_read', 'Read a signal iterator sequentially'));
          return new Promise((resolve, reject) => { waiter = { resolve, reject }; });
        },
        return() { reader.stop(); return Promise.resolve({ done: true, value: undefined }); },
        [Symbol.asyncIterator]() { return this; },
      };
      if (signal?.aborted) { ended = true; return iterator; }
      readers.add(reader); signal?.addEventListener('abort', aborted, { once: true });
      if (readers.size === 1) subscription(true);
      return iterator;
    },
    close(error) {
      if (closed) return;
      if (host.connected() && (subscribed || updating))
        void Promise.resolve().then(() => host.request({ t: 'signal_unsubscribe' })).catch(() => {});
      closed = true; generation++; lifetime.abort(error ?? new SignalError('signal_disconnected', 'Signal port closed'));
      updating?.abort(); updating = undefined;
      offMessage(); offConnection(); stopAll(error); host.close?.();
    },
  };
  return Object.freeze(port);
}

/** Connect explicitly. Never persist, retry or reconnect an SDK signal send. */
export function connectHostedSignals({ base, protocols = [HOSTED_SIGNAL_PROTOCOL], open = (url, values) => new WebSocket(url, values), signal }) {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new SignalError('signal_cancelled', 'Signal connection cancelled'));
  const url = new URL(base.replace(/\/+$/, '') + '/signals/socket');
  if (!['https:', 'http:'].includes(url.protocol)) return Promise.reject(new SignalError('invalid_signal', 'Signals require an HTTP service URL'));
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return new Promise((resolve, reject) => {
    let socket, port, ready = false, closed = false, sequence = 0;
    const pending = new Map(), listeners = new Set();
    const finish = error => {
      if (closed) return;
      closed = true; clearTimeout(timer); signal?.removeEventListener('abort', aborted);
      for (const item of [...pending.values()]) item.finish(error ?? new SignalError('signal_disconnected', 'Live connection closed'));
      port?.close(error);
      try { socket?.close(1000, 'Signal connection closed'); } catch {}
      if (!ready) reject(error ?? new SignalError('signal_disconnected', 'Signal connection closed'));
    };
    const aborted = () => finish(signal.reason ?? new SignalError('signal_cancelled', 'Signal connection cancelled'));
    const timer = setTimeout(() => finish(new SignalError('signal_timeout', 'Signal connection timed out')), 10_000);
    const request = (message, options = {}) => {
      if (!ready || closed || socket.readyState !== 1) return Promise.reject(new SignalError('signal_disconnected', 'A live connection is required'));
      if (options.signal?.aborted) return Promise.reject(options.signal.reason ?? new SignalError('signal_cancelled', 'Signal send cancelled'));
      if (pending.size >= SIGNAL_LIMITS.pending || socket.bufferedAmount > 256 * 1024)
        return Promise.reject(new SignalError('signal_overflow', 'Live connection is busy'));
      const cid = String(++sequence);
      return new Promise((resolveRequest, rejectRequest) => {
        const cancel = () => item.finish(options.signal.reason ?? new SignalError('signal_cancelled', 'Signal send cancelled'));
        const timeout = setTimeout(() => item.finish(new SignalError('signal_timeout', 'Live request timed out')), 5000);
        const item = { finish(error, value) {
          if (!pending.delete(cid)) return;
          clearTimeout(timeout); options.signal?.removeEventListener('abort', cancel);
          error ? rejectRequest(error) : resolveRequest(value);
        } };
        pending.set(cid, item); options.signal?.addEventListener('abort', cancel, { once: true });
        try { socket.send(JSON.stringify({ ...message, cid })); }
        catch (error) { item.finish(error); }
      });
    };
    try { socket = open(url.href, protocols); }
    catch (error) { finish(error); return; }
    signal?.addEventListener('abort', aborted, { once: true });
    socket.addEventListener('close', () => finish(new SignalError('signal_disconnected', 'Live connection closed')));
    socket.addEventListener('error', () => finish(new SignalError('signal_disconnected', 'Live connection failed')));
    socket.addEventListener('message', event => {
      if (closed) return;
      try {
        if (typeof event.data !== 'string' || new TextEncoder().encode(event.data).length > SIGNAL_LIMITS.bytes + 1024) throw new SignalError('invalid_response', 'Invalid live frame');
        const value = JSON.parse(event.data);
        if (!ready) {
          if (value?.t !== 'signal_ready') throw new SignalError('invalid_response', 'Missing signal handshake');
          ready = true; clearTimeout(timer);
          port = createHostedSignalPort({ connected: () => !closed && socket.readyState === 1, request,
            onMessage: listener => { listeners.add(listener); return () => listeners.delete(listener); }, close: () => finish() });
          resolve(port); return;
        }
        if (value.t === 'signal') { for (const listener of listeners) listener(value.signal); }
        else if (value.cid && pending.has(value.cid)) pending.get(value.cid).finish(value.error
          ? new SignalError(value.error, value.message || value.error) : undefined, value);
      } catch (error) { finish(error); }
    });
  });
}
