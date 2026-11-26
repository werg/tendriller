import { connectApplicationOwner, SessionError } from '@chronolog/peer-session/browser';
import { startTabRtcHost } from './browser-rtc.mjs';

export const TAB_OWNER_PROTOCOL = 'tendriller/tab-owner/v2';
const tabLockName = profileId => `tendriller:tab:${profileId}`;
const tabChannelName = profileId => `tendriller:tab-handoff:${profileId}`;

function validate(options) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(options.profileId)) throw new SessionError('INVALID_PROFILE');
  if (!globalThis.navigator?.locks) {
    throw new SessionError('OWNER_CAPABILITY_UNAVAILABLE', 'This browser needs Web Locks to retain one active tab session.');
  }
  if (typeof globalThis.Worker !== 'function') {
    throw new SessionError('OWNER_CAPABILITY_UNAVAILABLE', 'This browser needs dedicated Workers for local session storage.');
  }
  const url = new URL(options.workerUrl, globalThis.location?.href);
  if (url.origin !== globalThis.location?.origin) throw new SessionError('OWNER_ORIGIN_MISMATCH');
  return url;
}

/** Demultiplexes the app-RPC messages on the 1:1 dedicated Worker port. */
function createAppEndpoint(worker, signal) {
  const endpoint = new EventTarget();
  let closed = false;
  const onMessage = ({ data }) => {
    if (closed || data?.protocol !== TAB_OWNER_PROTOCOL || data.type !== 'app') return;
    endpoint.dispatchEvent(new MessageEvent('message', { data: data.payload }));
  };
  endpoint.postMessage = (payload, transfer) => {
    if (closed) return;
    if (transfer?.length) worker.postMessage({ protocol: TAB_OWNER_PROTOCOL, type: 'app', payload }, transfer);
    else worker.postMessage({ protocol: TAB_OWNER_PROTOCOL, type: 'app', payload });
  };
  const close = () => {
    if (closed) return;
    closed = true;
    worker.removeEventListener('message', onMessage);
    signal?.removeEventListener('abort', close);
  };
  endpoint.close = close;
  worker.addEventListener('message', onMessage);
  signal?.addEventListener('abort', close, { once: true });
  return endpoint;
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
    const onError = event => finish(new SessionError('OWNER_UNREACHABLE', event.message ?? 'Session worker failed to load'));
    const onAbort = () => finish(signal.reason);
    const timer = setTimeout(() => finish(new SessionError('OWNER_UNREACHABLE', 'The local session worker did not answer in time.')), timeoutMs);
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
        timer = setTimeout(() => { cancelled = true; reject(new SessionError('OWNER_UNREACHABLE')); }, timeoutMs);
        if (signal?.aborted) onAbort();
      }),
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function shouldTakeover(mode) {
  if (mode === true) return true;
  if (mode === false) return false;
  // Default 'auto': a foreground tab or standalone PWA seamlessly takes over from an
  // existing tab, while a hidden background tab never steals an active session.
  return globalThis.document?.visibilityState !== 'hidden';
}

function tryAcquireImmediateLock(lockName, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (error, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error); else resolve(value);
    };
    const onAbort = () => done(signal.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    void navigator.locks.request(lockName, { ifAvailable: true }, lock => {
      if (!lock) {
        done(null, null);
        return Promise.resolve();
      }
      if (settled || signal?.aborted) return Promise.resolve();
      let releaseLock;
      const held = new Promise(r => { releaseLock = r; });
      done(null, { release: () => releaseLock() });
      return held;
    }).catch(error => done(error));
  });
}

/**
 * Acquire the single-active-tab lock for `profileId`.
 * Always tries an immediate non-blocking acquire first. When another tab holds the lock:
 * - `takeover: false` (or `'auto'` while hidden) returns `null` immediately.
 * - `takeover: true` (or `'auto'` while visible) requests the existing tab to release
 *   over BroadcastChannel and waits for a clean handoff.
 */
