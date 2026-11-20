import { acquireApplicationOwnerLock, createApplicationOwner } from '@chronolog/peer-session/worker';
import { BROWSER_OWNER_PROTOCOL, ownerChannelName, createBroadcastOwner, checkOwnerFrame } from './browser-transport.mjs';
import { prepareCollaborationCommand } from './protocol.mjs';

const defaults = { maxPorts: 64, pendingTimeoutMs: 30000, idleTimeoutMs: 60000 };
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(value);
function rootLimits(value = {}) {
  const limits = { ...defaults, ...value };
  if (Object.keys(value).some(key => !Object.hasOwn(defaults, key)) ||
      !Number.isSafeInteger(limits.maxPorts) || limits.maxPorts < 1 || limits.maxPorts > 128 ||
      [limits.pendingTimeoutMs, limits.idleTimeoutMs].some(ms => !Number.isFinite(ms) || ms < 100 || ms > 120000)) throw Error('OWNER_CONFIGURATION_INVALID');
  return limits;
}

/** One public owner composition for SharedWorker and the Web-Lock-elected fallback. */
export function serveBrowserOwner(options) {
  const scope = options.scope ?? globalThis, lifetime = new AbortController(), roots = new Map(), identities = new Set();
  let profileId, openSession, createIdentity, ownerOptions, limits = defaults;
  let owner, owned, lease, opening, channel, election, broadcast, closed = false, retiring = false, closing, scopeRoot, sessionAborted;
  const post = (endpoint, value) => { try { endpoint.postMessage(value); } catch { /* The remote page may have gone away. */ } };
  const failure = (record, id, error) => post(record.endpoint, { protocol: BROWSER_OWNER_PROTOCOL, type: 'failure', id,
    profileId, rootId: record.rootId, ownerInstanceId: owner?.ownerInstanceId,
    code: error.code ?? error.message ?? 'OWNER_UNREACHABLE', message: error.message ?? String(error) });

  function dispose(record, code) {
    if (record.disposed) return;
    record.disposed = true; clearTimeout(record.timer);
    if (code) {
      if (record.ready) post(record.endpoint, { protocol: BROWSER_OWNER_PROTOCOL, type: 'root.ended',
        profileId, rootId: record.rootId, ownerInstanceId: owner?.ownerInstanceId, code });
      else failure(record, record.rootId, Error(code));
    }
    record.endpoint.removeEventListener('message', record.message);
    record.endpoint.removeEventListener('messageerror', record.failed);
    record.detach?.(); roots.delete(record.endpoint);
    if (record.shared) record.endpoint.close?.();
  }
  function renew(record) {
    clearTimeout(record.timer);
    if (!record.shared || record.disposed || record.suspended) return;
    const timeout = record.ready ? limits.idleTimeoutMs : limits.pendingTimeoutMs;
    record.timer = setTimeout(() => dispose(record, record.ready ? 'ENDPOINT_STALE' : 'OWNER_HANDSHAKE_TIMEOUT'), timeout);
    record.timer.unref?.();
  }

  // Register root listeners synchronously; first Worker events can arrive while
  // configuration awaits network or storage. Pending roots are bounded too.
  const configured = Promise.resolve().then(() => typeof options.load === 'function' ? options.load({ signal: lifetime.signal }) : options).then(value => {
    ({ profileId, openSession, createIdentity, ownerOptions = {} } = value);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(profileId) || typeof openSession !== 'function') throw Error('OWNER_CONFIGURATION_INVALID');
    limits = rootLimits(value.rootLimits);
    let count = 0;
    for (const record of roots.values()) { if (++count > limits.maxPorts) dispose(record, 'OWNER_BUSY'); else renew(record); }
  });
  void configured.catch(() => {});

  async function open(wait) {
    if (opening) return opening;
    opening = (async () => {
      lease = await acquireApplicationOwnerLock(profileId, { wait, signal: lifetime.signal });
      try {
        lifetime.signal.throwIfAborted();
        owned = await openSession({ signal: lifetime.signal }); lifetime.signal.throwIfAborted();
        if (!owned?.session) throw Error('OWNER_SESSION_REQUIRED');
        owner = createApplicationOwner(owned.session, { ...ownerOptions, host: owned.control,
          prepareCommand: (endpoint, name, input) => prepareCollaborationCommand(endpoint, name, input, owned.session.deviceId) });
        sessionAborted = () => { void close().catch(() => {}); };
        owned.session.signal.addEventListener('abort', sessionAborted, { once: true });
        if (owned.session.signal.aborted) sessionAborted();
        return owner;
      } catch (error) {
        try { try { await owned?.session?.close(); } finally { await owned?.close?.(); } }
        finally { await lease.close(); lease = undefined; }
        throw error;
      }
    })().catch(error => { opening = undefined; owned = undefined; owner = undefined; throw error; });
    return opening;
  }
  function startElection() {
    if (election) return election;
    channel = new BroadcastChannel(ownerChannelName(profileId));
    election = open(true).then(async () => {
      broadcast = await createBroadcastOwner(channel, owner, { profileId, maxRoutes: ownerOptions.maxAttachments ?? 32,
        onRoutesChanged: count => { if (retiring && count === 0) void close().catch(() => {}); } });
      if (closed) { await broadcast.close(); return; }
      if (retiring && broadcast.routes === 0) { void close().catch(() => {}); return; }
      broadcast.announce();
    });
    return election;
  }
  function result(record, id) {
    post(record.endpoint, { protocol: BROWSER_OWNER_PROTOCOL, type: 'root.result', id,
      profileId, rootId: record.rootId, ownerInstanceId: owner?.ownerInstanceId });
  }
  function attachBootstrap(endpoint, shared = false) {
    if (shared && (closed || roots.size >= limits.maxPorts)) {
      post(endpoint, { protocol: BROWSER_OWNER_PROTOCOL, type: 'failure', code: closed ? 'OWNER_UNREACHABLE' : 'OWNER_BUSY' }); endpoint.close?.(); return;
    }
    const record = { endpoint, shared, ready: false, suspended: false, disposed: false, pending: 0 };
    record.failed = () => dispose(record, 'OWNER_MESSAGE_INVALID');
    record.message = ({ data }) => {
      if (data?.protocol !== BROWSER_OWNER_PROTOCOL || closed || record.disposed) return;
      try {
        checkOwnerFrame(data);
        if (Object.keys(data).some(key => !['protocol', 'type', 'id', 'profileId', 'mode', 'rootId', 'ownerInstanceId'].includes(key))) throw Error('OWNER_HANDSHAKE_INVALID');
        if (!validId(data.id) || typeof data.type !== 'string') throw Error('OWNER_HANDSHAKE_INVALID');
        if (record.pending >= 8) throw Error('OWNER_BUSY');
        if (data.type === 'boot') {
          if (record.rootId && record.rootId !== data.id) throw Error('OWNER_HANDSHAKE_INVALID');
          record.rootId = data.id;
        }
        // Explicit cancellation also releases a pending root while load/openSession
        // is awaiting. It cannot cancel a different root or the shared owner.
        if (data.type === 'root.detach' && data.rootId === record.rootId && !record.ready) {
          result(record, data.id); dispose(record); return;
        }
      } catch (error) { failure(record, data?.id, error); dispose(record); return; }
      record.pending++;
      void (async () => {
        await configured; lifetime.signal.throwIfAborted();
        if (record.disposed) return;
        if (data.profileId !== profileId) throw Error('OWNER_PROFILE_MISMATCH');
        if (data.type.startsWith('root.')) {
          if (!record.shared || !record.ready || data.rootId !== record.rootId || data.ownerInstanceId !== owner?.ownerInstanceId) throw Error('ENDPOINT_STALE');
          if (data.type === 'root.suspend') record.suspended = true;
          else if (data.type === 'root.resume') record.suspended = false;
          else if (data.type !== 'root.ping' && data.type !== 'root.detach') throw Error('OWNER_HANDSHAKE_INVALID');
          renew(record); result(record, data.id);
          if (data.type === 'root.detach') dispose(record);
          return;
        }
        if (data.type === 'retire' && !shared) {
          retiring = true;
          post(endpoint, { protocol: BROWSER_OWNER_PROTOCOL, type: 'retired', id: data.id, profileId });
          // A detached page stops competing for ownership. An existing owner
          // serves authenticated siblings until its last active/pending route ends.
          if (!owner || broadcast?.routes === 0) void close().catch(() => {});
          return;
        }
        if (data.type === 'identity') {
          if (typeof createIdentity !== 'function') throw Error('IDENTITY_CREATION_UNAVAILABLE');
          const identity = (async () => {
            const identityLock = await acquireApplicationOwnerLock(profileId, { signal: lifetime.signal });
            let publicKey;
            try { publicKey = await createIdentity({ signal: lifetime.signal }); }
            finally { await identityLock.close(); }
            // The caller may immediately terminate this Worker and reopen the
            // profile. A successful response proves both resources and fencing released.
            if (!closed && !record.disposed) post(endpoint, { protocol: BROWSER_OWNER_PROTOCOL, type: 'identity', id: data.id, publicKey });
          })();
          identities.add(identity); try { await identity; } finally { identities.delete(identity); }
          return;
        }
        if (data.type !== 'boot') throw Error('OWNER_HANDSHAKE_INVALID');
        if (data.mode === 'elected' && !shared) { void startElection().catch(error => failure(record, data.id, error)); return; }
        if (data.mode !== 'shared' || !shared) throw Error('OWNER_MODE_INVALID');
        await open(false); lifetime.signal.throwIfAborted(); if (record.disposed) return;
        if (!record.detach) record.detach = owner.attach(endpoint);
        record.ready = true; renew(record);
        post(endpoint, { protocol: BROWSER_OWNER_PROTOCOL, type: 'ready', id: data.id, ownerInstanceId: owner.ownerInstanceId });
      })().catch(error => { if (!record.disposed) failure(record, data.id, error); }).finally(() => { record.pending--; });
    };
    endpoint.addEventListener('message', record.message); endpoint.addEventListener('messageerror', record.failed); endpoint.start?.();
    if (shared) { roots.set(endpoint, record); renew(record); } else scopeRoot = record;
  }
  const connect = event => { for (const port of event.ports) attachBootstrap(port, true); };
  scope.addEventListener('connect', connect); attachBootstrap(scope);

  function close() {
    if (closing) return closing;
    closed = true; lifetime.abort(Error('OWNER_UNREACHABLE')); scope.removeEventListener('connect', connect);
    for (const record of [...roots.values()]) dispose(record, 'OWNER_UNREACHABLE');
    if (scopeRoot) dispose(scopeRoot);
    closing = (async () => {
      try {
        await Promise.allSettled([opening, ...identities]);
        owned?.session?.signal.removeEventListener('abort', sessionAborted);
        try { await broadcast?.close(); }
        finally { try { await owner?.close(); } finally { await owned?.close?.(); } }
      } finally {
        await lease?.close(); channel?.close(); scope.close?.();
      }
    })(); return closing;
  }
  return Object.freeze({ get owner() { return owner; }, close });
}
