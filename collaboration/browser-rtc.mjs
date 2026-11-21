import { openWorkerWebRtcConnection, serveWorkerWebRtcConnections } from '@chronolog/peer-session/webrtc';

export const BROWSER_RTC_PROTOCOL = 'tendriller/browser-rtc-provider/v1';
// The payload is Chronolog's opaque bridge envelope, never an application RPC.
// Allow a full encrypted reliable packet plus its finite signaling envelope.
export const MAX_RTC_MESSAGE_BYTES = 2 * 1024 * 1024 + 65536;
export function checkRtcMessage(value) {
  let bytes = 0, nodes = 0; const seen = new Set();
  function visit(item, depth) {
    if (++nodes > 65536 || depth > 32) throw Error('RTC_MESSAGE_LIMIT');
    if (typeof item === 'string') bytes += new TextEncoder().encode(item).length;
    else if (item instanceof Uint8Array || item instanceof ArrayBuffer) bytes += item.byteLength;
    else if(typeof item === 'bigint')bytes += item.toString().length;
    else if (item === null || item === undefined || ['boolean','number'].includes(typeof item)) bytes += 16;
    else if (typeof item === 'object') {
      if (seen.has(item) || (!Array.isArray(item) && ![Object.prototype,null].includes(Object.getPrototypeOf(item)))) throw Error('RTC_MESSAGE_INVALID');
      if (Array.isArray(item)) {
        if (item.length > 65536 - nodes) throw Error('RTC_MESSAGE_LIMIT');
        nodes += item.length - Object.keys(item).filter(key => /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < item.length).length;
      }
      seen.add(item); for (const [key,child] of Object.entries(item)) { bytes += key.length * 3; visit(child, depth + 1); } seen.delete(item);
    } else throw Error('RTC_MESSAGE_INVALID');
    if (bytes > MAX_RTC_MESSAGE_BYTES) throw Error('RTC_MESSAGE_LIMIT');
  }
  visit(value, 0);
}
export function rtcEndpoint(send) {
  const endpoint = new EventTarget();
  endpoint.postMessage = message => { checkRtcMessage(message); return send(message); };
  return endpoint;
}
const error = code => Object.assign(Error(code), { code });
const bindingFields = ['ownerInstanceId','endpointId','endpointIncarnation'];

