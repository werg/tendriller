import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { authorityRecord, authorityRecordBytes } from '../../contract/authority.mjs';
import { sessionMeasurement, verifySignedOperation, verifiedAuthority, nativeMeasurement, probe } from '../agent-acceptance/observer-native.mjs';
import { StarterObserver, verifyBrowserPublication, verifyPublicationLineage, browserLocalMeasurement } from '../agent-acceptance/observer.mjs';
import { loadObserverConfig, publicationAddress } from '../agent-acceptance/observer-data.mjs';
import { Evidence } from '../agent-acceptance/evidence.mjs';

// Explicit current-source authority mapping is permitted for this focused unit
// test only. It is NOT installed-public-package, native SQL or browser qualification.
const p = await import(process.env.AGENT_ACCEPTANCE_AUTHORITY_SOURCE ?? '@chronolog/peer-session');
const revision = { digest: 'ca'.repeat(32), view: 'local', executionManifestDigest: 'ed'.repeat(32), policyDigest: 'fd'.repeat(32) };
const clone = value => structuredClone(value);
async function fixture(t, { native = true } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'authored-observer-')), runDirectory = join(directory, 'run'), project = join(runDirectory, 'project');
  mkdirSync(project, { recursive: true }); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = await p.createSigningIdentity(), browserSigner = await p.createSigningIdentity(), publisher = await p.createSigningIdentity();
  const applicationId = 'ac'.repeat(32), proposalId = 'ab'.repeat(32), operationId = 'original-local-operation';
  const descriptor = await p.signAppDescriptor({ applicationId, authorityPublicKey: root.publicKey, rootPrincipal: root.publicKey,
    executionManifestDigest: revision.executionManifestDigest, finalityPolicy: { kind: 'none' } }, root);
  const membership = await p.signMembership({ applicationId, revision: 0, previous: null, authorTimeAfterMs: -1n, epoch: 0, epochKeyDigest: 'ec'.repeat(32),
    members: [root, browserSigner].map(identity => ({ publicKey: identity.publicKey, wrapKey: null, reader: true, writer: true, administrator: true, publisher: false, finalizer: false })),
    admission: { mode: 'strict', hostKey: root.publicKey, accounts: [], grant: { reader: true, writer: true, administrator: true } }, admitted: [], invites: [] }, root);
  const bundle = { descriptor, memberships: [membership] }, membershipId = await p.recordDigest(membership);
  const envelope = await p.signRecord('operation-envelope', { applicationId, proposalId, author: root.publicKey, authorTimestampMs: 123n,
    membershipId, executionManifestDigest: revision.executionManifestDigest,
    encrypted: { epoch: 0n, nonce: Uint8Array.of(1, 2), ciphertext: Uint8Array.of(3, 4) } }, root);
  // Deliberately no fabricated decrypted core: this is a genuine signed outer
  // envelope and a strict fake public session for observer contract tests only.
  const state = { applicationId, proposalId, operationId, author: root.publicKey, authorTimestampMs: '123', stored: true, pending: null,
    materialized: { proposalId, revision, outcome: 'accepted', rejectionCode: null, failingStatementIndex: null }, retained: [], finalized: false, excluded: false };
  const rows = [{ operationId, author: root.publicKey, text: 'Observer marker' }];
  const event = { id: proposalId + ':0', proposalId, operationId, author: root.publicKey, authorTimestampMs: '123', topic: 'note', payload: { text: 'Observer marker' } };
  const stats = { releases: 0, inspections: 0 };
  const handle = { id: proposalId, operationId, inspect: async () => { stats.inspections++; return clone(state); }, materialized: async options => {
    if (options?.signal?.aborted) throw options.signal.reason; return clone(state.materialized);
  } };
  const session = { applicationId, identity: { publicKey: root.publicKey }, readAuthority: async () => bundle,
    query: async () => ({ applicationId, revision, value: clone(rows) }), status: { connectedPeers: 1, canAuthor: true },
    operations: { get: async id => [proposalId, operationId].includes(id) ? handle : null, retry: async id => { assert.equal(id, proposalId); return handle; } },
    exportFacts: () => ({ authority: bundle, envelopes: [envelope], retentions: [], finality: [] }), command: async (_command, _input, options) => {
      assert.deepEqual(options, { operationId }); return handle;
    }, readView: async () => ({ applicationId, revision, readEvents: async () => ({ revision, events: [event], hasMore: false }), release: () => { stats.releases++; } }) };
  const publicationAuthority = { applicationId, executionManifestDigest: revision.executionManifestDigest, grantId: 'ba'.repeat(32), publisherKeys: [publisher.publicKey] };
  const publication = await p.signPublicationManifest({ applicationId, membershipId: publicationAuthority.grantId, author: publisher.publicKey,
    executionManifestDigest: revision.executionManifestDigest, operationId: 'original-publication', revision: 0, previous: null, entry: 'index.html',
    files: [{ path: 'index.html', hash: 'ff'.repeat(32), size: 3, type: 'text/html' }] }, publisher);
  const receipt = { publication, version: 1 };
  const credential = { service: 'https://staging.example', agent: { id: 'ag_' + 'a'.repeat(26), name: 'fixture' }, token: 'ta_' + 'p'.repeat(32) };
  const hostHandle = { id: 'a'.repeat(12),
    application: { id: applicationId }, page_url: 'https://' + 'a'.repeat(12) + '.staging.example/s/' + 'a'.repeat(26) + '/' };
  const saveRecord = (name, value) => writeFileSync(join(project, name), JSON.stringify(value), { mode: 0o600 });
  saveRecord('descriptor.json', descriptor); saveRecord('handle.json', hostHandle); saveRecord('credential.json', credential); saveRecord('publication.json', publication); saveRecord('assets.json', []);
  const config = { protocol: 'tendriller-starter-observer-v2', origin: 'https://staging.example', project, applicationId, descriptor: { file: 'descriptor.json' }, handle: { file: 'handle.json' }, credential: { file: 'credential.json' },
    ...(native ? { native: { deviceId: root.publicKey, deviceStore: 'device.sqlite' } } : {}), ownerAccountId: 'fixture-owner',
    query: { name: 'notes', sql: 'SELECT operationId, author, text FROM notes', rows: '/value', marker: '/text', author: '/author', operationId: '/operationId' },
    browser: { device: { selector: '#device', read: 'value' }, rows: '#rows li' }, publication: { operationId: 'original-publication', intent: { file: 'publication.json' }, assets: { file: 'assets.json' } },
    commands: { 'browser-to-agent': { name: 'addNote' }, 'agent-to-browser': { name: 'addNote', input: { text: 'Observer marker' }, marker: 'Observer marker', operationId },
      'lost-command-response': { name: 'addNote', input: { text: 'Observer marker' }, marker: 'Observer marker', operationId } } };
  const configPath = join(directory, 'observer.json'), request = { project, origin: config.origin };
  const save = () => writeFileSync(configPath, JSON.stringify(config)); save();
  const loaded = loadObserverConfig(configPath, request);
  let browserLocal, browserOffline = false;
  const page = { url: () => hostHandle.page_url, evaluate: async (_fn, args) => args?.applicationId ? clone(browserLocal) : String(_fn).includes('navigator.onLine') ? browserOffline :
    { page: hostHandle.id, publication: '1', version: 1, documentPath: 'index.html' },
    locator: () => ({ count: async () => 1, inputValue: async () => browserSigner.publicKey,
      allInnerTexts: async () => ['Observer marker · operation ' + operationId] }) };
  const lifecycle = { owner: null, authority: authorityRecord(p.encodeRecord(bundle)) };
  const packages = async () => ({ session: p, core: { authorityRecordBytes, createAgentClient: (auth) => { assert.equal(auth.token, credential.token); return { page: (id, options) => { assert.equal(id, hostHandle.id); assert.equal(options.applicationId, applicationId); return {
    peers: { application: async () => ({ selection: { id: applicationId }, publicationAuthority, authority: lifecycle.authority }), publication: async () => clone(receipt),
      publish: async (intent, _assets) => { assert.deepEqual(intent, publication); return clone(receipt); } },
    info: async () => ({ id: hostHandle.id, application: hostHandle.application, page_url: hostHandle.page_url, owner_account_id: lifecycle.owner }) }; } }; } } });
  const owner = { page, actions: [] };
  const observer = new StarterObserver({ ...request, runDirectory, configPath, owner, native: async (_config, options) => sessionMeasurement(session, loaded, p, options), packages });
  const browserState = clone(state); browserState.author = browserSigner.publicKey;
  browserLocal = { applicationId, deviceId: browserSigner.publicKey, revision, rows: [{ ...rows[0], author: browserSigner.publicKey }],
    events: [{ ...event, author: browserSigner.publicKey }], operation: { state: browserState } };
  return { directory, project, runDirectory, config, configPath, loaded, request, save, saveRecord, session, state, handle, envelope, bundle, root, browserSigner, publisher,
    publicationAuthority, receipt, lifecycle, owner, observer, page, stats, credential, browserLocal, setOffline: value => { browserOffline = value; } };
}

