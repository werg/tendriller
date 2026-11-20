import { verifyAuthorityBundle } from '@chronolog/peer-session';
import { openBrowserDevice, openBrowserApplication } from '@chronolog/peer-session/worker';
import { openWebSocketConnection } from '@chronolog/peer-session/websocket';
import { createPeersClient, createPeerIntroductions } from '@tendriller/core/peers';
import { serveBrowserOwner } from '@tendriller/core/collaboration/worker';
import { definition } from './domain.mjs';

serveBrowserOwner({ async load({ signal }) {
const configuration = await fetch(new URL('./configuration.json', import.meta.url), { signal }).then(response => {
  if (!response.ok) throw Error('Application configuration is unavailable.');
  return response.json();
});
const profileId = `tendriller-notes-${configuration.applicationId}`;
return { profileId,
  async createIdentity() {
    const device = await openBrowserDevice({ name: profileId, create: true });
    try { return device.identity.publicKey; } finally { await device.close(); }
  },
  async openSession({ signal }) {
    if (new URL(configuration.page_url).origin !== self.location.origin)
      throw Error('Enroll and connect from the signed publication at its own host origin.');
    const device = await openBrowserDevice({ name: profileId });
    let session;
    try {
      const base = new URL('_tendril/', configuration.page_url);
      const peers = createPeersClient({ base: base.href, applicationId: configuration.applicationId,
        async request(path, { method = 'GET', body, signal: requestSignal } = {}) {
          const response = await fetch(new URL(path, base), { method, signal: requestSignal, credentials: 'same-origin', cache: 'no-store',
            ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
          const value = await response.json();
          if (!response.ok) throw Object.assign(Error(value.error?.message || `Host request failed (${response.status})`), {
            code: value.error?.code, status: response.status });
          return value;
        },
      });
      const authority = await peers.application();
      const verified = await verifyAuthorityBundle(authority, configuration.descriptor);
      if (!verified.grant(device.identity.publicKey)?.reader)
        throw Object.assign(Error('This retained browser is not enrolled. Request browser access, review its exact proposal on the service origin, and keep the native peer running to commit it.'), { code: 'DEVICE_NOT_ENROLLED' });
      signal.throwIfAborted();
      session = await openBrowserApplication({ device, definition, authority,
        signals: { localEcho: true, delivery: 'neighbors', limits: { maxSubscriptions: 256 } } });
      const control = session.connectControlParticipant({ exchange: (message, options) => peers.exchange(message, options) });
      await session.participate({ control, ...createPeerIntroductions({
        peers, identity: session.deviceId,
        // The shared owner uses the Worker-native encrypted relay. Closing a
        // particular page does not remove its RTC helper or create another journal.
        openDirectConnection: async () => { throw Error('SHARED_OWNER_USES_NATIVE_RELAY'); },
        openRelayConnection: ({ relay, signal }) => openWebSocketConnection(relay, { ready: relay.ready, signal }),
      }) });
      return { session, control };
    } catch (error) { if (session) await session.close(); else await device.close(); throw error; }
  },
};
}});
