// Bounded, disposable request/reply over authenticated live signals. Replies are
// JSON, not journal entries. Retries reuse an ID; fragments from different
// computations never mix. Signal topics are visible to application members, not
// a private channel to the requesting device.
const MAX_FRAME = 16_384, MAX_REPLY = 4 * 1024 * 1024, MAX_PARTS = 512;
// The kernel also limits the signed CBOR frame to 16 KiB. Leave 4 KiB
// for scope, credentials, stream metadata, timestamps, key and signature.
const PAYLOAD_BUDGET = 12 * 1024;
const MAX_CACHE = 32, MAX_CACHE_BYTES = 8 * 1024 * 1024, MAX_WAITING = 16;
const encoder = new TextEncoder();
const bytes = value => encoder.encode(JSON.stringify(value)).length;
const TRANSIENT = new Set(['SIGNAL_ROUTE_UNAVAILABLE', 'SIGNAL_BACKPRESSURE', 'SIGNAL_SEND_TIMEOUT']);
const fail = (code, message = code) => Object.assign(new Error(message), { code });
const combine = (...signals) => AbortSignal.any(signals.filter(Boolean));
function owned(task, signal) {
  const promise = Promise.resolve(task);
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    if (signal.aborted) { void promise.catch(() => {}); abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
function deadline(signal, timeoutMs, code) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw fail('REQUEST_OPTIONS_INVALID');
  const stop = new AbortController(), timer = setTimeout(() => stop.abort(fail(code)), timeoutMs);
  return { signal: combine(signal, stop.signal), close() { clearTimeout(timer); stop.abort(fail('REQUEST_FINISHED')); } };
}
function sleep(ms, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const finish = error => { clearTimeout(timer); signal.removeEventListener('abort', abort); error ? reject(error) : resolve(); };
    const abort = () => finish(signal.reason);
    const timer = setTimeout(() => finish(), ms);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

export function whenConnected(session, peer, { signal } = {}) {
  signal?.throwIfAborted();
  // The session reports a connected-peer COUNT. A count only permits an attempt;
  // replies still authenticate the named peer and request identity below.
  const source = session, routed = status => Number(status?.connectedPeers) > 0;
  if (routed(source.status)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let off, settled = false;
    const finish = error => { if (settled) return; settled = true; off?.(); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(); };
    const abort = () => finish(signal.reason); signal?.addEventListener('abort', abort, { once: true });
    try { off = source.onStatus(status => { if (routed(status)) finish(); }); if (settled) off(); if (signal?.aborted) abort(); else if (routed(source.status)) finish(); }
    catch (error) { finish(error); }
  });
}

/** Complete generated payloads leave room for the signed wire envelope. */
function splitReply(id, g, r, value) {
  const text = JSON.stringify(value);
  if (typeof text !== 'string') throw fail('REQUEST_REPLY_INVALID');
  if (encoder.encode(text).length > MAX_REPLY) throw fail('REQUEST_REPLY_TOO_LARGE');
  const parts = [];
  const boundary = end => end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end]) ? end - 1 : end;
  for (let start = 0; start < text.length;) {
    if (parts.length === MAX_PARTS) throw fail('REQUEST_REPLY_TOO_LARGE');
    let low = start, high = Math.min(text.length, start + MAX_FRAME);
    while (low < high) {
      const middle = Math.ceil((low + high) / 2), end = boundary(middle);
      if (bytes({ id, g, r, i: MAX_PARTS - 1, n: MAX_PARTS, z: text.slice(start, end) }) <= PAYLOAD_BUDGET) low = middle;
      else high = middle - 1;
    }
    const end = boundary(low);
    if (end <= start) throw fail('REQUEST_REPLY_TOO_LARGE');
    parts.push({ id, g, r, i: parts.length, n: 0, z: text.slice(start, end) }); start = end;
  }
  for (const part of parts) part.n = parts.length;
  return parts;
}