test('current public authority returns void; outer signature, historical writer and scope are independently verified', async t => {
  const f = await fixture(t), authority = await verifiedAuthority(f.bundle, f.loaded.descriptor, p);
  assert.equal(await p.verifyAuthorityBundle(f.bundle), undefined);
  await verifySignedOperation(f.envelope, authority, p);
  for (const mutate of [a => { a.signature = '00'.repeat(64); }, a => { a.payload.proposalId = '00'.repeat(32); },
    a => { a.payload.authorTimestampMs = 124n; }, a => { a.payload.executionManifestDigest = '00'.repeat(32); }, a => { a.payload.applicationId = '00'.repeat(32); }]) {
    const changed = clone(f.envelope); mutate(changed); await assert.rejects(verifySignedOperation(changed, authority, p));
  }
  const noWriter = await p.signMembership({ ...f.bundle.memberships[0].payload, members: f.bundle.memberships[0].payload.members.map(member => ({ ...member, writer: false })) }, f.root);
  const noWriterBundle = { descriptor: f.bundle.descriptor, memberships: [noWriter] };
  const noWriterAuthority = await verifiedAuthority(noWriterBundle, f.loaded.descriptor, p);
  const revoked = await p.signRecord('operation-envelope', { ...f.envelope.payload, membershipId: await p.recordDigest(noWriter) }, f.root);
  await assert.rejects(verifySignedOperation(revoked, noWriterAuthority, p), /historical-writer/);
});

