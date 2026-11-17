import { validatePeerRoute } from './discovery.mjs';
import { validatePeerInvitation } from './invitations.mjs';

const identityKey = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const invalid = message => { throw Object.assign(new Error(message), { name: 'PeerIntroductionError', code: 'invalid_introduction' }); };
const hint = (identity, route) => Object.freeze({ identity, route });
const invitationRoute = identity => Object.freeze({ kind: 'invitation', peerId: identity });

/** Host routing only. The owned Chronolog session supplies policy and authenticates every opened peer. */
export function createPeerIntroductions({ peers, identity, openConnection }) {
  if (!identityKey(identity) || typeof openConnection !== 'function' ||
      !['discover', 'advertise', 'withdraw', 'listenInvitations', 'invite', 'rendezvous'].every(key => typeof peers?.[key] === 'function'))
    invalid('Provide the session device identity, host peers client and raw connection opener');
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
        await peers.advertise({ peerId: identity, storageId: value.storageId,
          routes: [invitationRoute(identity)] }, { ttlMs, signal });
      },
      async withdraw({ signal }) {
        signal.throwIfAborted();
        await peers.withdraw(identity, { signal });
      },
      async *invitations({ signal }) {
        signal.throwIfAborted();
        const listener = peers.listenInvitations(identity, { signal });
        try {
          await listener.ready;
          for await (const value of listener.invitations) {
            signal.throwIfAborted();
            const token = validatePeerInvitation(value);
            if (identityKey(token.requesterPeerId) && token.requesterPeerId !== identity)
              yield Object.freeze({ peer: hint(token.requesterPeerId, invitationRoute(token.requesterPeerId)), token });
          }
        } finally { listener.close(); }
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
        const signaling = peers.rendezvous(channel, identity, { signal });
        try {
          if (invite) await peers.invite(peer.identity, { channel, requesterPeerId: identity }, { signal });
          const { role } = await signaling.ready;
          signal.throwIfAborted();
          const connection = await openConnection({ role, signaling, signal });
          if (signal.aborted) {
            try { await connection.close(); } catch { /* Preserve the cancellation reason after cleanup. */ }
            signal.throwIfAborted();
          }
          return connection;
        } finally { signaling.close(); }
      },
    }),
  });
}
