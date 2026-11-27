import { createApplicationOwner } from '@chronolog/peer-session/worker';
import { createWorkerRtcOpener } from './browser-rtc.mjs';

const TAB_OWNER_PROTOCOL = 'tendriller/tab-owner/v3';
const syncChannelName = profileId => `tendriller:sync:${profileId}`;

/**
 * Serves one dedicated Worker owned by a browser tab over lock-free multi-tab IndexedDB.
 * - Accepts a direct transferred MessagePort on `boot` for zero-wrapper app RPC.
 * - Broadcasts local fact commits on `BroadcastChannel('tendriller:sync:' + profileId)` and
 *   calls `session.syncFromStore()` when sibling tabs write or when the tab wakes up.
 * - Forwards stealable networking leader changes (`network-role`) to `owned.setNetworkActive`.
 */
export function serveBrowserOwner(options) {
  const scope = options.scope ?? globalThis;
  const lifetime = new AbortController();
  const workerId = crypto.randomUUID();
  let profileId, openSession, createIdentity, ownerOptions = {};
  let owner, owned, opening, appPort, syncChannel, stopFacts = () => {}, closing, closed = false;
  let syncingFromStore = false;
  let latestNetworkActive = null;

  const post = value => { try { scope.postMessage(value); } catch { /* Tab closed. */ } };

  const wakeSession = () => {
    if (closed || !owned?.session) return;
    if (typeof owned.session.syncFromStore === 'function') {
      syncingFromStore = true;
      void owned.session.syncFromStore().catch(() => {}).finally(() => { syncingFromStore = false; });
    }
    try { void owned.session.participation?.reconsiderConnections?.(); } catch {}
    try { void owned.onWake?.(); } catch {}
  };

  const rtc = createWorkerRtcOpener(scope, {
    signal: lifetime.signal,
    onNetworkChange: wakeSession,
  });

  let configPromise;
  const resolveConfig = (configuration) => {
    if (configPromise) return configPromise;
    configPromise = Promise.resolve()
      .then(() => (typeof options.load === 'function' ? options.load({ signal: lifetime.signal, configuration }) : options))
      .then(value => {
        ({ profileId, openSession, createIdentity, ownerOptions = {} } = value);
        if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(profileId) || typeof openSession !== 'function') {
          throw Error('OWNER_CONFIGURATION_INVALID');
        }
      });
    void configPromise.catch(() => {});
    return configPromise;
  };
  // If options is static (not a lazy `load` function), configure eagerly.
  if (typeof options.load !== 'function') void resolveConfig(undefined);

  async function ensureOpen(configuration, transferredPort) {
    if (opening) return opening;
    opening = (async () => {
      await resolveConfig(configuration);
      lifetime.signal.throwIfAborted();
      try {
        owned = await openSession({
          signal: lifetime.signal,
          openDirectConnection: rtc.openDirectConnection,
          initialNetworkActive: latestNetworkActive !== false,
        });
        lifetime.signal.throwIfAborted();
        if (!owned?.session) throw Error('OWNER_SESSION_REQUIRED');
        owner = createApplicationOwner(owned.session, owned.extensions ? { ...ownerOptions, extensions: owned.extensions } : ownerOptions);
        if (transferredPort) {
          appPort = transferredPort;
          appPort.start?.();
          owner.attach(appPort);
        }
        if (typeof globalThis.BroadcastChannel === 'function' && profileId) {
          syncChannel = new BroadcastChannel(syncChannelName(profileId));
          syncChannel.addEventListener('message', ({ data }) => {
            if (closed || !data || data.sender === workerId || data.type !== 'facts-updated') return;
            if (typeof owned?.session?.syncFromStore === 'function') {
              syncingFromStore = true;
              void owned.session.syncFromStore().catch(() => {}).finally(() => { syncingFromStore = false; });
            }
          });
          if (typeof owned.session.onFacts === 'function') {
            stopFacts = owned.session.onFacts(() => {
              if (closed || syncingFromStore) return;
              try { syncChannel?.postMessage({ type: 'facts-updated', sender: workerId }); } catch {}
            });
          }
        }
        if (latestNetworkActive !== null) {
          try { owned.setNetworkActive?.(latestNetworkActive); } catch {}
        }
        owned.session.signal.addEventListener('abort', () => { void close().catch(() => {}); }, { once: true });
        if (owned.session.signal.aborted) void close().catch(() => {});
        return owner;
      } catch (error) {
        try { await owned?.session?.close(); } finally { await owned?.close?.(); }
        throw error;
      }
    })().catch(error => { opening = undefined; owned = undefined; owner = undefined; throw error; });
    return opening;
  }

  async function handleControl(data, ports) {
    if (data.type === 'identity') {
      try {
        await resolveConfig(data.configuration);
        if (data.profileId !== profileId) throw Error('INVALID_PROFILE');
        if (typeof createIdentity !== 'function') throw Error('OWNER_IDENTITY_UNAVAILABLE');
        const publicKey = await createIdentity({ signal: lifetime.signal });
        post({ protocol: TAB_OWNER_PROTOCOL, type: 'identity', id: data.id, publicKey });
      } catch (error) {
        post({ protocol: TAB_OWNER_PROTOCOL, type: 'failure', id: data.id, code: error?.code ?? error?.message ?? 'OWNER_UNREACHABLE', message: error?.message ?? String(error) });
      }
      return;
    }
    if (data.type === 'boot') {
      try {
        await resolveConfig(data.configuration);
        if (data.profileId !== profileId) throw Error('INVALID_PROFILE');
        const port = ports?.[0] ?? null;
        const activeOwner = await ensureOpen(data.configuration, port);
        post({ protocol: TAB_OWNER_PROTOCOL, type: 'ready', id: data.id, profileId, ownerInstanceId: activeOwner.ownerInstanceId });
      } catch (error) {
        post({ protocol: TAB_OWNER_PROTOCOL, type: 'failure', id: data.id, code: error?.code ?? error?.message ?? 'OWNER_UNREACHABLE', message: error?.message ?? String(error) });
      }
      return;
    }
    if (data.type === 'network-role') {
      latestNetworkActive = Boolean(data.active);
      try { owned?.setNetworkActive?.(latestNetworkActive); } catch {}
      return;
    }
    if (data.type === 'retire') {
      try { await close(); }
      finally { post({ protocol: TAB_OWNER_PROTOCOL, type: 'retired', id: data.id, profileId }); }
    }
  }

  const onMessage = (event) => {
    const data = event?.data;
    if (closed || data?.protocol !== TAB_OWNER_PROTOCOL) return;
    void handleControl(data, event.ports);
  };
  scope.addEventListener('message', onMessage);

  function close() {
    if (closing) return closing;
    closed = true;
    lifetime.abort(new Error('OWNER_CLOSED'));
    scope.removeEventListener('message', onMessage);
    closing = (async () => {
      try { stopFacts(); } catch {}
      try { syncChannel?.close(); } catch {}
      try { appPort?.close?.(); } catch {}
      try { rtc.close(); } catch {}
      try { await owner?.close(); } catch {}
      try { await owned?.close?.(); } catch {}
      try { await owned?.session?.close?.(); } catch {}
      owner = undefined; owned = undefined; syncChannel = undefined; appPort = undefined;
    })();
    return closing;
  }

  return Object.freeze({
    get owner() { return owner; },
    close,
  });
}
