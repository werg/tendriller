export const BROWSER_OWNER_PROTOCOL = 'tendriller/browser-owner/v2';
export const ownerChannelName = profileId => `tendriller:owner:v2:${profileId}`;
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
const MAX_BYTES = 1048576, MAX_WIRE_BYTES = 2 * MAX_BYTES, MAX_QUEUED_BYTES = 4 * MAX_BYTES;
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(value);
const bytesEqual = (left, right) => left instanceof Uint8Array && right instanceof Uint8Array &&
  left.length === right.length && left.every((value, index) => value === right[index]);
const publicKeyValid = value => value instanceof Uint8Array && value.length === 65 && value[0] === 4;

export function checkOwnerFrame(value) {
  let nodes = 0, bytes = 0; const seen = new Set();
  function visit(item, depth) {
    if (++nodes > 65536 || depth > 32) throw Error('OWNER_MESSAGE_LIMIT');
    if (typeof item === 'string') bytes += encoder.encode(item).length;
    else if (typeof item === 'bigint') bytes += item.toString().length;
    else if (item === null || item === undefined || typeof item === 'boolean' || typeof item === 'number') bytes += 8;
    else if (item instanceof Uint8Array) bytes += item.byteLength;
    else if (typeof item === 'object') {
      if (seen.has(item) || (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)) throw Error('OWNER_MESSAGE_INVALID');
      seen.add(item);
      for (const [key, child] of Object.entries(item)) { bytes += encoder.encode(key).length; visit(child, depth + 1); }
      seen.delete(item);
    } else throw Error('OWNER_MESSAGE_INVALID');
    if (bytes > MAX_BYTES) throw Error('OWNER_MESSAGE_LIMIT');
  }
  visit(value, 0);
}
export function ended(code = 'OWNER_UNREACHABLE') { return { ended: { name: 'Error', message: code, code } }; }
export function isOwnerAnnouncement(value, profileId) {
  return value?.protocol === BROWSER_OWNER_PROTOCOL && value.type === 'ready' && value.profileId === profileId &&
    validId(value.ownerInstanceId) && publicKeyValid(value.publicKey);
}
function base64(bytes) {
  let value = ''; for (let index = 0; index < bytes.length; index += 32768) value += String.fromCharCode(...bytes.subarray(index, index + 32768));
  return btoa(value);
}
function binary(value) { return Uint8Array.from(atob(value), character => character.charCodeAt(0)); }
function encode(value) {
  checkOwnerFrame(value);
  const pack = item => {
    if (item === undefined) return ['undefined'];
    if (item === null) return ['null'];
    if (typeof item === 'boolean' || typeof item === 'string') return [typeof item, item];
    if (typeof item === 'number') return ['number', Object.is(item, -0) ? '-0' : Number.isFinite(item) ? item : String(item)];
    if (typeof item === 'bigint') return ['bigint', String(item)];
    if (item instanceof Uint8Array) return ['bytes', base64(item)];
    return Array.isArray(item) ? ['array', item.map(pack)] : ['object', Object.entries(item).map(([key, child]) => [key, pack(child)])];
  };
  const bytes = encoder.encode(JSON.stringify(pack(value)));
  if (bytes.length > MAX_WIRE_BYTES - 32) throw Error('OWNER_MESSAGE_LIMIT');
  return bytes;
}
function decode(bytes) {
  let nodes = 0;
  const unpack = (item, depth = 0) => {
    if (++nodes > 65536 || depth > 32 || !Array.isArray(item)) throw Error('OWNER_MESSAGE_INVALID');
    const [type, value] = item;
    if (type === 'undefined' && item.length === 1) return undefined;
    if (type === 'null' && item.length === 1) return null;
    if (item.length !== 2) throw Error('OWNER_MESSAGE_INVALID');
    if ((type === 'boolean' || type === 'string') && typeof value === type) return value;
    if (type === 'number' && (typeof value === 'number' || ['-0', 'NaN', 'Infinity', '-Infinity'].includes(value))) return Number(value);
    if (type === 'bigint' && typeof value === 'string' && /^-?(0|[1-9][0-9]*)$/u.test(value)) return BigInt(value);
    if (type === 'bytes' && typeof value === 'string') return binary(value);
    if (type === 'array' && Array.isArray(value)) return value.map(child => unpack(child, depth + 1));
    if (type === 'object' && Array.isArray(value)) {
      const keys = new Set();
      return Object.fromEntries(value.map(entry => {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || keys.has(entry[0])) throw Error('OWNER_MESSAGE_INVALID');
        keys.add(entry[0]); return [entry[0], unpack(entry[1], depth + 1)];
      }));
    }
    throw Error('OWNER_MESSAGE_INVALID');
  };
  const value = unpack(JSON.parse(decoder.decode(bytes))); checkOwnerFrame(value); return value;
}
async function keys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  return { privateKey: pair.privateKey, publicKey: new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)) };
}
async function material(privateKey, remoteKey) {
  if (!publicKeyValid(remoteKey)) throw Error('OWNER_HANDSHAKE_INVALID');
  const publicKey = await crypto.subtle.importKey('raw', remoteKey, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256);
  return crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
}
async function derive(shared, salt, context) {
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode(JSON.stringify(context)) }, shared,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
function transcript(profileId, ownerInstanceId, route, ownerKey, clientKey, nonce) {
  return [BROWSER_OWNER_PROTOCOL, profileId, ownerInstanceId, route, base64(ownerKey), base64(clientKey), base64(nonce)];
}
function aad(record, direction, sequence, phase = 'frame') { return encoder.encode(JSON.stringify([...record.context, phase, direction, sequence])); }
function sequenceIv(direction, sequence) {
  const value = new Uint8Array(12); value[0] = direction === 'owner' ? 1 : 2;
  new DataView(value.buffer).setBigUint64(4, BigInt(sequence)); return value;
}
function validPacket(value, direction) {
  return value?.type === 'sealed' && value.direction === direction && Number.isSafeInteger(value.sequence) && value.sequence > 0 &&
    value.ciphertext instanceof Uint8Array && value.ciphertext.length >= 16 && value.ciphertext.length <= MAX_WIRE_BYTES;
}
function queues(record, channel, ownerInstanceId, route, outgoing) {
  record.sendSequence = 0; record.receiveSequence = 0; record.outgoing = Promise.resolve(); record.incoming = Promise.resolve();
  record.queuedSend = 0; record.queuedReceive = 0; record.sending = 0; record.receiving = 0;
  record.send = value => {
    const bytes = encode(value);
    if (record.closed || record.sending >= 32 || record.queuedSend + bytes.length > MAX_QUEUED_BYTES) return Promise.reject(Error('OWNER_MESSAGE_LIMIT'));
    record.queuedSend += bytes.length; record.sending++;
    const result = record.outgoing.then(async () => {
      if (record.closed) throw Error('ENDPOINT_STALE');
      const sequence = ++record.sendSequence; if (!Number.isSafeInteger(sequence)) throw Error('ENDPOINT_STALE');
      const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: sequenceIv(outgoing, sequence),
        additionalData: aad(record, outgoing, sequence) }, record.key, bytes));
      if (!record.closed) channel.postMessage({ protocol: BROWSER_OWNER_PROTOCOL, type: 'sealed', ownerInstanceId, route, direction: outgoing, sequence, ciphertext });
    }).finally(() => { record.queuedSend -= bytes.length; record.sending--; });
    record.outgoing = result.catch(() => undefined); return result;
  };
  record.receive = (packet, deliver) => {
    const direction = outgoing === 'owner' ? 'client' : 'owner';
    if (!validPacket(packet, direction) || record.closed || record.receiving >= 32 || record.queuedReceive + packet.ciphertext.length > MAX_QUEUED_BYTES) return;
    record.queuedReceive += packet.ciphertext.length; record.receiving++;
    const next = record.incoming.then(async () => {
      if (record.closed || packet.sequence !== record.receiveSequence + 1) return;
      let plaintext;
      try { plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sequenceIv(direction, packet.sequence),
        additionalData: aad(record, direction, packet.sequence) }, record.key, packet.ciphertext); }
      catch { return; } // Public-channel forgery must not close another attachment.
      if (record.closed) return;
      record.receiveSequence = packet.sequence; await deliver(decode(new Uint8Array(plaintext)));
    }).finally(() => { record.queuedReceive -= packet.ciphertext.length; record.receiving--; });
    record.incoming = next.catch(() => undefined);
  };
}

