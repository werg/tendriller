import { createPeerDiscoveryWatcher, validatePeerDiscoveryWatchOptions, PeerDiscoveryWatchError, PEER_DISCOVERY_PROTOCOL } from './discovery-watch.mjs';
export * from './discovery-watch.mjs';
import { validatePeerAdvertisement, validatePeerAdvertisementPresence, validatePeerDirectory, validatePeerId } from './discovery.mjs';
export * from './discovery.mjs';
import { createAuthorityClient } from './authority.mjs';
export * from './authority.mjs';
import { createPeerInvitationListener, validatePeerInvitation, PEER_INVITATION_PROTOCOL } from './invitations.mjs';
export * from './invitations.mjs';
import { createPeerRelay, PEER_RELAY_LIMITS, PEER_RELAY_PROTOCOL } from './relay.mjs';
export * from './relay.mjs';
/** Bounded introduction only. Application framing belongs to the chosen peer transport. */
const MAX_BOOTSTRAP_ENDPOINTS = 8;
export class PeerConnectionError extends Error {
  constructor(code, message) { super(message); this.name = 'PeerConnectionError'; this.code = code; }
}
const isLoopbackHost = hostname => hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '127.0.0.1' || hostname === '[::1]';
const fail = (code, message) => { throw code === 'invalid_discovery_watch'
  ? new PeerDiscoveryWatchError(code, message) : new PeerConnectionError(code, message); };
export function validatePeerBootstrap(value) {
  if (!value || value.version !== 2 || !Array.isArray(value.endpoints) || value.endpoints.length > MAX_BOOTSTRAP_ENDPOINTS ||
      Object.keys(value).some(key => !['version', 'endpoints'].includes(key))) fail('invalid_bootstrap', 'Expected a bounded version 2 introduction endpoint list');
  const urls = new Set();
  const endpoints = value.endpoints.map(endpoint => {
    if (!endpoint || typeof endpoint.url !== 'string' || endpoint.url.length > 2048 ||
        Object.keys(endpoint).some(key => key !== 'url')) fail('invalid_bootstrap', 'Invalid introduction endpoint');
    let url; try { url = new URL(endpoint.url); } catch { fail('invalid_bootstrap', 'Invalid peer endpoint URL'); }
    const local = isLoopbackHost(url.hostname);
    if (url.username || url.password || url.hash || url.search || url.href.length > 2048 ||
        !(url.protocol === 'https:' || url.protocol === 'http:' && local))
      fail('invalid_bootstrap', 'Introduction endpoints require HTTPS without credentials, query or fragment (HTTP is limited to loopback tests)');
    if (urls.has(url.href)) fail('invalid_bootstrap', 'Introduction endpoints must be distinct');
    urls.add(url.href);
    return Object.freeze({ url: url.href });
  });
  return Object.freeze({ version: 2, endpoints: Object.freeze(endpoints) });
}
// Rendezvous v2: bounded offer/answer plus bounded trickle ICE candidates until connected.
export const PEER_RENDEZVOUS_PROTOCOL = 'tendriller.rendezvous.v2';
export const PEER_RENDEZVOUS_LIMITS = Object.freeze({
  descriptionBytes: 64 * 1024,
  candidateBytes: 2048,
  maxCandidates: 32,
  messageBytes: 128 * 1024,
  sessions: 32,
  lifetimeMs: 60_000,
});
const utf8Bytes = value => new TextEncoder().encode(value).byteLength;
export function validatePeerDescription(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== 2 || !['offer', 'answer'].includes(value.type) ||
      typeof value.sdp !== 'string' || !value.sdp.length || utf8Bytes(value.sdp) > PEER_RENDEZVOUS_LIMITS.descriptionBytes)
    fail('invalid_description', 'Expected one bounded WebRTC offer or answer');
  return { type: value.type, sdp: value.sdp };
}
export function validatePeerIceCandidate(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('invalid_candidate', 'Expected a bounded WebRTC ICE candidate or null');
  for (const key of Object.keys(value)) {
    if (!['candidate', 'sdpMid', 'sdpMLineIndex', 'usernameFragment'].includes(key))
      fail('invalid_candidate', 'Unexpected field on WebRTC ICE candidate');
  }
  if (typeof value.candidate !== 'string' || utf8Bytes(value.candidate) > PEER_RENDEZVOUS_LIMITS.candidateBytes)
    fail('invalid_candidate', 'Expected a bounded ICE candidate string');
  const sdpMid = value.sdpMid === undefined || value.sdpMid === null
    ? null
    : (typeof value.sdpMid === 'string' && value.sdpMid.length <= 128 ? value.sdpMid : fail('invalid_candidate', 'Invalid sdpMid'));
  const sdpMLineIndex = value.sdpMLineIndex === undefined || value.sdpMLineIndex === null
    ? null
    : (typeof value.sdpMLineIndex === 'number' && Number.isSafeInteger(value.sdpMLineIndex) && value.sdpMLineIndex >= 0 && value.sdpMLineIndex <= 1024
      ? value.sdpMLineIndex : fail('invalid_candidate', 'Invalid sdpMLineIndex'));
  const usernameFragment = value.usernameFragment === undefined || value.usernameFragment === null
    ? null
    : (typeof value.usernameFragment === 'string' && value.usernameFragment.length <= 256
      ? value.usernameFragment : fail('invalid_candidate', 'Invalid usernameFragment'));
  return {
    candidate: value.candidate,
    ...(sdpMid !== null ? { sdpMid } : {}),
    ...(sdpMLineIndex !== null ? { sdpMLineIndex } : {}),
    ...(usernameFragment !== null ? { usernameFragment } : {}),
  };
}

