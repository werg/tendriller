import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import * as p from '@chronolog/peer-session';
import { openNativeDevice, openNativeApplication } from '@chronolog/peer-session/native';
import { definition } from '../../docs/tutorial/domain.mjs';
import { sessionMeasurement, verifySignedOperation, nativeMeasurement, probe } from '../agent-acceptance/observer-native.mjs';
import { StarterObserver, verifyBrowserPublication } from '../agent-acceptance/observer.mjs';
import { loadObserverConfig, publicationAddress } from '../agent-acceptance/observer-data.mjs';
import { Evidence } from '../agent-acceptance/evidence.mjs';

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'starter-observer-')), runDirectory = join(directory, 'run'), project = join(runDirectory, 'project');
  mkdirSync(project, { recursive: true }); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const device = await openNativeDevice({ path: join(project, 'device.sqlite'), create: true });
  const hostSigner = await p.createPeerIdentity(), browserSigner = await p.createPeerIdentity(), key = crypto.getRandomValues(new Uint8Array(32));
  const execution = await p.executionManifestArtifacts(await p.eventExecutionManifest());
  const descriptor = await p.signApplicationDescriptor({ applicationId: 'ac'.repeat(32), historyId: 'observer-fixture', profile: 'peer-generation-v1', policy: 'eligible-members-v1',
    controlPublicKey: hostSigner.publicKey, schemaAdministrator: device.identity.publicKey, definitionDigest: await p.applicationDefinitionDigest(definition),
    executionManifestDigest: p.bytesToHex(execution.executionManifestDigest), schemaDigest: null }, hostSigner);
  const control = await p.signControlRevision({ applicationId: descriptor.payload.applicationId, profile: descriptor.payload.profile, policy: descriptor.payload.policy,
    revision: 0, previous: null, epoch: 0, keyDigest: await p.bytesDigest(key), recoveryFloor: null,
    grants: [p.participantGrant(device.identity.publicKey, { administrator: true, publisher: true }), p.participantGrant(browserSigner.publicKey)] }, hostSigner);
  const registry = await p.createGenerationRegistry({ store: new p.MemoryBytesStore(), descriptor, controls: [control], signer: hostSigner });
  await registry.select(await p.signTransitionRequest({ applicationId: descriptor.payload.applicationId, profile: descriptor.payload.profile, policy: descriptor.payload.policy,
    transitionId: 'initial', expectedGeneration: null, coordinator: device.identity.publicKey, requester: device.identity.publicKey, controlRevision: 0, reason: 'create', base: null }, device.identity));
  const authority = await registry.read(), session = await openNativeApplication({ device, definition, authority, epochKeys: new Map([[0, key]]) });
  t.after(() => session.close());
  await session.query('notes', null);
  const operation = await session.command('addNote', { text: 'Observer marker' }, { operationId: 'stable-observer-op' });
  await operation.applied();
  const publication = await p.signPublicationManifest({ applicationId: descriptor.payload.applicationId, historyId: descriptor.payload.historyId,
    profile: descriptor.payload.profile, controlRevision: 0, author: device.identity.publicKey, operationId: 'stable-publish-op', revision: 0, previous: null,
    definitionDigest: descriptor.payload.definitionDigest, executionManifestDigest: descriptor.payload.executionManifestDigest, entry: 'index.html',
    files: [{ path: 'index.html', hash: await p.bytesDigest(new TextEncoder().encode('<p>Fixture</p>')), size: 14, type: 'text/html' }] }, device.identity);
  const receipt = { publication, version: 1 };
  const handle = { id: 'a'.repeat(12), api: 'https://staging.example/api/t/' + 'a'.repeat(12), token: 'PRIVATE_HANDLE',
    application: { id: session.applicationId }, page_url: 'https://' + 'a'.repeat(12) + '.staging.example/s/' + 'a'.repeat(26) + '/' };
  for (const [name, value] of Object.entries({ 'descriptor.json': descriptor, 'handle.json': handle, 'device.json': { deviceId: session.deviceId }, 'authority.json': authority }))
    writeFileSync(join(project, name), JSON.stringify(value), { mode: 0o600 });
  writeFileSync(join(project, 'session.mjs'), 'export const fixture = true;');
  const config = { protocol: 'tendriller-starter-observer-v1', origin: 'https://staging.example', applicationId: session.applicationId, historyId: session.historyId, ownerAccountId: 'fixture-owner',
    native: { project, module: 'session.mjs', handle: { file: 'handle.json' }, descriptor: { file: 'descriptor.json' }, deviceId: { file: 'device.json', pointer: '/deviceId' }, deviceStore: 'device.sqlite' },
    query: { name: 'notes', rows: '/value', marker: '/text', author: '/author', operationId: '/operationId' },
    browser: { device: { selector: '#device', read: 'value' }, rows: '#rows li' },
    publication: { operationId: 'stable-publish-op' }, commands: { 'browser-to-agent': { name: 'addNote' },
      'agent-to-browser': { name: 'addNote', input: { text: 'Observer marker' }, marker: 'Observer marker', operationId: 'stable-observer-op' } } };
  const configPath = join(directory, 'observer.json'), request = { project, origin: config.origin };
  const save = () => writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 }); save();
  const loaded = loadObserverConfig(configPath, request);
  const snapshot = await sessionMeasurement(session, loaded, p, { operationId: 'stable-observer-op', author: session.deviceId, command: 'addNote' });
  const page = { url: () => handle.page_url, evaluate: async () => ({ page: handle.id, publication: '1', version: 1, documentPath: 'index.html' }),
    locator: selector => ({ count: async () => 1, inputValue: async () => browserSigner.publicKey, innerText: async () => 'Connected',
      allInnerTexts: async () => ['Observer marker · operation stable-observer-op'] }) };
  const lifecycle = { owner: null };
  const packages = async () => ({ session: p, core: { createClient: () => ({ peers: { application: async () => authority, publication: async () => structuredClone(receipt) },
    info: async () => ({ id: handle.id, application: handle.application, page_url: handle.page_url, owner_account_id: lifecycle.owner }) }) } });
  return { directory, runDirectory, project, config, configPath, request, loaded, session, snapshot, browserSigner, publication, receipt, authority, handle, page, packages, save, lifecycle, signer: device.identity };
}

