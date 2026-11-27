import { PEER_TRANSPORT_POLICY } from './transport-policy.mjs';
import { validatePeerRoute, validatePeerAdvertisement } from './discovery.mjs';
import { validatePeerDiscoveryNotification } from './discovery-watch.mjs';
import { validatePeerInvitation } from './invitations.mjs';

const identityKey = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const invalid = message => { throw Object.assign(new Error(message), { name: 'PeerIntroductionError', code: 'invalid_introduction', retryable: false }); };
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
export function createPeerIntroductions({ peers, identity, openDirectConnection, openRelayConnection, directTimeoutMs = PEER_TRANSPORT_POLICY.directTimeoutMs, onTransport }) {
  if (onTransport !== undefined && typeof onTransport !== 'function' || !identityKey(identity) || typeof openDirectConnection !== 'function' || typeof openRelayConnection !== 'function' ||
      !Number.isSafeInteger(directTimeoutMs) || directTimeoutMs < 1 || directTimeoutMs > 30_000 ||
      !['watchDiscovery', 'discover', 'advertise', 'withdraw', 'listenInvitations', 'invite', 'rendezvous', 'relay'].every(key => typeof peers?.[key] === 'function'))
    invalid('Provide the session device identity, host peers client and direct/relay connection openers');
  const selected = (peerId, kind, reason) => {
    try { void Promise.resolve(onTransport?.(Object.freeze({ peerId, kind, ...(reason ? { reason } : {}) }))).catch(() => {}); }
    catch { /* Diagnostics cannot change connection selection or ownership. */ }
  };
  const descriptions = new WeakMap();
  let activeListener, nextListener = Promise.withResolvers(), activeWatcher, nextWatcher = Promise.withResolvers();
  let advertisementEpoch = 0, advertisementRequest = 0, confirmedAdvertisement;
  const invalidateAdvertisement = () => { advertisementEpoch++; confirmedAdvertisement = undefined; };
  async function open({ peer, invitation }, { signal }, directOnly) {
        signal.throwIfAborted();
        if (!identityKey(peer?.identity) || peer.identity === identity) invalid('An introduction must name a different signing identity');
        let channel, invite = false;
        if (invitation !== undefined) {
          const token = validatePeerInvitation(invitation);
          if (token.requesterPeerId !== peer.identity) invalid('Invitation sender does not match the expected peer');
          channel = token.channel; directOnly ||= channel.startsWith('direct:');
        } else {
          const route = directOnly ? invitationRoute(peer.identity) : validatePeerRoute(peer.route);
          if (route.kind === 'invitation' && route.peerId === peer.identity) {
            channel = `${directOnly ? 'direct' : 'join'}:${crypto.randomUUID()}`; invite = true;
          } else if (route.kind === 'rendezvous') channel = route.channel;
          else invalid('This host adapter needs an invitation or rendezvous route');
        }
        const direct = new AbortController(), directSignal = AbortSignal.any([signal, direct.signal]);
        const signaling = peers.rendezvous(channel, identity, { signal: directSignal });
        let timer, timedOut = false;
        try {
          if (invite) await peers.invite(peer.identity, { channel, requesterPeerId: identity }, { signal });
          timer = setTimeout(() => { timedOut = true; direct.abort(new Error('PEER_DIRECT_CONNECTION_TIMEOUT')); }, directTimeoutMs);
          const opening = until(signaling.ready, directSignal).then(async ({ role }) => {
            directSignal.throwIfAborted();
            return openDirectConnection({ role, signaling, signal: directSignal });
          });
          // A slow platform opener cannot leak its connection after the fallback wins.
          const owned = opening.then(async value => { if (directSignal.aborted) await value.close(); return value; });
          void owned.catch(() => {});
          try {
            const connection = await until(owned, directSignal);
            directSignal.throwIfAborted(); descriptions.set(connection, Object.freeze({kind:'direct'})); selected(peer.identity, 'direct'); return connection;
          } catch (error) {
            direct.abort(error);
            // Keep an uncooperative platform opener charged to the session's
            // physical-opening budget until it actually relinquishes resources.
            await owned.catch(() => {}); signal.throwIfAborted();
            if (directOnly) throw error;
          }
        } finally { clearTimeout(timer); signaling.close(); }
        signal.throwIfAborted();
        const relay = peers.relay(channel, identity, { remotePeerId: peer.identity, signal });
        const opening = Promise.resolve().then(() => { signal.throwIfAborted(); return openRelayConnection({ relay, signal }); });
        void opening.then(value => { if (signal.aborted) return value.close(); }, () => {}).catch(() => {});
        try {
          const connection = await until(opening, signal);
          signal.throwIfAborted(); const reason = timedOut ? 'direct_timeout' : 'direct_failed'; descriptions.set(connection, Object.freeze({kind:'relay',reason})); selected(peer.identity, 'relay', reason); return connection;
        } catch (error) { relay.close(); throw error; }
  }
  return Object.freeze({
    discovery: Object.freeze({
      async *notifications({ signal }) {
        signal.throwIfAborted();
        if (activeWatcher) invalid('The owned session has one discovery watcher');
        const watcher = peers.watchDiscovery(identity, { signal });
        invalidateAdvertisement(); activeWatcher = watcher; nextWatcher.resolve(watcher);
        try {
          for await (const value of watcher.notifications) {
            signal.throwIfAborted();
            const notification = validatePeerDiscoveryNotification(value);
            if (notification.type === 'ready') invalidateAdvertisement();
            yield notification;
          }
        } finally {
          if (activeWatcher === watcher) { invalidateAdvertisement(); activeWatcher = undefined; nextWatcher = Promise.withResolvers(); }
          watcher.close();
        }
      },
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
      async advertise(value, { signal }) {
        signal.throwIfAborted();
        if (value.identity !== identity) invalid('An advertisement must identify this owned session');
        const advertisement = validatePeerAdvertisement({ peerId: identity, storageId: value.storageId, routes: [invitationRoute(identity)] });
        const key = JSON.stringify(advertisement);
        const watcher = await until(nextWatcher.promise, signal);
        await until(watcher.ready, signal);
        signal.throwIfAborted();
        if (activeWatcher !== watcher) invalid('The discovery watcher ended before advertising');
        const listener = await until(nextListener.promise, signal);
        await until(listener.ready, signal);
        signal.throwIfAborted();
        if (activeListener !== listener) invalid('The invitation listener ended before advertising');
        if (confirmedAdvertisement === key) return;
        const epoch = advertisementEpoch, request = ++advertisementRequest;
        confirmedAdvertisement = undefined;
        try {
          await peers.advertise(advertisement, { signal });
          signal.throwIfAborted();
          // A late or uncertain response must never restore a cache invalidated
          // by a new socket, invitation listener, withdrawal or another request.
          confirmedAdvertisement = epoch === advertisementEpoch && request === advertisementRequest ? key : undefined;
        } catch (error) { confirmedAdvertisement = undefined; throw error; }
      },
      probe() {
        try { activeWatcher?.probe?.(); } catch {}
        try { activeListener?.probe?.(); } catch {}
      },
      async withdraw({ signal }) {
        signal.throwIfAborted();
        invalidateAdvertisement();
        await peers.withdraw(identity, { signal });
      },
      async *invitations({ signal, onReady }) {
        signal.throwIfAborted();
        if (activeListener) invalid('The owned session has one invitation listener');
        const listener = peers.listenInvitations(identity, { signal });
        invalidateAdvertisement(); activeListener = listener; nextListener.resolve(listener);
        try {
          await listener.ready;
          try { onReady?.(); } catch {}
          for await (const value of listener.invitations) {
            signal.throwIfAborted();
            const token = validatePeerInvitation(value);
            if (identityKey(token.requesterPeerId) && token.requesterPeerId !== identity)
              yield Object.freeze({ peer: hint(token.requesterPeerId, invitationRoute(token.requesterPeerId)), token, ...(token.channel.startsWith('direct:') ? { upgrade: true } : {}) });
          }
        } finally {
          if (activeListener === listener) { invalidateAdvertisement(); activeListener = undefined; nextListener = Promise.withResolvers(); }
          listener.close();
        }
      },
    }),
    transport: Object.freeze({
      open: (input, options) => open(input, options, false),
      upgrade: (input, options) => open(input, options, true),
      describe: connection => descriptions.get(connection) ?? Object.freeze({kind:'unknown'}),
    }),
  });
}
