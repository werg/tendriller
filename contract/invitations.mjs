import { validatePeerId } from './discovery.mjs';

export const PEER_INVITATION_PROTOCOL = 'tendriller.invitations.v1';
export const PEER_INVITATION_LIMITS = Object.freeze({ listeners: 64, listenersPerPrincipal: 8,
  pending: 8, invitationsPerMinute: 32, messageBytes: 1024, openTimeoutMs: 15_000 });
const bytes = value => new TextEncoder().encode(value).byteLength;
const failure = (code, message) => Object.assign(new Error(message), { code });
export function validatePeerInvitation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2 ||
      typeof value.channel !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(value.channel))
    throw failure('invalid_invitation', 'Expected a bounded connection invitation');
  return Object.freeze({ channel: value.channel, requesterPeerId: validatePeerId(value.requesterPeerId) });
}

/** Receive-only connection hints, with consumption ACKs bounding host-side pending work. */
export function createPeerInvitationListener(socket, peerId, { signal, timeoutMs = PEER_INVITATION_LIMITS.openTimeoutMs } = {}) {
  peerId = validatePeerId(peerId);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
    throw failure('invalid_invitation', 'Invalid invitation listener open timeout');
  let ended = false, opened = false, error, reading = false, waiting, receivedBytes = 0, sentBytes = 0, receivedInvitations = 0;
  let resolveReady, rejectReady, resolveClosed;
  const queue = [], ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  void ready.catch(() => {});
  const finish = (cause, code = 1000, reason = 'Invitation listener closed') => {
    if (ended) return;
    ended = true; error = cause; clearTimeout(timer);
    for (const [type, listener] of listeners) socket.removeEventListener(type, listener);
    signal?.removeEventListener('abort', cancelled);
    if (!opened) rejectReady(cause || failure('invitation_closed', reason));
    waiting?.(); waiting = undefined; resolveClosed(Object.freeze({ code, reason }));
  };
  const close = (cause, code = 1000, reason = 'Invitation listener closed') => {
    finish(cause, code, reason);
    if (socket.readyState < 2) socket.close(code, reason.slice(0, 100));
  };
  const message = event => {
    if (ended) return;
    try {
      if (typeof event.data !== 'string' || bytes(event.data) > PEER_INVITATION_LIMITS.messageBytes)
        throw failure('invalid_invitation', 'Invitations contain bounded routing hints only');
      const value = JSON.parse(event.data); receivedBytes += bytes(event.data);
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 3)
        throw failure('invalid_invitation', 'Invalid invitation frame');
      if (value.t === 'ready' && !opened && value.version === 1 && value.peerId === peerId) {
        opened = true; clearTimeout(timer); resolveReady(); return;
      }
      if (!opened || value.t !== 'invitation') throw failure('invalid_invitation', 'Unexpected invitation frame');
      if (queue.length >= PEER_INVITATION_LIMITS.pending) throw failure('invitation_backpressure', 'Invitation consumer is not keeping up');
      queue.push(validatePeerInvitation({ channel: value.channel, requesterPeerId: value.requesterPeerId }));
      receivedInvitations++; waiting?.(); waiting = undefined;
    } catch (cause) { close(cause, 1008, 'Invalid invitation frame'); }
  };
  const disconnected = event => finish(event?.code === 1000 ? undefined : failure('invitation_closed', 'Invitation connection closed'), event?.code ?? 1006, event?.reason ?? 'Invitation connection closed');
  const errored = () => close(failure('invitation_failed', 'Invitation transport failed'), 1011, 'Invitation transport failed');
  const cancelled = () => close(signal.reason || new DOMException('Aborted', 'AbortError'));
  const listeners = [['message', message], ['close', disconnected], ['error', errored]];
  const timer = setTimeout(() => close(failure('invitation_timeout', 'Invitation listener timed out'), 1000, 'Invitation open timed out'), timeoutMs);
  for (const [type, listener] of listeners) socket.addEventListener(type, listener);
  signal?.addEventListener('abort', cancelled, { once: true });
  if (signal?.aborted) cancelled();
  else if (socket.readyState > 1) disconnected();
  return Object.freeze({ ready, closed,
    get stats() { return Object.freeze({ receivedBytes, sentBytes, receivedInvitations, closed: ended }); },
    invitations: { async *[Symbol.asyncIterator]() {
      if (reading) throw failure('reader_exists', 'Invitations have one consumer');
      reading = true;
      try {
        while (!ended) {
          if (!queue.length) { await new Promise(resolve => { waiting = resolve; }); continue; }
          const invitation = queue.shift();
          const ack = JSON.stringify({ t: 'received', ...invitation });
          try { socket.send(ack); sentBytes += bytes(ack); }
          catch (cause) { close(cause, 1011, 'Invitation acknowledgement failed'); break; }
          yield invitation;
        }
        if (error) throw error;
      } finally { reading = false; }
    } },
    close() { close(); },
  });
}