test('real Chronolog native query and signed operation proof reject tampering, wrong author, definition and application', async t => {
  const f = await fixture(t), authority = await p.verifyAuthorityBundle(f.authority, f.loaded.descriptor);
  assert.equal(f.snapshot.operation.state.outcome, 'accepted'); assert.equal(f.snapshot.operation.signatureVerified, true);
  await verifySignedOperation(f.snapshot.operation.attempt, authority, p);
  for (const change of [a => { a.signature = '00'.repeat(64); }, a => { a.payload.header.author = f.browserSigner.publicKey; }, a => { a.id = '00'.repeat(32); }]) {
    const attempt = structuredClone(f.snapshot.operation.attempt); change(attempt);
    await assert.rejects(verifySignedOperation(attempt, authority, p));
  }
  await assert.rejects(sessionMeasurement(f.session, f.loaded, p, { operationId: 'stable-observer-op', author: f.session.deviceId, command: 'invented-command' }), /attempt-command/);
  await assert.rejects(sessionMeasurement(f.session, { ...f.loaded, applicationId: 'bb'.repeat(32) }, p), /session-application/);
});

test('maintained observer proves native-to-browser from measured rows and signed ID, never from a status flag', async t => {
  const f = await fixture(t), evidence = new Evidence(f.runDirectory, {});
  const observer = new StarterObserver({ ...f.request, runDirectory: f.runDirectory, configPath: f.configPath, owner: { page: f.page },
    native: async () => f.snapshot, packages: f.packages });
  const passed = await observer.observe({ check: 'agent-to-browser' });
  assert.equal(passed.status, 'passed'); evidence.observation(passed, 'maintained-starter-observer');
  assert.equal(passed.evidence.operationId, 'stable-observer-op');
  f.page.locator = () => ({ count: async () => 1, inputValue: async () => f.browserSigner.publicKey, allInnerTexts: async () => ['Observer marker · operation unrelated-op'] });
  const wrongRow = await observer.observe({ check: 'agent-to-browser' }); assert.equal(wrongRow.status, 'failed');
  assert(wrongRow.evidence.mismatches.includes('browser-operation-row'));
  evidence.finish(); assert.equal(evidence.data.outcome, 'blocked');
  assert(!readFileSync(join(f.runDirectory, 'report.json'), 'utf8').includes('PRIVATE_HANDLE'));
});

