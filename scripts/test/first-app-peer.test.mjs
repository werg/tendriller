import assert from 'node:assert/strict';
import test from 'node:test';
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { QUALIFICATION_SOCKET_ENV, connectQualificationPeer, qualificationPageSource } from '../first-app-peer.mjs';

const browser = 'a'.repeat(64);
const files = {
  'node_modules/@chronolog/peer-session/package.json': JSON.stringify({ name: '@chronolog/peer-session', type: 'module',
    exports: { '.': './index.mjs', './native': './native.mjs', './worker': './worker.mjs' } }),
  'node_modules/@chronolog/peer-session/index.mjs': 'export async function verifyAuthorityBundle() {}',
  'node_modules/@chronolog/peer-session/native.mjs': `export async function openNativeApplication() {
  const calls = globalThis.__qualificationCalls;
  if (globalThis.__qualificationFailOpen) throw Error('open failed');
  return { deviceId: 'native-device', signal: new AbortController().signal, onStatus() {},
    connectControlParticipant: () => ({}),
    participation: { status: { phase: 'following', connectedPeers: [${JSON.stringify(browser)}], connectionRevision: 3 },
      onStatus: () => () => {}, diagnostics: async () => [{ peerId: ${JSON.stringify(browser)}, kind: 'direct', sentReliableBytes: 1,
        receivedReliableBytes: 2, sentLiveBytes: 3, receivedLiveBytes: 4 }] },
    query: async () => ({ value: [{ text: 'retained' }], revision: { generation: 'g' } }),
    command: async (_name, input, options) => ({ applied: async () => ({ outcome: 'accepted', operationId: options.operationId, text: input.text }) }),
    async close() { calls.push('session'); } };
}`,
  'node_modules/@chronolog/peer-session/worker.mjs': `export function createApplicationOwner() {
  return { ownerInstanceId: 'owner-instance', async close() { globalThis.__qualificationCalls.push('owner'); } };
}`,
  'node_modules/@tendriller/core/package.json': JSON.stringify({ name: '@tendriller/core', type: 'module',
    exports: { './native-rtc': './native-rtc.mjs', './setup': './setup.mjs' } }),
  'node_modules/@tendriller/core/native-rtc.mjs': 'export function participateNativeApplication() {}',
  'node_modules/@tendriller/core/setup.mjs': 'export function watchApplicationSetup() { return { close() {} }; }',
  'shared/native-page.mjs': 'export function pairingFor() { return { processPairings: async () => [] }; }',
  'shared/participant-lifecycle.mjs': `export function superviseParticipant({ watch }) {
  watch({ onChange() {}, onStatus() {} });
  return { async close() { globalThis.__qualificationCalls.push('lifecycle'); } };
}`,
  'shared/media/inference-service.mjs': `export function servePeerInference({ allowedDevices }) {
  return { snapshot: () => ({ admitted: 0, allowedDevices }), async close() { globalThis.__qualificationCalls.push('inference'); } };
}`,
  'shared/helpers/signal-request.mjs': `export function serveSignalRequests(_session, { signal }) {
  return new Promise(resolve => signal.addEventListener('abort', () => { globalThis.__qualificationCalls.push('requests'); resolve(); }, { once: true }));
}
`,
  'pages/notes/domain.mjs': 'export const definition = { name: "fixture" };',
};

async function fixture(t, { sources = [], failOpen = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'qualification-page-'));
  const sockets = await mkdtemp(join(tmpdir(), 'qsock-'));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), text);
  }
  await writeFile(join(directory, 'pages/notes/agent.mjs'), qualificationPageSource({ evidenceBase64: 'AA==', qualificationSources: sources }));
  const calls = globalThis.__qualificationCalls = [];
  globalThis.__qualificationFailOpen = failOpen;
  const previous = process.env[QUALIFICATION_SOCKET_ENV];
  process.env[QUALIFICATION_SOCKET_ENV] = sockets;
  t.after(async () => {
    if (previous === undefined) delete process.env[QUALIFICATION_SOCKET_ENV]; else process.env[QUALIFICATION_SOCKET_ENV] = previous;
    delete globalThis.__qualificationFailOpen;
    await rm(directory, { recursive: true, force: true }); await rm(sockets, { recursive: true, force: true });
  });
  const module = await import(pathToFileURL(join(directory, 'pages/notes/agent.mjs')).href + `?${Math.random()}`);
  const context = { report() {}, page: { slug: 'notes' },
    host: { peers: { application: async () => ({}), exchange: async () => ({}) } },
    readPrivate: async () => ({}), openDevice: async () => ({ async close() { calls.push('device'); } }) };
  return { module, context, calls, socket: join(sockets, 'notes.sock') };
}

test('the qualification page serves evidence actions over its private socket inside the agent program', async t => {
  const f = await fixture(t);
  const owner = await f.module.openPage(f.context);
  assert.equal(owner.ownerInstanceId, 'owner-instance');
  const peer = connectQualificationPeer(f.socket);
  assert.deepEqual(await peer.request('self'), { deviceId: 'native-device', ownerInstanceId: 'owner-instance' });
  assert.deepEqual((await peer.request('query')).value, [{ text: 'retained' }]);
  assert.equal((await peer.request('command', { text: 'fixture', operationId: 'op-1' })).outcome, 'accepted');
  assert.deepEqual(await peer.request('configure', { browserDeviceId: browser }), { configured: true });
  assert.deepEqual(await peer.request('configure', { browserDeviceId: browser }), { configured: true }, 'Configuration is idempotent.');
  await assert.rejects(peer.request('configure', { browserDeviceId: 'b'.repeat(64) }), /One qualified browser device/);
  assert.deepEqual(await peer.request('transport-snapshot'), { connectionRevision: 3, browserLinks: 1, otherLinks: 0,
    kind: 'direct', sentReliableBytes: 1, receivedReliableBytes: 2, sentLiveBytes: 3, receivedLiveBytes: 4 });
  assert.equal((await peer.request('transport-wait', { kind: 'direct' })).kind, 'direct');
  assert.deepEqual((await peer.request('participation-log')).current, { phase: 'following', peers: [browser] });
  await assert.rejects(peer.request('unknown-action'), /Unknown test action/);
  await owner.close();
  assert.deepEqual(f.calls, ['requests', 'inference', 'lifecycle', 'owner']);
  await assert.rejects(access(f.socket), { code: 'ENOENT' });
  await owner.close();
  assert.deepEqual(f.calls, ['requests', 'inference', 'lifecycle', 'owner'], 'Closing twice joins the one cleanup.');
});

test('qualification actions are dispatched by name and closed before the page owner', async t => {
  const source = (async () => ({ actions: { 'fixture-echo': async ({ value }) => ({ value }) },
    async close() { globalThis.__qualificationCalls.push('qualification'); } })).toString();
  const f = await fixture(t, { sources: [source] });
  const owner = await f.module.openPage(f.context);
  assert.deepEqual(await connectQualificationPeer(f.socket).request('fixture-echo', { value: 7 }), { value: 7 });
  await owner.close();
  assert.deepEqual(f.calls, ['requests', 'qualification', 'lifecycle', 'owner']);
});

test('a failed open releases the device it opened and no socket remains', async t => {
  const f = await fixture(t, { failOpen: true });
  await assert.rejects(f.module.openPage(f.context), /open failed/);
  assert.deepEqual(f.calls, ['device']);
  await assert.rejects(access(f.socket), { code: 'ENOENT' });
});

test('the harness request reports a closed participant instead of waiting', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'qsock-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(connectQualificationPeer(join(directory, 'missing.sock')).request('self', {}, 500), { code: 'ENOENT' });
});
