import assert from 'node:assert/strict';
import test from 'node:test';
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { closeSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { QUALIFICATION_SOCKET_ENV, connectQualificationPeer, qualificationPageSource } from '../first-app-peer.mjs';

const browser = 'a'.repeat(64);
const APPLICATION = 'f'.repeat(64);

// The qualification page module is imported the way `tendril agent run` imports a page module. Its
// shared modules are stubs of the CURRENT public surface: openNativePage returns the workspace owner
// (public session with identity.publicKey, status/onStatus, query, command/materialized) plus the
// separate participation controller. Cleanup order is recorded so close semantics are observed.
const files = {
  'shared/native-page.mjs': `export async function openNativePage(context) {
  const calls = globalThis.__qualificationCalls, status = { canAuthor: true, phase: 'ready', database: 'ready', materializationError: null, connectionRevision: 3 };
  if (globalThis.__qualificationFailOpen) throw Error('open failed');
  const signal = new AbortController().signal;
  const operation = (operationId, input) => ({ id: 'p'.repeat(64), operationId,
    materialized: async () => ({ outcome: 'accepted', operationId, text: input.text }),
    retained: async () => { throw Error('Local commands must not wait for peer retention'); },
    finalized: async () => { throw Error('Local commands must not wait for finality'); } });
  const session = { applicationId: ${JSON.stringify(APPLICATION)}, identity: { publicKey: 'native-key' }, signal, get status() { return status; },
    onStatus(listener) { listener(status); return () => {}; },
    query: async (name, input) => ({ applicationId: ${JSON.stringify(APPLICATION)}, revision: { digest: 'd', view: 'local' }, value: [{ text: 'retained' }, name, input] }),
    // Reliable and live byte counters come from the authenticated application links of the session itself.
    diagnostics: async () => [{ peerId: ${JSON.stringify(browser)}, sentReliableBytes: 1, receivedReliableBytes: 2, sentLiveBytes: 3, receivedLiveBytes: 4 }],
    command: async (name, input, options) => { globalThis.__qualificationCommands.push({ name, input, options }); return operation(options.operationId, input); },
    close: async () => { throw Error('The page owner closes the session, never the qualification page directly'); } };
  const participation = { status: { phase: 'connected', connectedPeers: [${JSON.stringify(browser)}], connectionRevision: 3 },
    // The rendezvous controller reports only the selected live route kind, never application byte counters.
    onStatus: () => () => {}, diagnostics: async () => [{ peerId: ${JSON.stringify(browser)}, kind: 'direct' }] };
  return { session, participation, ownerInstanceId: 'owner-instance', async close() { calls.push('owner'); } };
}`,
  'shared/media/inference-service.mjs': `export function servePeerInference({ allowedDevices, maxRequests }) {
  return { snapshot: () => ({ admitted: 0, allowedDevices, maxRequests }), async close() { globalThis.__qualificationCalls.push('inference'); } };
}`,
  'shared/helpers/signal-request.mjs': `export function serveSignalRequests(_session, { signal }) {
  return new Promise(resolve => signal.addEventListener('abort', () => { globalThis.__qualificationCalls.push('requests'); resolve(); }, { once: true }));
}
`,
  'pages/notes/domain.mjs': 'export const definition = { name: "fixture" };',
};

async function fixture(t, { sources = [], failOpen = false, networkQualification = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'qualification-page-'));
  const privateSockets = await mkdtemp(join(tmpdir(), 'qsock-'));
  // Unix socket paths are limited to ~107 bytes and a scratch TMPDIR can exceed that. Address the same private
  // directory through its open descriptor (Linux), which keeps the filesystem permissions and stays short.
  const directoryFd = process.platform === 'linux' ? openSync(privateSockets) : null;
  const sockets = directoryFd === null ? privateSockets : `/proc/self/fd/${directoryFd}`;
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), text);
  }
  const source = qualificationPageSource({ evidenceBase64: 'AA==', networkQualification, qualificationSources: sources });
  await writeFile(join(directory, 'pages/notes/agent.mjs'), source);
  const calls = globalThis.__qualificationCalls = [];
  globalThis.__qualificationCommands = [];
  globalThis.__qualificationFailOpen = failOpen;
  const previous = process.env[QUALIFICATION_SOCKET_ENV];
  process.env[QUALIFICATION_SOCKET_ENV] = sockets;
  t.after(async () => {
    if (previous === undefined) delete process.env[QUALIFICATION_SOCKET_ENV]; else process.env[QUALIFICATION_SOCKET_ENV] = previous;
    delete globalThis.__qualificationFailOpen; delete globalThis.__qualificationCommands;
    if (directoryFd !== null) closeSync(directoryFd);
    await rm(directory, { recursive: true, force: true }); await rm(privateSockets, { recursive: true, force: true });
  });
  const module = await import(pathToFileURL(join(directory, 'pages/notes/agent.mjs')).href + `?${Math.random()}`);
  const context = { report() {}, page: { slug: 'notes' }, host: {}, readPrivate: async () => ({}), openDevice: async () => { throw Error('The page module must not open a device itself'); } };
  return { module, context, calls, source, socket: join(sockets, 'notes.sock') };
}