/** A rendezvous session carries one description plus bounded trickle ICE candidates per side until connected. */
export function createPeerRendezvous(socket, { signal, timeoutMs = PEER_RENDEZVOUS_LIMITS.lifetimeMs } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > PEER_RENDEZVOUS_LIMITS.lifetimeMs)
    fail('invalid_rendezvous', 'Invalid rendezvous timeout');
  let ended = false, failure, pairing, sent = false, received = false, complete = false, reading = false, waiting;
  let sentBytes = 0, receivedBytes = 0, sentCandidates = 0, receivedCandidates = 0, resolveReady, rejectReady;
  const queue = [];
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  void ready.catch(() => {});
  const finish = error => {
    if (ended) return;
    ended = true; failure = error;
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancelled);
    for (const [type, listener] of listeners) socket.removeEventListener(type, listener);
    if (!pairing) rejectReady(error || new PeerConnectionError('rendezvous_closed', 'Rendezvous closed before pairing'));
    waiting?.(); waiting = undefined;
  };
  const close = (error, code = 1000) => {
    finish(error);
    if (socket.readyState < 2) socket.close(code, error ? String(error.code || 'rendezvous_failed').slice(0, 100) : 'Rendezvous complete');
  };
  const message = event => {
    if (ended) return;
    try {
      if (typeof event.data !== 'string' || utf8Bytes(event.data) > PEER_RENDEZVOUS_LIMITS.messageBytes)
        fail('invalid_rendezvous', 'Rendezvous accepts bounded JSON signaling only');
      const value = JSON.parse(event.data);
      receivedBytes += utf8Bytes(event.data);
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_rendezvous', 'Invalid rendezvous message');
      if (value.t === 'ready' && !pairing && Object.keys(value).length === 4 && value.version === 2 &&
          typeof value.session === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value.session) && ['offerer', 'answerer'].includes(value.role)) {
        pairing = Object.freeze({ session: value.session, role: value.role }); resolveReady(pairing); return;
      }
      if (!pairing || value.session !== pairing.session) fail('invalid_rendezvous', 'Stale or unpaired rendezvous message');
      if (value.t === 'description' && !received && Object.keys(value).length === 3) {
        const description = validatePeerDescription(value.description);
        if (description.type !== (pairing.role === 'offerer' ? 'answer' : 'offer')) fail('invalid_description', 'Description conflicts with the assigned role');
        received = true; queue.push(description); waiting?.(); waiting = undefined; return;
      }
      if (value.t === 'candidate' && received && receivedCandidates < PEER_RENDEZVOUS_LIMITS.maxCandidates && Object.keys(value).length === 3) {
        const candidate = validatePeerIceCandidate(value.candidate);
        receivedCandidates += 1; queue.push({ kind: 'candidate', candidate }); waiting?.(); waiting = undefined; return;
      }
      if (value.t === 'complete' && Object.keys(value).length === 2 && sent && received && !complete) {
        complete = true; close(); return;
      }
      fail('invalid_rendezvous', 'Unexpected or repeated rendezvous message');
    } catch (error) { close(error instanceof PeerConnectionError ? error : new PeerConnectionError('invalid_rendezvous', 'Invalid rendezvous JSON'), 1008); }
  };
  const disconnected = () => finish(complete || sent && received ? undefined : new PeerConnectionError('rendezvous_closed', 'Rendezvous closed before description exchange'));
  const errored = () => close(new PeerConnectionError('rendezvous_failed', 'Rendezvous transport failed'));
  const cancelled = () => close(signal.reason || new DOMException('Aborted', 'AbortError'));
  const listeners = [['message', message], ['close', disconnected], ['error', errored]];
  const timer = setTimeout(() => close(new PeerConnectionError('rendezvous_timeout', 'Rendezvous timed out')), timeoutMs);
  for (const [type, listener] of listeners) socket.addEventListener(type, listener);
  signal?.addEventListener('abort', cancelled, { once: true });
  if (signal?.aborted) cancelled();
  else if (socket.readyState > 1) disconnected();
  return Object.freeze({ ready,
    get stats() { return Object.freeze({ sentBytes, receivedBytes, sentDescriptions: Number(sent), receivedDescriptions: Number(received), sentCandidates, receivedCandidates, closed: ended }); },
    messages: { async *[Symbol.asyncIterator]() {
      if (reading) fail('reader_exists', 'Rendezvous has one signaling reader');
      reading = true;
      try {
        while (true) {
          if (queue.length) { yield queue.shift(); continue; }
          if (ended) { if (failure) throw failure; return; }
          await new Promise(resolve => { waiting = resolve; });
        }
      } finally { reading = false; }
    } },
    async send(input) {
      const assigned = await ready;
      if (ended || socket.readyState !== 1) throw failure || new PeerConnectionError('rendezvous_closed', 'Rendezvous is closed');
      let encoded;
      if (input && typeof input === 'object' && input.kind === 'candidate') {
        if (!sent) fail('invalid_candidate', 'Send SDP description before trickle ICE candidates');
        if (sentCandidates >= PEER_RENDEZVOUS_LIMITS.maxCandidates) return;
        const candidate = validatePeerIceCandidate(input.candidate);
        encoded = JSON.stringify({ t: 'candidate', session: assigned.session, candidate });
        sentCandidates += 1;
      } else if (input && typeof input === 'object' && input.kind === 'connected') {
        if (!sent || !received || complete) return;
        encoded = JSON.stringify({ t: 'connected', session: assigned.session });
      } else {
        const description = validatePeerDescription(input);
        if (sent || description.type !== (assigned.role === 'offerer' ? 'offer' : 'answer'))
          fail('invalid_description', 'Send exactly one description for the assigned role');
        encoded = JSON.stringify({ t: 'description', session: assigned.session, description });
        sent = true;
      }
      if (utf8Bytes(encoded) > PEER_RENDEZVOUS_LIMITS.messageBytes) fail('invalid_description', 'Encoded signaling exceeds the wire limit');
      try { socket.send(encoded); sentBytes += utf8Bytes(encoded); }
      catch (error) { close(new PeerConnectionError('rendezvous_failed', 'Signaling delivery failed')); throw error; }
    },
    close() { close(); },
  });
}

