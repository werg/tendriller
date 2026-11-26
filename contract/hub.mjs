/** One multiplexed agent control connection. Streams are virtual WebSockets onto
 * page socket endpoints; application data (WebRTC, relay) never uses the hub. */
export const HUB_PROTOCOL = 'tendriller.hub.v1';
export const HUB_LIMITS = Object.freeze({ streams: 64, frameBytes: 1024 * 1024, maxStreamId: 2 ** 31 - 1,
  openTimeoutMs: 15_000, closeTimeoutMs: 5_000, pingMs: 30_000, retryMs: 1000, maxRetryMs: 60_000 });
export const HUB_PATHS = Object.freeze(['setup/watch', 'peers/discovery/watch', 'peers/invitations', 'peers/rendezvous']);
export const HUB_EVENT_KINDS = Object.freeze(['grant', 'revoked', 'page-deleted', 'publication', 'agents-changed']);
const CONNECTING = 0, OPEN = 1, CLOSING = 2, CLOSED = 3;
export class HubError extends Error {
  constructor(code, message = code) { super(message); this.name = 'HubError'; this.code = code; }
}
const fail = (code, message) => { throw new HubError(code, message); };
const encoder = new TextEncoder();
const bytesOf = data => data instanceof ArrayBuffer ? new Uint8Array(data)
  : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;
const toBase64 = bytes => { let text = ''; for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(text); };
const fromBase64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));
const pageId = value => typeof value === 'string' && /^[a-z2-7]{12}$/.test(value);

