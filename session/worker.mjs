import { createBrowserRtcBroker, rtcEndpoint, checkRtcMessage, BROWSER_RTC_PROTOCOL } from './browser-rtc.mjs';
import { acquireApplicationOwnerLock, createApplicationOwner } from '@chronolog/peer-session/worker';
import { BROWSER_OWNER_PROTOCOL, ownerChannelName, createBroadcastOwner, checkOwnerFrame } from './browser-transport.mjs';
import { createDocumentLifetimeObserver } from './root-lifetime.mjs';

const defaults = { maxPorts: 64, pendingTimeoutMs: 30000, idleTimeoutMs: 60000, parkedSweepMs: 60000, retireGraceMs: 5000 };
// rootLimits.retireGraceMs: a retired elected owner with no routes stays this long,
// so the same page can reattach (an app-level reconnect) without restarting the
// session and its peer connections. A new route cancels the retirement wait.
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(value);
function rootLimits(value = {}) {
  const limits = { ...defaults, ...value };
  if (Object.keys(value).some(key => !Object.hasOwn(defaults, key)) ||
      !Number.isSafeInteger(limits.maxPorts) || limits.maxPorts < 1 || limits.maxPorts > 128 ||
      [limits.pendingTimeoutMs, limits.idleTimeoutMs, limits.parkedSweepMs].some(ms => !Number.isFinite(ms) || ms < 100 || ms > 120000) ||
      !Number.isFinite(limits.retireGraceMs) || limits.retireGraceMs < 0 || limits.retireGraceMs > 60000) throw Error('OWNER_CONFIGURATION_INVALID');
  return limits;
}