/** Browser/facade side. Close cancels pending sends and connectivity waits too. */
export function createSignalRequests(session, { peer, requestTopic = 'app/request', replyTopic = 'app/reply', retryMs = 3000 }) {
  if (!Number.isSafeInteger(retryMs) || retryMs < 1 || retryMs > 60_000) throw fail('REQUEST_OPTIONS_INVALID');
  const waiting = new Map(), stop = new AbortController(), lifetime = combine(stop.signal, session.signal);
  void (async () => {
    for await (const signal of session.signals.subscribe({ topics: [replyTopic], mode: 'all', signal: lifetime })) {
      if (signal.authorId !== peer) continue;
      const { id, g, r, i, n, z, error, code } = signal.payload ?? {};
      if (r !== session.identity.publicKey) continue;
      const entry = waiting.get(id);
      if (!entry || entry.done) continue;
      try {
        if (typeof g !== 'string' || !g.length || g.length > 128 || bytes(signal.payload) > MAX_FRAME) throw fail('REQUEST_REPLY_INVALID');
        let assembly = entry.assemblies.get(g);
        if (!assembly) {
          if (entry.assemblies.size >= 32) throw fail('REQUEST_REPLY_INVALID');
          entry.assemblies.set(g, assembly = { pieces: new Map(), n: undefined });
        }
        if (typeof error === 'string') throw fail(typeof code === 'string' ? code.slice(0, 128) : 'REQUEST_FAILED', error.slice(0, 2000));
        if (!Number.isSafeInteger(i) || !Number.isSafeInteger(n) || n < 1 || n > MAX_PARTS || i < 0 || i >= n || typeof z !== 'string' ||
            (assembly.n !== undefined && n !== assembly.n)) throw fail('REQUEST_REPLY_INVALID');
        assembly.n = n;
        if (assembly.pieces.has(i)) { if (assembly.pieces.get(i) !== z) throw fail('REQUEST_REPLY_INVALID'); continue; }
        entry.total += encoder.encode(z).length;
        if (entry.total > MAX_REPLY) throw fail('REQUEST_REPLY_TOO_LARGE');
        assembly.pieces.set(i, z); entry.progressAt = Date.now();
        if (assembly.pieces.size === n) {
          const text = Array.from({ length: n }, (_, index) => assembly.pieces.get(index)).join('');
          let answer; try { answer = JSON.parse(text); } catch { throw fail('REQUEST_REPLY_INVALID'); }
          entry.done = true; entry.resolve(answer);
        }
      } catch (error) { entry.done = true; entry.reject(error); }
    }
    if (!lifetime.aborted) stop.abort(fail('REQUEST_STREAM_CLOSED'));
  })().catch(error => stop.abort(error));
  return Object.freeze({
    async request(name, input = null, { signal, timeoutMs = 30_000 } = {}) {
      const base = combine(lifetime, signal); base.throwIfAborted();
      if (waiting.size >= MAX_WAITING) throw fail('REQUEST_BUSY');
      const id = crypto.randomUUID(), payload = { id, q: name, input };
      if (typeof name !== 'string' || bytes(payload) > PAYLOAD_BUDGET) throw fail('REQUEST_TOO_LARGE');
      const scope = deadline(base, timeoutMs, 'REQUEST_TIMEOUT');
      const entry = { assemblies: new Map(), total: 0, done: false, progressAt: 0 };
      const result = new Promise((resolve, reject) => { entry.resolve = resolve; entry.reject = reject; });
      waiting.set(id, entry);
      const abort = () => { entry.done = true; entry.reject(scope.signal.reason); };
      scope.signal.addEventListener('abort', abort, { once: true });
      if (scope.signal.aborted) abort();
      const sending = (async () => {
        while (!entry.done) {
          scope.signal.throwIfAborted();
          if (Date.now() - entry.progressAt >= retryMs) {
            await whenConnected(session, peer, { signal: scope.signal }); scope.signal.throwIfAborted();
            try { await owned(session.signals.send(requestTopic, payload, { ttlMs: 20_000, signal: scope.signal }), scope.signal); }
            catch (error) { if (!TRANSIENT.has(error.code)) throw error; }
          }
          if (!entry.done) await sleep(retryMs, scope.signal);
        }
      })();
      void sending.catch(error => { entry.done = true; entry.reject(error); });
      try { return await result; }
      finally { entry.done = true; waiting.delete(id); scope.signal.removeEventListener('abort', abort); scope.close(); await sending.catch(() => {}); }
    },
    close() { stop.abort(fail('REQUEST_CLOSED')); },
  });
}

