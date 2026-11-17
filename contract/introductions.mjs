import { validatePeerRoute } from './discovery.mjs';
import { validatePeerInvitation } from './invitations.mjs';

const identityKey = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const invalid = message => { throw Object.assign(new Error(message), { name: 'PeerIntroductionError', code: 'invalid_introduction' }); };
const hint = (identity, route) => Object.freeze({ identity, route });
const invitationRoute = identity => Object.freeze({ kind: 'invitation', peerId: identity });

function until(value, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cancelled = () => { signal.removeEventListener('abort', cancelled); reject(signal.reason); };
    signal.addEventListener('abort', cancelled, { once: true });
    void value.then(result => { signal.removeEventListener('abort', cancelled); resolve(result); },
      error => { signal.removeEventListener('abort', cancelled); reject(error); });
  });
}

/** Host routing only. The owned Chronolog session supplies policy and authenticates every opened peer. */
export function createPeerIntroductions({ peers, identity, openDirectConnection, openRelayConnection, directTimeoutMs = 5000 }) {
  if (!identityKey(identity) || typeof openDirectConnection !== 'function' || typeof openRelayConnection !== 'function' ||
      !Number.isSafeInteger(directTimeoutMs) || directTimeoutMs < 1 || directTimeoutMs > 30_000 ||
      !['discover', 'advertise', 'withdraw', 'listenInvitations', 'invite', 'rendezvous', 'relay'].every(key => typeof peers?.[key] === 'function'))
    invalid('Provide the session device identity, host peers client and direct/relay connection openers');
  let activeListener, nextListener = Promise.withResolvers();
  return Object.freeze({
    discovery: Object.freeze({
      async read({ signal }) {
        signal.throwIfAborted();
        const directory = await peers.discover({ signal });
        signal.throwIfAborted();
        return Object.freeze(directory.peers.flatMap(({ advertisement }) => {
          const remote = advertisement.peerId;
          if (!identityKey(remote) || remote === identity) return [];
          const route = advertisement.routes.find(value => value.kind === 'invitation' && value.peerId === remote)
            ?? advertisement.routes.find(value => value.kind === 'rendezvous');
          return route ? [hint(remote, validatePeerRoute(route))] : [];
        }));
      },
      async advertise(value, { ttlMs, signal }) {
        signal.throwIfAborted();
        if (value.identity !== identity) invalid('An advertisement must identify this owned session');
        const listener = await until(nextListener.promise, signal);
        await until(listener.ready, signal);
        signal.throwIfAborted();
        if (activeListener !== listener) invalid('The invitation listener ended before advertising');
        await peers.advertise({ peerId: identity, storageId: value.storageId,
          routes: [invitationRoute(identity)] }, { ttlMs, signal });
      },
      async withdraw({ signal }) {
        signal.throwIfAborted();
        await peers.withdraw(identity, { signal });
      },
      async *invitations({ signal }) {
        signal.throwIfAborted();
        if (activeListener) invalid('The owned session has one invitation listener');
        const listener = peers.listenInvitations(identity, { signal });
        activeListener = listener; nextListener.resolve(listener);
        try {
          await listener.ready;
          for await (const value of listener.invitations) {
            signal.throwIfAborted();
            const token = validatePeerInvitation(value);
            if (identityKey(token.requesterPeerId) && token.requesterPeerId !== identity)
              yield Object.freeze({ peer: hint(token.requesterPeerId, invitationRoute(token.requesterPeerId)), token });
          }
        } finally {
          if (activeListener === listener) { activeListener = undefined; nextListener = Promise.withResolvers(); }
          listener.close();
        }
      },
    }),
    transport: Object.freeze({
      async open({ peer, invitation }, { signal }) {
        signal.throwIfAborted();
        if (!identityKey(peer?.identity) || peer.identity === identity) invalid('An introduction must name a different signing identity');
        let channel, invite = false;
        if (invitation !== undefined) {
          const token = validatePeerInvitation(invitation);
          if (token.requesterPeerId !== peer.identity) invalid('Invitation sender does not match the expected peer');
          channel = token.channel;
        } else {
          const route = validatePeerRoute(peer.route);
          if (route.kind === 'invitation' && route.peerId === peer.identity) {
            channel = `join:${crypto.randomUUID()}`; invite = true;
          } else if (route.kind === 'rendezvous') channel = route.channel;
          else invalid('This host adapter needs an invitation or rendezvous route');
        }
        const direct = new AbortController(), directSignal = AbortSignal.any([signal, direct.signal]);
        const signaling = peers.rendezvous(channel, identity, { signal: directSignal });
        let timer;
        try {
          if (invite) await peers.invite(peer.identity, { channel, requesterPeerId: identity }, { signal });
          timer = setTimeout(() => direct.abort(new Error('PEER_DIRECT_CONNECTION_TIMEOUT')), directTimeoutMs);
          const opening = until(signaling.ready, directSignal).then(async ({ role }) => {
            directSignal.throwIfAborted();
            return openDirectConnection({ role, signaling, signal: directSignal });
          });
          // A slow platform opener cannot leak its connection after the fallback wins.
          const owned = opening.then(async value => { if (directSignal.aborted) await value.close(); return value; });
          void owned.catch(() => {});
          try {
            const connection = await until(owned, directSignal);
            directSignal.throwIfAborted(); return connection;
          } catch (error) {
            direct.abort(error);
            // Keep an uncooperative platform opener charged to the session's
            // physical-opening budget until it actually relinquishes resources.
            await owned.catch(() => {}); signal.throwIfAborted();
          }
        } finally { clearTimeout(timer); signaling.close(); }
        signal.throwIfAborted();
        const relay = peers.relay(channel, identity, { remotePeerId: peer.identity, signal });
        const opening = Promise.resolve().then(() => { signal.throwIfAborted(); return openRelayConnection({ relay, signal }); });
        void opening.then(value => { if (signal.aborted) return value.close(); }, () => {}).catch(() => {});
        try {
          const connection = await until(opening, signal);
          signal.throwIfAborted(); return connection;
        } catch (error) { relay.close(); throw error; }
      },
    }),
  });
}