test('the qualification page serves evidence actions over its private socket inside the agent program', async t => {
  const f = await fixture(t);
  const owner = await f.module.openPage(f.context);
  assert.equal(owner.ownerInstanceId, 'owner-instance');
  const peer = connectQualificationPeer(f.socket);
  assert.deepEqual(await peer.request('self'), { publicKey: 'native-key', ownerInstanceId: 'owner-instance' });
  assert.deepEqual((await peer.request('query')).value.slice(0, 1), [{ text: 'retained' }]);
  const stored = await peer.request('command', { text: 'fixture', operationId: 'op-1' });
  assert.equal(stored.outcome, 'accepted');
  assert.deepEqual(globalThis.__qualificationCommands, [{ name: 'putNote', input: { noteId: 'op-1', text: 'fixture' }, options: { operationId: 'op-1' } }],
    'one direct session.command with the caller operation ID, no basedOn and no second queue');
  assert.deepEqual(await peer.request('configure', { browserDeviceId: browser }), { configured: true });
  assert.deepEqual(await peer.request('configure', { browserDeviceId: browser }), { configured: true }, 'Configuration is idempotent.');
  await assert.rejects(peer.request('configure', { browserDeviceId: 'b'.repeat(64) }), /One qualified browser device/);
  assert.deepEqual(await peer.request('transport-snapshot'), { connectionRevision: 3, browserLinks: 1, otherLinks: 0,
    kind: 'direct', sentReliableBytes: 1, receivedReliableBytes: 2, sentLiveBytes: 3, receivedLiveBytes: 4 });
  assert.equal((await peer.request('transport-wait', { kind: 'direct' })).kind, 'direct');
  assert.deepEqual((await peer.request('participation-log')).current, { phase: 'connected', peers: [browser] });
  assert.equal((await peer.request('inference-status')).calls, 0);
  await assert.rejects(peer.request('unknown-action'), /Unknown test action/);
  await owner.close();
  assert.deepEqual(f.calls, ['requests', 'inference', 'owner']);
  await assert.rejects(access(f.socket), { code: 'ENOENT' });
  await owner.close();
  assert.deepEqual(f.calls, ['requests', 'inference', 'owner'], 'Closing twice joins the one cleanup.');
});

test('the qualification page models only the current session API and reports public-key identity', async t => {
  const f = await fixture(t);
  // Removed generation, pairing, recovery and ordering-pause vocabulary must not return.
  assert.doesNotMatch(f.source, /orderingPause|ordering-pause|processPairings|pairing|watchSetup|superviseParticipant|\.applied\(|basedOn|session\.deviceId|connectControlParticipant|createGenerationRegistry/i);
  const owner = await f.module.openPage(f.context);
  const peer = connectQualificationPeer(f.socket);
  for (const action of ['ordering-pause', 'pairing-process']) await assert.rejects(peer.request(action), /Unknown test action/);
  assert.equal('deviceId' in await peer.request('self'), false);
  await owner.close();
});

test('local readiness and diagnostics use local status only and expose separate participation', async t => {
  const f = await fixture(t);
  const owner = await f.module.openPage(f.context);
  const peer = connectQualificationPeer(f.socket);
  const ready = await peer.request('setup-ready');
  assert.equal(ready.before.ready, true);
  assert.equal(ready.after.ready, true, 'no connected peer or finalizer is needed');
  const diagnostics = await peer.request('diagnostics');
  assert.equal(diagnostics.status.canAuthor, true);
  assert.equal(diagnostics.participation.phase, 'connected');
  assert.equal(diagnostics.setupReadiness.ready, true);
  assert.equal(diagnostics.signalRequests.state, 'running');
  await owner.close();
});

test('inference admission is bounded by default and widened only for network qualification', async t => {
  for (const [networkQualification, expected] of [[false, 2], [true, 20]]) {
    const f = await fixture(t, { networkQualification });
    const owner = await f.module.openPage(f.context);
    const peer = connectQualificationPeer(f.socket);
    await peer.request('configure', { browserDeviceId: browser });
    assert.equal((await peer.request('inference-status')).maxRequests, expected);
    await owner.close();
  }
});

test('qualification actions are dispatched by name and closed before the page owner', async t => {
  const source = (async () => ({ actions: { 'fixture-echo': async ({ value }) => ({ value }) },
    async close() { globalThis.__qualificationCalls.push('qualification'); } })).toString();
  const f = await fixture(t, { sources: [source] });
  const owner = await f.module.openPage(f.context);
  assert.deepEqual(await connectQualificationPeer(f.socket).request('fixture-echo', { value: 7 }), { value: 7 });
  await owner.close();
  assert.deepEqual(f.calls, ['requests', 'qualification', 'owner']);
});

test('a failed open leaves no socket and no half-open owner', async t => {
  const f = await fixture(t, { failOpen: true });
  await assert.rejects(f.module.openPage(f.context), /open failed/);
  assert.deepEqual(f.calls, [], 'nothing was started, so nothing needs closing and the page owner is not closed twice');
  await assert.rejects(access(f.socket), { code: 'ENOENT' });
});

test('the harness request reports a closed participant instead of waiting', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'qsock-'));
  const directoryFd = process.platform === 'linux' ? openSync(directory) : null;
  t.after(async () => { if (directoryFd !== null) closeSync(directoryFd); await rm(directory, { recursive: true, force: true }); });
  const alias = directoryFd === null ? directory : `/proc/self/fd/${directoryFd}`;
  await assert.rejects(connectQualificationPeer(join(alias, 'missing.sock')).request('self', {}, 500), { code: 'ENOENT' });
});