/** Retry refused pieces within one fixed batch lifetime, never once per piece. */
export async function sendPieces(session, topic, parts, { signal, ttlMs = 30_000 } = {}) {
  const base = combine(session.signal, signal); base.throwIfAborted();
  const scope = deadline(base, ttlMs, 'SIGNAL_SEND_TIMEOUT'); let retries = 0;
  try {
    for (const part of parts) {
      if (bytes(part) > MAX_FRAME) throw fail('SIGNAL_FRAME_TOO_LARGE');
      for (let attempt = 0;; attempt++) {
        scope.signal.throwIfAborted();
        // The deadline bounds this wait only. Delivery follows the caller's lifetime:
        // a session may resolve after local delivery while remote delivery continues,
        // and closing the per-call deadline must not cancel that in-flight frame.
        try { await owned(session.signals.send(topic, part, { ttlMs, signal: base }), scope.signal); break; }
        catch (error) {
          if (!TRANSIENT.has(error.code) || scope.signal.aborted) throw error;
          retries++; await sleep(250 * 2 ** Math.min(attempt, 4), scope.signal);
        }
      }
    }
    return retries;
  } finally { scope.close(); }
}

/** Native side. Cache scope is authenticated author + ID, never ID alone.
 * 4 MiB / 512-piece answers, 32 entries and 8 MiB cached payloads are hard caps.
 * Terminal delivery failures reject this service promise instead of disappearing.
 */