test('missing measurements block; duplicate application, replaced signer and changed configured identity fail', async t => {
  const f = await fixture(t);
  const observer = new StarterObserver({ ...f.request, runDirectory: f.runDirectory, configPath: f.configPath, owner: { page: f.page }, native: async () => f.snapshot, packages: f.packages });
  const missing = await observer.observe({ check: 'native-reopen' }); assert.equal(missing.status, 'blocked'); assert(missing.evidence.missing.includes('retention-operation-id'));
  const duplicate = structuredClone(f.snapshot); duplicate.rows.push(duplicate.rows[0]); observer.native = async () => duplicate;
  assert.equal((await observer.observe({ check: 'agent-to-browser' })).status, 'failed');
  observer.native = async () => f.snapshot;
  const bound = await observer.observe({ check: 'agent-to-browser' }); assert.equal(bound.status, 'passed');
  f.config.historyId = 'replacement-history'; f.save();
  const replacement = await observer.observe({ check: 'agent-to-browser' }); assert.equal(replacement.status, 'failed');
});

test('preclaim uses actual signed publication verification and blocks claim/head substitutions', async t => {
  const f = await fixture(t), observer = new StarterObserver({ ...f.request, runDirectory: f.runDirectory, configPath: f.configPath, owner: { page: f.page }, packages: f.packages });
  const preclaim = await observer.observe({ check: 'preclaim-publication' }); assert.equal(preclaim.status, 'passed');
  f.lifecycle.owner = 'fixture-owner';
  const current = await observer.observe({ check: 'publication', options: { phase: 'claim-boundary' } }); assert.equal(current.status, 'passed');
  f.receipt.publication.signature = '00'.repeat(64);
  assert.notEqual((await observer.observe({ check: 'publication' })).status, 'passed');
});

test('native probe is a bounded real subprocess using existing app module and installed public package', async t => {
  const f = await fixture(t);
  await f.session.close();
  mkdirSync(join(f.project, 'node_modules/@chronolog'), { recursive: true });
  symlinkSync(resolve(import.meta.dirname, '../../node_modules/@chronolog/peer-session'), join(f.project, 'node_modules/@chronolog/peer-session'));
  mkdirSync(join(f.project, 'node_modules/@tendriller/core'), { recursive: true });
  writeFileSync(join(f.project, 'node_modules/@tendriller/core/package.json'), JSON.stringify({ type: 'module', exports: './index.mjs' }));
  writeFileSync(join(f.project, 'node_modules/@tendriller/core/index.mjs'), 'export const hostFixtureUnusedByNativeProbe = true;');
  writeFileSync(join(f.project, 'session.mjs'), `import {readFileSync} from 'node:fs';
import {openNativeDevice,openNativeApplication} from '@chronolog/peer-session/native';
import {definition} from ${JSON.stringify(new URL('../../docs/tutorial/domain.mjs', import.meta.url).href)};
export async function attachSession(){const device=await openNativeDevice({path:new URL('./device.sqlite',import.meta.url).pathname});
 const session=await openNativeApplication({device,definition,authority:JSON.parse(readFileSync(new URL('./authority.json',import.meta.url)))});
 return {session,detach:()=>session.close()};}`);
  const options = { operationId: 'stable-observer-op', author: f.loaded.native.deviceId, command: 'addNote' };
  await probe(f.loaded, options);
  const measured = await nativeMeasurement(f.loaded, options);
  assert.equal(measured.operation.signatureVerified, true); assert.equal(measured.rows[0].text, 'Observer marker');
  assert.equal(measured.deviceId, f.loaded.native.deviceId);
});

