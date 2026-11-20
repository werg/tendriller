import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import * as p from '@chronolog/peer-session';
import { openNativeDevice, openNativeApplication } from '@chronolog/peer-session/native';
import { definition } from '../../docs/tutorial/domain.mjs';
import { sessionMeasurement, verifySignedOperation, nativeMeasurement, probe } from '../agent-acceptance/observer-native.mjs';
import { StarterObserver } from '../agent-acceptance/observer.mjs';
import { loadObserverConfig } from '../agent-acceptance/observer-data.mjs';
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
  const config = { protocol: 'tendriller-starter-observer-v1', origin: 'https://staging.example', applicationId: session.applicationId, historyId: session.historyId,
    native: { project, module: 'session.mjs', handle: { file: 'handle.json' }, descriptor: { file: 'descriptor.json' }, deviceId: { file: 'device.json', pointer: '/deviceId' }, deviceStore: 'device.sqlite' },
    query: { name: 'notes', rows: '/value', marker: '/text', author: '/author', operationId: '/operationId' },
    browser: { device: { selector: '#device', read: 'value' }, rows: '#rows li' },
    publication: { operationId: 'stable-publish-op' }, commands: { 'browser-to-agent': { name: 'addNote' },
      'agent-to-browser': { name: 'addNote', input: { text: 'Observer marker' }, marker: 'Observer marker', operationId: 'stable-observer-op' } } };
  const configPath = join(directory, 'observer.json'), request = { project, origin: config.origin };
  const save = () => writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 }); save();
  const loaded = loadObserverConfig(configPath, request);
  const snapshot = await sessionMeasurement(session, loaded, p, { operationId: 'stable-observer-op', author: session.deviceId, command: 'addNote' });
  const page = { url: () => handle.page_url, evaluate: async () => ({ page: handle.id, publication: publication.id, version: 1 }),
    locator: selector => ({ count: async () => 1, inputValue: async () => browserSigner.publicKey, innerText: async () => 'Connected',
      allInnerTexts: async () => ['Observer marker · operation stable-observer-op'] }) };
  const packages = async () => ({ session: p, core: { createClient: () => ({ peers: { application: async () => authority, publication: async () => receipt },
    info: async () => ({ owner_account_id: null }) }) } });
  return { directory, runDirectory, project, config, configPath, request, loaded, session, snapshot, browserSigner, publication, receipt, authority, page, packages, save };
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
  const observer = new StarterObserver({ ...f.request, runDirectory: f.runDirectory, configPath: f.configPath, owner: { page: f.page }, native: async () => f.snapshot });
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
  const current = await observer.observe({ check: 'publication' }); assert.equal(current.status, 'passed');
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
    native: async (_config, options) => ({ ...f.snapshot, waiterInterrupted: options.action === 'submit-lost' }) });
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