async function acquireTabLock(profileId, { takeover = 'auto', signal, timeoutMs = 15_000 } = {}) {
  signal?.throwIfAborted();
  const lockName = tabLockName(profileId);
  const immediate = await tryAcquireImmediateLock(lockName, signal);
  if (immediate) return immediate;
  if (!shouldTakeover(takeover)) return null;

  let channel, nudgeTimer;
  if (typeof globalThis.BroadcastChannel === 'function') {
    channel = new BroadcastChannel(tabChannelName(profileId));
    const requestId = crypto.randomUUID();
    const postTakeover = () => {
      try { channel.postMessage({ protocol: TAB_OWNER_PROTOCOL, type: 'takeover', profileId, requestId }); } catch { /* Channel closed. */ }
    };
    postTakeover();
    // Re-nudge briefly in case the previous holder was mid-boot or waking from throttle.
    nudgeTimer = setInterval(postTakeover, 400);
    nudgeTimer.unref?.();
  }
  try {
    return await new Promise((resolve, reject) => {
      let settled = false;
      const done = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (error) reject(error); else resolve(value);
      };
      const onAbort = () => done(signal.reason);
      const timer = setTimeout(() => done(new SessionError('OWNER_BUSY', 'Another tab did not release this page in time.')), timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });

      void navigator.locks.request(lockName, {}, lock => {
        if (!lock) {
          done(null, null);
          return Promise.resolve();
        }
        if (settled || signal?.aborted) return Promise.resolve();
        let releaseLock;
        const held = new Promise(r => { releaseLock = r; });
        done(null, { release: () => releaseLock() });
        return held;
      }).catch(error => done(error));
    });
  } finally {
    clearInterval(nudgeTimer);
    channel?.close();
  }
}

/** Ask the browser to keep this origin's storage (device key, journal, unsent work)
 * out of best-effort eviction under storage pressure. Never throws; null = unsupported. */
export function requestPersistentStorage() {
  const storage = globalThis.navigator?.storage;
  if (typeof storage?.persist !== 'function') return Promise.resolve(null);
  return (async () => { try { return await storage.persisted?.() || await storage.persist(); } catch { return false; } })();
}

/** Keeps Chromium in-memory OPFS record directories touched while visible and non-persistent. */
export function keepStorageInUse({ intervalMs = 240_000, storagePersisted = requestPersistentStorage(), now = () => Date.now(), onTick } = {}) {
  const storage = globalThis.navigator?.storage, doc = globalThis.document;
  if (!intervalMs || typeof storage?.getDirectory !== 'function' || !doc) return () => {};
  let stopped = false, timer;
  const touch = async () => {
    if (stopped) return;
    const started = now(); let directories = 0;
    const root = await storage.getDirectory();
    for await (const [name, handle] of root.entries()) {
      if (handle.kind !== 'directory' || !name.startsWith('chronolog-')) continue;
      await root.getDirectoryHandle(name); directories++;
    }
    onTick?.({ ms: now() - started, directories });
  };
  const tick = () => { void touch().catch(() => {}); };
  const schedule = () => { clearInterval(timer); timer = undefined; if (!stopped && doc.visibilityState === 'visible') timer = setInterval(tick, intervalMs); };
  const visibility = () => { tick(); schedule(); };
  const pagehide = () => { tick(); clearInterval(timer); timer = undefined; };
  void Promise.resolve(storagePersisted).then(persisted => {
    if (persisted === true || stopped) return;
    doc.addEventListener('visibilitychange', visibility); doc.addEventListener('freeze', pagehide); doc.addEventListener('resume', visibility);
    globalThis.addEventListener?.('pagehide', pagehide); globalThis.addEventListener?.('pageshow', visibility);
    if (doc.visibilityState === 'visible') tick();
    schedule();
  }).catch(() => {});
  return () => {
    stopped = true; clearInterval(timer);
    doc.removeEventListener('visibilitychange', visibility); doc.removeEventListener('freeze', pagehide); doc.removeEventListener('resume', visibility);
    globalThis.removeEventListener?.('pagehide', pagehide); globalThis.removeEventListener?.('pageshow', visibility);
  };
}

/**
 * Single-active-tab browser session owner:
 * - Acquires one exclusive Web Lock per `profileId` (with optional `takeover` handoff).
 * - Spawns one private 1:1 dedicated Worker for device storage, signing, and SQL/OPFS.
 * - Hosts all WebRTC PeerConnections directly in this active tab so MediaStreamTracks
 *   and custom `app:*` DataChannels work in-tab with zero Worker hop (`attachment.rtc`).
 */