test('lost command wait keeps exact measured signed attempt, rejects replacement and requires the original checkpoint', async t => {
  const f = await fixture(t);
  f.config.commands['lost-command-response'] = f.config.commands['agent-to-browser']; f.save();
  const observer = new StarterObserver({ ...f.request, runDirectory: f.runDirectory, configPath: f.configPath, owner: { page: f.page },
    native: async (_config, options) => ({ ...f.snapshot, waiterInterrupted: options.action === 'submit-lost' }), packages: f.packages });
  assert.equal((await observer.observe({ check: 'lost-command-response', options: { action: 'retry' } })).status, 'blocked');
  const lost = await observer.observe({ check: 'lost-command-response', options: { action: 'submit-lost' } });
  assert.equal(lost.status, 'blocked'); assert(lost.evidence.missing.includes('saved-wait-interrupted-retry-same-operation'));
  const retried = await observer.observe({ check: 'lost-command-response', options: { action: 'retry' } });
  assert.equal(retried.status, 'passed'); assert.equal(retried.evidence.attemptHash, retried.evidence.retryAttemptHash);
  const evidence = new Evidence(f.runDirectory, {}); evidence.observation(retried, 'maintained-starter-observer');
  observer.native = async () => ({ ...f.snapshot, operation: { ...f.snapshot.operation, attemptHash: '00'.repeat(32) } });
  assert.equal((await observer.observe({ check: 'lost-command-response', options: { action: 'retry' } })).status, 'failed');
  f.config.commands['lost-command-response'].input = { text: 'Changed input' }; f.save();
  assert.equal((await observer.observe({ check: 'lost-command-response', options: { action: 'retry' } })).status, 'failed');
});

test('lost publication acknowledgement retries only saved signed bytes and the original versioned receipt', async t => {
  const f = await fixture(t); writeFileSync(join(f.project, 'publication.json'), JSON.stringify({ publication: f.publication, assets: [] }));
  f.config.publication.intent = { file: 'publication.json', pointer: '/publication' };
  f.config.publication.assets = { file: 'publication.json', pointer: '/assets' }; f.save();
  const packages = async () => { const result = await f.packages(); const createClient = result.core.createClient;
    result.core.createClient = () => { const host = createClient(); host.peers.publish = async () => f.receipt; return host; }; return result; };
  const observer = new StarterObserver({ ...f.request, runDirectory: f.runDirectory, configPath: f.configPath, packages });
  assert.equal((await observer.observe({ check: 'lost-publication-response', options: { action: 'drop' } })).status, 'blocked');
  const retried = await observer.observe({ check: 'lost-publication-response', options: { action: 'retry' } });
  assert.equal(retried.status, 'passed'); assert.equal(retried.evidence.receiptId, retried.evidence.retryReceiptId);
  new Evidence(f.runDirectory, {}).observation(retried, 'maintained-starter-observer');
  f.receipt.version = 2;
  assert.equal((await observer.observe({ check: 'lost-publication-response', options: { action: 'retry' } })).status, 'failed');
});

test('private configuration cannot switch to a foreign service, native project, or signer', async t => {
  const f = await fixture(t);
  f.config.origin = 'https://foreign.example'; f.save(); assert.throws(() => loadObserverConfig(f.configPath, f.request), /observer-origin/);
  f.config.origin = f.request.origin; f.config.native.project = f.directory; f.save();
  assert.throws(() => loadObserverConfig(f.configPath, f.request), /inside-model-project|outside-this-run/);
  f.config.native.project = f.project; f.config.native.deviceId = f.browserSigner.publicKey; f.save();
  const observer = new StarterObserver({ ...f.request, runDirectory: f.runDirectory, configPath: f.configPath, native: async () => f.snapshot, owner: { page: f.page } });
  assert.equal((await observer.observe({ check: 'agent-to-browser' })).status, 'failed');
});