export async function serveSignalRequests(session, { handle, requestTopic = 'app/request', replyTopic = 'app/reply', signal, cacheMs = 60_000 }) {
  if (!Number.isSafeInteger(cacheMs) || cacheMs < 0 || cacheMs > 300_000) throw fail('REQUEST_OPTIONS_INVALID');
  const stop = new AbortController(), lifetime = combine(stop.signal, session.signal, signal), recent = new Map(), jobs = new Set(), executions = new Set();
  let cachedBytes = 0, failure, failed = false;
  const forget = key => { const entry = recent.get(key); if (entry) cachedBytes -= entry.bytes; recent.delete(key); };
  const evict = () => { for (const [key, entry] of recent) if (!entry.pending && !entry.active) { forget(key); return true; } return false; };
  const errorPart = (id, g, r, error) => {
    let message = 'Request failed', code = 'REQUEST_FAILED';
    try { message = String(error?.message ?? error).slice(0, 2000); code = String(error?.code || code).slice(0, 128); } catch { /* Hostile thrown values are not protocol objects. */ }
    const part = { id, g, r, error: message, code };
    while (bytes(part) > PAYLOAD_BUDGET && part.error.length) part.error = part.error.slice(0, Math.floor(part.error.length / 2));
    return [part];
  };
  const dispatch = entry => {
    if (entry.active) return;
    const job = (async () => { const parts = await entry.parts; lifetime.throwIfAborted(); await sendPieces(session, replyTopic, parts, { signal: lifetime }); })();
    entry.active = job; jobs.add(job);
    void job.catch(error => { if (!lifetime.aborted) { failed = true; failure = error; stop.abort(error); } }).finally(() => { entry.active = null; jobs.delete(job); });
  };
  try {
    lifetime.throwIfAborted();
    for await (const request of session.signals.subscribe({ topics: [requestTopic], mode: 'all', signal: lifetime })) {
      lifetime.throwIfAborted();
      const { id, q, input } = request.payload ?? {};
      if (typeof request.authorId !== 'string' || typeof id !== 'string' || !id.length || id.length > 128 || typeof q !== 'string' || bytes(request.payload) > MAX_FRAME) continue;
      for (const [key, entry] of recent) if (!entry.pending && !entry.active && entry.until <= Date.now()) forget(key);
      const key = JSON.stringify([request.authorId, id]), cached = recent.get(key);
      if (cached) { dispatch(cached); continue; } // Same author/ID retains its ORIGINAL name/input.
      while (recent.size >= MAX_CACHE && evict()) { /* bounded cache */ }
      if (recent.size >= MAX_CACHE) continue; // Busy requests can retry; never grow work without bound.
      const g = crypto.randomUUID(), entry = { bytes: 0, pending: true, active: null, until: Infinity };
      recent.set(key, entry);
      entry.parts = (async () => {
        const scope = deadline(lifetime, 30_000, 'REQUEST_TIMEOUT'); let parts;
        try {
          if (executions.size >= MAX_CACHE) throw fail('REQUEST_BUSY');
          const execution = Promise.resolve().then(() => handle(q, input ?? null, { from: request.authorId, signal: scope.signal }));
          executions.add(execution);
          // A deadline releases its waiter, not the underlying provider slot.
          void execution.then(() => executions.delete(execution), () => executions.delete(execution));
          parts = splitReply(id, g, request.authorId, await owned(execution, scope.signal));
        }
        catch (error) { parts = errorPart(id, g, request.authorId, error); }
        finally { scope.close(); }
        lifetime.throwIfAborted();
        let size = parts.reduce((sum, part) => sum + bytes(part), 0);
        // Reserve one bounded error envelope per entry, including when all data
        // replies are active and therefore cannot be evicted.
        const limit = typeof parts[0]?.error === 'string' ? MAX_CACHE_BYTES : MAX_CACHE_BYTES - MAX_CACHE * MAX_FRAME;
        while (cachedBytes + size > limit && evict()) { /* retain active replies */ }
        if (cachedBytes + size > limit) { parts = errorPart(id, g, request.authorId, fail('REQUEST_BUSY')); size = parts.reduce((sum, part) => sum + bytes(part), 0); }
        entry.bytes = size; cachedBytes += size; entry.pending = false; entry.until = Date.now() + cacheMs;
        return parts;
      })();
      dispatch(entry);
    }
  } catch (error) { if (!lifetime.aborted) { failed = true; failure = error; } }
  // Uncooperative provider promises retain capacity until they settle, but do
  // not prevent service shutdown. Late results cannot send or alter the cache.
  finally { stop.abort(failed ? failure : fail('REQUEST_CLOSED')); await Promise.allSettled([...jobs]); recent.clear(); }
  if (failed) throw failure;
}

/**
 * Multi-agent ephemeral RPC client: address any agent dynamically by public key
 * over session.signals (4 MiB / 512-piece chunked JSON replies, zero durable journal writes).
 */