/** The elected owner binds private ports behind authenticated, replay-fenced routes. */
export async function createBroadcastOwner(channel, owner, { profileId, timeoutMs = 30000, idleTimeoutMs = 60000, maxRoutes = 32 } = {}) {
  if (!validId(profileId) || !validId(owner.ownerInstanceId) || !Number.isSafeInteger(maxRoutes) || maxRoutes < 1 || maxRoutes > 128 ||
      !Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000 ||
      !Number.isFinite(idleTimeoutMs) || idleTimeoutMs < 100 || idleTimeoutMs > 120000) throw Error('OWNER_CONFIGURATION_INVALID');
  const pair = await keys(), routes = new Map(); let closed = false;
  const announcement = { protocol: BROWSER_OWNER_PROTOCOL, type: 'ready', profileId, ownerInstanceId: owner.ownerInstanceId, publicKey: pair.publicKey };
  const announce = () => { if (!closed) channel.postMessage(announcement); };
  function retire(route) {
    const record = routes.get(route); if (!record) return;
    record.closed = true; clearTimeout(record.timer); clearTimeout(record.idleTimer); record.detach?.(); record.port?.close(); routes.delete(route);
  }
  function observeLiveness(record, route) {
    clearTimeout(record.idleTimer);
    if (record.closed) return;
    if (!record.suspended && performance.now() - record.lastReceived >= idleTimeoutMs) {
      void record.send({ kind: 'frame', frame: ended('OWNER_UNREACHABLE') }).finally(() => retire(route)).catch(() => undefined); return;
    }
    record.idleTimer = setTimeout(() => observeLiveness(record, route), Math.max(50, idleTimeoutMs / 3)); record.idleTimer.unref?.();
  }
  async function hello(data) {
    if (!publicKeyValid(data.publicKey) || !(data.nonce instanceof Uint8Array) || data.nonce.length !== 32) return;
    const existing = routes.get(data.route);
    if (existing) {
      if (bytesEqual(existing.publicKey, data.publicKey) && bytesEqual(existing.nonce, data.nonce) && existing.welcome) channel.postMessage(existing.welcome);
      return;
    }
    if (routes.size >= maxRoutes) return;
    const record = { publicKey: data.publicKey.slice(), nonce: data.nonce.slice(), closed: false };
    routes.set(data.route, record); record.timer = setTimeout(() => retire(data.route), timeoutMs); record.timer.unref?.();
    try {
      record.context = transcript(profileId, owner.ownerInstanceId, data.route, pair.publicKey, record.publicKey, record.nonce);
      const shared = await material(pair.privateKey, record.publicKey), base = await derive(shared, record.nonce, [...record.context, 'welcome']);
      const challenge = crypto.getRandomValues(new Uint8Array(32)), iv = crypto.getRandomValues(new Uint8Array(12));
      record.key = await derive(shared, challenge, [...record.context, 'session']);
      queues(record, channel, owner.ownerInstanceId, data.route, 'client');
      const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv,
        additionalData: aad(record, 'client', 0, 'welcome') }, base, challenge));
      record.welcome = { protocol: BROWSER_OWNER_PROTOCOL, type: 'welcome', ownerInstanceId: owner.ownerInstanceId, route: data.route, iv, ciphertext };
      if (!closed && !record.closed) channel.postMessage(record.welcome);
    } catch { retire(data.route); }
  }
  async function deliver(record, route, value) {
    record.lastReceived = performance.now();
    if (!record.port) {
      if (value?.kind !== 'attach' || typeof value.facadeProtocol !== 'string') { retire(route); return; }
      checkOwnerFrame(value.handshake);
      const ports = new MessageChannel(), endpoint = new EventTarget(); endpoint.postMessage = () => {};
      record.detach = owner.attach(endpoint); record.port = ports.port2; clearTimeout(record.timer); observeLiveness(record, route);
      record.port.addEventListener('message', ({ data: frame }) => {
        let sending;
        try { sending = record.send({ kind: 'frame', frame }); } catch { retire(route); return; }
        sending.catch(() => retire(route)); if (frame?.ended) void sending.finally(() => retire(route)).catch(() => undefined);
      }); record.port.start();
      endpoint.dispatchEvent(new MessageEvent('message', { data: { protocol: value.facadeProtocol, handshake: value.handshake, port: ports.port1 } }));
    } else if (value?.kind === 'frame') {
      if (value.frame?.method === 'endpoint.suspend') record.suspended = true;
      if (value.frame?.method === 'endpoint.resume') record.suspended = false;
      record.port.postMessage(value.frame);
    }
    else if (value?.kind === 'ping') await record.send({ kind: 'pong' });
    else if (value?.kind === 'detach') retire(route);
    else retire(route);
  }
  const receive = ({ data }) => {
    if (closed || data?.protocol !== BROWSER_OWNER_PROTOCOL) return;
    if (data.type === 'discover') { announce(); return; }
    if (data.ownerInstanceId !== owner.ownerInstanceId || !validId(data.route)) return;
    if (data.type === 'hello') { void hello(data).catch(() => undefined); return; }
    const record = routes.get(data.route);
    if (record?.key) record.receive(data, value => deliver(record, data.route, value).catch(() => retire(data.route)));
  };
  channel.addEventListener('message', receive);
  return Object.freeze({ announce, get routes() { return routes.size; }, async close() {
    if (closed) return; closed = true; channel.removeEventListener('message', receive);
    await Promise.allSettled([...routes].map(async ([route, record]) => {
      try { if (record.port) await record.send({ kind: 'frame', frame: ended('ENDPOINT_STALE') }); } finally { retire(route); }
    }));
  } });
}

