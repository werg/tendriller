// Optional browser SQL owner. Bundle this module; serve engine/ and public
// configuration.json next to its output. The SQL guide describes its messages.
import { verifyAuthorityBundle } from '@chronolog/peer-session';
import { openBrowserDevice, serveApplicationWorker } from '@chronolog/peer-session/worker';
import { openSqlApplication } from '@chronolog/peer-session/sql';
import { openWorkerWebRtcConnection } from '@chronolog/peer-session/webrtc';
import { openWebSocketConnection } from '@chronolog/peer-session/websocket';
import { createPeersClient, createPeerIntroductions } from '@tendriller/core/peers';
import { definition } from './domain.mjs';

let opening = false, openingTask, device, session, bridge, pool;
const lifetime = new AbortController();
async function release() {
  // The SQL session closes its database handles. The application still owns
  // its external OPFS pool and releases it only after those handles close.
  try { if (bridge) await bridge.close(); else if (session) await session.close(); else await device?.close(); }
  finally { const ownedPool = pool; pool = undefined; await ownedPool?.pauseVfs(); }
}
async function close() {
  lifetime.abort(Error('SQL worker owner closed.'));
  // Closing a partially opened session cancels participation. Then wait for
  // setup to finish unwinding so no device or VFS can appear after sql-closed.
  await Promise.allSettled([session?.close(), openingTask]);
  await release();
}

self.addEventListener('message', async ({ data }) => {
  if (data?.type === 'sql-close') {
    try { await close(); self.postMessage({ type: 'sql-closed' }); }
    catch (error) { self.postMessage({ type: 'sql-failure', message: error.message }); }
    return;
  }
  if (!['sql-create', 'sql-open'].includes(data?.type) || opening || lifetime.signal.aborted) return;
  opening = true;
  openingTask = open(data.type);
  await openingTask;
});

async function open(type) {
  try {
    const configuration = await fetch(new URL('./configuration.json', import.meta.url), { signal: lifetime.signal }).then(response => {
      if (!response.ok) throw Error('Application configuration is unavailable.');
      return response.json();
    });
    if (new URL(configuration.page_url).origin !== self.location.origin) {
      throw Error('Open this worker at its authorized page origin; localhost does not inherit its account cookie or device.');
    }
    const name = `tendriller-inventory-${configuration.applicationId}`;
    lifetime.signal.throwIfAborted();
    device = await openBrowserDevice({ name, ...(type === 'sql-create' ? { create: true } : {}) });
    lifetime.signal.throwIfAborted();
    const publicKey = device.identity.publicKey;
    if (type === 'sql-create') {
      await device.close();
      self.postMessage({ type: 'sql-identity', publicKey });
      return;
    }
    const base = new URL('_tendril/', configuration.page_url);
    const peers = createPeersClient({ base: base.href, applicationId: configuration.applicationId,
      async request(path, { method = 'GET', body, signal } = {}) {
        const response = await fetch(new URL(path, base), { method,
          signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(30_000), ...[signal].filter(Boolean)]),
          credentials: 'same-origin', cache: 'no-store',
          ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
        const value = await response.json();
        if (!response.ok) throw Object.assign(Error(value.error?.message || `Host request failed (${response.status})`), {
          code: value.error?.code, status: response.status });
        return value;
      },
    });
    const authority = await peers.application();
    const verified = await verifyAuthorityBundle(authority, configuration.descriptor);
    if (!verified.grant(publicKey)?.reader) throw Error(`Enroll this browser's verified public key: npm run enroll -- ${publicKey}`);
    const advertised = await peers.definition();
    session = await openSqlApplication({ device, definition, authority, schema: advertised.schema,
      databasePath: '/inventory.sqlite',
      async createEngine({ signal }) {
        // The loader and VFS stay inside the first durable data demand, never
        // in the page's eager graph. This uses the actual exact SQL engine.
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
    lifetime.signal.throwIfAborted();
    const control = session.connectControlParticipant({ exchange: (message, options) => peers.exchange(message, options) });
    await session.participate({ control, ...createPeerIntroductions({ peers, identity: session.deviceId,
      openDirectConnection: options => openWorkerWebRtcConnection(self, options),
      openRelayConnection: ({ relay, signal }) => openWebSocketConnection(relay, { ready: relay.ready, signal }),
    }) });
    lifetime.signal.throwIfAborted();
    // No epoch key or native credential is published. The enrolled reader gets
    // keys from the native peer over authenticated encrypted participation.
    bridge = serveApplicationWorker(session, self, { host: control });
    self.postMessage({ type: 'sql-opened', publicKey });
  } catch (error) {
    try { await release(); } catch { /* Preserve the opening failure. */ }
    self.postMessage({ type: 'sql-failure', message: `${error.code ?? error.name}: ${error.message}` });
  }
}
