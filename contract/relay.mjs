/** Physical relay admission and flow control. Application bytes stay opaque. */
export const PEER_RELAY_PROTOCOL = 'tendriller.relay.v1';
export const PEER_RELAY_LIMITS = Object.freeze({ packetBytes: 64 * 1024, pendingPackets: 32,
  pendingBytes: 512 * 1024, liveBufferedBytes: 64 * 1024, sessions: 16, sessionsPerPrincipal: 8,
  pairingMs: 30_000, progressMs: 30_000, authorizationMs: 30_000, lifetimeMs: 3_600_000,
  reliablePacketsPerSecond: 2048, livePacketsPerSecond: 128 });
const identity = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const failure = (code, message) => Object.assign(new Error(message), { name: 'PeerConnectionError', code });
const assert = (value, message) => { if (!value) throw failure('invalid_relay', message); };
const hex = bytes => Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
const byteLength = value => typeof value === 'string' ? new TextEncoder().encode(value).length : value.byteLength;

/**
 * Two binary-only socket facades. Receipts bound host egress independently of
 * the end-to-end framing protocol; they never acknowledge application commits.
 * Construct the framed connection synchronously, before awaiting `ready`.
 */
export function createPeerRelay(sockets, { peerId, remotePeerId, signal, timeoutMs = PEER_RELAY_LIMITS.pairingMs } = {}) {
  assert(identity(peerId) && identity(remotePeerId) && peerId !== remotePeerId, 'A relay needs two distinct signing identities');
  assert(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= PEER_RELAY_LIMITS.pairingMs, 'Invalid relay pairing timeout');
  assert(sockets?.reliable && sockets?.live && sockets.reliable !== sockets.live, 'A relay needs independent reliable and live sockets');
  const controller = new AbortController(), readiness = Promise.withResolvers();
  let ended = false, session, paired = 0;
  const ready = readiness.promise;
  void ready.catch(() => {});
  const close = error => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancelled);
    const reason = error ?? failure('relay_closed', 'Peer relay closed');
    controller.abort(reason); readiness.reject(reason);
    for (const lane of lanes) lane.finish(reason);
  };
  const cancelled = () => close(signal.reason || new DOMException('Aborted', 'AbortError'));
  const lanes = [];
  class Lane extends EventTarget {
    #socket; #lane; #ready = false; #sequence = 0; #received = 0; #pending = [];
    #listeners; #sentBytes = 0; #receivedBytes = 0;
    binaryType = 'arraybuffer';
    constructor(socket, lane) {
      super(); this.#socket = socket; this.#lane = lane;
      socket.binaryType = 'arraybuffer';
      const message = event => {
        if (ended) return;
        try { this.#message(event.data); } catch (error) { close(error); }
      };
      const disconnected = () => close(failure('relay_closed', 'A relay lane disconnected'));
      const errored = () => close(failure('relay_failed', 'A relay lane failed'));
      this.#listeners = [['message', message], ['close', disconnected], ['error', errored]];
      for (const [type, listener] of this.#listeners) socket.addEventListener(type, listener);
    }
    get readyState() { return ended ? 3 : this.#ready ? 1 : 0; }
    get bufferedAmount() {
      const native = Number.isFinite(this.#socket.bufferedAmount) ? this.#socket.bufferedAmount : 0;
      return native + (this.#lane === 'live' ? (this.#pending.length ? PEER_RELAY_LIMITS.liveBufferedBytes : 0)
        : this.#pending.reduce((sum, item) => sum + Math.max(16 * 1024, item.bytes), 0));
    }
    get stats() { return Object.freeze({ sentBytes: this.#sentBytes, receivedBytes: this.#receivedBytes,
      pendingPackets: this.#pending.length, bufferedAmount: this.bufferedAmount }); }
    #message(data) {
      if (typeof data === 'string') {
        assert(byteLength(data) <= 512, 'Relay control exceeds its bound');
        const value = JSON.parse(data);
        assert(value && typeof value === 'object' && !Array.isArray(value), 'Invalid relay control');
        if (value.t === 'ready') {
          assert(!this.#ready && Object.keys(value).length === 6 && value.version === 1 && value.lane === this.#lane &&
            value.peerId === peerId && value.remotePeerId === remotePeerId && typeof value.session === 'string' &&
            /^[0-9a-f-]{36}$/.test(value.session) && (session === undefined || session === value.session), 'Invalid relay pairing');
          session = value.session; this.#ready = true; paired++;
          this.dispatchEvent(new Event('open'));
          if (paired === 2) { clearTimeout(timer); readiness.resolve(Object.freeze({ session })); }
          return;
        }
        assert(this.#ready && value.t === 'credit' && Object.keys(value).length === 3 && value.session === session &&
          Number.isSafeInteger(value.sequence) && this.#pending[0]?.sequence === value.sequence, 'Invalid relay credit');
        this.#pending.shift(); this.dispatchEvent(new Event('bufferedamountlow')); return;
      }
      assert(this.#ready && data instanceof ArrayBuffer && data.byteLength > 20 && data.byteLength <= PEER_RELAY_LIMITS.packetBytes + 20,
        'Relay accepts bounded binary packets');
      const bytes = new Uint8Array(data), sequence = new DataView(data).getUint32(0);
      assert(this.#lane === 'live' ? sequence > this.#received : sequence === this.#received + 1, 'Relay packet sequence changed');
      this.#received = sequence; this.#receivedBytes += bytes.length - 20;
      this.dispatchEvent(new MessageEvent('message', { data: data.slice(20) }));
      if (!ended) this.#socket.send(JSON.stringify({ t: 'received', session, sequence, receipt: hex(bytes.subarray(4, 20)) }));
    }
    send(data) {
      assert(this.readyState === 1, 'Relay is not paired');
      const input = data instanceof ArrayBuffer ? new Uint8Array(data)
        : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;
      assert(input && input.length > 0 && input.length <= PEER_RELAY_LIMITS.packetBytes, 'Relay accepts bounded binary packets');
      const maximum = this.#lane === 'live' ? 1 : PEER_RELAY_LIMITS.pendingPackets;
      assert(this.#pending.length < maximum && this.#pending.reduce((sum, value) => sum + value.bytes, 0) + input.length <= PEER_RELAY_LIMITS.pendingBytes,
        'Relay send credit exhausted');
      assert(this.#sequence < 0xffffffff, 'Relay packet sequence exhausted');
      const sequence = ++this.#sequence, packet = new Uint8Array(4 + input.length);
      new DataView(packet.buffer).setUint32(0, sequence); packet.set(input, 4);
      this.#pending.push({ sequence, bytes: input.length });
      try { this.#socket.send(packet.buffer); this.#sentBytes += input.length; }
      catch (error) { close(error); throw error; }
    }
    close() { close(); }
    finish(reason) {
      for (const [type, listener] of this.#listeners) this.#socket.removeEventListener(type, listener);
      this.#pending.length = 0;
      try { if (this.#socket.readyState < 2) this.#socket.close(1000, 'Peer relay closed'); } catch {}
      this.dispatchEvent(Object.assign(new Event('close'), { code: 1000, reason: String(reason.code || 'relay_closed') }));
    }
  }
  const timer = setTimeout(() => close(failure('relay_timeout', 'Peer relay pairing timed out')), timeoutMs);
  const reliable = new Lane(sockets.reliable, 'reliable'), live = new Lane(sockets.live, 'live');
  lanes.push(reliable, live);
  signal?.addEventListener('abort', cancelled, { once: true });
  if (signal?.aborted) cancelled();
  else if (sockets.reliable.readyState > 1 || sockets.live.readyState > 1) close(failure('relay_closed', 'A relay lane is already closed'));
  return Object.freeze({ reliable, live, ready, signal: controller.signal, close() { close(); } });
}
