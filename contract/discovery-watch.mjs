/** Hibernatable routing invalidations. There is no heartbeat or HTTP polling fallback. */
export const PEER_DISCOVERY_PROTOCOL = 'tendriller.discovery.v1';
export const PEER_DISCOVERY_WATCH_LIMITS = Object.freeze({ messageBytes: 128, openTimeoutMs: 15_000,
  retryMs: 1000, maxRetryMs: 60_000 });
export class PeerDiscoveryWatchError extends Error {
  constructor(code, message) { super(message); this.name = 'PeerDiscoveryWatchError'; this.code = code; this.retryable = false; }
}
const fail = (code, message) => new PeerDiscoveryWatchError(code, message);
const REVISION_VECTOR = /^[0-9a-f]{12}(?:\.(?:0|[1-9][0-9]{0,9})){4}$/;
const REVISION = /^[0-9a-f]{12}\.(?:0|[1-9][0-9]{0,9})$/;
export function validatePeerDiscoveryNotification(value) {
  const keys = value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).sort().join() : '';
  if ((keys !== 'type' && keys !== 'rev,type') || !['ready', 'changed'].includes(value.type) ||
      keys === 'rev,type' && (typeof value.rev !== 'string' || !REVISION_VECTOR.test(value.rev)))
    throw fail('invalid_discovery_notification', 'Expected only a discovery ready or changed notification');
  return Object.freeze(value.rev === undefined ? { type: value.type } : { type: value.type, rev: value.rev });
}

/**
 * Host invalidation scopes carried by discovery notifications: public control
 * (`control`), pending admissions (`admissions`), peer directory (`directory`)
 * and store-and-forward mailbox (`mailbox`). A notification is only a hint to
 * re-read host state; it carries no state and authorizes nothing.
 */
export const HOST_REVISION_SCOPES = Object.freeze(['control', 'admissions', 'directory', 'mailbox']);
const parseVector = rev => {
  if (typeof rev !== 'string' || !REVISION_VECTOR.test(rev)) return null;
  const [nonce, ...counts] = rev.split('.');
  return { nonce, counts: Object.fromEntries(HOST_REVISION_SCOPES.map((scope, i) => [scope, Number(counts[i])])) };
};
const parseRevision = rev => {
  if (typeof rev !== 'string' || !REVISION.test(rev)) return null;
  const [nonce, count] = rev.split('.');
  return { nonce, count: Number(count) };
};

/**
 * Remembers the host revision each scope was last read at, from responses that
 * carry `revision`, and answers which scopes a notification invalidates. A
 * notification without a vector, from another host instance, or for a scope
 * never read invalidates that scope.
 */
export function createHostRevisionTracker() {
  const seen = new Map();
  return Object.freeze({
    observe(scope, revision) {
      const parsed = parseRevision(revision);
      if (!parsed || !HOST_REVISION_SCOPES.includes(scope)) return;
      const previous = seen.get(scope);
      if (!previous || previous.nonce !== parsed.nonce || previous.count < parsed.count) seen.set(scope, parsed);
    },
    forget(scope) { seen.delete(scope); },
    stale(notification, scopes = HOST_REVISION_SCOPES) {
      const vector = parseVector(notification?.rev);
      return scopes.filter(scope => {
        if (!vector) return true;
        const last = seen.get(scope);
        return !last || last.nonce !== vector.nonce || last.count < vector.counts[scope];
      });
    },
  });
}
export function validatePeerDiscoveryWatchOptions({ timeoutMs = PEER_DISCOVERY_WATCH_LIMITS.openTimeoutMs,
  retryMs = PEER_DISCOVERY_WATCH_LIMITS.retryMs, maxRetryMs = PEER_DISCOVERY_WATCH_LIMITS.maxRetryMs } = {}) {
  if (![timeoutMs, retryMs, maxRetryMs].every(value => Number.isSafeInteger(value) && value >= 1 && value <= 60_000) || retryMs > maxRetryMs)
    throw fail('invalid_discovery_watch', 'Expected bounded discovery opening and reconnect budgets');
  return { timeoutMs, retryMs, maxRetryMs };
}

