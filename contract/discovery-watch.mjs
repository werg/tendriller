/** Hibernatable routing invalidations. There is no heartbeat or HTTP polling fallback. */
export const PEER_DISCOVERY_PROTOCOL = 'tendriller.discovery.v1';
export const PEER_DISCOVERY_WATCH_LIMITS = Object.freeze({ messageBytes: 128, openTimeoutMs: 15_000,
  retryMs: 1000, maxRetryMs: 60_000 });
export class PeerDiscoveryWatchError extends Error {
  constructor(code, message) { super(message); this.name = 'PeerDiscoveryWatchError'; this.code = code; this.retryable = false; }
}
const fail = (code, message) => new PeerDiscoveryWatchError(code, message);
export function validatePeerDiscoveryNotification(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).join() !== 'type' ||
      !['ready', 'changed'].includes(value.type)) throw fail('invalid_discovery_notification', 'Expected only a discovery ready or changed notification');
  return Object.freeze({ type: value.type });
}
export function validatePeerDiscoveryWatchOptions({ timeoutMs = PEER_DISCOVERY_WATCH_LIMITS.openTimeoutMs,
  retryMs = PEER_DISCOVERY_WATCH_LIMITS.retryMs, maxRetryMs = PEER_DISCOVERY_WATCH_LIMITS.maxRetryMs } = {}) {
  if (![timeoutMs, retryMs, maxRetryMs].every(value => Number.isSafeInteger(value) && value >= 1 && value <= 60_000) || retryMs > maxRetryMs)
    throw fail('invalid_discovery_watch', 'Expected bounded discovery opening and reconnect budgets');
  return { timeoutMs, retryMs, maxRetryMs };
}

/** One owned receive-only subscription, reconnecting only after transport failure. */
export function createPeerDiscoveryWatcher(openSocket, options = {}) {
  const { signal } = options, { timeoutMs, retryMs, maxRetryMs } = validatePeerDiscoveryWatchOptions(options);
  let ended = false, failure, socket, detach = () => {}, openTimer, retryTimer, failures = 0;
  let reading = false, waiting, resolveReady, rejectReady, resolveClosed, probing, probeController;
  const queue = [], ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  ready.catch(() => {});
  const wake = () => { waiting?.(); waiting = undefined; };
  function disconnect(code = 1000, reason = 'Discovery watch disconnected') {
    clearTimeout(openTimer); openTimer = undefined; detach(); detach = () => {};
    const previous = socket; socket = undefined;
    try { if (previous?.readyState < 2) previous.close(code, reason); } catch {}
  }
  function finish(error, code = 1000, reason = 'Discovery watch closed') {
    if (ended) return;
    ended = true; failure = error; probeController?.abort(); clearTimeout(retryTimer); disconnect(code, reason); queue.length = 0;
    signal?.removeEventListener('abort', cancelled);
    rejectReady(error ?? fail('discovery_closed', reason)); wake(); resolveClosed(Object.freeze({ code, reason }));
  }
  const cancelled = () => finish(signal.reason ?? new DOMException('Aborted', 'AbortError'));
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
        // Network failures and unavailable/unknown self routes remain retryable.
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
        const value = validatePeerDiscoveryNotification(JSON.parse(event.data));
        if (value.type === 'ready') {
          if (opened) throw fail('invalid_discovery_notification', 'Repeated ready notification');
          opened = true; failures = 0; clearTimeout(openTimer); openTimer = undefined;
          queue.push(value); resolveReady();
        } else {
          if (!opened) throw fail('invalid_discovery_notification', 'Changed notification before ready');
          // Changes invalidate one directory read; coalesce while the consumer is busy.
          if (queue.at(-1)?.type !== 'changed') queue.push(value);
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
  if (signal?.aborted) cancelled(); else connect();
  return Object.freeze({ ready, closed,
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