export async function openBrowserOwner(options) {
  const url = validate(options);
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new SessionError('OWNER_CONFIGURATION_INVALID', 'Opening timeout must be finite and positive');

  const lock = await acquireTabLock(options.profileId, {
    takeover: options.takeover ?? 'auto',
    signal: options.signal,
    timeoutMs,
  });
  if (!lock) {
    throw Object.assign(
      new SessionError('TAB_ACTIVE_ELSEWHERE', 'This page is already open in another tab.'),
      {
        nextAction: 'Switch to the existing tab or click Switch here to move the session to this tab.',
        takeover: () => openBrowserOwner({ ...options, takeover: true }),
      },
    );
  }

  const tabId = crypto.randomUUID();
  const lifetime = new AbortController();
  let worker, rtcHost, appEndpoint, session, handoffChannel, detached = false, releasing;
  const storagePersisted = options.persistStorage === false ? Promise.resolve(null) : requestPersistentStorage();
  const stopKeepAlive = keepStorageInUse({ intervalMs: options.storageKeepAliveMs ?? 240_000, storagePersisted });

  const release = (reason) => {
    if (releasing) return releasing;
    detached = true;
    stopKeepAlive();
    handoffChannel?.close();
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
      try { appEndpoint?.close(); } catch { /* Best-effort port cleanup. */ }
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
      lock.release();
    })();
    return releasing;
  };

  const onPageHide = event => {
    if (event.persisted) return;
    // Even if app code called detach() earlier in pagehide, close RTC links
    // synchronously right now rather than waiting for an async Worker RPC.
    try { rtcHost?.closeNow(); } catch { /* Best-effort synchronous RTC close. */ }
    void release(new Error('PAGE_UNLOAD'));
  };
  const onExternalAbort = () => { void release(options.signal.reason); };

  try {
    options.signal?.addEventListener('abort', onExternalAbort, { once: true });
    if (options.signal?.aborted) onExternalAbort();

    // Register the handoff listener immediately after acquiring the lock so a takeover
    // arriving while this tab is still booting its Worker is honored cleanly.
    if (typeof globalThis.BroadcastChannel === 'function') {
      handoffChannel = new BroadcastChannel(tabChannelName(options.profileId));
      handoffChannel.addEventListener('message', ({ data }) => {
        if (detached || data?.protocol !== TAB_OWNER_PROTOCOL || data.type !== 'takeover' || data.profileId !== options.profileId) return;
        const hadSession = Boolean(session);
        void Promise.resolve(session?.detach()).catch(() => {}).finally(() => release(new Error('TAB_TAKEN_OVER'))).finally(() => {
          if (hadSession) {
            try { options.onOwnerReplaced?.({ previous: tabId, reason: 'tab_takeover' }); } catch { /* Isolate callback errors. */ }
          }
        });
      });
    }

    worker = new Worker(url, { type: 'module', name: `tendriller-tab-${tabId}` });
    rtcHost = startTabRtcHost(worker, {
      signal: lifetime.signal,
      createPeerConnection: options.createPeerConnection,
    });
    appEndpoint = createAppEndpoint(worker, lifetime.signal);

    const bootId = crypto.randomUUID();
    const ready = waitForWorker(worker, data => data.type === 'ready' && data.id === bootId, { signal: lifetime.signal, timeoutMs });
    worker.postMessage({ protocol: TAB_OWNER_PROTOCOL, type: 'boot', id: bootId, profileId: options.profileId });
    await ready;

    session = await connectFacade(appEndpoint, { applicationId: options.applicationId, context: options.context ?? {} }, { signal: lifetime.signal, timeoutMs });
    lifetime.signal.throwIfAborted();

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
    worker.postMessage({ protocol: TAB_OWNER_PROTOCOL, type: 'identity', profileId: options.profileId, id });
    const publicKey = (await ready).publicKey;
    if (options.persistStorage !== false) void requestPersistentStorage();
    return publicKey;
  } finally {
    worker.terminate();
  }
}
