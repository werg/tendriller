import * as log from '@chronolog/peer-session';
import { openBrowserDevice, serveApplicationWorker } from '@chronolog/peer-session/worker';
import { openSqlApplication } from '@chronolog/peer-session/sql';
import { createBrowserSqlEngine, loadBrowserEngine } from '@chronolog/peer-session/sql-browser';
import { openWebSocketConnection } from '@chronolog/peer-session/websocket';
import { createPeersClient } from '@tendriller/core/peers';
import { checklist, intake } from './sql-domains.mjs';

let session, pool;
self.addEventListener('message', async ({ data }) => {
  if (data?.type === 'release-engine') {
    try { await pool?.pauseVfs(); }
    finally { self.postMessage({ type: 'closed' }); }
    return;
  }
  if (data?.type === 'identity') {
    try {
      const device = await openBrowserDevice({ name: data.name, create: true });
      const id = device.identity.publicKey;
      await device.close();
      self.postMessage({ type: 'identity', id });
    } catch (error) { self.postMessage({ type: 'failure', message: error.message }); }
  }
  if (data?.type !== 'open' || session) return;
  try {
    const device = await openBrowserDevice({ name: data.name });
    const definition = data.respondent ? intake(log, data.respondent) : checklist(log);
    const base = new URL('_tendril/', data.base);
    const peers = createPeersClient({ applicationId: data.applicationId, base: base.href,
      async request(path, { method = 'GET', body, signal } = {}) {
        const response = await fetch(new URL(path, base), { method, signal, cache: 'no-store',
          ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }) });
        if (!response.ok) throw new Error(`Host request failed (${response.status})`);
        return response.json();
      },
    });
    const advertised = await peers.definition();
    session = await openSqlApplication({
      device, definition, authority: await peers.application(), schema: advertised.schema,
      epochKeys: new Map([[0, data.key]]), databasePath: '/application.sqlite',
      async createEngine() {
        const loaded = await loadBrowserEngine(new URL('./engine/', self.location.href));
        pool = await loaded.module.installOpfsSAHPoolVfs({ name: 'acceptance-sql',
          directory: `acceptance-sql-${data.name}`, initialCapacity: 12 });
        return createBrowserSqlEngine({ ...loaded, vfs: pool.vfsName });
      },
    });
    if (data.remote) {
      const relay = peers.relay(data.channel, session.deviceId, { remotePeerId: data.remote, signal: session.signal });
      const connection = await openWebSocketConnection(relay, { ready: relay.ready, signal: session.signal });
      const link = await session.connectPeer({ connection, peerIdentity: data.remote });
      await link.synchronize();
    }
    serveApplicationWorker(session, self);
    self.postMessage({ type: 'open' });
  } catch (error) {
    await session?.close().catch(() => {});
    if (pool) await pool.pauseVfs();
    self.postMessage({ type: 'failure', message: error.message });
  }
});