/** One public owner composition for SharedWorker and the Web-Lock-elected fallback. */
export function serveBrowserOwner(options) {
  const scope = options.scope ?? globalThis, lifetime = new AbortController(), roots = new Map(), identities = new Set();
  const rtc = createBrowserRtcBroker({signal:lifetime.signal,onNetworkChange:() => owned?.session?.participation?.reconsiderConnections()});
  const addRtcRoute = endpoint => rtc.addRoute(endpoint,{authorize:()=>!closed});
  let profileId, openSession, createIdentity, ownerOptions, limits = defaults;
  let lifetimes, pendingAdmission;
  let owner, owned, lease, opening, channel, election, broadcast, broadcastStarting, closed = false, retiring = false, retireTimer, closing, scopeRoot, sessionAborted;
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
    record.endpoint.removeEventListener('close', record.portClosed);
    record.rtc?.dispatchEvent(new Event('close')); record.detach?.(); roots.delete(record.endpoint);
    if (record.shared) record.endpoint.close?.();
    record.lifetime?.close();
  }
  function renew(record) {
    clearTimeout(record.timer);
    if (!record.shared || record.disposed) return;
    record.lifetime?.setParked(record.parked);
    if (record.parked) return;
    const timeout = record.ready ? limits.idleTimeoutMs : limits.pendingTimeoutMs;
    record.timer = setTimeout(() => dispose(record, record.ready ? 'ENDPOINT_STALE' : 'OWNER_HANDSHAKE_TIMEOUT'), timeout);
    record.timer.unref?.();
  }

  function waitForAdmission(endpoint) {
    if (pendingAdmission) { post(endpoint, { protocol: BROWSER_OWNER_PROTOCOL, type: 'failure', code: 'OWNER_BUSY' }); endpoint.close?.(); return; }
    const admission = { endpoint };
    const finish = code => {
      if (pendingAdmission !== admission) return false;
      pendingAdmission = undefined; clearTimeout(admission.timer);
      endpoint.removeEventListener('close', admission.portClosed);
      if (code) { post(endpoint, { protocol: BROWSER_OWNER_PROTOCOL, type: 'failure', code }); endpoint.close?.(); }
      return true;
    };
    admission.cancel = () => finish('OWNER_UNREACHABLE');
    admission.portClosed = () => { finish(); };
    pendingAdmission = admission;
    endpoint.addEventListener('close', admission.portClosed);
    admission.timer = setTimeout(() => finish('OWNER_BUSY'), limits.pendingTimeoutMs);
    admission.timer.unref?.();
    // Do not start/consume this port yet: the browser queues boot/RTC frames
    // until the bounded admission installs the normal root listeners.
    void (async () => {
      await configured;
      if (closed || pendingAdmission !== admission) return;
      await lifetimes.reapFresh();
      if (closed || pendingAdmission !== admission) return;
      if (roots.size >= limits.maxPorts) { finish('OWNER_BUSY'); return; }
      if (finish()) attachBootstrap(endpoint, true, true);
    })().catch(() => { finish(closed ? 'OWNER_UNREACHABLE' : 'OWNER_BUSY'); });
  }

  // Register root listeners synchronously; first Worker events can arrive while
  // configuration awaits network or storage. Pending roots are bounded too.
  const configured = Promise.resolve().then(() => typeof options.load === 'function' ? options.load({ signal: lifetime.signal }) : options).then(value => {
    ({ profileId, openSession, createIdentity, ownerOptions = {} } = value);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(profileId) || typeof openSession !== 'function') throw Error('OWNER_CONFIGURATION_INVALID');
    limits = rootLimits(value.rootLimits);
    lifetimes = createDocumentLifetimeObserver({ profileId, signal: lifetime.signal,
      sweepMs: limits.parkedSweepMs, timeoutMs: limits.pendingTimeoutMs });
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
        owned = await openSession({ signal: lifetime.signal, openDirectConnection: rtc.openDirectConnection }); lifetime.signal.throwIfAborted();
        if (!owned?.session) throw Error('OWNER_SESSION_REQUIRED');
        owner = createApplicationOwner(owned.session, ownerOptions);
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
  function retireSoon() {
    if (retireTimer || closed) return;
    retireTimer = setTimeout(() => { retireTimer = undefined; if (!broadcast || broadcast.routes === 0) void close().catch(() => {}); }, limits.retireGraceMs);
  }
  function startElection() {
    if (election) return election;
    channel = new BroadcastChannel(ownerChannelName(profileId));
    election = open(true).then(async () => {
      broadcast = await createBroadcastOwner(channel, owner, { profileId, lifetimes, maxRoutes: ownerOptions.maxAttachments ?? 32, onRtcEndpoint:addRtcRoute,
        onRoutesChanged: count => { if (count > 0) { clearTimeout(retireTimer); retireTimer = undefined; } else if (retiring) retireSoon(); } });
      if (closed) { await broadcast.close(); return; }
      if (retiring && broadcast.routes === 0) { retireSoon(); return; }
      broadcast.announce();
    });
    return election;
  }
  // Every owner, shared or elected, also answers BroadcastChannel discovery, so a
  // page whose own Worker cannot take the profile (another publication's Worker,
  // or a fallback owner) attaches to the owner that holds it instead of failing.
  function serveBroadcast() {
    if (broadcastStarting || closed) return broadcastStarting;
    channel ??= new BroadcastChannel(ownerChannelName(profileId));
    broadcastStarting = createBroadcastOwner(channel, owner, { profileId, lifetimes, maxRoutes: ownerOptions.maxAttachments ?? 32, onRtcEndpoint:addRtcRoute }).then(async value => {
      if (closed) { await value.close(); return; }
      broadcast = value; value.announce();
    });
    void broadcastStarting.catch(() => {});
    return broadcastStarting;
  }
  function result(record, id) {
    post(record.endpoint, { protocol: BROWSER_OWNER_PROTOCOL, type: 'root.result', id,
      profileId, rootId: record.rootId, ownerInstanceId: owner?.ownerInstanceId });
  }
  function attachBootstrap(endpoint, shared = false, scanned = false) {
    if (closed) { post(endpoint, { protocol: BROWSER_OWNER_PROTOCOL, type: 'failure', code: 'OWNER_UNREACHABLE' }); if (shared) endpoint.close?.(); return; }
    if (shared && !scanned && (roots.size >= limits.maxPorts || lifetimes?.hasParked)) { waitForAdmission(endpoint); return; }
    const record = { endpoint, shared, ready: false, suspended: false, parked: false, frozen: false, disposed: false, pending: 0 };
    record.failed = () => dispose(record, 'OWNER_MESSAGE_INVALID');
    record.portClosed = () => dispose(record);
    record.message = ({ data }) => {
      if(closed || record.disposed)return;
      if(data?.protocol === BROWSER_RTC_PROTOCOL){
        if(!record.rtc || record.suspended || data.profileId!==record.profileId || data.rootId!==record.rootId)return;
        try{checkRtcMessage(data.payload);record.rtc?.dispatchEvent(new MessageEvent('message',{data:data.payload}));}catch{record.rtc?.dispatchEvent(new Event('close'));}
        return;
      }
      if (data?.protocol !== BROWSER_OWNER_PROTOCOL) return;
      try {
        checkOwnerFrame(data);
        if (Object.keys(data).some(key => !['protocol', 'type', 'id', 'profileId', 'mode', 'rootId', 'ownerInstanceId', ...(data.type==='root.park'?['frozen']:[])].includes(key))) throw Error('OWNER_HANDSHAKE_INVALID');
        if (!validId(data.id) || typeof data.type !== 'string') throw Error('OWNER_HANDSHAKE_INVALID');
        if (record.pending >= 8) throw Error('OWNER_BUSY');
        if (data.type === 'boot') {
          if (record.rootId && record.rootId !== data.id) throw Error('OWNER_HANDSHAKE_INVALID');
          record.rootId = data.id;record.profileId=data.profileId;
          if(!record.rtc){record.rtc=rtcEndpoint(payload=>post(record.endpoint,{protocol:BROWSER_RTC_PROTOCOL,profileId:record.profileId,rootId:record.rootId,payload}));rtc.addRoute(record.rtc,{authorize:()=>!closed&&!record.disposed&&!record.suspended&&(profileId===undefined||record.profileId===profileId),available:()=>!record.frozen});}
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
          if (data.type === 'root.park') {if(typeof data.frozen!=='boolean')throw Error('OWNER_HANDSHAKE_INVALID');record.parked = true;record.frozen=data.frozen;rtc.availabilityChanged();}
          else if (data.type === 'root.suspend') record.suspended = record.parked = true;
          else if (data.type === 'root.resume') {record.suspended = record.parked = record.frozen = false;rtc.availabilityChanged();}
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
          if (!owner) void close().catch(() => {});
          else if (broadcast?.routes === 0) retireSoon();
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
        const witness = await lifetimes.prove(record.rootId);
        if (record.disposed || closed) return;
        if (!witness) throw Error('OWNER_ROOT_LIFETIME_MISSING');
        record.witness = witness;
        await open(false); lifetime.signal.throwIfAborted(); if (record.disposed) return;
        if (typeof BroadcastChannel === 'function') void serveBroadcast();
        if (!record.detach) {
          // The RPC attachment must not own the physical bootstrap port. Its
          // close reclaims this root through the same lifetime/listener cleanup.
          const rpc = Object.assign(new EventTarget(), { postMessage: frame => post(endpoint, frame), close: () => dispose(record) });
          const forward = ({ data }) => { if (data?.protocol === 'chronolog/authored-session/owner/v1') rpc.dispatchEvent(new MessageEvent('message', { data })); };
          endpoint.addEventListener('message', forward);
          let detach;
          try { detach = owner.attach(rpc); } catch (error) { endpoint.removeEventListener('message', forward); throw error; }
          record.detach = () => { endpoint.removeEventListener('message', forward); detach(); };
        }
        record.lifetime?.close();
        record.lifetime = lifetimes.register(record.rootId, witness, () => dispose(record, 'ENDPOINT_STALE'));
        record.ready = true; renew(record);
        post(endpoint, { protocol: BROWSER_OWNER_PROTOCOL, type: 'ready', id: data.id, ownerInstanceId: owner.ownerInstanceId });
      })().catch(error => { if (!record.disposed) { failure(record, data.id, error); if (data.type === 'boot' && !record.ready) dispose(record); } }).finally(() => { record.pending--; });
    };
    endpoint.addEventListener('message', record.message); endpoint.addEventListener('messageerror', record.failed); endpoint.addEventListener('close', record.portClosed); endpoint.start?.();
    if (shared) { roots.set(endpoint, record); renew(record); } else scopeRoot = record;
  }
  const connect = event => { for (const port of event.ports) attachBootstrap(port, true); };
  scope.addEventListener('connect', connect); attachBootstrap(scope);

  function close() {
    if (closing) return closing;
    closed = true; rtc.close(); clearTimeout(retireTimer); lifetimes?.close(); pendingAdmission?.cancel(); lifetime.abort(Error('OWNER_UNREACHABLE')); scope.removeEventListener('connect', connect);
    for (const record of [...roots.values()]) dispose(record, 'OWNER_UNREACHABLE');
    if (scopeRoot) dispose(scopeRoot);
    closing = (async () => {
      try {
        await Promise.allSettled([opening, broadcastStarting, ...identities]);
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