test('staging preview page origins require the authenticated host to confirm the exact URL', async t => {
  const f = await fixture(t);
  f.handle.page_url = `https://${f.handle.id}--p-9a9a9a9a9a9a.tendriller.dev/s/${'a'.repeat(26)}/`;
  writeFileSync(join(f.project, 'handle.json'), JSON.stringify(f.handle));
  const observer = new StarterObserver({ ...f.request, runDirectory: f.runDirectory, configPath: f.configPath, owner: { page: f.page }, packages: f.packages });
  assert.equal((await observer.observe({ check: 'preclaim-publication' })).status, 'passed');
  const packages = await f.packages(), createClient = packages.core.createClient;
  packages.core.createClient = () => { const host = createClient(); const info = host.info;
    host.info = async () => ({ ...await info(), page_url: 'https://wrong.example/' }); return host; };
  observer.packages = async () => packages;
  const mismatch = await observer.observe({ check: 'publication' });
  assert.equal(mismatch.status, 'failed'); assert(mismatch.evidence.mismatches.includes('host-authoritative-page-url'));
});

test('only the exact page and documented immutable publication URLs can be measured', () => {
  const base = 'https://aaaaaaaaaaaa--p-stage.example/s/' + 'a'.repeat(26) + '/';
  assert.deepEqual(publicationAddress(base, base), { version: null, documentPath: null });
  assert.deepEqual(publicationAddress(base + '_publications/2/index.html', base), { version: 2, documentPath: 'index.html' });
  for (const value of [base.replace('aaaaaaaaaaaa--p-stage', 'bbbbbbbbbbbb--p-stage') + '_publications/2/index.html',
    base.replace('/s/' + 'a'.repeat(26), '/s/' + 'b'.repeat(26)), base + '_tendril/manage', base + 'arbitrary.html',
    base + '_publications/0/index.html', base + '_publications/9007199254740993/index.html',
    base + '_publications/2/%5csecret', base + '_publications/2/index.html?token=bad', base + '_publications/2/index.html#bad'])
    assert.throws(() => publicationAddress(value, base));
});

test('pinned browser publication ordinal is bound to a verified receipt and signed HTML graph', async t => {
  const f = await fixture(t);
  f.page.url = () => f.handle.page_url + '_publications/1/index.html';
  const observer = new StarterObserver({ ...f.request, runDirectory: f.runDirectory, configPath: f.configPath,
    owner: { page: f.page }, native: async () => f.snapshot, packages: f.packages });
  const result = await observer.observe({ check: 'agent-to-browser' }); assert.equal(result.status, 'passed');
  const valid = { runtime: { version: 1, publication: '1', documentPath: 'index.html' } };
  verifyBrowserPublication(valid, f.receipt);
  assert.throws(() => verifyBrowserPublication({ runtime: { ...valid.runtime, version: 2 } }, f.receipt), /selected-version/);
  assert.throws(() => verifyBrowserPublication({ runtime: { ...valid.runtime, publication: f.publication.id } }, f.receipt), /publication-version-id/);
  assert.throws(() => verifyBrowserPublication({ runtime: { ...valid.runtime, documentPath: 'not-signed.html' } }, f.receipt), /unsigned-document/);
  f.page.evaluate = async () => ({ page: f.handle.id, version: 2, publication: '2', documentPath: 'index.html' });
  const wrong = await observer.observe({ check: 'agent-to-browser' });
  assert.equal(wrong.status, 'failed'); assert(wrong.evidence.mismatches.includes('browser-url-runtime-version'));
});

test('claim continuity and later signed CAS updates are separate measurements', async t => {
  const f = await fixture(t), observer = new StarterObserver({ ...f.request, runDirectory: f.runDirectory, configPath: f.configPath, owner: { page: f.page }, packages: f.packages });
  await observer.observe({ check: 'preclaim-publication' });
  const missingBoundary = await observer.observe({ check: 'publication' });
  assert.equal(missingBoundary.status, 'blocked'); assert(missingBoundary.evidence.missing.includes('claim-boundary-checkpoint-not-observed'));
  f.lifecycle.owner = 'fixture-owner';
  const boundary = await observer.observe({ check: 'publication', options: { phase: 'claim-boundary' } });
  assert.equal(boundary.status, 'passed'); assert.equal(boundary.evidence.claimBoundary.before.publication.id, f.publication.id);
  const second = await p.signPublicationManifest({ ...f.publication.payload, operationId: 'release-2', revision: 1, previous: f.publication.id }, f.signer);
  f.receipt.publication = second; f.receipt.version = 2; f.config.publication.operationId = 'release-2'; f.save();
  const stale = await observer.observe({ check: 'publication' });
  assert.equal(stale.status, 'failed'); assert(stale.evidence.mismatches.includes('browser-selected-version'));
  f.page.url = () => f.handle.page_url + '_publications/2/index.html';
  f.page.evaluate = async () => ({ page: f.handle.id, version: 2, publication: '2', documentPath: 'index.html' });
  const current = await observer.observe({ check: 'publication' });
  assert.equal(current.status, 'passed'); assert.equal(current.evidence.publicationId, second.id);
  assert.deepEqual(current.evidence.signedCasLineage.map(value => value.publicationId), [second.id, f.publication.id]);
  assert.equal(current.evidence.claimBoundary.after.publication.id, f.publication.id);
  assert.equal(current.evidence.claimBoundary.retainedSameSignedReceipt, true);
});