/** Public discovery is pinned once; only authenticated route frames can affect a facade. */
export function createBroadcastEndpoint(channel, announcement, { profileId, onReplaced, livenessTimeoutMs = 15000 } = {}) {
  if (!isOwnerAnnouncement(announcement, profileId) || !Number.isFinite(livenessTimeoutMs) || livenessTimeoutMs < 100 || livenessTimeoutMs > 120000) throw Error('OWNER_HANDSHAKE_INVALID');
  const { ownerInstanceId } = announcement, ownerKey = announcement.publicKey.slice();
  let record, closed = false, paused = false, heartbeat, handshakeTimer;
  const replaced = code => {
    if (closed) return; closed = true; clearTimeout(heartbeat); clearTimeout(handshakeTimer); channel.removeEventListener('message', receive);
    if (record) { record.port.postMessage(ended(code)); record.closed = true; record.port.close(); }
    try { onReplaced?.({ previous: ownerInstanceId, reason: code }); } catch { /* Product callbacks cannot keep an invalid route alive. */ }
  };
  function pulse() {
    clearTimeout(heartbeat); if (closed || paused || !record?.key) return;
    if (performance.now() - record.lastReceived >= livenessTimeoutMs) { replaced('OWNER_UNREACHABLE'); return; }
    void record.send({ kind: 'ping' }).catch(() => replaced('OWNER_UNREACHABLE'));
    heartbeat = setTimeout(pulse, Math.max(50, Math.min(5000, livenessTimeoutMs / 3))); heartbeat.unref?.();
  }
  async function welcome(data) {
    if (!record || record.key || record.welcoming || !(data.iv instanceof Uint8Array) || data.iv.length !== 12 ||
        !(data.ciphertext instanceof Uint8Array) || data.ciphertext.length !== 48) return;
    record.welcoming = true;
    try {
      await record.opening;
      let challenge;
      try { challenge = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: data.iv,
        additionalData: aad(record, 'client', 0, 'welcome') }, record.base, data.ciphertext)); }
      catch { return; }
      if (closed) return;
      record.key = await derive(record.shared, challenge, [...record.context, 'session']);
      clearTimeout(handshakeTimer);
      queues(record, channel, ownerInstanceId, record.route, 'owner');
      await record.send({ kind: 'attach', facadeProtocol: record.facadeProtocol, handshake: record.handshake });
      record.lastReceived = performance.now(); pulse();
    } catch { replaced('OWNER_HANDSHAKE_INVALID'); }
    finally { if (record) record.welcoming = false; }
  }
  const receive = ({ data }) => {
    if (closed || !record || data?.protocol !== BROWSER_OWNER_PROTOCOL || data.ownerInstanceId !== ownerInstanceId || data.route !== record.route) return;
    // Plaintext ready/retired/failure/frame messages cannot replace or impersonate this route.
    if (data.type === 'welcome') { void welcome(data); return; }
    if (!record.key) return;
    record.receive(data, value => {
      record.lastReceived = performance.now();
      if (value?.kind === 'frame') {
        record.port.postMessage(value.frame);
        if (value.frame?.ended) {
          record.closed = true; closed = true; clearTimeout(heartbeat); clearTimeout(handshakeTimer); channel.removeEventListener('message', receive); record.port.close();
          if (['ENDPOINT_STALE', 'OWNER_UNREACHABLE'].includes(value.frame.ended.code)) {
            try { onReplaced?.({ previous: ownerInstanceId, reason: value.frame.ended.code }); } catch { /* A product callback cannot reopen the route. */ }
          }
        }
      } else if (value?.kind !== 'pong') replaced('OWNER_MESSAGE_INVALID');
    });
  };
  channel.addEventListener('message', receive);
  return { postMessage(frame) {
    if (closed || record || !frame?.port || typeof frame.port.postMessage !== 'function') throw Error('OWNER_HANDSHAKE_INVALID');
    checkOwnerFrame(frame.handshake);
    record = { route: crypto.randomUUID(), port: frame.port, facadeProtocol: frame.protocol, handshake: frame.handshake, closed: false };
    record.port.addEventListener('message', ({ data }) => {
      try { if (!record.key) throw Error('OWNER_HANDSHAKE_INVALID'); void record.send({ kind: 'frame', frame: data }).catch(() => replaced('OWNER_UNREACHABLE')); }
      catch { replaced('OWNER_MESSAGE_LIMIT'); }
    }); record.port.start();
    record.opening = (async () => {
      const pair = await keys(), nonce = crypto.getRandomValues(new Uint8Array(32));
      record.context = transcript(profileId, ownerInstanceId, record.route, ownerKey, pair.publicKey, nonce);
      record.shared = await material(pair.privateKey, ownerKey); record.base = await derive(record.shared, nonce, [...record.context, 'welcome']);
      const hello = { protocol: BROWSER_OWNER_PROTOCOL, type: 'hello', ownerInstanceId, route: record.route, publicKey: pair.publicKey, nonce };
      const offer = () => { if (closed || record.key) return;
        try { channel.postMessage(hello); } catch { replaced('OWNER_UNREACHABLE'); return; }
        handshakeTimer = setTimeout(offer, 500); handshakeTimer.unref?.();
      }; offer();
    })(); record.opening.catch(() => replaced('OWNER_HANDSHAKE_INVALID'));
  }, addEventListener() {}, removeEventListener() {},
  suspend() { paused = true; clearTimeout(heartbeat); },
  resume() { if (closed) throw Error('ENDPOINT_STALE'); paused = false; if (record) record.lastReceived = performance.now(); pulse(); },
  async close() {
    if (closed) return; closed = true; clearTimeout(heartbeat); clearTimeout(handshakeTimer); channel.removeEventListener('message', receive);
    try { if (record?.key) await record.send({ kind: 'detach' }); } catch { /* An unavailable owner does not retain a caller. */ }
    finally { if (record) { record.closed = true; record.port.close(); } }
  } };
}
