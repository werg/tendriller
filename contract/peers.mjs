/** A connection forwards opaque, bounded frames; it does not grant database membership. */
export const PEER_LIMITS = Object.freeze({ frameBytes: 256 * 1024, signalBytes: 16 * 1024, queueBytes: 4 * 1024 * 1024,
  relayBytesPerSecond: 4 * 1024 * 1024, relaySessions: 16, endpoints: 8 });
export class PeerConnectionError extends Error {
  constructor(code, message) { super(message); this.name = 'PeerConnectionError'; this.code = code; }
}
const fail = (code, message) => { throw new PeerConnectionError(code, message); };
const domains = ['records', 'signals', 'control'];
export function encodePeerFrame(frame) {
  const domain = domains.indexOf(frame?.domain);
  if (domain < 0 || !(frame.payload instanceof Uint8Array)) fail('invalid_frame', 'Expected a named frame domain and bytes');
  const bound = frame.domain === 'signals' ? PEER_LIMITS.signalBytes : PEER_LIMITS.frameBytes;
  if (!frame.payload.byteLength || frame.payload.byteLength > bound) fail('frame_too_large', 'Peer payload exceeds its domain limit');
  const bytes = new Uint8Array(frame.payload.byteLength + 3);
  bytes.set([0x54, 1, domain]); bytes.set(frame.payload, 3); return bytes;
}
export function decodePeerFrame(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 4 || bytes[0] !== 0x54 || bytes[1] !== 1 || !domains[bytes[2]])
    fail('invalid_frame', 'Unsupported peer frame encoding');
  const frame = { domain: domains[bytes[2]], payload: bytes.slice(3) };
  encodePeerFrame(frame); return frame;
}
export function validatePeerBootstrap(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.endpoints) || value.endpoints.length > PEER_LIMITS.endpoints ||
      Object.keys(value).some(key => !['version', 'endpoints'].includes(key))) fail('invalid_bootstrap', 'Expected a bounded version 1 endpoint list');
  return { version: 1, endpoints: value.endpoints.map(endpoint => {
    if (!endpoint || typeof endpoint.url !== 'string' || endpoint.url.length > 2048 || !['direct', 'relay'].includes(endpoint.route) ||
        Object.keys(endpoint).some(key => !['url', 'route'].includes(key))) fail('invalid_bootstrap', 'Invalid peer endpoint');
    let url; try { url = new URL(endpoint.url); } catch { fail('invalid_bootstrap', 'Invalid peer endpoint URL'); }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.hash || !(url.protocol === 'wss:' || url.protocol === 'ws:' && local))
      fail('invalid_bootstrap', 'Peer endpoints require WSS without embedded credentials (WS is limited to loopback tests)');
    return { url: url.href, route: endpoint.route };
  }) };
}
export function createPeerConnection(socket, { route, relayHandshake = false, queueBytes = PEER_LIMITS.queueBytes }) {
  if (!['direct', 'relay'].includes(route) || !Number.isSafeInteger(queueBytes) || queueBytes < PEER_LIMITS.frameBytes + 3 || queueBytes > PEER_LIMITS.queueBytes)
    fail('invalid_connection', 'Invalid route or queue bound');
  socket.binaryType = 'arraybuffer';
  let ended = false, failure, readyDone = false, reader = false, waiting, resolveReady, rejectReady;
  let sendCredit = PEER_LIMITS.queueBytes;
  let queuedBytes = 0, pendingSendBytes = 0, sentBytes = 0, receivedBytes = 0, openedAt = null;
  const queue = [];
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  // A caller may inspect frames before awaiting ready; keep the rejection observed.
  void ready.catch(() => {});
  const finish = error => {
    if (ended) return; ended = true; failure = error;
    if (!readyDone) rejectReady(error || new PeerConnectionError('connection_closed', 'Peer connection closed'));
    waiting?.(); waiting = undefined;
    for (const [type, listener] of listeners) socket.removeEventListener(type, listener);
  };
  const abort = error => { finish(error); socket.close(1008, String(error.code || 'invalid peer frame').slice(0, 100)); };
  const markReady = () => { if (ended || readyDone) return; readyDone = true; openedAt = Date.now(); resolveReady(); };
  const open = () => { if (!relayHandshake) markReady(); };
  const message = event => {
    if (ended) return;
    try {
      if (relayHandshake && typeof event.data === 'string') {
        if (event.data === '{"t":"peer_ready","version":1}') { markReady(); return; }
        const credit = JSON.parse(event.data);
        if (readyDone && Object.keys(credit).length === 2 && credit.t === 'peer_credit' && Number.isSafeInteger(credit.bytes) && credit.bytes >= 4 && sendCredit + credit.bytes <= PEER_LIMITS.queueBytes) { sendCredit += credit.bytes; return; }
        fail('invalid_frame', 'Invalid relay control message');
      }
      if (!readyDone) fail('invalid_frame', 'Received application bytes before peer connection readiness');
      if (!(event.data instanceof ArrayBuffer) && !(event.data instanceof Uint8Array)) fail('invalid_frame', 'Peer messages must be binary');
      const bytes = event.data instanceof Uint8Array ? event.data : new Uint8Array(event.data);
      const frame = decodePeerFrame(bytes);
      if (queuedBytes + bytes.byteLength > queueBytes) fail('backpressure', 'Peer receive queue exceeded its bound; reconnect from durable progress');
      receivedBytes += bytes.byteLength; queuedBytes += bytes.byteLength; queue.push({ frame, size: bytes.byteLength });
      waiting?.(); waiting = undefined;
    } catch (error) { abort(error); }
  };
  const closed = () => finish();
  const errored = () => finish(new PeerConnectionError('connection_error', 'Peer transport failed'));
  const listeners = [['open', open], ['message', message], ['close', closed], ['error', errored]];
  for (const [type, listener] of listeners) socket.addEventListener(type, listener);
  if (socket.readyState === 1) open();
  else if (socket.readyState > 1) finish(new PeerConnectionError('connection_closed', 'Peer socket is already closed'));
  let sends = Promise.resolve();
  return Object.freeze({ route, ready, get stats() { return Object.freeze({ sentBytes, receivedBytes, queuedBytes: queuedBytes + pendingSendBytes, openedAt }); },
    frames: { async *[Symbol.asyncIterator]() {
      if (reader) fail('reader_exists', 'A connection has one frame reader');
      reader = true;
      try {
        while (true) {
          if (queue.length) { const item = queue.shift(); queuedBytes -= item.size;
            if (relayHandshake && !ended) socket.send(JSON.stringify({ t: 'peer_credit', bytes: item.size }));
            yield item.frame; continue; }
          if (ended) { if (failure) throw failure; return; }
          await new Promise(resolve => { waiting = resolve; });
        }
      } finally { reader = false; }
    } },
    send(frame, { signal } = {}) {
      const bytes = encodePeerFrame(frame);
      if (ended) return Promise.reject(failure || new PeerConnectionError('connection_closed', 'Peer connection closed'));
      if (pendingSendBytes + bytes.length > queueBytes) return Promise.reject(new PeerConnectionError('backpressure', 'Peer send queue exceeded its bound'));
      pendingSendBytes += bytes.length;
      const send = sends.then(async () => {
        await ready;
        while (!ended && !signal?.aborted && ((socket.bufferedAmount || 0) + bytes.length > queueBytes || relayHandshake && sendCredit < bytes.length))
          await new Promise(resolve => setTimeout(resolve, 10));
        if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
        if (ended || socket.readyState !== 1) throw failure || new PeerConnectionError('connection_closed', 'Peer connection closed');
        socket.send(bytes); if (relayHandshake) sendCredit -= bytes.length; sentBytes += bytes.length;
      }).finally(() => { pendingSendBytes -= bytes.length; });
      sends = send.catch(() => {}); return send;
    },
    close() { finish(); socket.close(1000, 'Peer session closed'); },
  });
}
export function connectPeer(endpoint, { protocols = [], socket = (url, protocols) => new WebSocket(url, protocols), relayHandshake = endpoint.route === 'relay' } = {}) {
  const checked = validatePeerBootstrap({ version: 1, endpoints: [endpoint] }).endpoints[0];
  return createPeerConnection(socket(checked.url, protocols), { route: checked.route, relayHandshake });
}