/** Routing only. Chronolog keeps negotiation, framing, session crypto and recovery. */
export function createBrowserRtcBroker({ signal, openConnection = openWorkerWebRtcConnection, maxPending = 8 } = {}) {
  if(typeof openConnection!=='function'||!Number.isSafeInteger(maxPending)||maxPending<1||maxPending>32)throw error('RTC_CONFIGURATION_INVALID');
  const ownLifetime = new AbortController(), routes = new Set(), waiting = new Set(); let closed = false, pending = 0;
  const wake = () => { for (const resume of [...waiting]) resume(); };
  function removeProvider(route) {
    route.provider?.abort(error('RTC_PROVIDER_LOST')); route.provider = undefined;
    for (const attempt of route.attempts) attempt.abort(error('RTC_PROVIDER_LOST'));
    route.attempts.clear(); wake();
  }
  function addRoute(endpoint, { authorize } = {}) {
    if (closed || typeof authorize !== 'function') throw error('RTC_BROKER_CLOSED');
    const route = { endpoint, authorize, attempts: new Set(), provider: undefined };
    const receive = ({ data }) => {
      if (data?.protocol !== BROWSER_RTC_PROTOCOL) return;
      if (data.type === 'unregister') { removeProvider(route); return; }
      if (data.type !== 'register' || !authorize(data.binding)) return;
      if (!route.provider) route.provider = new AbortController();
      route.binding = data.binding; wake();
    };
    const close = () => { removeProvider(route); routes.delete(route); endpoint.removeEventListener('message', receive); endpoint.removeEventListener('close', close); };
    endpoint.addEventListener('message', receive); endpoint.addEventListener('close', close); routes.add(route);
    return close;
  }
  function selected(attempt) {
    for (const route of routes) {
      if (!route.provider || route.attempts.size >= 8) continue;
      if (!route.authorize(route.binding)) { removeProvider(route); continue; }
      route.attempts.add(attempt); return route;
    }
  }
  async function openDirectConnection(options) {
    if (closed || pending >= maxPending) throw error(closed ? 'RTC_BROKER_CLOSED' : 'RTC_PROVIDER_BUSY');
    const timeoutMs = options.timeoutMs ?? 5000;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw error('RTC_TIMEOUT_INVALID');
    options.signal?.throwIfAborted(); const attempt = new AbortController(), deadline = Date.now() + timeoutMs;
    const timer = setTimeout(() => attempt.abort(error('RTC_PROVIDER_TIMEOUT')), timeoutMs);
    const lifetime = AbortSignal.any([attempt.signal,ownLifetime.signal,...[signal,options.signal].filter(Boolean)]); let route, retained = false, opening, candidate, retired = false, charged = true;
    const releasePending = () => { if (charged) { charged = false; pending--; } };
    const retireCandidate = () => {
      if (!candidate || retired) return;
      retired = true;
      void Promise.resolve().then(() => candidate.close()).catch(() => {});
    };
    pending++;
    try {
      route = await new Promise((resolve,reject) => {
        const abort = () => { waiting.delete(ready); reject(lifetime.reason); };
        const ready = () => { if (lifetime.aborted) { abort(); return; } const value = selected(attempt); if (value) { waiting.delete(ready); lifetime.removeEventListener('abort',abort); resolve(value); } };
        waiting.add(ready); lifetime.addEventListener('abort',abort,{once:true}); ready();
      });
      lifetime.throwIfAborted();
      opening = Promise.resolve().then(() => {
        lifetime.throwIfAborted();
        return openConnection(route.endpoint, { ...options,
          timeoutMs: Math.max(1,deadline - Date.now()), signal: AbortSignal.any([lifetime,route.provider.signal]) });
      }).then(value => {
        candidate = value;
        if (lifetime.aborted) {
          retireCandidate();
          throw lifetime.reason;
        }
        return candidate;
      }).finally(releasePending);
      const connection = await new Promise((resolve, reject) => {
        const abort = () => reject(lifetime.reason);
        lifetime.addEventListener('abort', abort, {once:true});
        opening.then(resolve,reject).finally(() => lifetime.removeEventListener('abort',abort));
        if (lifetime.aborted) abort();
      });
      lifetime.throwIfAborted(); clearTimeout(timer); retained = true;
      const released = () => { route.attempts.delete(attempt); wake(); };
      connection.signal?.addEventListener('abort',released,{once:true});
      if (connection.signal?.aborted) released();
      let closing;
      const close = (...args) => closing ??= Promise.resolve().then(() => connection.close(...args)).finally(() => {
        connection.signal?.removeEventListener('abort',released); released(); attempt.abort(error('RTC_CONNECTION_CLOSED'));
      });
      return new Proxy(connection,{ get(target,key) { if (key === 'close') return close; const value = Reflect.get(target,key,target); return typeof value === 'function' ? value.bind(target) : value; } });
    } finally {
      if (!opening) releasePending();
      clearTimeout(timer);
      if (!retained) { retireCandidate(); route?.attempts.delete(attempt); attempt.abort(error('RTC_CONNECTION_CLOSED')); wake(); }
    }
  }
  function close() {
    if (closed) return; closed = true; ownLifetime.abort(error('RTC_BROKER_CLOSED'));
    for (const route of [...routes]) { removeProvider(route); route.endpoint.dispatchEvent(new Event('close')); }
    wake(); signal?.removeEventListener('abort', close);
  }
  signal?.addEventListener('abort', close, { once:true }); if (signal?.aborted) close();
  return { addRoute, openDirectConnection, close };
}

/** The private bootstrap channel or authenticated broadcast attachment scopes this
 * capability-only provider before application RPC becomes ready. */
export function registerBrowserRtcProvider(endpoint, session, { serve = serveWorkerWebRtcConnections, createPeerConnection } = {}) {
  if (!endpoint || (!createPeerConnection && typeof globalThis.RTCPeerConnection !== 'function')) return { close() {}, adopt() {} };
  const lifetime = new AbortController(); let closed = false, ownerSignal = session.signal;
  const bridge = serve(endpoint,{signal:lifetime.signal,...(createPeerConnection ? {createPeerConnection} : {})});
  const ended = () => {try{void Promise.resolve(close()).catch(()=>{});}catch{}};
  const leaving = event => {if(!event.persisted)ended();};
  globalThis.addEventListener?.('pagehide',leaving);
  endpoint.addEventListener('close',ended); ownerSignal.addEventListener('abort',ended,{once:true});
  try{endpoint.postMessage({protocol:BROWSER_RTC_PROTOCOL,type:'register',...(session.endpoint ? {binding:Object.fromEntries(bindingFields.map(key=>[key,session.endpoint[key]]))} : {})});}catch(error){void Promise.resolve(close()).catch(()=>{});throw error;}
  function close() {
    if (closed) return; closed = true;
    try { endpoint.postMessage({protocol:BROWSER_RTC_PROTOCOL,type:'unregister'}); } catch { /* Route already closed. */ }
    lifetime.abort(error('RTC_PROVIDER_LOST'));globalThis.removeEventListener?.('pagehide',leaving);endpoint.removeEventListener('close',ended); ownerSignal.removeEventListener('abort',ended);
    return bridge.close();
  }
  function adopt(session) {
    // Opening cancellation no longer owns this live attachment. Keep the same
    // bridge and its active negotiations while transferring shutdown ownership.
    if (closed) throw error('RTC_PROVIDER_LOST');
    ownerSignal.removeEventListener('abort',ended);
    ownerSignal = session.signal;
    ownerSignal.addEventListener('abort',ended,{once:true});
    if (ownerSignal.aborted) ended();
  }
  if(ownerSignal.aborted)ended();
  return {close,adopt};
}
