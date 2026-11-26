// Actual public Chromium owning-Worker + native SQLite sessions. This is a
// bounded local test bridge, not network/provider/hardware qualification.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import * as p from '@chronolog/peer-session';
import { openNativeDevice } from '@chronolog/peer-session/native';
import { definition } from '../docs/tutorial/shared/observation/domain.mjs';
import { serveObservations } from '../docs/tutorial/shared/observation/receiver.mjs';
import { servePeerInference } from '../docs/tutorial/shared/media/inference-service.mjs';
import { createTestConnection } from './observation-fixture/connection.mjs';

const root = resolve(import.meta.dirname, '..'), output = join(root, '.results/observation-assets');
const runtimeRoot = join(root, 'dist/runtime');
const runtimePackage = JSON.parse(await readFile(join(runtimeRoot, 'package.json'), 'utf8'));
assert.equal(runtimePackage.name, '@tendriller/runtime');
const runtimeEntry = resolve(runtimeRoot, runtimePackage.exports['./kernel'].import);
const temporary = await mkdtemp(join(tmpdir(), 'observation-'));
const report = { status: 'failed', scope: 'Actual public Chromium owning Worker and native SQLite sessions; bounded test bridge; simulated/injected geolocation and synthetic camera; exact media-content transfer with deterministic local analysis callback, not model inference. No physical-device, network-topology, provider or production-host qualification.', stages: [] };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const workerSource = await readFile(join(root, 'scripts/observation-fixture/worker.mjs'), 'utf8');
const pageSource = await readFile(join(root, 'scripts/observation-fixture/page.mjs'), 'utf8');
let server, browser, context, page, session, receiver, mediaReceiver, bridge, device, link, authority;
const mediaReceived = [], errors = [];
const closeDeadline = setTimeout(() => { void browser?.close(); }, 90000);
async function stage(name, action) { report.stage = name; console.log(`Observation: ${name}`); const result = await action(); report.stages.push(name); return result; }
async function until(check, timeout = 15000) { const end = Date.now() + timeout; while (!await check()) { if (Date.now() >= end) throw Error(`Observation deadline at ${report.stage}`); await new Promise(resolve => setTimeout(resolve, 20)); } }
try {
  await mkdir(output, { recursive: true });
  // Only installed public peer-session and the explicitly selected built runtime
  // enter these bundles; the Root tutorial helpers remain the actual consumers.
  await build({ absWorkingDir: root, entryPoints: { page: 'scripts/observation-fixture/page.mjs', worker: 'scripts/observation-fixture/worker.mjs' },
    bundle: true, splitting: true, format: 'esm', platform: 'browser', target: 'es2022', outdir: output, outExtension: { '.js': '.mjs' },
    alias: { '@tendriller/runtime/kernel': runtimeEntry } });
  report.runtime = { id: runtimePackage.tendriller.runtime, kernelSha256: hash(await readFile(runtimeEntry)) };
  report.harness = { workerSourceSha256: hash(workerSource), pageSourceSha256: hash(pageSource) };
  server = createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    response.setHeader('Cache-Control', 'no-store');
    if (pathname === '/') { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<!doctype html><title>Observation qualification</title><main></main><section><video muted playsinline></video><button id="media-start">Start synthetic camera</button><button id="media-capture">Capture local frame</button><button id="media-analyze">Share reviewed frame with local test callback</button></section><script type="module" src="/page.mjs"></script>'); return; }
    if (!/^\/[A-Za-z0-9_.-]+\.mjs$/.test(pathname)) { response.writeHead(404); response.end(); return; }
    try { const bytes = await readFile(join(output, pathname.slice(1))); response.writeHead(200, { 'content-type': 'text/javascript' }); response.end(bytes); }
    catch { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'], ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  report.browser = browser.version(); context = await browser.newContext({ geolocation: { latitude: 52.52, longitude: 13.405, accuracy: 5 }, permissions: ['geolocation', 'camera'] });
  page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => { errors.push(error.message); });
  bridge = createTestConnection((lane, bytes) => page.evaluate(([lane, bytes]) => { window.worker.postMessage({ type: 'bridge-in', lane, bytes }); return true; }, [lane, [...bytes]]));
  await page.exposeBinding('__nativeFrame', (_source, lane, bytes) => bridge.accept(lane, new Uint8Array(bytes)));
  const ready = await stage('real-browser-owning-worker-and-native-session', async () => {
    const created = page.waitForEvent('worker');
    await page.goto(`http://127.0.0.1:${server.address().port}/`); await page.waitForFunction(() => window.identity);
    const owningWorker = await created, browserId = await page.evaluate(() => window.identity);
    device = await openNativeDevice({ path: join(temporary, 'native.sqlite'), create: true });
    const signer = await p.createSigningIdentity(), key = crypto.getRandomValues(new Uint8Array(32));
    const execution = await p.executionManifestArtifacts(await p.eventExecutionManifest()), applicationId = '73'.repeat(32);
    const descriptor = await p.signAppDescriptor({ applicationId, rootPrincipal: device.identity.publicKey,
      authorityPublicKey: signer.publicKey, executionManifestDigest: p.bytesToHex(execution.executionManifestDigest), finalityPolicy: { kind: 'none' } }, signer);
    const membership = await p.signMembership({ applicationId, revision: 0, previous: null, authorTimeAfterMs: -1n, epoch: 0,
      epochKeyDigest: await p.epochKeyCommitment(applicationId, 0, key),
      members: [device.identity.publicKey, browserId].map((publicKey, index) => ({ publicKey, wrapKey: null, reader: true, writer: true, administrator: index === 0, publisher: index === 0, finalizer: false })),
      admission: { mode: 'strict', hostKey: signer.publicKey, accounts: [], grant: { reader: true, writer: true, administrator: true } }, admitted: [], invites: [] }, signer);
    authority = { descriptor, memberships: [membership] };
    session = await p.createApplicationSession({ device, definition, authority, epochKeys: new Map([[0, key]]) });
    receiver = serveObservations({ session, allowedDevices: [browserId] });
    mediaReceiver = servePeerInference({ session, allowedDevices: [browserId], maxRequests: 2, infer: async input => {
      const received = { bytes: input.bytes.length, sha256: hash(input.bytes), mediaType: input.mediaType, context: input.context, source: input.source };
      mediaReceived.push(received); return { text: 'Deterministic local transport check only.', sha256: received.sha256 };
    } });
    const workerSetup = owningWorker.evaluate(value => self.initializeWorker(value), {
      authority: { descriptor, memberships: [{ ...membership, payload: { ...membership.payload, authorTimeAfterMs: '-1' } }] },
      key: [...key], nativePublicKey: session.identity.publicKey,
    });
    link = await Promise.all([session.connectPeer({ connection: bridge.connection, peerIdentity: browserId }), workerSetup]).then(([link]) => link);
    return page.evaluate(value => window.setup(value), { applicationId, nativePublicKey: session.identity.publicKey });
  });
  assert.notEqual(ready.publicKey, session.identity.publicKey);
  await stage('remote-request-is-inert', async () => {
    await receiver.requestObservation(ready.publicKey, 'simulated');
    await page.waitForFunction(() => window.controller.source.snapshot().request !== null);
    assert.equal(await page.evaluate(() => window.runtime.sensors.status().active.length), 0);
    assert.deepEqual((await session.query('observations', null)).value, []); assert.equal(mediaReceived.length, 0);
  });
  await stage('trusted-start-coalesced-signal-and-native-reply', async () => {
    await page.locator('#observation-simulate').click();
    await page.waitForFunction(() => window.controller.source.snapshot().receiver === 'accepted');
    const received = receiver.snapshot()[ready.publicKey]; assert.equal(received.phase, 'fresh');
    assert.equal(JSON.parse(received.streamKey)[0], ready.publicKey);
    assert.equal(JSON.parse(received.streamKey)[3], ready.endpoint.endpointId);
    assert.equal(JSON.parse(received.streamKey)[4], ready.endpoint.endpointIncarnation);
    assert.deepEqual((await session.query('observations', null)).value, []);
  });
  await stage('reviewed-command-stored-materialized-and-peer-retained', async () => {
    await page.locator('#observation-review').fill('Reviewed simulator sample'); await page.locator('#observation-retain').click();
    await until(async () => (await session.query('observations', null)).value.length === 1);
    const retained = (await session.query('observations', null)).value[0];
    assert.equal(retained.text, 'Reviewed simulator sample'); assert.equal(retained.fix.source, 'simulated');
    report.operationId = retained.operationId;
    const reviewedAttempt = await page.evaluate(() => JSON.parse(localStorage.getItem(`observation-pending:${window.session.applicationId}:${window.session.identity.publicKey}`)));
    assert.equal(reviewedAttempt.operationId, report.operationId);
    const { author, operationId, proposalId, ...retainedInput } = retained;
    assert.equal(author, ready.publicKey); assert.equal(operationId, report.operationId);
    assert.deepEqual(retainedInput, reviewedAttempt.input); // Exact reviewed sample/text, not a later live arrival.
    const inspection = await page.evaluate(async operationId => {
      const operation = await window.session.operations.get(operationId); if (!operation) throw Error('Original operation missing.');
      await operation.materialized({ signal: AbortSignal.timeout(15000) }); await operation.retained({ signal: AbortSignal.timeout(15000) });
      return operation.inspect();
    }, report.operationId);
    assert.equal(inspection.stored, true); assert.equal(inspection.materialized.outcome, 'accepted'); assert.equal(inspection.finalized, false);
    assert.equal(inspection.proposalId, proposalId);
    assert(inspection.retained.some(row => row.signer === session.identity.publicKey && row.payload.peer === session.identity.publicKey));
    report.operation = inspection;
    await page.locator('#observation-inspect').click();
    assert.match(await page.locator('#observation-result').textContent(), /Stored locally: true/);
  });
  await stage('visible-stop-invalidates-registered-source', async () => {
    await page.locator('#observation-stop').click(); await until(() => receiver.snapshot()[ready.publicKey].phase === 'stopped');
    assert.equal(await page.evaluate(() => window.runtime.sensors.status().active.length), 0);
  });
  await stage('standard-geolocation-adapter-and-global-stop', async () => {
    await context.setGeolocation({ latitude: 52.52, longitude: 13.405, accuracy: 5 });
    await receiver.requestObservation(ready.publicKey, 'location'); await page.waitForFunction(() => window.controller.source.snapshot().request !== null);
    await page.locator('#observation-location').click();
    await page.waitForFunction(() => window.controller.source.snapshot().receiver === 'accepted' && window.controller.source.snapshot().sample?.fix.source === 'location');
    assert.equal(await page.evaluate(() => window.runtime.sensors.status().active.includes('location')), true);
    assert.equal(receiver.snapshot()[ready.publicKey].sample.fix.latitude, 52.52);
    await page.evaluate(() => window.runtime.sensors.stopAll()); await until(() => receiver.snapshot()[ready.publicKey].phase === 'stopped');
    assert.equal(await page.evaluate(() => window.controller.source.snapshot().sharing), false);
  });
  await stage('trusted-synthetic-camera-local-review-and-exact-content', async () => {
    await page.locator('#media-start').click(); await page.waitForFunction(() => window.camera.snapshot().phase === 'preview');
    await page.waitForFunction(() => document.querySelector('video').videoWidth > 0);
    await page.locator('#media-capture').click(); await page.waitForFunction(() => window.mediaReview.snapshot.candidate !== null);
    assert.equal(mediaReceived.length, 0);
    assert.equal(await page.evaluate(() => window.runtime.sensors.status().active.includes('camera')), false);
    const candidate = await page.evaluate(() => { const value = window.mediaReview.snapshot.candidate; return { bytes: value.size, sha256: value.sha256, frozen: Object.isFrozen(value.context), context: value.context }; });
    assert(candidate.bytes > 0); assert.equal(candidate.frozen, true); assert.equal(candidate.context.question, 'original reviewed question');
    await page.locator('#media-analyze').click(); await page.waitForFunction(() => window.mediaReview.snapshot.analysis !== null);
    assert.equal(mediaReceived.length, 1); assert.equal(mediaReceived[0].bytes, candidate.bytes); assert.equal(mediaReceived[0].sha256, candidate.sha256);
    assert.deepEqual(mediaReceived[0].context, candidate.context);
    const source = await page.evaluate(() => window.mediaReview.snapshot.analysis.source);
    assert.equal(source.reference.profile, 'authored-content-v1'); assert.equal(source.sha256, candidate.sha256);
    report.media = { candidate, received: mediaReceived[0], reference: source.reference };
  });
  await stage('root-media-helper-64-kib-content-boundary', async () => {
    // A labelled synthetic byte fixture, not claimed to be captured/decodable
    // audio, checks recorder MIME normalization and exact multi-chunk transport.
    const result = await page.evaluate(async () => {
      const bytes = Uint8Array.from({ length: 70000 }, (_, index) => index % 251);
      const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
      const candidate = { id: crypto.randomUUID(), sha256, blob: new Blob([bytes], { type: 'audio/webm;codecs=opus' }), context: { syntheticTransportFixture: true } };
      return { sha256, result: await window.inference.analyze({ candidate }) };
    });
    assert.equal(mediaReceived.length, 2); assert.equal(mediaReceived[1].bytes, 70000); assert.equal(mediaReceived[1].sha256, result.sha256);
    assert.equal(mediaReceived[1].mediaType, 'audio/webm'); assert.equal(result.result.source.reference.bytes, 70000);
    assert.equal((await session.query('observations', null)).value.length, 1); // Analysis never auto-retains a domain observation.
    report.contentBoundary = { bytes: 70000, sha256: result.sha256, mediaType: mediaReceived[1].mediaType };
  });
  await stage('native-sqlite-reopen-preserves-only-reviewed-observation', async () => {
    await page.evaluate(() => window.closeOwner());
    await receiver.close(); receiver = null; await mediaReceiver.close(); mediaReceiver = null;
    await link.close(); link = null; await session.close(); session = null; await device.close(); device = null;
    device = await openNativeDevice({ path: join(temporary, 'native.sqlite') });
    session = await p.createApplicationSession({ device, definition, applicationId: authority.descriptor.payload.applicationId });
    const retained = (await session.query('observations', null)).value; assert.equal(retained.length, 1); assert.equal(retained[0].operationId, report.operationId);
    assert.equal(retained[0].proposalId, report.operation.proposalId);
    assert.equal(session.operations.get(report.operation.proposalId).inspect().materialized.outcome, 'accepted');
  });
  assert.deepEqual(errors, []); assert.equal(await page.evaluate(() => window.mediaError ?? null), null);
  report.status = 'passed'; report.stage = 'complete'; console.log(JSON.stringify(report, null, 2));
} catch (error) { report.failure = error.stack ?? String(error); report.receiver = receiver?.snapshot();
  report.pageState = await page?.evaluate(() => ({ state: window.controller?.source.snapshot(), status: document.querySelector('#observation-state')?.textContent, retention: document.querySelector('#observation-result')?.textContent, sensors: window.runtime?.sensors.status(), mediaError: window.mediaError })).catch(() => null);
  console.error(JSON.stringify(report, null, 2)); throw error;
} finally {
  clearTimeout(closeDeadline); await receiver?.close().catch(() => {}); await mediaReceiver?.close().catch(() => {}); await bridge?.close();
  await link?.close().catch(() => {}); await session?.close().catch(() => {}); await device?.close().catch(() => {});
  await browser?.close(); if (server?.listening) await new Promise(resolve => server.close(resolve));
  await mkdir(join(root, '.results'), { recursive: true });
  await writeFile(join(root, '.results/observation.json'), JSON.stringify(report, null, 2) + '\n');
  await rm(temporary, { recursive: true, force: true });
}
