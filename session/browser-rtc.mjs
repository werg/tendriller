import { openWorkerWebRtcConnection, serveWorkerWebRtcConnections } from '@chronolog/peer-session/webrtc';

export const BROWSER_RTC_PROTOCOL = 'tendriller/browser-rtc-provider/v2';
export const MAX_RTC_MESSAGE_BYTES = 2 * 1024 * 1024 + 65536;

export function checkRtcMessage(value) {
  let bytes = 0, nodes = 0; const seen = new Set();
  function visit(item, depth) {
    if (++nodes > 65536 || depth > 32) throw Error('RTC_MESSAGE_LIMIT');
    if (typeof item === 'string') bytes += new TextEncoder().encode(item).length;
    else if (item instanceof Uint8Array || item instanceof ArrayBuffer) bytes += item.byteLength;
    else if (typeof item === 'bigint') bytes += item.toString().length;
    else if (item === null || item === undefined || ['boolean', 'number'].includes(typeof item)) bytes += 16;
    else if (typeof item === 'object') {
      if (seen.has(item) || (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item)))) throw Error('RTC_MESSAGE_INVALID');
      seen.add(item);
      for (const [key, child] of Object.entries(item)) { bytes += key.length * 3; visit(child, depth + 1); }
      seen.delete(item);
    } else throw Error('RTC_MESSAGE_INVALID');
    if (bytes > MAX_RTC_MESSAGE_BYTES) throw Error('RTC_MESSAGE_LIMIT');
  }
  visit(value, 0);
}

/**
 * Demultiplexes a single 1:1 Worker <-> active-tab channel into an isolated RTC endpoint.
 * All WebRTC PeerConnections, MediaStreamTracks and `app:*` DataChannels live directly
 * in the active tab; only bounded opaque sync/signal/renegotiation frames cross to the Worker.
 */
export function createTabRtcEndpoint(port, { signal } = {}) {
  const endpoint = new EventTarget();
  let closed = false;
  const onMessage = ({ data }) => {
    if (closed || data?.protocol !== BROWSER_RTC_PROTOCOL || data.type !== 'rtc') return;
    endpoint.dispatchEvent(new MessageEvent('message', { data: data.payload }));
  };
  endpoint.postMessage = payload => {
    if (closed) return;
    checkRtcMessage(payload);
    port.postMessage({ protocol: BROWSER_RTC_PROTOCOL, type: 'rtc', payload });
  };
  const close = () => {
    if (closed) return;
    closed = true;
    port.removeEventListener('message', onMessage);
    signal?.removeEventListener('abort', close);
    endpoint.dispatchEvent(new Event('close'));
  };
  endpoint.close = close;
  port.addEventListener('message', onMessage);
  signal?.addEventListener('abort', close, { once: true });
  if (signal?.aborted) close();
  return endpoint;
}

/** Tab-side 1:1 RTC host: returns the WorkerWebRtcServer (getPeer, peers, onPeer, close). */
export function startTabRtcHost(port, { signal, createPeerConnection, onNetworkChange } = {}) {
  const endpoint = createTabRtcEndpoint(port, { signal });
  const server = serveWorkerWebRtcConnections(endpoint, {
    signal,
    ...(createPeerConnection ? { createPeerConnection } : {}),
  });
  const notifyNetwork = () => {
    if (signal?.aborted) return;
    try { port.postMessage({ protocol: BROWSER_RTC_PROTOCOL, type: 'network-change' }); } catch { /* Worker closed. */ }
    try { onNetworkChange?.(); } catch { /* Observer error isolated. */ }
  };
  const network = globalThis.navigator?.connection;
  for (const name of ['online', 'pageshow']) globalThis.addEventListener?.(name, notifyNetwork);
  network?.addEventListener?.('change', notifyNetwork);
  const cleanupListeners = () => {
    for (const name of ['online', 'pageshow']) globalThis.removeEventListener?.(name, notifyNetwork);
    network?.removeEventListener?.('change', notifyNetwork);
  };
  signal?.addEventListener('abort', cleanupListeners, { once: true });
  return Object.freeze({
    getPeer: peerId => server.getPeer(peerId),
    peers: () => server.peers(),
    onPeer: listener => server.onPeer(listener),
    async close() {
      cleanupListeners();
      endpoint.close();
      await server.close();
    },
  });
}

/** Worker-side 1:1 RTC opener bound directly to the owning tab's PeerConnection host. */
export function createWorkerRtcOpener(scope, { signal, onNetworkChange } = {}) {
  const endpoint = createTabRtcEndpoint(scope, { signal });
  const onMessage = ({ data }) => {
    if (data?.protocol === BROWSER_RTC_PROTOCOL && data.type === 'network-change') {
      try { void Promise.resolve(onNetworkChange?.()).catch(() => {}); } catch { /* Isolate recovery errors. */ }
    }
  };
  scope.addEventListener('message', onMessage);
  const close = () => {
    scope.removeEventListener('message', onMessage);
    endpoint.close();
  };
  signal?.addEventListener('abort', close, { once: true });
  return {
    openDirectConnection: options => openWorkerWebRtcConnection(endpoint, options),
    close,
  };
}
