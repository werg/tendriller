// Request/reply over live signals, for answers that are computed on demand and not
// retained in the journal (dashboards, search results, previews).
//
// - A request waits until the answering participant is actually connected; a
//   signal sent before a route exists is only echoed locally and would be lost.
// - The same request ID is re-sent until the first reply piece arrives, and the
//   server answers a repeat from its short reply cache instead of recomputing.
// - Replies of any size are split into signal-sized pieces and reassembled in
//   order. Each piece is sent after the previous one is accepted; the relay paces
//   them, so applications never handle SIGNAL_BACKPRESSURE themselves.
// Subscribers use mode 'all': every piece matters. ('latest' keeps only the newest
// value per stream and is meant for state snapshots, not for multi-piece replies.)

// JSON escaping inside a signal payload can roughly double a piece; keep each frame under 16 KiB.
const PIECE_CHARACTERS = 7_000;
const fail = (code, message) => Object.assign(new Error(message), { code });
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const done = () => { signal?.removeEventListener('abort', abort); resolve(); };
  const abort = () => { clearTimeout(timer); reject(signal.reason); };
  const timer = setTimeout(done, ms); signal?.addEventListener('abort', abort, { once: true });
});

/** Resolves once `peer` is among the session's connected peers. */
export function whenConnected(session, peer, { signal } = {}) {
  if (session.participation.status.connectedPeers.includes(peer)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let off;
    const abort = () => { off?.(); reject(signal.reason); };
    off = session.participation.onStatus(status => {
      if (status.connectedPeers.includes(peer)) { off?.(); signal?.removeEventListener('abort', abort); resolve(); }
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (session.participation.status.connectedPeers.includes(peer)) { off?.(); resolve(); }
  });
}

/** Browser side. `peer` is the answering participant's device ID (e.g. configuration.nativeDeviceId). */
export function createSignalRequests(session, { peer, requestTopic = 'app/request', replyTopic = 'app/reply', retryMs = 3000 }) {
  const waiting = new Map(), lifetime = new AbortController();
  void (async () => {
    for await (const signal of session.signals.subscribe({ topics: [replyTopic], mode: 'all', signal: lifetime.signal })) {
      if (signal.authorId !== peer) continue;
      const { id, i, n, z, error, code } = signal.payload ?? {}, entry = waiting.get(id);
      if (!entry) continue;
      entry.started = true;
      if (error) { entry.reject(fail(code || 'REQUEST_FAILED', error)); continue; }
      if (!Number.isSafeInteger(i) || !Number.isSafeInteger(n) || i < 0 || i >= n || typeof z !== 'string') continue;
      entry.pieces[i] = z; entry.count = entry.pieces.filter(value => value !== undefined).length;
      if (entry.count === n) {
        try { entry.resolve(JSON.parse(entry.pieces.join(''))); } catch { entry.reject(fail('REQUEST_REPLY_INVALID', 'The reply could not be read.')); }
      }
    }
  })().catch(() => {});
  return Object.freeze({
    async request(name, input = null, { signal, timeoutMs = 30_000 } = {}) {
      const id = crypto.randomUUID(), deadline = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...[signal].filter(Boolean)]);
      const entry = { pieces: [], count: 0, started: false };
      const result = new Promise((resolve, reject) => { entry.resolve = resolve; entry.reject = reject; });
      waiting.set(id, entry);
      try {
        const sending = (async () => {
          while (!entry.started) {
            await whenConnected(session, peer, { signal: deadline });
            try { await session.signals.send(requestTopic, { id, q: name, input }, { ttlMs: 20_000 }); }
            catch (error) { if (!['SIGNAL_ROUTE_UNAVAILABLE', 'SIGNAL_BACKPRESSURE', 'SIGNAL_SEND_TIMEOUT'].includes(error.code)) throw error; }
            await sleep(retryMs, deadline);
          }
        })();
        sending.catch(error => entry.reject(error));
        return await Promise.race([result, new Promise((_resolve, reject) => {
          deadline.addEventListener('abort', () => reject(fail('REQUEST_TIMEOUT', 'The answer did not arrive in time.')), { once: true });
        })]);
      } finally { entry.started = true; waiting.delete(id); }
    },
    close() { lifetime.abort(); },
  });
}

/** Native side: answer each request once, re-sending a cached reply for repeats. */
export function serveSignalRequests(session, { handle, requestTopic = 'app/request', replyTopic = 'app/reply', signal, cacheMs = 60_000 }) {
  const recent = new Map();
  const send = async parts => { for (const part of parts) await session.signals.send(replyTopic, part, { ttlMs: 30_000 }); };
  return (async () => {
    for await (const request of session.signals.subscribe({ topics: [requestTopic], mode: 'all', signal })) {
      const { id, q, input } = request.payload ?? {};
      if (typeof id !== 'string' || id.length > 128 || typeof q !== 'string') continue;
      const now = Date.now();
      for (const [key, value] of recent) if (value.at < now - cacheMs) recent.delete(key);
      const cached = recent.get(id);
      if (cached) { void cached.parts.then(send).catch(() => {}); continue; }
      const parts = (async () => {
        try {
          const text = JSON.stringify(await handle(q, input ?? null, { from: request.authorId }));
          const n = Math.max(1, Math.ceil(text.length / PIECE_CHARACTERS));
          return Array.from({ length: n }, (_value, i) => ({ id, i, n, z: text.slice(i * PIECE_CHARACTERS, (i + 1) * PIECE_CHARACTERS) }));
        } catch (error) { return [{ id, error: String(error.message ?? error).slice(0, 2000), code: error.code || 'error' }]; }
      })();
      recent.set(id, { at: now, parts });
      void parts.then(send).catch(() => {});
    }
  })();
}
