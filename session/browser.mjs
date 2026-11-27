import { connectApplicationOwner, SessionError } from '@chronolog/peer-session/browser';
import { startTabRtcHost } from './browser-rtc.mjs';

export const TAB_OWNER_PROTOCOL = 'tendriller/tab-owner/v3';
const netLockName = profileId => `tendriller:net:${profileId}`;
const netChannelName = profileId => `tendriller:net:${profileId}`;

function validate(options) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(options.profileId)) throw new SessionError('INVALID_PROFILE');
  if (typeof globalThis.Worker !== 'function') {
    throw new SessionError('OWNER_CAPABILITY_UNAVAILABLE', 'This browser needs dedicated Workers for local session storage.');
  }
  const url = new URL(options.workerUrl, globalThis.location?.href);
  if (url.origin !== globalThis.location?.origin) throw new SessionError('OWNER_ORIGIN_MISMATCH');
  return url;
}

function waitForWorker(worker, predicate, { signal, timeoutMs = 30_000 } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const finish = (error, value) => {
      clearTimeout(timer);
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error); else resolve(value);
    };
    const onMessage = ({ data }) => {
      if (data?.protocol !== TAB_OWNER_PROTOCOL) return;
      if (data.type === 'failure') finish(new SessionError(data.code ?? 'OWNER_UNREACHABLE', data.message));
      else if (predicate(data)) finish(null, data);
    };
    const onError = event => finish(new SessionError('WORKER_LOAD_FAILED', event.message ?? 'Session worker failed to load'));
    const onAbort = () => finish(signal.reason);
    const timer = setTimeout(() => finish(new SessionError('BOOT_TIMEOUT', 'The local session worker did not answer in time.')), timeoutMs);
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function connectFacade(endpoint, { applicationId, context }, { signal, timeoutMs = 30_000 } = {}) {
  signal?.throwIfAborted();
  let cancelled = false, timer, onAbort;
  const opening = connectApplicationOwner(endpoint, { applicationId, ...(context === undefined ? {} : { context }) });
  void opening.then(session => { if (cancelled) void session.detach().catch(() => {}); }, () => {});
  try {
    return await Promise.race([
      opening,
      new Promise((_, reject) => {
        onAbort = () => { cancelled = true; reject(signal.reason); };
        signal?.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => { cancelled = true; reject(new SessionError('CONNECT_TIMEOUT', 'Timed out attaching to the local session worker.')); }, timeoutMs);
        if (signal?.aborted) onAbort();
      }),
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Non-blocking, stealable networking leader election across concurrent tabs/PWAs
 * of the same profile. Never blocks local IndexedDB reads or writes — follower tabs
 * stay 100% interactive via shared IndexedDB + BroadcastChannel `syncFromStore()`,
 * while at most one live tab maintains host discovery/invitation sockets so the server
 * never bounces sockets with `4000 Discovery listener replaced`.
 */
function coordinateNetworkLeader(profileId, { tabId, signal, onRole }) {
  const locks = globalThis.navigator?.locks;
  const doc = globalThis.document;
  if (typeof locks?.request !== 'function') {
    onRole(true);
    return () => {};
  }
  const lockName = netLockName(profileId);
  const channel = typeof globalThis.BroadcastChannel === 'function' ? new BroadcastChannel(netChannelName(profileId)) : null;
  let stopped = false;
  let holding = false;
  let releaseHeld = null;
  let hiddenTimer;
  let trying = false;

  const isVisible = () => !doc || doc.visibilityState !== 'hidden';
  const setHolding = next => {
    if (holding === next) return;
    holding = next;
    try { onRole(next); } catch {}
  };
  const dropLeadership = () => {
    clearTimeout(hiddenTimer);
    hiddenTimer = undefined;
    if (!releaseHeld) return;
    const rel = releaseHeld;
    releaseHeld = null;
    setHolding(false);
    rel();
    try { channel?.postMessage({ type: 'net-released', from: tabId }); } catch {}
  };

  const pingHolder = () => new Promise(resolve => {
    if (!channel) { resolve(null); return; }
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      channel.removeEventListener('message', onPong);
      resolve(null);
    }, 500);
    timer.unref?.();
    const onPong = ({ data }) => {
      if (data?.type !== 'net-pong' || data.id !== id) return;
      clearTimeout(timer);
      channel.removeEventListener('message', onPong);
      resolve({ visible: Boolean(data.visible) });
    };
    channel.addEventListener('message', onPong);
    try { channel.postMessage({ type: 'net-ping', id, from: tabId }); } catch {
      clearTimeout(timer);
      channel.removeEventListener('message', onPong);
      resolve(null);
    }
  });

  const holdLock = (options) => new Promise(resolve => {
    let resolved = false;
    const finish = acquired => {
      if (!resolved) { resolved = true; resolve(acquired); }
    };
    void locks.request(lockName, options, lock => {
      if (!lock || stopped || signal?.aborted) {
        finish(false);
        return Promise.resolve();
      }
      return new Promise(release => {
        releaseHeld = release;
        setHolding(true);
        finish(true);
      });
    }).catch(() => {
      // Steal or abort can reject the previous holder's lock promise cleanly.
      if (releaseHeld) { releaseHeld = null; setHolding(false); }
      finish(false);
    });
  });

  const tryAcquire = async () => {
    if (stopped || signal?.aborted || holding || trying) return;
    trying = true;
    try {
      if (await holdLock({ ifAvailable: true })) return;
      if (!isVisible() || stopped || signal?.aborted) return;
      // Another tab holds the lock. Probe liveness: if it is frozen/zombie on Android
      // (no pong within 500ms) or hidden while we are visible, steal the lock cleanly.
      const holder = await pingHolder();
      if (stopped || signal?.aborted || holding) return;
      if (holder === null || !holder.visible) {
        await holdLock({ steal: true });
      }
    } finally {
      trying = false;
    }
  };

  const onChannel = ({ data }) => {
    if (stopped || !data || data.from === tabId) return;
    if (data.type === 'net-ping' && holding) {
      try { channel?.postMessage({ type: 'net-pong', id: data.id, from: tabId, visible: isVisible() }); } catch {}
    } else if (data.type === 'net-released' && !holding && isVisible()) {
      void tryAcquire();
    }
  };
  channel?.addEventListener('message', onChannel);

  const onVisibility = () => {
    if (stopped) return;
    if (isVisible()) {
      clearTimeout(hiddenTimer);
      hiddenTimer = undefined;
      if (!holding) void tryAcquire();
    } else if (holding) {
      clearTimeout(hiddenTimer);
      hiddenTimer = setTimeout(() => { hiddenTimer = undefined; if (!isVisible()) dropLeadership(); }, 10_000);
      hiddenTimer.unref?.();
    }
  };
  const onFreeze = () => dropLeadership();
  const onFocus = () => { if (!stopped && !holding && isVisible()) void tryAcquire(); };

  doc?.addEventListener?.('visibilitychange', onVisibility);
  doc?.addEventListener?.('freeze', onFreeze);
  doc?.addEventListener?.('resume', onFocus);
  globalThis.addEventListener?.('focus', onFocus);
  globalThis.addEventListener?.('pagehide', onFreeze);

  void tryAcquire();

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(hiddenTimer);
    doc?.removeEventListener?.('visibilitychange', onVisibility);
    doc?.removeEventListener?.('freeze', onFreeze);
    doc?.removeEventListener?.('resume', onFocus);
    globalThis.removeEventListener?.('focus', onFocus);
    globalThis.removeEventListener?.('pagehide', onFreeze);
    channel?.removeEventListener('message', onChannel);
    dropLeadership();
    channel?.close();
  };
  signal?.addEventListener('abort', stop, { once: true });
  return stop;
}