/** One owned receive-only subscription with zero-wake edge ping/pong liveness detection. */
export function createPeerDiscoveryWatcher(openSocket, options = {}) {
  const { signal } = options, { timeoutMs, retryMs, maxRetryMs } = validatePeerDiscoveryWatchOptions(options);
  const pingIntervalMs = options.pingIntervalMs ?? 0;
  const pongTimeoutMs = options.pongTimeoutMs ?? 5_000;
  let ended = false, failure, socket, detach = () => {}, openTimer, retryTimer, pingTimer, pongTimer, failures = 0;
  let reading = false, waiting, resolveReady, rejectReady, resolveClosed, probing, probeController;
  const queue = [], ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  ready.catch(() => {});
  const wake = () => { waiting?.(); waiting = undefined; };
  function clearLiveness() {
    clearTimeout(pingTimer); pingTimer = undefined;
    clearTimeout(pongTimer); pongTimer = undefined;
  }
  function disconnect(code = 1000, reason = 'Discovery watch disconnected') {
    clearTimeout(openTimer); openTimer = undefined; clearLiveness(); detach(); detach = () => {};
    const previous = socket; socket = undefined;
    try { if (previous?.readyState < 2) previous.close(code, reason); } catch {}
  }
  function finish(error, code = 1000, reason = 'Discovery watch closed') {
    if (ended) return;
    ended = true; failure = error; probeController?.abort(); clearTimeout(retryTimer); disconnect(code, reason); queue.length = 0;
    signal?.removeEventListener('abort', cancelled); network?.removeEventListener('online', reachable);
    rejectReady(error ?? fail('discovery_closed', reason)); wake(); resolveClosed(Object.freeze({ code, reason }));
  }
  const cancelled = () => finish(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  // A browser or worker that regains its network reconnects now instead of sitting out
  // the backoff it accumulated while offline, or probes an open socket for half-open death.
  const network = options.network === undefined ? (typeof globalThis.addEventListener === 'function' ? globalThis : null) : options.network;
  function sendPing() {
    if (ended || !socket || socket.readyState !== 1 || pongTimer) return;
    try {
      socket.send('{"t":"ping"}');
      pongTimer = setTimeout(() => {
        pongTimer = undefined;
        if (!ended && socket) retry();
      }, pongTimeoutMs);
      pongTimer.unref?.();
    } catch { retry(); }
  }
  function schedulePing() {
    clearTimeout(pingTimer);
    if (ended || !pingIntervalMs || pingIntervalMs <= 0) return;
    pingTimer = setTimeout(() => { pingTimer = undefined; sendPing(); }, pingIntervalMs);
    pingTimer.unref?.();
  }
  function reachable() {
    if (ended) return;
    if (retryTimer) {
      clearTimeout(retryTimer); retryTimer = undefined; failures = 0; connect();
    } else if (socket?.readyState === 1) {
      sendPing();
    }
  }
  function scheduleRetry() {
    if (ended || retryTimer) return;
    const ms = Math.min(maxRetryMs, retryMs * 2 ** Math.min(failures++, 16));
    retryTimer = setTimeout(() => { retryTimer = undefined; connect(); }, ms);
  }
  function retry() {
    disconnect(); queue.length = 0;
    if (ended || retryTimer || probing) return;
    if (!options.probeAccess) { scheduleRetry(); return; }
    // Upgrade errors conceal HTTP status. Diagnose access only after failure;
    // the authenticated caller owns credential and page-proxy handling.
    const controller = probeController = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    probing = (async () => {
      try {
        await new Promise((resolve, reject) => {
          const abort = () => reject(controller.signal.reason);
          controller.signal.addEventListener('abort', abort, { once: true });
          Promise.resolve().then(() => {
            controller.signal.throwIfAborted(); return options.probeAccess({ signal: controller.signal });
          }).then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', abort));
        });
      } catch (error) {
        if (!ended && [401, 403, 409].includes(error?.status))
          finish(fail('discovery_access_revoked', 'Discovery access was refused'), 4003, 'Discovery access refused');
        // Network failures and unavailable/unknown access probes remain retryable.
      } finally {
        clearTimeout(timeout); probeController = undefined;
      }
    })();
    probing.finally(() => { probing = undefined; scheduleRetry(); }).catch(() => {});
  }
  function connect() {
    if (ended) return;
    let current;
    try { current = socket = openSocket(); } catch { retry(); return; }
    let opened = false;
    const live = () => !ended && socket === current;
    const message = event => {
      if (!live()) return;
      try {
        if (typeof event.data !== 'string' || new TextEncoder().encode(event.data).byteLength > PEER_DISCOVERY_WATCH_LIMITS.messageBytes)
          throw fail('invalid_discovery_notification', 'Discovery accepts bounded JSON notifications only');
        const parsed = JSON.parse(event.data);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.t === 'pong' && Object.keys(parsed).length === 1) {
          clearTimeout(pongTimer); pongTimer = undefined;
          schedulePing();
          return;
        }
        const value = validatePeerDiscoveryNotification(parsed);
        if (value.type === 'ready') {
          if (opened) throw fail('invalid_discovery_notification', 'Repeated ready notification');
          opened = true; failures = 0; clearTimeout(openTimer); openTimer = undefined;
          schedulePing();
          queue.push(value); resolveReady();
        } else {
          if (!opened) throw fail('invalid_discovery_notification', 'Changed notification before ready');
          // Changes are invalidations; while the consumer is busy only the newest
          // pending vector matters (host counters only grow).
          if (queue.at(-1)?.type === 'changed') queue[queue.length - 1] = value; else queue.push(value);
        }
        wake();
      } catch (error) {
        finish(error?.code ? error : fail('invalid_discovery_notification', 'Invalid discovery JSON'), 1008, 'Invalid discovery notification');
      }
    };
    const disconnected = event => {
      if (!live()) return;
      if (event.code === 4000) finish(fail('participant_replaced', 'Discovery subscription was replaced'), 4000, 'Discovery participant replaced');
      else if ([1008, 4003].includes(event.code)) finish(fail('discovery_access_revoked', 'Discovery subscription was refused'), event.code, 'Discovery subscription refused');
      else retry();
    };
    const errored = () => { if (live()) retry(); };
    const listeners = [['message', message], ['close', disconnected], ['error', errored]];
    detach = () => { for (const [type, listener] of listeners) current.removeEventListener(type, listener); };
    for (const [type, listener] of listeners) current.addEventListener(type, listener);
    openTimer = setTimeout(() => { if (live()) retry(); }, timeoutMs);
    if (current.readyState > 1) disconnected({ code: 1006 });
  }
  signal?.addEventListener('abort', cancelled, { once: true });
  network?.addEventListener('online', reachable);
  if (signal?.aborted) cancelled(); else connect();
  return Object.freeze({ ready, closed,
    probe() { sendPing(); },
    notifications: { async *[Symbol.asyncIterator]() {
      if (reading) throw fail('reader_exists', 'Discovery notifications have one consumer');
      reading = true;
      try {
        while (!ended) {
          if (queue.length) { yield queue.shift(); continue; }
          await new Promise(resolve => { waiting = resolve; });
        }
        if (failure) throw failure;
      } finally { reading = false; }
    } },
    close() { finish(); },
  });
}