test('measurement uses get/inspect, coherent top-level applicationId and independent operation facts', async t => {
  const f = await fixture(t), measured = await sessionMeasurement(f.session, f.loaded, p, { operationId: f.state.operationId, author: f.root.publicKey });
  assert.equal(measured.operation.state.proposalId, f.state.proposalId); assert.equal(measured.operation.signatureVerified, true);
  assert.equal(measured.operation.state.stored, true); assert.equal(measured.operation.state.finalized, false); assert.deepEqual(measured.operation.state.retained, []);
  assert.match(measured.operation.proofScope, /not independent decrypted-core/); assert.equal('attempt' in measured.operation, false);
  assert.equal(p.decodeRecord(Buffer.from(measured.operation.envelope.record, 'hex')).payload.proposalId, f.state.proposalId);
  assert.equal(JSON.stringify(measured).includes('privateKey'), false);
  f.session.query = async () => ({ applicationId: '00'.repeat(32), revision, value: [] });
  await assert.rejects(sessionMeasurement(f.session, f.loaded, p), /query-application/);
});

test('read-only facade without exportFacts precisely blocks crypto evidence, not ordinary coherent reads', async t => {
  const f = await fixture(t); delete f.session.exportFacts;
  const read = await sessionMeasurement(f.session, f.loaded, p); assert.equal(read.rows.length, 1);
  await assert.rejects(sessionMeasurement(f.session, f.loaded, p, { operationId: f.state.operationId, author: f.root.publicKey }), /signed-operation-evidence-unsupported/);
  assert.equal(f.stats.inspections, 1);
});

test('coherent event evidence binds stable proposal, author and operation, releases pinned view on error', async t => {
  const f = await fixture(t); f.loaded.query.operationId = null;
  const measured = await sessionMeasurement(f.session, f.loaded, p, { operationId: f.state.proposalId, author: f.root.publicKey });
  assert.equal(measured.events[0].proposalId, f.state.proposalId); assert.equal(f.stats.releases, 1);
  f.session.readView = async () => ({ applicationId: f.state.applicationId, revision: { ...revision, digest: 'changed' }, release: () => { f.stats.releases++; } });
  await assert.rejects(sessionMeasurement(f.session, f.loaded, p, { operationId: f.state.operationId, author: f.root.publicKey }), /coherent-query-event-view/);
  assert.equal(f.stats.releases, 2);
});