export function createAgentRpc(session, { requestTopic = 'agent/rpc/req', replyTopic = 'agent/rpc/res', retryMs = 3000 } = {}) {
  if (!Number.isSafeInteger(retryMs) || retryMs < 1 || retryMs > 60_000) throw fail('REQUEST_OPTIONS_INVALID');
  const waiting = new Map(), stop = new AbortController(), lifetime = combine(stop.signal, session.signal);
  void (async () => {
    for await (const signal of session.signals.subscribe({ topics: [replyTopic], mode: 'all', signal: lifetime })) {
      const { id, g, r, i, n, z, error, code } = signal.payload ?? {};
      if (r !== session.identity.publicKey) continue;
      const entry = waiting.get(id);
      if (!entry || entry.done || signal.authorId !== entry.target) continue;
      try {
        if (typeof g !== 'string' || !g.length || g.length > 128 || bytes(signal.payload) > MAX_FRAME) throw fail('REQUEST_REPLY_INVALID');
        let assembly = entry.assemblies.get(g);
        if (!assembly) {
          if (entry.assemblies.size >= 32) throw fail('REQUEST_REPLY_INVALID');
          entry.assemblies.set(g, assembly = { pieces: new Map(), n: undefined });
        }
        if (typeof error === 'string') throw fail(typeof code === 'string' ? code.slice(0, 128) : 'REQUEST_FAILED', error.slice(0, 2000));
        if (!Number.isSafeInteger(i) || !Number.isSafeInteger(n) || n < 1 || n > MAX_PARTS || i < 0 || i >= n || typeof z !== 'string' ||
            (assembly.n !== undefined && n !== assembly.n)) throw fail('REQUEST_REPLY_INVALID');
        assembly.n = n;
        if (assembly.pieces.has(i)) { if (assembly.pieces.get(i) !== z) throw fail('REQUEST_REPLY_INVALID'); continue; }
        entry.total += encoder.encode(z).length;
        if (entry.total > MAX_REPLY) throw fail('REQUEST_REPLY_TOO_LARGE');
        assembly.pieces.set(i, z); entry.progressAt = Date.now();
        if (assembly.pieces.size === n) {
          const text = Array.from({ length: n }, (_, index) => assembly.pieces.get(index)).join('');
          let answer; try { answer = JSON.parse(text); } catch { throw fail('REQUEST_REPLY_INVALID'); }
          entry.done = true; entry.resolve(answer);
        }
      } catch (err) { entry.done = true; entry.reject(err); }
    }
    if (!lifetime.aborted) stop.abort(fail('REQUEST_STREAM_CLOSED'));
  })().catch(error => stop.abort(error));
  return Object.freeze({
    async call(targetPublicKey, method, input = null, { signal, timeoutMs = 30_000 } = {}) {
      if (typeof targetPublicKey !== 'string' || !/^[a-f0-9]{64}$/u.test(targetPublicKey)) throw fail('REQUEST_TARGET_INVALID');
      const base = combine(lifetime, signal); base.throwIfAborted();
      if (waiting.size >= MAX_WAITING) throw fail('REQUEST_BUSY');
      const id = crypto.randomUUID(), payload = { id, to: targetPublicKey, q: method, input };
      if (typeof method !== 'string' || bytes(payload) > PAYLOAD_BUDGET) throw fail('REQUEST_TOO_LARGE');
      const scope = deadline(base, timeoutMs, 'REQUEST_TIMEOUT');
      const entry = { target: targetPublicKey, assemblies: new Map(), total: 0, done: false, progressAt: 0 };
      const result = new Promise((resolve, reject) => { entry.resolve = resolve; entry.reject = reject; });
      waiting.set(id, entry);
      const abort = () => { entry.done = true; entry.reject(scope.signal.reason); };
      scope.signal.addEventListener('abort', abort, { once: true });
      if (scope.signal.aborted) abort();
      const sending = (async () => {
        while (!entry.done) {
          scope.signal.throwIfAborted();
          if (Date.now() - entry.progressAt >= retryMs) {
            await whenConnected(session, targetPublicKey, { signal: scope.signal }); scope.signal.throwIfAborted();
            try { await owned(session.signals.send(requestTopic, payload, { ttlMs: 20_000, signal: scope.signal }), scope.signal); }
            catch (err) { if (!TRANSIENT.has(err.code)) throw err; }
          }
          if (!entry.done) await sleep(retryMs, scope.signal);
        }
      })();
      void sending.catch(err => { entry.done = true; entry.reject(err); });
      try { return await result; }
      finally { entry.done = true; waiting.delete(id); scope.signal.removeEventListener('abort', abort); scope.close(); await sending.catch(() => {}); }
    },
    close() { stop.abort(fail('REQUEST_CLOSED')); },
  });
}

/** Multi-agent ephemeral RPC server: handles requests explicitly addressed to this agent's public key. */
export function serveAgentRpc(session, { handle, requestTopic = 'agent/rpc/req', replyTopic = 'agent/rpc/res', signal, cacheMs = 60_000 }) {
  const selfKey = session.identity.publicKey;
  const wrappedSession = {
    ...session,
    signals: {
      ...session.signals,
      async *subscribe(opts) {
        for await (const frame of session.signals.subscribe(opts)) {
          if (frame?.payload?.to !== selfKey) continue;
          yield frame;
        }
      },
    },
  };
  return serveSignalRequests(wrappedSession, { handle, requestTopic, replyTopic, signal, cacheMs });
}
