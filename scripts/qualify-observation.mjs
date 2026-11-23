// Actual Chromium Worker + native SQLite public sessions, over a bounded test
// bridge with distinct reliable/live lanes. No production account or hardware.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import * as p from '@chronolog/peer-session';
import { openNativeDevice, openNativeApplication } from '@chronolog/peer-session/native';
import { definition } from '../docs/tutorial/observation/domain.mjs';
import { serveObservations } from '../docs/tutorial/observation/receiver.mjs';
import { createTestConnection } from './observation-fixture/connection.mjs';

const root = resolve(import.meta.dirname, '..'), output = join(root, '.results/observation-assets');
const temporary = await mkdtemp(join(tmpdir(), 'observation-'));
const report = { status: 'failed', scope: 'Actual Chromium Worker and native SQLite sessions; bounded local test bridge; simulated and browser-emulated geolocation; no physical-device or production-host qualification.', stages: [] };
await mkdir(output, { recursive: true });
await build({ absWorkingDir: root, entryPoints: { page: 'scripts/observation-fixture/page.mjs', worker: 'scripts/observation-fixture/worker.mjs' },
  bundle: true, splitting: true, format: 'esm', platform: 'browser', target: 'es2022', outdir: output, outExtension: { '.js': '.mjs' } });
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  if (pathname === '/') { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<!doctype html><title>Observation qualification</title><main></main><script type="module" src="/page.mjs"></script>'); return; }
  if (!/^\/[A-Za-z0-9_.-]+\.mjs$/.test(pathname)) { response.writeHead(404); response.end(); return; }
  try { const bytes = await readFile(join(output, pathname.slice(1))); response.writeHead(200, { 'content-type': 'text/javascript' }); response.end(bytes); }
  catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser, context, page, session, receiver, bridge, device, link, authority;
const closeDeadline = setTimeout(() => { void browser?.close(); }, 90000);
async function stage(name, action) { report.stage = name; console.log(`Observation: ${name}`); const result = await action(); report.stages.push(name); return result; }
async function until(check, timeout = 10000) { const end = Date.now() + timeout; while (!await check()) { if (Date.now() >= end) throw Error(`Observation deadline at ${report.stage}`); await new Promise(resolve => setTimeout(resolve, 10)); } }
try {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  report.browser = browser.version(); context = await browser.newContext({ geolocation: { latitude: 52.52, longitude: 13.405, accuracy: 5 }, permissions: ['geolocation'] });
  page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => { report.pageError = error.message; });
  bridge = createTestConnection((lane, bytes) => page.evaluate(([lane, bytes]) => window.worker.postMessage({ type: 'bridge-in', lane, bytes }), [lane, [...bytes]]));
  await page.exposeBinding('__nativeFrame', (_source, lane, bytes) => bridge.accept(lane, new Uint8Array(bytes)));
  await page.exposeBinding('__bootstrap', async (_source, browserId) => {
    if (session) throw Error('Fixture bootstrap is one-shot.');
    device = await openNativeDevice({ path: join(temporary, 'native.sqlite'), create: true });
    const signer = await p.createPeerIdentity(), key = crypto.getRandomValues(new Uint8Array(32));
    const execution = await p.executionManifestArtifacts(await p.eventExecutionManifest());
    const descriptor = await p.signApplicationDescriptor({ applicationId: '73'.repeat(32), historyId: 'observation-qualification',
      profile: 'peer-generation-v1', policy: 'eligible-members-v1', controlPublicKey: signer.publicKey,
      schemaAdministrator: device.identity.publicKey, definitionDigest: await p.applicationDefinitionDigest(definition),
      executionManifestDigest: p.bytesToHex(execution.executionManifestDigest), schemaDigest: null }, signer);
    const control = await p.signControlRevision({ applicationId: descriptor.payload.applicationId, profile: descriptor.payload.profile,
      policy: descriptor.payload.policy, revision: 0, previous: null, epoch: 0, keyDigest: await p.bytesDigest(key), recoveryFloor: null,
      grants: [p.participantGrant(device.identity.publicKey, { administrator: true }), p.participantGrant(browserId)] }, signer);
    const registry = await p.createGenerationRegistry({ store: new p.MemoryBytesStore(), descriptor, controls: [control], signer });
    await registry.select(await p.signTransitionRequest({ applicationId: descriptor.payload.applicationId, profile: descriptor.payload.profile,
      policy: descriptor.payload.policy, transitionId: 'initial', expectedGeneration: null, coordinator: device.identity.publicKey,
      requester: device.identity.publicKey, controlRevision: 0, reason: 'create', base: null }, device.identity));
    authority = await registry.read();
    session = await openNativeApplication({ device, definition, authority, epochKeys: new Map([[0, key]]) });
    receiver = serveObservations({ session, allowedDevices: [browserId] });
    link = session.connectPeer({ connection: bridge.connection, peerIdentity: browserId }); void link.catch(() => {});
    return { authority, key: [...key], nativeDeviceId: session.deviceId };
  });
  const ready = await stage('real-browser-worker-and-native-session', async () => {
    await page.goto(`http://127.0.0.1:${server.address().port}/`); return page.evaluate(() => window.ready);
  });
  await link; assert.notEqual(ready.deviceId, session.deviceId);
  await stage('remote-request-is-inert', async () => {
    await receiver.requestObservation(ready.deviceId, 'simulated');
    await page.waitForFunction(() => window.controller.source.snapshot().request !== null);
    assert.equal(await page.evaluate(() => runtime.sensors.status().active.length), 0);
    assert.deepEqual((await session.query('observations', null)).value, []);
  });
  await stage('trusted-start-coalesced-signal-and-native-reply', async () => {
    await page.locator('#observation-simulate').click();
    await page.waitForFunction(() => window.controller.source.snapshot().receiver === 'accepted');
    const received = receiver.snapshot()[ready.deviceId]; assert.equal(received.phase, 'fresh');
    assert.equal(JSON.parse(received.streamKey)[0], ready.deviceId);
    assert.equal(JSON.parse(received.streamKey)[3], ready.endpoint.endpointId);
    assert.equal(JSON.parse(received.streamKey)[4], ready.endpoint.endpointIncarnation);
    assert.deepEqual((await session.query('observations', null)).value, []);
  });
  await stage('reviewed-command-is-applied-and-read-natively', async () => {
    await page.locator('#observation-review').fill('Reviewed simulator sample'); await page.locator('#observation-retain').click();
    await page.waitForFunction(() => { const text = document.querySelector('#observation-result').textContent; return text.startsWith('Applied') || text.includes('unresolved'); });
    assert.match(await page.locator('#observation-result').textContent(), /^Applied/);
    const retained = (await session.query('observations', null)).value;
    assert.equal(retained.length, 1); assert.equal(retained[0].text, 'Reviewed simulator sample'); assert.equal(retained[0].fix.source, 'simulated');
    report.operationId = retained[0].operationId;
  });
  await stage('visible-stop-invalidates-registered-source', async () => {
    await page.locator('#observation-stop').click(); await until(() => receiver.snapshot()[ready.deviceId].phase === 'stopped');
    assert.equal(await page.evaluate(() => runtime.sensors.status().active.length), 0);
  });
  await stage('standard-geolocation-adapter-and-global-stop', async () => {
    // Refresh before acquisition. Replacing an override during a live watch
    // deliberately produces POSITION_UNAVAILABLE in Chromium and stops the app.
    await context.setGeolocation({ latitude: 52.52, longitude: 13.405, accuracy: 5 });
    await receiver.requestObservation(ready.deviceId, 'location'); await page.waitForFunction(() => window.controller.source.snapshot().request !== null);
    await page.locator('#observation-location').click();
    await page.waitForFunction(() => window.controller.source.snapshot().receiver === 'accepted' && window.controller.source.snapshot().sample?.fix.source === 'location');
    assert.equal(await page.evaluate(() => runtime.sensors.status().active.includes('location')), true);
    assert.equal(receiver.snapshot()[ready.deviceId].sample.fix.latitude, 52.52);
    await page.evaluate(() => runtime.sensors.stopAll()); await until(() => receiver.snapshot()[ready.deviceId].phase === 'stopped');
    assert.equal(await page.evaluate(() => controller.source.snapshot().sharing), false);
  });
  await stage('native-sqlite-reopen-preserves-only-reviewed-observation', async () => {
    await page.evaluate(async () => { await controller.close(); await session.detach(); worker.postMessage({ type: 'close' }); });
    await receiver.close(); receiver = null; await (await link).close(); await session.close(); session = null;
    await device.close(); device = null;
    device = await openNativeDevice({ path: join(temporary, 'native.sqlite') });
    session = await openNativeApplication({ device, definition, authority });
    const retained = (await session.query('observations', null)).value; assert.equal(retained.length, 1); assert.equal(retained[0].operationId, report.operationId);
  });
  report.status = 'passed'; report.stage = 'complete'; console.log(JSON.stringify(report, null, 2));
} catch (error) { report.failure = error.stack ?? String(error); report.receiver = receiver?.snapshot();
  report.pageState = await page?.evaluate(() => ({ state: window.controller?.source.snapshot(), status: document.querySelector('#observation-state')?.textContent, retention: document.querySelector('#observation-result')?.textContent, sensors: window.runtime?.sensors.status() })).catch(() => null);
  console.error(JSON.stringify(report, null, 2)); throw error; }
finally {
  clearTimeout(closeDeadline); await receiver?.close().catch(() => {}); await bridge?.close();
  await session?.close().catch(() => {}); await device?.close().catch(() => {});
  await browser?.close(); await new Promise(resolve => server.close(resolve));
  await writeFile(join(root, '.results/observation.json'), JSON.stringify(report, null, 2) + '\n');
  await rm(temporary, { recursive: true, force: true });
}