test('round trip requires real measured signed envelope and coherent domain row, not applied/status labels', async t => {
  const f = await fixture(t), evidence = new Evidence(f.runDirectory, {});
  const passed = await f.observer.observe({ check: 'agent-to-browser' });
  assert.equal(passed.status, 'passed', JSON.stringify(passed)); evidence.observation(passed, 'unit-observer');
  assert.equal(passed.evidence.proposalId, f.state.proposalId); assert.equal('commandOutcome' in passed.evidence, false);
  f.page.locator = () => ({ count: async () => 1, inputValue: async () => f.browserSigner.publicKey, allInnerTexts: async () => ['Observer marker unrelated'] });
  const wrong = await f.observer.observe({ check: 'agent-to-browser' }); assert.equal(wrong.status, 'failed'); assert.deepEqual(wrong.evidence.mismatches, ['browser-operation-row']);
  evidence.finish(); assert.equal(evidence.data.outcome, 'blocked'); assert(!readFileSync(join(f.runDirectory, 'report.json'), 'utf8').includes(f.credential.token));
});

test('lost response checkpoint preserves proposal, timestamp and exact signed-envelope witness on retry', async t => {
  const f = await fixture(t), measured = await sessionMeasurement(f.session, f.loaded, p, { operationId: f.state.operationId, author: f.root.publicKey });
  const actions = [];
  f.observer.native = async (_config, options) => { actions.push(options); return { ...clone(measured), waiterInterrupted: options.action === 'submit-lost' }; };
  assert.equal((await f.observer.observe({ check: 'lost-command-response', options: { action: 'retry' } })).status, 'blocked');
  assert.equal((await f.observer.observe({ check: 'lost-command-response', options: { action: 'submit-lost' } })).status, 'blocked');
  const passed = await f.observer.observe({ check: 'lost-command-response', options: { action: 'retry' } });
  assert.equal(passed.status, 'passed', JSON.stringify(passed));
  assert.equal(passed.evidence.proposalId, passed.evidence.retryProposalId); assert.equal(passed.evidence.proofHash, passed.evidence.retryProofHash);
  assert.equal(actions.at(-1).expectedProposalId, f.state.proposalId);
  new Evidence(f.directory, {}).observation(passed, 'unit-observer');
  f.observer.native = async () => ({ ...clone(measured), operation: { ...clone(measured.operation), proofHash: '00'.repeat(32) } });
  assert.equal((await f.observer.observe({ check: 'lost-command-response', options: { action: 'retry' } })).status, 'failed');
});

test('publication authority is independent and preclaim needs no data root/native/descriptor', async t => {
  const f = await fixture(t, { native: false }); delete f.config.descriptor; f.save(); f.lifecycle.authority = null;
  const result = await f.observer.observe({ check: 'preclaim-publication' });
  assert.equal(result.status, 'passed', JSON.stringify(result)); assert.equal(result.evidence.signatureVerified, true);
  assert.equal((await f.observer.observe({ check: 'authority' })).status, 'blocked');
  f.lifecycle.owner = 'foreign-owner';
  assert.equal((await f.observer.observe({ check: 'publication', options: { phase: 'claim-boundary' } })).status, 'failed');
  f.lifecycle.owner = 'fixture-owner';
  assert.equal((await f.observer.observe({ check: 'publication', options: { phase: 'claim-boundary' } })).status, 'passed');
  assert.equal((await f.observer.observe({ check: 'agent-to-browser' })).evidence.missing[0], 'optional-native-observer-not-configured');
});

test('saved signed publication retry returns the same receipt, not an operation application count', async t => {
  const f = await fixture(t, { native: false });
  assert.equal((await f.observer.observe({ check: 'lost-publication-response' })).status, 'blocked');
  assert.equal((await f.observer.observe({ check: 'lost-publication-response', options: { action: 'drop' } })).status, 'blocked');
  const passed = await f.observer.observe({ check: 'lost-publication-response' });
  assert.equal(passed.status, 'passed', JSON.stringify(passed)); assert.equal(passed.evidence.receiptCount, 1);
  assert.equal(passed.evidence.publicationHash, passed.evidence.retryPublicationHash);
  new Evidence(f.directory, {}).observation(passed, 'unit-observer');
  f.receipt.version = 2; assert.equal((await f.observer.observe({ check: 'lost-publication-response' })).status, 'failed');
});