/** Ask the browser to keep this origin's storage (device key, journal, unsent work)
 * out of best-effort eviction under storage pressure. Never throws; null = unsupported. */
export function requestPersistentStorage() {
  const storage = globalThis.navigator?.storage;
  if (typeof storage?.persist !== 'function') return Promise.resolve(null);
  return (async () => { try { return await storage.persisted?.() || await storage.persist(); } catch { return false; } })();
}

/**
 * Lock-free multi-tab browser session owner:
 * - Never blocks or fails when another tab/PWA window is open (zero exclusive storage lock).
 * - Spawns a 1:1 dedicated Worker backed by multi-tab IndexedDB + BroadcastChannel sync.
 * - Transfers a direct MessageChannel port to `createApplicationOwner` (no wrapper overhead).
 * - Coordinates a non-blocking, stealable networking leader lock (`tendriller:net:${profileId}`)
 *   so background/sibling tabs converge locally without socket-replacement churn.
 * - Hosts all WebRTC PeerConnections directly in-tab (`attachment.rtc`).
 */
export async function openBrowserOwner(options) {
  const url = validate(options);
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new SessionError('OWNER_CONFIGURATION_INVALID', 'Opening timeout must be finite and positive');

  const tabId = crypto.randomUUID();
  const lifetime = new AbortController();
  let worker, rtcHost, appPort, session, stopNetLeader, detached = false, releasing;
  const storagePersisted = options.persistStorage === false ? Promise.resolve(null) : requestPersistentStorage();

  const release = (reason) => {
    if (releasing) return releasing;
    detached = true;
    try { stopNetLeader?.(); } catch {}
    globalThis.removeEventListener?.('pagehide', onPageHide);
    options.signal?.removeEventListener('abort', onExternalAbort);
    // Close active RTCPeerConnections synchronously before any await so page
    // unload emits SCTP ABORT / DTLS close_notify instead of stranding peers.
    try { rtcHost?.closeNow(); } catch { /* Best-effort synchronous RTC close. */ }
    lifetime.abort(reason ?? new Error('TAB_DETACHED'));
    let retirePosted = false;
    const postRetire = () => {
      if (!worker || retirePosted) return null;
      retirePosted = true;
      const id = crypto.randomUUID();
      try { worker.postMessage({ protocol: TAB_OWNER_PROTOCOL, type: 'retire', id, profileId: options.profileId }); } catch { return null; }
      return id;
    };
    const unload = reason?.message === 'PAGE_UNLOAD';
    const retireId = unload ? postRetire() : null;
    releasing = (async () => {
      try { await rtcHost?.close(); } catch { /* Best-effort RTC cleanup. */ }
      try { appPort?.close(); } catch { /* Best-effort port cleanup. */ }
      if (worker) {
        try {
          const id = retireId ?? postRetire();
          if (id) {
            const retired = waitForWorker(worker, data => data.type === 'retired' && data.id === id, { timeoutMs: 2000 });
            await retired;
          }
        } catch { /* Terminate unconditionally if worker is busy/closing. */ }
        worker.terminate();
      }
    })();
    return releasing;
  };

  const onPageHide = event => {
    if (event.persisted) return;
    try { rtcHost?.closeNow(); } catch { /* Best-effort synchronous RTC close. */ }
    void release(new Error('PAGE_UNLOAD'));
  };
  const onExternalAbort = () => { void release(options.signal.reason); };

  try {
    options.signal?.addEventListener('abort', onExternalAbort, { once: true });
    if (options.signal?.aborted) onExternalAbort();

    worker = new Worker(url, { type: 'module', name: `tendriller-tab-${tabId}` });
    rtcHost = startTabRtcHost(worker, {
      signal: lifetime.signal,
      createPeerConnection: options.createPeerConnection,
    });

    const appChannel = new MessageChannel();
    appPort = appChannel.port1;
    appPort.start();

    const bootId = crypto.randomUUID();
    const ready = waitForWorker(worker, data => data.type === 'ready' && data.id === bootId, { signal: lifetime.signal, timeoutMs });
    worker.postMessage({
      protocol: TAB_OWNER_PROTOCOL,
      type: 'boot',
      id: bootId,
      profileId: options.profileId,
      ...(options.configuration !== undefined ? { configuration: options.configuration } : {}),
    }, [appChannel.port2]);
    await ready;

    session = await connectFacade(appPort, { applicationId: options.applicationId, context: options.context ?? {} }, { signal: lifetime.signal, timeoutMs });
    lifetime.signal.throwIfAborted();

    stopNetLeader = coordinateNetworkLeader(options.profileId, {
      tabId,
      signal: lifetime.signal,
      onRole: active => {
        try { worker?.postMessage({ protocol: TAB_OWNER_PROTOCOL, type: 'network-role', active }); } catch {}
      },
    });

    globalThis.addEventListener?.('pagehide', onPageHide);

    return Object.freeze({
      session,
      mode: 'dedicated',
      rtc: rtcHost,
      storagePersisted,
      async suspend() { if (!detached) await session.suspend(); },
      async resume() { if (detached) throw new SessionError('ENDPOINT_STALE'); await session.resumeAttachment(); return session; },
      async detach() {
        if (detached) { await releasing; return; }
        detached = true;
        try { await session.detach(); }
        finally { await release(new Error('TAB_DETACHED')); }
      },
    });
  } catch (error) {
    await release(error);
    throw error;
  }
}

/** Enrollment is deliberate. Spawns a short-lived dedicated Worker to create/read the device key. */
export async function createBrowserIdentity(options) {
  const url = validate(options);
  const worker = new Worker(url, { type: 'module' });
  const id = crypto.randomUUID();
  try {
    const ready = waitForWorker(worker, data => data.type === 'identity' && data.id === id, options);
    worker.postMessage({
      protocol: TAB_OWNER_PROTOCOL,
      type: 'identity',
      profileId: options.profileId,
      id,
      ...(options.configuration !== undefined ? { configuration: options.configuration } : {}),
    });
    const publicKey = (await ready).publicKey;
    if (options.persistStorage !== false) void requestPersistentStorage();
    return publicKey;
  } finally {
    worker.terminate();
  }
}
