import * as log from '@chronolog/peer-session';
import { openBrowserDevice, probeBrowserCapabilities, serveApplicationWorker } from '@chronolog/peer-session/worker';
import { openSqlApplication } from '@chronolog/peer-session/sql';
import { createBrowserSqlEngine, loadBrowserEngine } from '@chronolog/peer-session/sql-browser';
import { openWebSocketConnection } from '@chronolog/peer-session/websocket';
import { createPeersClient } from '@tendriller/core/peers';
import { checklist, intake } from './sql-domains.mjs';

let session, pool, peers, link;
async function connect(channel, remote) {
  await link?.close();
  const relay = peers.relay(channel, session.deviceId, { remotePeerId: remote, signal: session.signal });
  const connection = await openWebSocketConnection(relay, { ready: relay.ready, signal: session.signal });
  link = await session.connectPeer({ connection, peerIdentity: remote });
  await link.synchronize();
}
self.addEventListener('message', async ({ data }) => {
  if (data?.type === 'inspect-state') {
    const state = session?.status;
    self.postMessage({ type: 'inspected-state', state: { phase: state?.phase ?? null, database: state?.database ?? null,
      sequence: session?.revision?.point.sequence ?? null, role: state?.role ?? null,
      linkClosed: link?.signal.aborted ?? null, linkData: link?.data ?? null, linkStats: link?.stats ?? null } });
    return;
  }
  if (data?.type === 'capabilities') {
    try {
      self.postMessage({ type: 'capabilities', report: await probeBrowserCapabilities() });
    } catch (error) { self.postMessage({ type: 'failure', message: error.message }); }
    return;
  }
  if (data?.type === 'reconnect' && session) {
    try {
      await connect(data.channel, data.remote);
      self.postMessage({ type: 'reconnected' });
    } catch (error) { self.postMessage({ type: 'failure', message: error.message }); }
    return;
  }
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
  const started = performance.now();
  const progress = stage => self.postMessage({ type: 'startup-progress', stage, elapsedMs: performance.now() - started });
  let device;
  try {
    // The acceptance harness checks scratch diagnostics before enrollment.
    // Opening the real engine below is the authoritative SQL/VFS check.
    device = await openBrowserDevice({ name: data.name });
    const definition = data.respondent ? intake(log, data.respondent) : checklist(log);
    const base = new URL('_tendril/', data.base);
    peers = createPeersClient({ applicationId: data.applicationId, base: base.href,
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
        progress('engine-load-start');
        const loaded = await loadBrowserEngine(new URL('./engine/', self.location.href));
        progress('engine-load-ready');
        pool = await loaded.module.installOpfsSAHPoolVfs({ name: 'acceptance-sql',
          directory: `acceptance-sql-${data.name}`, initialCapacity: 12 });
        progress('opfs-ready');
        return createBrowserSqlEngine({ ...loaded, vfs: pool.vfsName });
      },
    });
    progress('metadata-ready');
    // openSqlApplication is metadata-ready, with SQL still lazy. Qualify this
    // explicitly SQL fixture in its SQL-readiness phase before exposing the
    // page RPC facade; metadata preparation and SQL activation have separate
    // bounded budgets, and normal UI RPCs retain their shorter deadline.
    await session.query(data.respondent ? 'answer' : 'board', null);
    progress('sql-read-ready');
    if (data.remote) await connect(data.channel, data.remote);
    serveApplicationWorker(session, self);
    self.postMessage({ type: 'open' });
  } catch (error) {
    // Capability and engine errors can happen after identity metadata opens
    // but before session ownership transfers. Always close that device.
    try {
      if (session) await session.close();
      else await device?.close();
    } catch { /* Preserve the original opening failure. */ }
    try { await pool?.pauseVfs(); } catch { /* Preserve the original failure. */ }
    self.postMessage({ type: 'failure', message: error.message });
  }
});
