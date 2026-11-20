// Optional SQL owner. Publish its matching engine assets and configuration.
import { verifyAuthorityBundle } from '@chronolog/peer-session';
import { openBrowserDevice } from '@chronolog/peer-session/worker';
import { openSqlApplication } from '@chronolog/peer-session/sql';
import { openWebSocketConnection } from '@chronolog/peer-session/websocket';
import { createPeersClient, createPeerIntroductions } from '@tendriller/core/peers';
import { serveBrowserOwner } from '@tendriller/core/collaboration/worker';
import { definition } from './domain.mjs';

serveBrowserOwner({ async load({ signal }) {
const configuration = await fetch(new URL('./configuration.json', import.meta.url), { signal }).then(response => {
  if (!response.ok) throw Error('Application configuration is unavailable.');
  return response.json();
});
const profileId = `tendriller-inventory-${configuration.applicationId}`;
return { profileId,
  async createIdentity() {
    const device = await openBrowserDevice({ name: profileId, create: true });
    try { return device.identity.publicKey; } finally { await device.close(); }
  },
  async openSession({ signal }) {
    if (new URL(configuration.page_url).origin !== self.location.origin)
      throw Error('Open this owner at its authorized page origin; localhost does not inherit its account or device.');
    const device = await openBrowserDevice({ name: profileId });
    let session, pool;
    const releasePool = async () => { const owned = pool; pool = undefined; await owned?.pauseVfs(); };
    try {
      const base = new URL('_tendril/', configuration.page_url);
      const peers = createPeersClient({ base: base.href, applicationId: configuration.applicationId,
        async request(path, { method = 'GET', body, signal: requestSignal } = {}) {
          const response = await fetch(new URL(path, base), { method,
            signal: AbortSignal.any([signal, AbortSignal.timeout(30_000), ...[requestSignal].filter(Boolean)]),
            credentials: 'same-origin', cache: 'no-store',
            ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
          const value = await response.json();
          if (!response.ok) throw Object.assign(Error(value.error?.message || `Host request failed (${response.status})`),
            { code: value.error?.code, status: response.status });
          return value;
        },
      });
      const authority = await peers.application(), verified = await verifyAuthorityBundle(authority, configuration.descriptor);
      if (!verified.grant(device.identity.publicKey)?.reader)
        throw Error(`Enroll this browser's verified public key: npm run enroll -- ${device.identity.publicKey}`);
      const advertised = await peers.definition();
      signal.throwIfAborted();
      session = await openSqlApplication({ device, definition, authority, schema: advertised.schema, databasePath: '/inventory.sqlite',
        signals: { localEcho: true, delivery: 'neighbors', limits: { maxSubscriptions: 256 } },
        async createEngine({ signal }) {
          // Protocol-only attachments never import the SQL loader or open OPFS.
          const { createBrowserSqlEngine, loadBrowserEngine } = await import('@chronolog/peer-session/sql-browser');
          const loaded = await loadBrowserEngine(new URL('./engine/', import.meta.url));
          signal.throwIfAborted();
          if (!loaded.module.installOpfsSAHPoolVfs) throw Error('SQL_OPFS_POOL_UNAVAILABLE');
          pool = await loaded.module.installOpfsSAHPoolVfs({ name: `inventory-${configuration.applicationId}`,
            directory: `inventory-${configuration.applicationId}`, initialCapacity: 12 });
          signal.throwIfAborted();
          return createBrowserSqlEngine({ ...loaded, vfs: pool.vfsName });
        },
      });
      const control = session.connectControlParticipant({ exchange: (message, options) => peers.exchange(message, options) });
      await session.participate({ control, ...createPeerIntroductions({ peers, identity: session.deviceId,
        openDirectConnection: async () => { throw Error('SHARED_OWNER_USES_NATIVE_RELAY'); },
        openRelayConnection: ({ relay, signal }) => openWebSocketConnection(relay, { ready: relay.ready, signal }),
      }) });
      // The owner closes the session's database handles before this external VFS.
      return { session, control, close: releasePool };
    } catch (error) {
      try { if (session) await session.close(); else await device.close(); } finally { await releasePool(); }
      throw error;
    }
  },
};
}});