test('later publication verifies actual signed CAS parents; missing parents and cycles cannot pass', async t => {
  const f = await fixture(t);
  const next = { version: 2, publication: await p.signPublicationManifest({ ...f.receipt.publication.payload, operationId: 'second-publication', revision: 1, previous: f.receipt.publication.id }, f.publisher) };
  const lineage = await verifyPublicationLineage(next, f.receipt, [f.receipt], p, f.publicationAuthority);
  assert.equal(lineage.length, 2);
  const third = { version: 3, publication: await p.signPublicationManifest({ ...next.publication.payload, operationId: 'third-publication', revision: 2, previous: next.publication.id }, f.publisher) };
  await assert.rejects(verifyPublicationLineage(third, f.receipt, [], p, f.publicationAuthority), /parent-receipt-unobserved/);
  const invalid = clone(next); invalid.publication.signature = '00'.repeat(64);
  await assert.rejects(verifyPublicationLineage(invalid, f.receipt, [f.receipt], p, f.publicationAuthority));
});

test('native-optional browser reload checks same local identity/proposal and actual reload action', async t => {
  const f = await fixture(t, { native: false }), options = { operationId: f.state.operationId, author: f.browserSigner.publicKey, marker: 'Observer marker' };
  const measured = await browserLocalMeasurement(f.owner, f.loaded, options); assert.equal(measured.local.operation.state.stored, true);
  assert.equal((await f.observer.observe({ check: 'browser-reload', options: { ...options, phase: 'before' } })).status, 'blocked');
  assert.equal((await f.observer.observe({ check: 'browser-reload', options })).evidence.missing[0], 'browser-reload-not-observed');
  f.owner.actions.push({ action: 'reload' });
  const passed = await f.observer.observe({ check: 'browser-reload', options });
  assert.equal(passed.status, 'passed', JSON.stringify(passed)); assert.equal(passed.evidence.nativeRequired, false);
  new Evidence(f.directory, {}).observation(passed, 'unit-observer');
});

test('offline browser authoring needs a new stored/materialized proposal and does not claim convergence/finality', async t => {
  const f = await fixture(t, { native: false }), options = { operationId: f.state.operationId, author: f.browserSigner.publicKey, marker: 'Observer marker' };
  f.browserLocal.events = [];
  assert.equal((await f.observer.observe({ check: 'unavailable-peer', options: { phase: 'before' } })).status, 'blocked');
  f.browserLocal.events = [{ proposalId: f.state.proposalId }]; f.setOffline(true);
  assert.equal((await f.observer.observe({ check: 'unavailable-peer', options: { ...options, phase: 'offline' } })).status, 'blocked');
  const passed = await f.observer.observe({ check: 'unavailable-peer', options });
  assert.equal(passed.status, 'passed', JSON.stringify(passed)); assert.match(passed.evidence.convergence, /Not established/);
  assert.equal(passed.evidence.browserNetworkOffline, true); assert.equal(passed.evidence.localDurable, true);
  new Evidence(f.directory, {}).observation(passed, 'unit-observer');
});