/** Shared browser/agent host client. Construction performs no network work. */
export function createPeersClient({ base, request: dispatch, applicationId, initialBootstrap, protocols = [PEER_RENDEZVOUS_PROTOCOL], socket = (url, protocols) => new WebSocket(url, protocols) }) {
  const prefix = base.replace(/\/+$/, '');
  const request = async (path, options) => { options?.signal?.throwIfAborted(); const value = await (options === undefined ? dispatch(path) : dispatch(path, options)); options?.signal?.throwIfAborted(); return value; };
  const authority = createAuthorityClient(request, { applicationId });
  const discovery = (action, payload, options) => request('peers/discovery', { method: 'POST', body: { action, ...payload }, signal: options?.signal });
  const socketUrl = (path, code) => {
    const url = new URL(prefix + '/' + path);
    if (!['https:', 'http:'].includes(url.protocol) || url.search) fail(code, 'Expected an HTTP service base without query parameters');
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    if (url.username || url.password || url.hash || url.protocol === 'ws:' && !isLoopbackHost(url.hostname))
      fail(code, 'Peer introductions require a secure URL without credentials');
    return url;
  };
  return Object.freeze({
    ...authority,
    initialBootstrap: initialBootstrap === undefined ? null : validatePeerBootstrap(initialBootstrap),
    async bootstrap() { return validatePeerBootstrap(await request('peers/bootstrap')); },
    async setBootstrap(value) { return validatePeerBootstrap(await request('peers/bootstrap', { method: 'PUT', body: validatePeerBootstrap(value) })); },
    async discover(options = {}) { return validatePeerDirectory(await discovery('read', {}, options)); },
    async advertise(value, options = {}) {
      return validatePeerAdvertisementPresence(await discovery('advertise', { advertisement: validatePeerAdvertisement(value) }, options));
    },
    async withdraw(peerId, options = {}) {
      peerId = validatePeerId(peerId);
      const result = await discovery('withdraw', { peerId }, options);
      if (!result || result.withdrawn !== peerId) fail('invalid_response', 'Invalid withdrawal response');
    },
    watchDiscovery(peerId, options = {}) {
      if (typeof peerId !== 'string' || !/^[0-9a-f]{64}$/.test(peerId)) fail('invalid_discovery_watch', 'Discovery requires a signing peer identity');
      validatePeerDiscoveryWatchOptions(options);
      if (options.signal?.aborted) throw options.signal.reason || new DOMException('Aborted', 'AbortError');
      let url;
      try { url = socketUrl('peers/discovery/watch', 'invalid_discovery_watch'); }
      catch { fail('invalid_discovery_watch', 'Discovery requires a secure service URL without credentials'); }
      url.searchParams.set('peerId', peerId);
      const watchProtocols = [PEER_DISCOVERY_PROTOCOL, ...protocols.filter(value =>
        ![PEER_DISCOVERY_PROTOCOL, PEER_RENDEZVOUS_PROTOCOL, PEER_INVITATION_PROTOCOL, PEER_RELAY_PROTOCOL].includes(value))];
      return createPeerDiscoveryWatcher(() => (options.socket || socket)(url.href, watchProtocols), { ...options,
        probeAccess: options.probeAccess ?? (({ signal }) => request('', { signal })),
      });
    },
    listenInvitations(peerId, options = {}) {
      peerId = validatePeerId(peerId);
      if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 60_000))
        fail('invalid_invitation', 'Invalid invitation listener open timeout');
      if (options.signal?.aborted) throw options.signal.reason || new DOMException('Aborted', 'AbortError');
      const url = socketUrl('peers/invitations', 'invalid_invitation'); url.searchParams.set('peerId', peerId);
      const invitationProtocols = [PEER_INVITATION_PROTOCOL, ...protocols.filter(value => value !== PEER_RENDEZVOUS_PROTOCOL && value !== PEER_INVITATION_PROTOCOL)];
      return createPeerInvitationListener((options.socket || socket)(url.href, invitationProtocols), peerId, options);
    },
    async invite(peerId, input, options = {}) {
      peerId = validatePeerId(peerId); const invitation = validatePeerInvitation(input);
      const result = await request('peers/invite', { method: 'POST', body: { peerId, ...invitation }, signal: options.signal });
      if (!result || result.invited !== peerId || result.channel !== invitation.channel) fail('invalid_response', 'Invalid invitation response');
    },
    rendezvous(channel, peerId, options = {}) {
      if (![channel, peerId].every(value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value)))
        fail('invalid_rendezvous', 'Expected bounded channel and endpoint identities');
      const timeoutMs = options.timeoutMs ?? PEER_RENDEZVOUS_LIMITS.lifetimeMs;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > PEER_RENDEZVOUS_LIMITS.lifetimeMs)
        fail('invalid_rendezvous', 'Invalid rendezvous timeout');
      const url = socketUrl('peers/rendezvous', 'invalid_rendezvous');
      url.searchParams.set('channel', channel); url.searchParams.set('peerId', peerId);
      if (options.signal?.aborted) throw options.signal.reason || new DOMException('Aborted', 'AbortError');
      return createPeerRendezvous((options.socket || socket)(url.href, protocols), options);
    },
    relay(channel, peerId, options = {}) {
      if (typeof channel !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(channel) ||
          ![peerId, options.remotePeerId].every(value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)) || peerId === options.remotePeerId)
        fail('invalid_relay', 'Expected a bounded relay channel and two distinct signing identities');
      if (options.signal?.aborted) throw options.signal.reason || new DOMException('Aborted', 'AbortError');
      const url = socketUrl('peers/relay', 'invalid_relay');
      url.searchParams.set('channel', channel); url.searchParams.set('peerId', peerId); url.searchParams.set('remotePeerId', options.remotePeerId);
      url.searchParams.set('liveWindow', String(PEER_RELAY_LIMITS.livePendingPackets));
      const relayProtocols = [PEER_RELAY_PROTOCOL, ...protocols.filter(value => ![PEER_RENDEZVOUS_PROTOCOL, PEER_INVITATION_PROTOCOL, PEER_RELAY_PROTOCOL].includes(value))];
      const open = lane => { const route = new URL(url); route.searchParams.set('lane', lane); return (options.socket || socket)(route.href, relayProtocols); };
      let reliable, live;
      try {
        reliable = open('reliable'); live = open('live');
        return createPeerRelay({ reliable, live }, { ...options, peerId });
      } catch (error) {
        for (const lane of [reliable, live]) try { lane?.close(1000, 'Relay construction failed'); } catch {}
        throw error;
      }
    },
  });
}

export { createPeerIntroductions } from './introductions.mjs';
