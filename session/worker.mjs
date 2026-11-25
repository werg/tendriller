import { acquireApplicationOwnerLock, createApplicationOwner } from '@chronolog/peer-session/worker';
import { createWorkerRtcOpener } from './browser-rtc.mjs';

const TAB_OWNER_PROTOCOL = 'tendriller/tab-owner/v2';

/**
 * Serves one private 1:1 dedicated Worker owned by the active browser tab.
 * Registers listeners synchronously before `load()` awaits network/storage.
 */
export function serveBrowserOwner(options) {
  const scope = options.scope ?? globalThis;
  const lifetime = new AbortController();
  let profileId, openSession, createIdentity, ownerOptions = {};
  let owner, owned, lease, opening, appEndpoint, closing, closed = false;

  const post = value => { try { scope.postMessage(value); } catch { /* Tab closed. */ } };

  const rtc = createWorkerRtcOpener(scope, {
    signal: lifetime.signal,
    onNetworkChange: () => owned?.session?.participation?.reconsiderConnections(),
  });

  const configured = Promise.resolve()
    .then(() => (typeof options.load === 'function' ? options.load({ signal: lifetime.signal }) : options))
    .then(value => {
      ({ profileId, openSession, createIdentity, ownerOptions = {} } = value);
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(profileId) || typeof openSession !== 'function') {
        throw Error('OWNER_CONFIGURATION_INVALID');
      }
    });
  void configured.catch(() => {});

  function createWorkerAppEndpoint() {
    const endpoint = new EventTarget();
    let endpointClosed = false;
    const onMessage = ({ data }) => {
      if (endpointClosed || data?.protocol !== TAB_OWNER_PROTOCOL || data.type !== 'app') return;
      endpoint.dispatchEvent(new MessageEvent('message', { data: data.payload }));
    };
    endpoint.postMessage = (payload, transfer) => {
      if (endpointClosed) return;
      if (transfer?.length) scope.postMessage({ protocol: TAB_OWNER_PROTOCOL, type: 'app', payload }, transfer);
      else scope.postMessage({ protocol: TAB_OWNER_PROTOCOL, type: 'app', payload });
    };
    endpoint.close = () => {
      if (endpointClosed) return;
      endpointClosed = true;
      scope.removeEventListener('message', onMessage);
    };
    scope.addEventListener('message', onMessage);
    return endpoint;
  }

  async function ensureOpen() {
    if (opening) return opening;
    opening = (async () => {
      await configured;
      lifetime.signal.throwIfAborted();
      lease = await acquireApplicationOwnerLock(profileId, { wait: true, signal: lifetime.signal });
      try {
        lifetime.signal.throwIfAborted();
        owned = await openSession({ signal: lifetime.signal, openDirectConnection: rtc.openDirectConnection });
        lifetime.signal.throwIfAborted();
        if (!owned?.session) throw Error('OWNER_SESSION_REQUIRED');
        owner = createApplicationOwner(owned.session, ownerOptions);
        appEndpoint = createWorkerAppEndpoint();
        owner.attach(appEndpoint);
        owned.session.signal.addEventListener('abort', () => { void close().catch(() => {}); }, { once: true });
        if (owned.session.signal.aborted) void close().catch(() => {});
        return owner;
      } catch (error) {
        try { try { await owned?.session?.close(); } finally { await owned?.close?.(); } }
        finally { await lease?.close(); lease = undefined; }
        throw error;
      }
    })().catch(error => { opening = undefined; owned = undefined; owner = undefined; throw error; });
    return opening;
  }

  async function handleControl(data) {
    if (data.type === 'identity') {
      try {
        await configured;
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
        await configured;
        if (data.profileId !== profileId) throw Error('INVALID_PROFILE');
        const activeOwner = await ensureOpen();
        post({ protocol: TAB_OWNER_PROTOCOL, type: 'ready', id: data.id, profileId, ownerInstanceId: activeOwner.ownerInstanceId });
      } catch (error) {
        post({ protocol: TAB_OWNER_PROTOCOL, type: 'failure', id: data.id, code: error?.code ?? error?.message ?? 'OWNER_UNREACHABLE', message: error?.message ?? String(error) });
      }
      return;
    }
    if (data.type === 'retire') {
      try { await close(); }
      finally { post({ protocol: TAB_OWNER_PROTOCOL, type: 'retired', id: data.id, profileId }); }
    }
  }

  const onMessage = ({ data }) => {
    if (closed || data?.protocol !== TAB_OWNER_PROTOCOL) return;
    if (data.type === 'app') return;
    void handleControl(data);
  };
  scope.addEventListener('message', onMessage);

  function close() {
    if (closing) return closing;
    closed = true;
    lifetime.abort(new Error('OWNER_CLOSED'));
    scope.removeEventListener('message', onMessage);
    closing = (async () => {
      try { appEndpoint?.close(); } catch {}
      try { rtc.close(); } catch {}
      try { await owner?.close(); } catch {}
      try { await owned?.close?.(); } catch {}
      try { await owned?.session?.close?.(); } catch {}
      try { await lease?.close(); } catch {}
      lease = undefined; owner = undefined; owned = undefined;
    })();
    return closing;
  }

  return Object.freeze({
    get owner() { return owner; },
    close,
  });
}