test('a later receipt cannot invent the missing claim boundary or skip unobserved signed parents', async t => {
  const f = await fixture(t), observer = new StarterObserver({ ...f.request, runDirectory: f.runDirectory, configPath: f.configPath, owner: { page: f.page }, packages: f.packages });
  await observer.observe({ check: 'preclaim-publication' }); f.lifecycle.owner = 'fixture-owner';
  await observer.observe({ check: 'publication', options: { phase: 'claim-boundary' } });
  const second = await p.signPublicationManifest({ ...f.publication.payload, operationId: 'release-2', revision: 1, previous: f.publication.id }, f.signer);
  const third = await p.signPublicationManifest({ ...second.payload, operationId: 'release-3', revision: 2, previous: second.id }, f.signer);
  f.receipt.publication = third; f.receipt.version = 3; f.config.publication.operationId = 'release-3'; f.save();
  f.page.url = () => f.handle.page_url + '_publications/3/index.html';
  f.page.evaluate = async () => ({ page: f.handle.id, version: 3, publication: '3', documentPath: 'index.html' });
  const absent = await observer.observe({ check: 'publication' });
  assert.equal(absent.status, 'blocked'); assert(absent.evidence.missing.includes('publication-parent-receipt-unobserved'));
  writeFileSync(join(f.project, 'second-receipt.json'), JSON.stringify({ publication: second, version: 2 }));
  f.config.publication.ancestors = [{ file: 'second-receipt.json' }]; f.save();
  assert.equal((await observer.observe({ check: 'publication' })).status, 'passed');
  writeFileSync(join(f.project, 'second-receipt.json'), JSON.stringify({ publication: { ...second, signature: '00'.repeat(64) }, version: 2 }));
  assert.equal((await observer.observe({ check: 'publication' })).status, 'failed');
  f.lifecycle.owner = 'changed-owner'; assert.equal((await observer.observe({ check: 'publication' })).status, 'failed');
});

test('a changed release before the first post-claim checkpoint cannot be relabeled unchanged', async t => {
  const f = await fixture(t), observer = new StarterObserver({ ...f.request, runDirectory: f.runDirectory, configPath: f.configPath, owner: { page: f.page }, packages: f.packages });
  await observer.observe({ check: 'preclaim-publication' }); f.lifecycle.owner = 'fixture-owner';
  const second = await p.signPublicationManifest({ ...f.publication.payload, operationId: 'release-2', revision: 1, previous: f.publication.id }, f.signer);
  f.receipt.publication = second; f.receipt.version = 2; f.config.publication.operationId = 'release-2'; f.save();
  f.page.url = () => f.handle.page_url + '_publications/2/index.html';
  f.page.evaluate = async () => ({ page: f.handle.id, version: 2, publication: '2', documentPath: 'index.html' });
  const result = await observer.observe({ check: 'publication', options: { phase: 'claim-boundary' } });
  assert.equal(result.status, 'failed'); assert(result.evidence.mismatches.includes('claim-boundary-publication-changed'));
  assert.equal(observer.state.checkpoints['preclaim-publication'].receipt.publication.id, f.publication.id);
  assert.equal(observer.state.checkpoints['claim-boundary'], undefined);
});
