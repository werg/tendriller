import quickJsWasmUrl from '@jitl/quickjs-ng-wasmfile-release-sync/wasm';
import sqliteCasWasmUrl from '@chronolog/peer-session/sqlite-cas.wasm';
import * as log from '@chronolog/peer-session';
import { openBrowserDevice, probeBrowserCapabilities } from '@chronolog/peer-session/worker';
import { openWebSocketConnection } from '@chronolog/peer-session/websocket';
import { createPeersClient } from '@tendriller/core/peers';
import { authorityRecord, authorityRecordBytes } from '@tendriller/core/authority';
import { serveBrowserOwner } from '@tendriller/core/worker-owner';
import { checklist, intake, CHECKLIST_TOPICS, INTAKE_TOPICS } from './sql-domains.mjs';
import { signSpecimenGenesis } from './genesis.mjs';

const fixture = (() => {
  try { return JSON.parse(decodeURIComponent(self.location.hash.slice(1))); } catch { return null; }
})();
const startup = fixture ? new BroadcastChannel('sql-fixture-startup:' + fixture.name) : null;
const control = fixture ? new BroadcastChannel('sql-fixture-control:' + fixture.name) : null;
let session, peers, link, wasmModulesPromise;

const loadWasm = async url => {
  const res = await fetch(new URL(url, self.location.href));
  if (!res.ok) throw Error(`Failed to load WASM (${res.status})`);
  return WebAssembly.compile(await res.arrayBuffer());
};
const loadWasmModules = () => (wasmModulesPromise ??= Promise.all([loadWasm(quickJsWasmUrl), loadWasm(sqliteCasWasmUrl)]));

async function connect(channel, remote) {
  await link?.close();
  const relay = peers.relay(channel, session.identity.publicKey, { remotePeerId: remote, signal: session.signal });
  const connection = await openWebSocketConnection(relay, { ready: relay.ready, signal: session.signal });
  link = await session.connectPeer({ connection, peerIdentity: remote });
  await link.synchronize();
}

function fixturePeers({ applicationId, base: page }, marked) {
  const base = new URL('_tendril/', page);
  return createPeersClient({
    applicationId,
    base: base.href,
    async request(path, { method = 'GET', body, signal } = {}) {
      const response = await fetch(new URL(path, base), {
        method, signal, cache: 'no-store', credentials: 'same-origin',
        headers: { ...(marked ? { 'X-SQL-Fixture-Read': path } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const value = await response.json().catch(() => ({}));
      if (!response.ok) throw Object.assign(new Error(value.error?.message ?? `Host request failed (${response.status})`), { code: value.error?.code, status: response.status });
      return value;
    },
  });
}

async function pageGenesis(device, peersClient, key, members, imports, topics) {
  let metadata = await peersClient.application();
  let casNodes = [];
  if (metadata.genesis === null) {
    if (!members) throw new Error('The creating device has not initialized this page yet');
    const created = await signSpecimenGenesis(log, { metadata, identity: device.identity, members, key, imports, topics });
    casNodes = created.casNodes;
    metadata = await peersClient.initialize({
      genesis: authorityRecord(created.genesisBytes),
      casNodes: created.casNodes.map(n => ({ hash: n.hash, bytes: log.bytesToHex(n.bytes) })),
    });
  }
  const genesisBytes = authorityRecordBytes(metadata.genesis, 1024 * 1024);
  const synced = await peersClient.syncControl({});
  const syncedCas = (synced.casNodes ?? []).map(n => ({ hash: n.hash, bytes: log.hexToBytes(n.bytes), partition: 'public' }));
  const publicOps = (synced.publicOps ?? []).map(r => authorityRecordBytes(r, 256 * 1024));
  return { genesisBytes, casNodes: syncedCas.length ? syncedCas : casNodes, publicOps };
}

self.addEventListener('message', async ({ data }) => {
  if (data?.type === 'capabilities') {
    try { self.postMessage({ type: 'capabilities', report: await probeBrowserCapabilities() }); }
    catch (error) { self.postMessage({ type: 'failure', message: error.message }); }
    return;
  }
  if (data?.type === 'identity') {
    try {
      const device = await openBrowserDevice({ name: data.name, create: true });
      const id = device.identity.publicKey;
      await device.close();
      self.postMessage({ type: 'identity', id });
    } catch (error) { self.postMessage({ type: 'failure', message: error.message }); }
    return;
  }
});

if (control) control.addEventListener('message', async ({ data }) => {
  if (data?.type === 'reconnect' && session) {
    try { await connect(data.channel, data.remote); control.postMessage({ type: 'reconnected' }); }
    catch (error) { control.postMessage({ type: 'failure', message: error.message }); }
  } else if (data?.type === 'release-engine') {
    control.postMessage({ type: 'closed' });
  }
});

if (fixture) serveBrowserOwner({
  async load() {
    return {
      profileId: fixture.name,
      async createIdentity() {
        const device = await openBrowserDevice({ name: fixture.name, create: true });
        try { return device.identity.publicKey; } finally { await device.close(); }
      },
      async openSession() {
        const started = performance.now();
        const progress = stage => startup.postMessage({ type: 'startup-progress', stage, elapsedMs: performance.now() - started });
        let device;
        try {
          device = await openBrowserDevice({ name: fixture.name });
          const isIntake = Boolean(fixture.respondent);
          const definition = isIntake ? intake(log, fixture.respondent) : checklist(log);
          const imports = {};
          const topics = isIntake ? INTAKE_TOPICS : CHECKLIST_TOPICS;
          peers = fixturePeers(fixture, true);
          const key = new Uint8Array(fixture.key);
          const opened = await pageGenesis(device, peers, key, fixture.members, imports, topics);
          progress('metadata-ready');
          progress('engine-load-start');
          const [wasmModule, sqliteWasmModule] = await loadWasmModules();
          progress('engine-load-ready');
          session = await log.createApplicationSession({
            device,
            applicationId: fixture.applicationId,
            definition,
            genesis: opened.genesisBytes,
            casNodes: opened.casNodes,
            wasmModule,
            sqliteWasmModule,
            epochKeys: new Map([[0, key]]),
          });
          if (opened.publicOps.length > 0) {
            await session.mergeFacts({ publicOps: opened.publicOps, encryptedEnvelopes: [], casNodes: opened.casNodes, retentions: [], checkpoints: [] });
          }
          await session.query('ready', null);
          progress('sql-read-ready');
          if (fixture.remote) await connect(fixture.channel, fixture.remote);
          return { session, async close() { await link?.close(); } };
        } catch (error) {
          try { if (session) await session.close(); else await device?.close(); } catch { /* preserve original */ }
          throw error;
        }
      },
    };
  },
});