/** Split a stream path into its route and query; only hub-served routes are accepted. */
export function validateHubPath(path) {
  if (typeof path !== 'string' || path.length > 2048) fail('invalid_hub_path', 'Expected a bounded hub stream path');
  const [route, query = ''] = path.split('?', 2);
  if (!HUB_PATHS.includes(route) || /[#\s]/.test(query)) fail('invalid_hub_path', `The hub serves only ${HUB_PATHS.join(', ')}`);
  return path;
}

class Event_ extends Event {}
const event = (type, fields = {}) => Object.assign(new Event_(type), fields);

/** A WebSocket-compatible stream: readyState, send, close, binaryType and both listener styles. */
class HubStream extends EventTarget {
  #hub; #stream; #closeTimer;
  constructor(hub, stream, page, path, protocols) {
    super();
    this.#hub = hub; this.#stream = stream;
    this.page = page; this.path = path; this.url = path; this.protocols = protocols;
    this.readyState = CONNECTING; this.protocol = ''; this.extensions = ''; this.bufferedAmount = 0; this.binaryType = 'arraybuffer';
    this.onopen = null; this.onmessage = null; this.onclose = null; this.onerror = null;
  }
  get stream() { return this.#stream; }
  dispatchEvent(value) {
    const handler = this['on' + value.type];
    const result = super.dispatchEvent(value);
    if (typeof handler === 'function') { try { handler.call(this, value); } catch (error) { queueMicrotask(() => { throw error; }); } }
    return result;
  }
  send(data) {
    if (this.readyState === CONNECTING) throw new DOMException('Stream is still connecting', 'InvalidStateError');
    if (this.readyState !== OPEN) return;
    if (typeof data === 'string') this.#hub.sendFrame({ t: 'data', s: this.#stream, text: data });
    else {
      const bytes = bytesOf(data);
      if (!bytes) throw new TypeError('Hub streams send strings, ArrayBuffers or views');
      this.#hub.sendFrame({ t: 'data', s: this.#stream, base64: toBase64(bytes) });
    }
  }
  close(code = 1000, reason = '') {
    if (code !== 1000 && !(code >= 3000 && code <= 4999)) throw new DOMException('Invalid close code', 'InvalidAccessError');
    if (encoder.encode(reason).length > 123) throw new DOMException('Close reason too long', 'SyntaxError');
    if (this.readyState >= CLOSING) return;
    this.readyState = CLOSING;
    try { this.#hub.sendFrame({ t: 'close', s: this.#stream, code, reason }); }
    catch { this.finish(1006, 'Hub unavailable', false); return; }
    this.#closeTimer = setTimeout(() => this.finish(1006, 'Close acknowledgement timed out', false), HUB_LIMITS.closeTimeoutMs);
  }
  /** Hub-internal transitions. */
  opened(protocol = '') {
    if (this.readyState !== CONNECTING) return;
    this.readyState = OPEN; this.protocol = protocol;
    this.dispatchEvent(event('open'));
  }
  receive(frame) {
    if (this.readyState !== OPEN) return;
    let data;
    if (typeof frame.text === 'string') data = frame.text;
    else if (typeof frame.base64 === 'string') {
      const bytes = fromBase64(frame.base64);
      data = this.binaryType === 'blob' ? new Blob([bytes]) : bytes.buffer;
    } else return;
    this.dispatchEvent(new MessageEvent('message', { data }));
  }
  finish(code = 1006, reason = '', wasClean = code !== 1006) {
    if (this.readyState === CLOSED) return;
    clearTimeout(this.#closeTimer);
    const failed = code === 1006 && this.readyState !== CLOSING;
    this.readyState = CLOSED;
    this.#hub.release(this.#stream, this);
    if (failed) this.dispatchEvent(event('error'));
    this.dispatchEvent(Object.assign(event('close'), { code, reason, wasClean }));
  }
}

/** Lazily connected; reconnects with backoff while streams or event listeners need it.
 * Streams fail closed (1006) when the connection is lost so callers' own retry logic reopens them. */
export function createAgentHub({ service, token, WebSocket: Socket = globalThis.WebSocket, probe,
  retryMs = HUB_LIMITS.retryMs, maxRetryMs = HUB_LIMITS.maxRetryMs, pingMs = HUB_LIMITS.pingMs,
  openTimeoutMs = HUB_LIMITS.openTimeoutMs, keepAlive = false, versions, lastBroadcastSeq } = {}) {
  let url;
  try { url = new URL('/api/agent/hub', service); } catch { fail('invalid_hub', 'Expected the service origin'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!(url.protocol === 'https:' || url.protocol === 'http:' && loopback) || url.username || url.password)
    fail('invalid_hub', 'The hub requires an HTTPS service origin (HTTP only on loopback)');
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  if (typeof token !== 'string' || !/^ta_[a-z2-7]{32}$/.test(token)) fail('invalid_hub', 'The hub requires an agent token');
  if (typeof Socket !== 'function') fail('invalid_hub', 'A WebSocket implementation is required');
  const streams = new Map(), pending = new Map(), listeners = new Set(), statusListeners = new Set(), broadcastListeners = new Set();
  let socket, state = 'idle', failures = 0, retryTimer, pingTimer, lastSeen = 0, nextStream = 1, stopped = false, terminal, connectedOnce = false;
  let currentVersions = versions ?? null;
  let broadcastCursor = Number.isSafeInteger(lastBroadcastSeq) && lastBroadcastSeq >= 0 ? lastBroadcastSeq : 0;
  const want = () => !stopped && !terminal && (keepAlive || streams.size > 0 || listeners.size > 0 || broadcastListeners.size > 0);
  const status = value => {
    state = value.state;
    for (const listener of statusListeners) { try { listener(Object.freeze(value)); } catch {} }
  };
  function sendFrame(frame) {
    if (!socket || socket.readyState !== OPEN) fail('hub_offline', 'The hub connection is not open');
    const text = JSON.stringify(frame);
    if (encoder.encode(text).length > HUB_LIMITS.frameBytes) fail('hub_frame_too_large', 'Hub frames are limited to 1 MiB');
    socket.send(text);
  }
  function release(stream, value) { if (streams.get(stream) === value) streams.delete(stream); pending.delete(stream); scheduleIdle(); }
  function scheduleIdle() {
    if (!want() && socket && state === 'connected') {
      const current = socket; socket = undefined; clearInterval(pingTimer);
      try { current.close(1000, 'Idle'); } catch {}
      status({ state: 'idle' });
    }
  }
  function failStreams(reason) {
    for (const stream of [...streams.values()]) stream.finish(1006, reason, false);
  }
  function onFrame(text) {
    lastSeen = Date.now();
    let frame;
    try { frame = JSON.parse(text); } catch { return; }
    if (!frame || typeof frame !== 'object') return;
    if (frame.t === 'ping') { try { sendFrame({ t: 'pong' }); } catch {} return; }
    if (frame.t === 'pong') return;
    if (frame.t === 'event') {
      if (typeof frame.page !== 'string' || typeof frame.kind !== 'string') return;
      const value = Object.freeze({ page: frame.page, kind: frame.kind, data: frame.data ?? null });
      for (const listener of listeners) { try { listener(value); } catch {} }
      return;
    }
    if (frame.t === 'broadcasts') {
      if (!Array.isArray(frame.broadcasts)) return;
      const latest = Number.isSafeInteger(frame.latest_seq) && frame.latest_seq >= 0 ? frame.latest_seq : broadcastCursor;
      if (latest > broadcastCursor) broadcastCursor = latest;
      const value = Object.freeze({
        issuer: typeof frame.issuer === 'string' ? frame.issuer : '',
        keys: Array.isArray(frame.keys) ? frame.keys : [],
        latest_seq: latest,
        broadcasts: frame.broadcasts,
      });
      for (const listener of broadcastListeners) { try { listener(value); } catch {} }
      return;
    }
    const stream = Number.isSafeInteger(frame.s) ? streams.get(frame.s) : undefined;
    if (!stream) return;
    if (frame.t === 'opened') { clearTimeout(pending.get(frame.s)); pending.delete(frame.s); stream.opened(typeof frame.protocol === 'string' ? frame.protocol : ''); }
    else if (frame.t === 'data') stream.receive(frame);
    else if (frame.t === 'closed') {
      clearTimeout(pending.get(frame.s)); pending.delete(frame.s);
      stream.finish(Number.isSafeInteger(frame.code) ? frame.code : 1006, typeof frame.reason === 'string' ? frame.reason : '', frame.code !== 1006);
    }
  }
  function openStream(stream) {
    try { sendFrame({ t: 'open', s: stream.stream, page: stream.page, path: stream.path, protocols: stream.protocols }); }
    catch { stream.finish(1006, 'Hub unavailable', false); return; }
    pending.set(stream.stream, setTimeout(() => { pending.delete(stream.stream); stream.finish(1006, 'Stream open timed out', false); }, openTimeoutMs));
  }
  async function diagnose() {
    // Upgrade failures hide HTTP status; read the agent once after a failure, never while healthy.
    if (!probe) return false;
    try { await probe({ signal: AbortSignal.timeout(5000) }); return false; }
    catch (error) { return [401, 403].includes(error?.status); }
  }
  function reconnectLater() {
    if (!want() || retryTimer) return;
    const ms = Math.min(maxRetryMs, retryMs * 2 ** Math.min(failures++, 16));
    status({ state: 'reconnecting', retryInMs: ms });
    retryTimer = setTimeout(() => { retryTimer = undefined; connect(); }, ms);
  }
  function connect() {
    if (socket || !want()) return;
    clearTimeout(retryTimer); retryTimer = undefined;
    let current, opened = false;
    status({ state: 'connecting' });
    try { current = socket = new Socket(url.href, [HUB_PROTOCOL, token]); }
    catch { socket = undefined; reconnectLater(); return; }
    const openTimer = setTimeout(() => { if (!opened) { try { current.close(); } catch {} lost(1006); } }, openTimeoutMs);
    const lost = async code => {
      clearTimeout(openTimer);
      if (socket !== current) return;
      socket = undefined; clearInterval(pingTimer);
      failStreams('Hub connection lost');
      if (stopped) return;
      if (code === 4000) { terminal = 'replaced'; status({ state: 'replaced' }); return; }
      if ([4001, 4003, 1008].includes(code) || !opened && await diagnose()) { terminal = 'revoked'; status({ state: 'revoked' }); return; }
      reconnectLater();
    };
    current.addEventListener('open', () => {
      if (socket !== current) return;
      opened = true; clearTimeout(openTimer); failures = 0; lastSeen = Date.now();
      status({ state: 'connected', reconnected: connectedOnce }); connectedOnce = true;
      if (currentVersions || broadcastListeners.size > 0) {
        try {
          sendFrame({
            t: 'hello',
            ...(currentVersions ? { versions: currentVersions } : {}),
            ...(broadcastListeners.size > 0 ? { last_broadcast_seq: broadcastCursor } : {}),
          });
        } catch {}
      }
      pingTimer = setInterval(() => {
        if (Date.now() - lastSeen > 2 * pingMs) { try { current.close(); } catch {} lost(1006); return; }
        try { sendFrame({ t: 'ping' }); } catch {}
      }, pingMs);
      pingTimer.unref?.();
      for (const stream of streams.values()) if (stream.readyState === CONNECTING && !pending.has(stream.stream)) openStream(stream);
      scheduleIdle();
    });
    current.addEventListener('message', message => { if (socket === current && typeof message.data === 'string') onFrame(message.data); });
    current.addEventListener('close', closed => { void lost(closed.code); });
    // Some WebSocket implementations (Node 22.15's undici) fire 'error' again,
    // synchronously, from close() on a failed connection; handle it once.
    let failed = false;
    current.addEventListener('error', () => {
      if (failed) return; failed = true;
      try { current.close(); } catch {} void lost(1006);
    });
  }
  function allocate() {
    for (let tries = 0; tries <= streams.size; tries++) {
      const id = nextStream; nextStream = nextStream >= HUB_LIMITS.maxStreamId ? 1 : nextStream + 1;
      if (!streams.has(id)) return id;
    }
    fail('hub_stream_limit', 'No hub stream identity is available');
  }
  return Object.freeze({
    get state() { return state; },
    get streams() { return streams.size; },
    /** A WebSocket-compatible object for setup/discovery/invitation/rendezvous/assistant factories. */
    socket(page, path, protocols = []) {
      if (!pageId(page)) fail('invalid_hub_page', 'Expected a page identity');
      validateHubPath(path);
      if (!Array.isArray(protocols) || protocols.length > 8 || protocols.some(value => typeof value !== 'string' || !value.length || value.length > 256))
        fail('invalid_hub_protocols', 'Expected bounded stream subprotocols');
      if (terminal) fail(terminal === 'replaced' ? 'hub_replaced' : 'hub_access_revoked', 'The hub connection ended permanently');
      if (stopped) fail('hub_closed', 'The hub is closed');
      if (streams.size >= HUB_LIMITS.streams) fail('hub_stream_limit', 'At most 64 hub streams may be open');
      const stream = new HubStream({ sendFrame, release }, allocate(), page, path, [...protocols]);
      streams.set(stream.stream, stream);
      if (socket?.readyState === OPEN) openStream(stream);
      else connect();
      return stream;
    },
    /** Receive {page, kind, data}; the agent re-reads state after a reconnect. */
    events(listener) {
      if (typeof listener !== 'function') fail('invalid_hub_listener', 'Expected an event listener');
      listeners.add(listener); connect();
      return () => { listeners.delete(listener); scheduleIdle(); };
    },
    /** Receive {issuer, keys, latest_seq, broadcasts} delivered on hub connect/reconnect. */
    broadcasts(listener) {
      if (typeof listener !== 'function') fail('invalid_hub_listener', 'Expected a broadcast listener');
      broadcastListeners.add(listener); connect();
      return () => { broadcastListeners.delete(listener); scheduleIdle(); };
    },
    /** Update client versions and optional broadcast cursor sent on connect (or immediately if open). */
    sendHello({ versions: nextVersions, lastBroadcastSeq: nextSeq } = {}) {
      if (nextVersions !== undefined) currentVersions = nextVersions;
      if (Number.isSafeInteger(nextSeq) && nextSeq >= 0) broadcastCursor = nextSeq;
      if (socket?.readyState === OPEN) {
        try {
          sendFrame({
            t: 'hello',
            ...(currentVersions ? { versions: currentVersions } : {}),
            last_broadcast_seq: broadcastCursor,
          });
        } catch {}
      }
    },
    onStatus(listener) { statusListeners.add(listener); return () => statusListeners.delete(listener); },
    connect() { keepAlive = true; connect(); },
    close() {
      stopped = true; clearTimeout(retryTimer); clearInterval(pingTimer);
      const current = socket; socket = undefined;
      failStreams('Hub closed');
      try { current?.close(1000, 'Agent stopped'); } catch {}
      status({ state: 'closed' });
    },
  });
}