test('private config pins run/project/origin and rejects old-profile config, signer substitution and module escapes', async t => {
  const f = await fixture(t);
  assert.throws(() => loadObserverConfig(f.configPath, { ...f.request, origin: 'https://other.example' }), /observer-origin/);
  f.config.protocol = 'tendriller-starter-observer-v1'; f.save(); assert.throws(() => loadObserverConfig(f.configPath, f.request), /observer-config-version/);
  f.config.protocol = 'tendriller-starter-observer-v2'; f.save();
  // Native is optional and workspace-attached only: no module, export or profile fallback exists.
  for (const key of ['module', 'export', 'profile']) {
    f.config.native[key] = 'escape.mjs'; f.save();
    assert.throws(() => loadObserverConfig(f.configPath, f.request), /native-workspace-attachment-required/);
    delete f.config.native[key]; f.save();
  }
  const record = f.config.handle; delete f.config.credential; f.save();
  assert.throws(() => loadObserverConfig(f.configPath, f.request), /agent-credential/);
  f.config.credential = { file: 'credential.json' }; writeFileSync(join(f.project, 'handle.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(f.project, 'handle.json'), 'utf8')), token: 'ta_' + 'p'.repeat(32) })); f.save();
  assert.throws(() => loadObserverConfig(f.configPath, f.request), /page-record-must-not-hold-agent-credential/);
  await assert.rejects(nativeMeasurement({}), /optional-native-observer-not-configured/);
});

test('publication selection binds immutable URL ordinal, runtime identity and signed HTML path', async t => {
  const f = await fixture(t), pageUrl = f.loaded.handle.page_url;
  assert.deepEqual(publicationAddress(pageUrl, pageUrl), { version: null, documentPath: null });
  assert.deepEqual(publicationAddress(pageUrl + '_publications/2/nested/index.html', pageUrl), { version: 2, documentPath: 'nested/index.html' });
  for (const url of [pageUrl + '?other=1', pageUrl + '_publications/0/index.html', pageUrl + '_publications/2/%2e%2e/index.html', 'https://foreign.example/']) assert.throws(() => publicationAddress(url, pageUrl));
  verifyBrowserPublication({ runtime: { version: 1, publication: '1', documentPath: 'index.html' } }, f.receipt);
  assert.throws(() => verifyBrowserPublication({ runtime: { version: 2, publication: '2', documentPath: 'index.html' } }, f.receipt), /selected-version/);
  assert.throws(() => verifyBrowserPublication({ runtime: { version: 1, publication: '1', documentPath: 'unsigned.html' } }, f.receipt), /unsigned-document/);
});

test('probe only attaches/detaches; current retry uses the original proposal handle and never resubmits', async t => {
  const f = await fixture(t); let detached = 0, submitted = 0;
  const command = f.session.command;
  f.session.command = (...args) => { submitted++; return command(...args); };
  const attachments = [];
  const dependencies = { packages: async () => ({ session: p }), workspaceTools: async () => ({
    openWorkspace: async ({ root }) => ({ root }),
    attachPage: async (workspace, page, { signal }) => { attachments.push([workspace.root, page]); assert(signal instanceof AbortSignal);
      return { session: f.session, detach: async () => { detached++; } }; } }) };
  const options = { operationId: f.state.operationId, command: 'addNote', input: { text: 'Observer marker' } };
  const lost = await probe(f.loaded, { ...options, action: 'submit-lost' }, dependencies);
  assert.equal(lost.waiterInterrupted, true); assert.equal(submitted, 1); assert.equal(detached, 1);
  const retried = await probe(f.loaded, { ...options, action: 'retry', author: f.root.publicKey,
    expectedProposalId: f.state.proposalId, expectedProofHash: lost.operation.proofHash }, dependencies);
  assert.equal(retried.operation.state.proposalId, lost.operation.state.proposalId);
  assert.equal(retried.operation.state.authorTimestampMs, lost.operation.state.authorTimestampMs);
  assert.equal(retried.operation.proofHash, lost.operation.proofHash); assert.equal(submitted, 1); assert.equal(detached, 2);
  delete f.session.exportFacts;
  await assert.rejects(probe(f.loaded, { ...options, action: 'submit' }, dependencies), /signed-operation-evidence-unsupported/);
  assert.equal(submitted, 1); assert.equal(detached, 3);
  assert.deepEqual([...new Set(attachments.map(entry => entry.join('|')))], [f.project + '|' + f.loaded.handle.id], 'only the workspace page attachment is used');
});

test('multiple signed outer envelopes preserve one stable proposal and retry selects the original witness', async t => {
  const f = await fixture(t);
  const before = await sessionMeasurement(f.session, f.loaded, p, { operationId: f.state.operationId, author: f.root.publicKey });
  const other = await p.signRecord('operation-envelope', { ...f.envelope.payload, encrypted: { ...f.envelope.payload.encrypted, nonce: Uint8Array.of(9) } }, f.root);
  f.session.exportFacts = () => ({ envelopes: [other, f.envelope], retentions: [], finality: [] });
  const measured = await sessionMeasurement(f.session, f.loaded, p, { operationId: f.state.operationId, author: f.root.publicKey, expectedProofHash: before.operation.proofHash });
  assert.equal(measured.operation.proofHash, before.operation.proofHash);
  assert.equal(measured.operation.state.proposalId, before.operation.state.proposalId);
});

test('peer retention verifies its signature and actual author/envelope subject, independently of materialization/finality', async t => {
  const f = await fixture(t), options = { operationId: f.state.operationId, author: f.root.publicKey };
  const payload = { applicationId: f.state.applicationId, proposalId: f.state.proposalId, author: f.root.publicKey,
    envelopeDigest: await p.recordDigest(f.envelope), peer: f.browserSigner.publicKey, storageId: 'independent-peer-store' };
  f.state.retained = [await p.signRecord('retention', payload, f.browserSigner)];
  const measured = await sessionMeasurement(f.session, f.loaded, p, options);
  assert.equal(measured.operation.state.retained.length, 1); assert.equal(measured.operation.state.finalized, false);
  f.state.retained = [await p.signRecord('retention', { ...payload, envelopeDigest: '00'.repeat(32) }, f.browserSigner)];
  await assert.rejects(sessionMeasurement(f.session, f.loaded, p, options), /retention-signed-envelope-subject/);
  f.state.retained = [await p.signRecord('retention', { ...payload, author: f.browserSigner.publicKey }, f.browserSigner)];
  await assert.rejects(sessionMeasurement(f.session, f.loaded, p, options), /retention-author/);
  f.state.retained = [await p.signRecord('retention', payload, f.browserSigner)]; f.state.retained[0].signature = '00'.repeat(64);
  await assert.rejects(sessionMeasurement(f.session, f.loaded, p, options), /AUTHORITY_SIGNATURE_INVALID/);
});

test('browser callback actually consumes the installed backend and releases one coherent read view', async t => {
  const f = await fixture(t, { native: false }), options = { operationId: f.state.operationId, author: f.browserSigner.publicKey, marker: 'Observer marker' };
  const evaluate = f.page.evaluate; let releases = 0;
  const backend = { applicationId: f.state.applicationId, identity: { publicKey: f.browserSigner.publicKey },
    operations: { get: async id => { assert.equal(id, f.state.operationId); return { inspect: async () => clone(f.browserLocal.operation.state) }; } },
    readView: async () => ({ applicationId: f.state.applicationId, revision,
      query: async (sql, parameters) => { assert.equal(sql, f.loaded.query.sql); assert.deepEqual(parameters, []);
        return { columns: [{ name: 'operationId' }, { name: 'author' }, { name: 'text' }], rows: [[f.state.operationId, f.browserSigner.publicKey, 'Observer marker']] }; },
      readEvents: async () => ({ revision, events: f.browserLocal.events, hasMore: false }), release: async () => { releases++; } }) };
  f.page.evaluate = async (fn, args) => {
    if (!args?.applicationId) return evaluate(fn, args);
    const previous = globalThis.window;
    globalThis.window = { tendril: { application: { available: true, backend } } };
    try { return await fn(args); } finally { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; }
  };
  const measured = await browserLocalMeasurement(f.owner, f.loaded, options);
  assert.equal(measured.local.rows[0].text, 'Observer marker'); assert.equal(releases, 1);
  backend.applicationId = '00'.repeat(32);
  await assert.rejects(browserLocalMeasurement(f.owner, f.loaded, options), /browser-backend-application/);
});

test('canonical descriptor transport retains signed bigint policy scopes without JSON reinterpretation', async t => {
  const f = await fixture(t);
  const descriptor = await p.signAppDescriptor({ ...f.bundle.descriptor.payload,
    finalityPolicy: { kind: 'signed-frontier', signer: f.root.publicKey, scopes: [{ id: 'cc'.repeat(32), authorTimeAfterMs: -1n }] } }, f.root);
  const bundle = { ...f.bundle, descriptor };
  const pinned = authorityRecord(p.encodeRecord(descriptor));
  f.saveRecord('descriptor.json', pinned);
  const config = loadObserverConfig(f.configPath, f.request);
  const authority = await verifiedAuthority(bundle, config.descriptor, p);
  assert.equal(authority.descriptor.finalityPolicy.scopes[0].authorTimeAfterMs, -1n);
});
