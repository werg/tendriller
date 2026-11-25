import * as log from '@chronolog/peer-session';
import { openBrowserDevice, probeBrowserCapabilities } from '@chronolog/peer-session/worker';
import { createSqlMaterializationRuntime } from '@chronolog/peer-session/sql';
import { createBrowserSqlEngine, loadBrowserEngine } from '@chronolog/peer-session/sql-browser';
import { openWebSocketConnection } from '@chronolog/peer-session/websocket';
import { createPeersClient } from '@tendriller/core/peers';
import { authorityRecord, authorityRecordBytes } from '@tendriller/core/authority';
import { serveBrowserOwner } from '@tendriller/core/worker-owner';
import { checklist, intake } from './sql-domains.mjs';

// Fixture input is test provisioning from outside the signed code graph. It travels in this Worker URL's
// fragment, which is never sent over the network: { name, base, applicationId, key, respondent }.
const fixture = (() => {
  try { return JSON.parse(decodeURIComponent(self.location.hash.slice(1))); } catch { return null; }
})();
const startup = fixture ? new BroadcastChannel('sql-fixture-startup:' + fixture.name) : null;
const control = fixture ? new BroadcastChannel('sql-fixture-control:' + fixture.name) : null;
let session, pool, peers, link;

async function connect(channel, remote) {
  await link?.close();
  const relay = peers.relay(channel, session.identity.publicKey, { remotePeerId: remote, signal: session.signal });
  const connection = await openWebSocketConnection(relay, { ready: relay.ready, signal: session.signal });
  link = await session.connectPeer({ connection, peerIdentity: remote });
  await link.synchronize();
}

// The marker lets the acceptance harness delay exactly the measured opening Worker's metadata read, never
// the page's own requests or the separate explicit enrollment below.
function fixturePeers({ applicationId, base: page }, marked) {
  const base = new URL('_tendril/', page);
  return createPeersClient({ applicationId, base: base.href,
    async request(path, { method = 'GET', body, signal } = {}) {
      const response = await fetch(new URL(path, base), { method, signal, cache: 'no-store', credentials: 'same-origin',
        headers: { ...(marked ? { 'X-SQL-Fixture-Read': path } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const value = await response.json().catch(() => ({}));
      if (!response.ok) throw Object.assign(new Error(value.error?.message ?? `Host request failed (${response.status})`), { code: value.error?.code, status: response.status });
      return value;
    },
  });
}

// Hosts sign authority from this device's own enrollment proof; the data key is the explicit test-provisioned
// one, so an additional device never invents a replacement key. Proof only binds the key to this account: an
// additional device becomes a member (reader/writer) only through the owner's separate explicit grant.
async function enroll(device, peers, applicationId, key) {
  let metadata = await peers.application();
  let epoch = 0, epochKeyDigest = await log.epochKeyCommitment(applicationId, 0, key);
  if (metadata.authority !== null) {
    const previous = log.decodeRecord(authorityRecordBytes(metadata.authority));
    await log.verifyAuthorityBundle(previous);
    ({ epoch, epochKeyDigest } = previous.memberships.at(-1).payload);
  }
  const challenge = await peers.challenge(device.identity.publicKey);
  const proof = await log.signEnrollmentRequest({ applicationId: challenge.applicationId, publicKey: challenge.publicKey,
    challenge: challenge.challenge, epoch, epochKeyDigest }, device.identity);
  metadata = await peers.enroll(authorityRecord(log.encodeRecord(proof)));
  if (!metadata.authority) throw new Error('The owner must sign in before this device is enrolled');
  const bundle = log.decodeRecord(authorityRecordBytes(metadata.authority));
  await log.verifyAuthorityBundle(bundle);
  return bundle;
}

// The throwaway capability/identity Worker: a plain Worker of this same file answers these two messages
// without ever receiving the owner boot protocol, so no session is opened by the probe.
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
  // Explicit enrollment proof for an additional device, before its session opens. It caches no authority:
  // the opening Worker reads the bundle again after the owner's grant.
  if (data?.type === 'enroll') {
    try {
      const device = await openBrowserDevice({ name: data.name });
      try { await enroll(device, fixturePeers(data, false), data.applicationId, new Uint8Array(data.key)); }
      finally { await device.close(); }
      self.postMessage({ type: 'enrolled' });
    } catch (error) { self.postMessage({ type: 'failure', message: error.message }); }
  }
});

// Fixture-only control of the live owner Worker. The application session itself is attached through the
// public browser-owner protocol; these messages only move the one-shot relay and release the SQL VFS.
if (control) control.addEventListener('message', async ({ data }) => {
  if (data?.type === 'reconnect' && session) {
    try { await connect(data.channel, data.remote); control.postMessage({ type: 'reconnected' }); }
    catch (error) { control.postMessage({ type: 'failure', message: error.message }); }
  } else if (data?.type === 'release-engine') {
    try { await pool?.pauseVfs(); } finally { control.postMessage({ type: 'closed' }); }
  }
});

if (fixture) serveBrowserOwner({ async load() {
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
      const release = async () => { const owned = pool; pool = undefined; await owned?.pauseVfs(); };
      try {
        // The acceptance harness checks scratch diagnostics before enrollment. Opening the real engine
        // below is the authoritative SQL/VFS check. The enrolled identity already exists: never create one.
        device = await openBrowserDevice({ name: fixture.name });
        const definition = fixture.respondent ? intake(log, fixture.respondent) : checklist(log);
        peers = fixturePeers(fixture, true);
        const key = new Uint8Array(fixture.key);
        let authority;
        try { authority = await log.createAuthorityProvider({ store: device.store, applicationId: fixture.applicationId }); }
        catch (error) {
          if ((error.code ?? error.message) !== 'AUTHORITY_CACHE_MISSING') throw error;
          const bundle = await enroll(device, peers, fixture.applicationId, key);
          authority = await log.createAuthorityProvider({ store: device.store, bundle, epochKeys: [[0, key]] });
        }
        session = await log.createApplicationSession({ device, definition, authority, epochKeys: new Map([[0, key]]),
          async createMaterializer({ signal, rootPrincipal }) {
            progress('engine-load-start');
            const loaded = await loadBrowserEngine(new URL('./engine/', self.location.href)); signal.throwIfAborted();
            progress('engine-load-ready');
            pool = await loaded.module.installOpfsSAHPoolVfs({ name: 'acceptance-sql',
              directory: `acceptance-sql-${fixture.name}`, initialCapacity: 12 });
            signal.throwIfAborted();
            progress('opfs-ready');
            return createSqlMaterializationRuntime({ engine: createBrowserSqlEngine({ ...loaded, vfs: pool.vfsName }),
              path: '/application.sqlite', rootPrincipal });
          },
        });
        progress('metadata-ready');
        // The session is metadata-ready while SQL may still be lazy. Qualify SQL execution explicitly, in its
        // own bounded phase and before the page can attach: this query touches no application table, so it
        // does not depend on `initialize` having arrived. Normal UI RPCs keep their shorter deadlines.
        await session.query('ready', null);
        progress('sql-read-ready');
        if (fixture.remote) await connect(fixture.channel, fixture.remote);
        return { session, async close() { try { await link?.close(); } finally { await release(); } } };
      } catch (error) {
        // Capability and engine errors can happen after identity metadata opens but before session
        // ownership transfers. Always close that device, preserving the original opening failure.
        try { if (session) await session.close(); else await device?.close(); } catch { /* preserve original */ }
        try { await release(); } catch { /* preserve original */ }
        throw error;
      }
    },
  };
} });
