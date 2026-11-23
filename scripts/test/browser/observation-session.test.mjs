import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import * as peer from '@chronolog/peer-session';
import { openNativeDevice, openNativeApplication } from '@chronolog/peer-session/native';
import { definition } from '../../../docs/tutorial/observation/domain.mjs';
import { serveObservations } from '../../../docs/tutorial/observation/receiver.mjs';
import { createTestConnection } from '../../observation-fixture/connection.mjs';

async function until(predicate, label, milliseconds = 10_000) {
  const deadline = Date.now() + milliseconds;
  while (!await predicate()) { assert(Date.now() < deadline, label); await new Promise(resolve => setTimeout(resolve, 20)); }
}

test('real Chromium to native session: consent, coalesced live fixes, correlated replies, stale/disconnected state, and reviewed retention', { timeout: 45_000 }, async t => {
  const root = fileURLToPath(new URL('../../..', import.meta.url));
  const directory = await mkdtemp(join(tmpdir(), 'tendriller-observation-')), cleanup = [];
  t.after(async () => { for (const close of cleanup.reverse()) await close().catch(() => {}); await rm(directory, { recursive: true, force: true }); });
  const bundle = await build({ stdin: { contents: `
    import { openApplicationDevice, openPeerApplication, MemoryBytesStore } from '@chronolog/peer-session';
    import { definition } from './docs/tutorial/observation/domain.mjs';
    import { mountObservations } from './docs/tutorial/observation/panel.mjs';
    import { installSensorWrappers } from './runtime/src/sensors.ts';
    import { createTestConnection } from './scripts/observation-fixture/connection.mjs';
    const tracker = installSensorWrappers();
    const runtime = { sensors: tracker, on: () => () => {}, capabilities: async () => ({capabilities:{location:{available:true,permission:'granted'}}}) };
    const device = await openApplicationDevice({ store: new MemoryBytesStore(), create: true });
    window.identity = device.identity.publicKey;
    window.transport = createTestConnection((lane, bytes) => window.observationToNative(lane, [...bytes]));
    window.setup = async ({authority,key,nativeDeviceId}) => {
      const session = window.session = await openPeerApplication({device,definition,authority,epochKeys:new Map([[0,new Uint8Array(key)]])});
      window.link = await session.connectPeer({connection:window.transport.connection,peerIdentity:nativeDeviceId});
      window.controls = mountObservations({container:document.querySelector('main'),session,runtime,nativeDeviceId,coalesceMs:200});
      window.tracker = tracker;
    };
    window.ready = true;
  `, resolveDir: root, sourcefile: 'observation-browser.mjs' }, bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022' });
  const script = bundle.outputFiles[0].text;
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', request.url === '/app.mjs' ? 'text/javascript' : 'text/html');
    response.end(request.url === '/app.mjs' ? script : '<!doctype html><meta charset="utf-8"><title>Observation check</title><main></main><script type="module" src="/app.mjs"></script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); cleanup.push(() => new Promise(resolve => server.close(resolve)));
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  cleanup.push(() => browser.close());
  const context = await browser.newContext({ permissions: ['geolocation'], geolocation: { latitude: 52.52, longitude: 13.405, accuracy: 3 } });
  const page = await context.newPage(), browserErrors = [];
  page.on('pageerror', error => browserErrors.push(error.message));
  const transport = createTestConnection((lane, bytes) => page.evaluate(({lane,bytes}) => window.transport.accept(lane, bytes), {lane,bytes:[...bytes]}));
  cleanup.push(() => transport.close());
  await page.exposeFunction('observationToNative', (lane, bytes) => transport.accept(lane, bytes));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => window.ready);
  const browserId = await page.evaluate(() => window.identity);
  const nativePath = join(directory, 'native.sqlite');
  let device = await openNativeDevice({ path: nativePath, create: true });
  cleanup.push(() => device?.close());
  const host = await peer.createPeerIdentity(), epochKey = crypto.getRandomValues(new Uint8Array(32));
  const manifest = await peer.executionManifestArtifacts(await peer.eventExecutionManifest());
  const descriptor = await peer.signApplicationDescriptor({ applicationId: 'c3'.repeat(32), historyId: 'observation-reference',
    profile: 'peer-generation-v1', policy: 'eligible-members-v1', controlPublicKey: host.publicKey, schemaAdministrator: device.identity.publicKey,
    executionManifestDigest: peer.bytesToHex(manifest.executionManifestDigest), definitionDigest: await peer.applicationDefinitionDigest(definition), schemaDigest: null }, host);
  const control = await peer.signControlRevision({ applicationId: descriptor.payload.applicationId, profile: descriptor.payload.profile,
    policy: descriptor.payload.policy, revision: 0, previous: null, epoch: 0, keyDigest: await peer.bytesDigest(epochKey), recoveryFloor: null,
    grants: [peer.participantGrant(device.identity.publicKey, { administrator: true }), peer.participantGrant(browserId)] }, host);
  const registry = await peer.createGenerationRegistry({ store: new peer.MemoryBytesStore(), descriptor, controls: [control], signer: host });
  await registry.select(await peer.signTransitionRequest({ applicationId: descriptor.payload.applicationId, profile: descriptor.payload.profile,
    policy: descriptor.payload.policy, transitionId: 'initial', expectedGeneration: null, requester: device.identity.publicKey,
    coordinator: device.identity.publicKey, controlRevision: 0, reason: 'create', base: null }, device.identity));
  const authority = await registry.read();
  let session = await openNativeApplication({ device, definition, authority, epochKeys: new Map([[0, epochKey]]) });
  cleanup.push(() => session.close());
  const observed = [], receiver = serveObservations({ session, allowedDevices: [browserId], maxAgeMs: 600, onState: state => observed.push(state) });
  cleanup.push(() => receiver.close());
  const browserOpening = page.evaluate(value => window.setup(value), { authority, key: [...epochKey], nativeDeviceId: session.deviceId });
  const link = await session.connectPeer({ connection: transport.connection, peerIdentity: browserId });
  await browserOpening;
  cleanup.push(async () => { await page.evaluate(async () => { await window.controls.close(); await window.session.close(); }); });
  const request = await receiver.requestObservation(browserId, 'simulated');
  await page.waitForFunction(() => window.controls.source.snapshot().request !== null);
  assert.equal(await page.evaluate(() => window.controls.source.snapshot().sharing), false, 'Remote requests cannot activate capture.');
  assert.equal((await session.query('observations', null)).value.length, 0);
  await page.click('#observation-simulate');
  await until(() => receiver.snapshot()[browserId]?.phase === 'fresh', 'Native receiver should accept a real signed live sample.');
  await page.waitForFunction(() => window.controls.source.snapshot().receiver === 'accepted');
  assert.equal(receiver.snapshot()[browserId].sample.requestId, request.requestId);
  await new Promise(resolve => setTimeout(resolve, 550));
  assert(observed.filter(value => value.phase === 'fresh').length <= 5, '50 ms acquisition is coalesced before 200 ms transport.');
  await page.click('#observation-stop');
  await until(() => receiver.snapshot()[browserId]?.phase === 'stopped', 'Stop marker should reach native receiver.');
  const stoppedCount = observed.filter(value => value.phase === 'fresh').length;
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(observed.filter(value => value.phase === 'fresh').length, stoppedCount);
  assert.equal((await session.query('observations', null)).value.length, 0, 'Live observation is not a domain write.');
  await page.fill('#observation-review', 'Human-reviewed simulated observation.');
  await page.click('#observation-retain');
  await page.waitForFunction(() => document.querySelector('#observation-result').textContent.includes('Applied: accepted'));
  assert.equal((await session.query('observations', null)).value[0].text, 'Human-reviewed simulated observation.');
  // Refresh the synthetic device measurement itself; a later delivery time
  // must not make the original context-created geolocation fix fresh.
  await context.setGeolocation({ latitude: 52.5201, longitude: 13.4051, accuracy: 3 });
  await page.click('#observation-location');
  await until(() => receiver.snapshot()[browserId]?.sample?.fix.source === 'location' && receiver.snapshot()[browserId].phase === 'fresh', 'Actual browser geolocation adapter should send the supplied test fix.');
  await until(() => receiver.snapshot()[browserId]?.phase === 'stale', 'Native receiver expires sample age without a new measurement.');
  await page.waitForFunction(() => window.controls.source.snapshot().receiver === 'stale');
  await page.evaluate(() => window.tracker.stopAll());
  assert.equal(await page.evaluate(() => window.controls.source.snapshot().sharing), false);
  await link.close();
  await until(() => receiver.snapshot()[browserId]?.phase === 'disconnected', 'Native receiver should expose disconnection.');
  await receiver.close(); await session.close(); await device.close();
  device = await openNativeDevice({ path: nativePath });
  session = await openNativeApplication({ device, definition, authority });
  assert.equal((await session.query('observations', null)).value.length, 1, 'Only explicitly retained review survives native reopen.');
  assert.deepEqual(browserErrors, []);
});
