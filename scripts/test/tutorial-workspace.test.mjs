import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, cp, symlink, writeFile, readFile, readdir, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../../', import.meta.url));
const run = promisify(execFile);
const flush = () => new Promise(resolve => setImmediate(resolve));
const PAGE = 'abcdefghijkl', TOKEN = 'ta_' + 'b'.repeat(32), AGENT = 'ag_' + 'c'.repeat(26);

/** A downloaded kit extracted into an empty folder, with the built public packages installed. */
async function kit(t) {
  const directory = await mkdtemp(join(tmpdir(), 'kit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(join(root, 'docs/tutorial'), directory, { recursive: true });
  for (const [scope, name, source] of [['@tendriller', 'core', 'dist/sdk'], ['@chronolog', 'peer-session', 'node_modules/@chronolog/peer-session']]) {
    await mkdir(join(directory, 'node_modules', scope), { recursive: true });
    await symlink(join(root, source), join(directory, 'node_modules', scope, name));
  }
  // The tools package is copied so its runtime imports resolve inside this workspace's install.
  await cp(join(root, 'dist/tools'), join(directory, 'node_modules/@tendriller/tools'), { recursive: true });
  await mkdir(join(directory, 'node_modules/.bin'), { recursive: true });
  await symlink(join(directory, 'node_modules/@tendriller/tools/bin/tendril.mjs'), join(directory, 'node_modules/.bin/tendril'));
  return directory;
}

/** Only the host boundary is a fixture: signed authority, native storage, build and owner are real. */
async function hostPeers() {
  const p = await import('@chronolog/peer-session');
  const signer = await p.createPeerIdentity();
  let registry;
  const unavailable = () => { throw Error('Unexpected remote peer'); };
  const wait = signal => {
    const done = Promise.withResolvers(), close = () => done.resolve();
    signal?.addEventListener('abort', close, { once: true }); if (signal?.aborted) close();
    return { ready: Promise.resolve(), close, done: done.promise, closed: done.promise };
  };
  return {
    async configureApplication(configuration) {
      const descriptor = await p.signApplicationDescriptor({ applicationId: '74'.repeat(32), historyId: configuration.historyId,
        profile: 'peer-generation-v1', policy: 'eligible-members-v1', controlPublicKey: signer.publicKey,
        schemaAdministrator: configuration.schemaAdministrator, definitionDigest: await p.applicationDescriptionDigest(configuration.definition),
        executionManifestDigest: configuration.executionManifestDigest, schemaDigest: null }, signer);
      const control = await p.signControlRevision({ applicationId: descriptor.payload.applicationId, profile: descriptor.payload.profile,
        policy: descriptor.payload.policy, revision: 0, previous: null, epoch: 0, keyDigest: configuration.keyDigest, recoveryFloor: null,
        grants: configuration.members.map(member => member.grant) }, signer);
      registry ??= await p.createGenerationRegistry({ store: new p.MemoryBytesStore(), descriptor, controls: [control], signer });
      return registry.read();
    },
    selectGeneration: request => registry.select(request),
    application: () => registry.read(),
    exchange: async request => p.createParticipantResponse(request, request.action === 'read' ? await registry.read() : unavailable()),
    discover: async () => ({ peers: [] }), advertise: async () => {}, withdraw: async () => {},
    invite: unavailable, rendezvous: unavailable, relay: unavailable,
    watchDiscovery(_identity, { signal }) { const life = wait(signal);
      return { ...life, notifications: { async *[Symbol.asyncIterator]() { yield { type: 'ready' }; await life.done; } } }; },
    listenInvitations(_identity, { signal }) { const life = wait(signal);
      return { ...life, invitations: { async *[Symbol.asyncIterator]() { await life.done; } } }; },
  };
}

/** The page context `tendril agent run` hands a page module, over a fixture host. */
async function pageContext(directory, slug, { signal, requests = [] } = {}) {
  const { openSharedSigner, openPageDevice, savePrivateJson } = await import(pathToFileURL(join(directory, 'node_modules/@tendriller/tools/lib/workspace.mjs')).href);
  const privateDir = join(directory, '.tendriller/pages', PAGE), identity = join(directory, '.tendriller/agent/identity.sqlite');
  await mkdir(privateDir, { recursive: true, mode: 0o700 });
  const signer = await openSharedSigner(identity, { create: true });
  const peers = await hostPeers(), reports = [];
  const host = { base: `https://service.test/api/agent/pages/${PAGE}`, peers,
    info: async () => ({ owner_account_id: 'acct_owner' }),
    fetch: async () => Response.json({ pairings: [] }),
    async request(path, options) { requests.push({ path, ...options }); return { proposed: 'd'.repeat(64), reviewUrl: 'https://service.test/review', approved: false, applicationId: '74'.repeat(32) }; },
    socket() { const socket = new EventTarget(); socket.readyState = 1; socket.close = () => { socket.readyState = 3; socket.dispatchEvent(Object.assign(new Event('close'), { code: 1000 })); }; queueMicrotask(() => socket.dispatchEvent(new Event('open'))); return socket; },
  };
  const read = async (name, optional = false) => {
    try { return JSON.parse(await readFile(join(privateDir, name), 'utf8')); }
    catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
  };
  return { reports, context: { workspace: directory, service: 'https://service.test', agent: { id: AGENT, name: 'laptop' },
    page: { id: PAGE, slug, name: 'Field notes', applicationId: '74'.repeat(32), pageUrl: `https://${PAGE}.pages.test/s/${'e'.repeat(26)}/`,
      directory: privateDir, source: join(directory, 'pages', slug) },
    host, signal, report: value => reports.push(value), signer: { publicKey: signer.publicKey },
    devicePath: join(privateDir, 'device.sqlite'),
    openDevice: ({ create = false } = {}) => openPageDevice({ path: join(privateDir, 'device.sqlite'), signer, create }),
    readPrivate: read, savePrivate: (name, value) => savePrivateJson(join(privateDir, name), value), privatePath: name => join(privateDir, name) } };
}

test('a renamed events page initializes with the shared agent key, builds its dist and runs as an agent page owner', { timeout: 60_000 }, async t => {
  const directory = await kit(t), slug = 'field';
  await cp(join(directory, 'templates/notes'), join(directory, 'pages', slug), { recursive: true });
  await writeFile(join(directory, 'pages', slug, 'domain.mjs'), `
import { defineApplication, defineCommand, defineQuery, emit, program } from '@chronolog/peer-session';
export const definition = defineApplication({
  id: 'field-observations', version: '7',
  commands: { record: defineCommand({ description: 'Record one observation',
    input: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    prepare: ({text}) => program(emit('observation', {text})) }) },
  queries: { entries: defineQuery({ description: 'Read retained observations', input: {type:'null'},
    read: view => view.readEvents({topics:['observation']}).events.map(event => event.payload.text) }) },
});
`);
  const { context, reports } = await pageContext(directory, slug);
  const page = join(directory, 'pages', slug), module = name => import(pathToFileURL(join(page, name)).href);
  const setup = await module('setup.mjs');
  const initialized = await setup.initializePage(context);
  assert.equal(initialized.initialized, true);
  assert(initialized.revision, 'initialization returns a coherent applied revision');
  assert.equal((await context.readPrivate('initialized.json')).deviceId, context.signer.publicKey, 'the page device signs with the shared agent key');
  assert.deepEqual(await setup.initializePage(context), { initialized: true, next: `npm run build -- ${slug}` });
  const descriptor = await context.readPrivate('descriptor.json');

  const { definition } = await module('domain.mjs');
  const { buildPage } = await module('build.mjs');
  await buildPage(context, { bundle: build, definition });
  const publicConfiguration = JSON.parse(await readFile(join(page, 'dist/configuration.json'), 'utf8'));
  assert.equal(publicConfiguration.definitionId, 'field-observations');
  assert.equal(publicConfiguration.pageId, PAGE);
  assert.equal(publicConfiguration.serviceOrigin, 'https://service.test');
  assert.deepEqual(Object.keys(publicConfiguration).sort(), ['applicationId', 'definitionId', 'definitionVersion',
    'descriptor', 'nativeDeviceId', 'pageId', 'page_url', 'serviceOrigin']);
  assert(!JSON.stringify(publicConfiguration).includes(TOKEN));
  await assert.rejects(buildPage(context, { bundle: build, definition: { ...definition, version: '8' } }), /retained initialized descriptor/);
  await assert.rejects(access(join(page, 'dist')), { code: 'ENOENT' });
  assert.deepEqual(await context.readPrivate('descriptor.json'), descriptor);

  const { prepareAssistant } = await module('assistant.mjs');
  await assert.rejects(prepareAssistant(context), /Review the explicit capability selection/);
  await assert.rejects(access(context.privatePath('assistant-key.json')), { code: 'ENOENT' });

  const { openPage } = await module('agent.mjs');
  const owner = await openPage(context);
  try {
    assert.equal(owner.session.deviceId, context.signer.publicKey);
    assert(owner.control, 'the owner exposes its control participant for attached publication');
    await (await owner.session.command('record', { text: 'Retained observation' }, { operationId: 'record-one' })).applied();
    assert.deepEqual((await owner.session.query('entries', null)).value, ['Retained observation']);
    await flush();
    assert(reports.some(value => value.setup?.state === 'connected'), 'setup notices arrive through the page client socket');
  } finally { await owner.close(); }
  const reopened = await openPage(context);
  try { assert.deepEqual((await reopened.session.query('entries', null)).value, ['Retained observation']); }
  finally { await reopened.close(); }
});

test('assistant preparation retains one private key on the page and the agent connects only a prepared proposal', { timeout: 30_000 }, async t => {
  const directory = await kit(t), requests = [];
  await cp(join(directory, 'templates/notes'), join(directory, 'pages/notes'), { recursive: true });
  const { context } = await pageContext(directory, 'notes', { requests });
  const assistant = await import(pathToFileURL(join(directory, 'pages/notes/assistant.mjs')).href);
  assert.deepEqual(await assistant.assistantIntegration({ context, session: {} }), {}, 'no adapter before preparation');
  const first = await assistant.prepareAssistant(context);
  const key = await context.readPrivate('assistant-key.json');
  assert.match(key, /^td_a_[a-f0-9]{64}$/);
  assert.equal(requests[0].path, '/assistant/propose');
  assert.deepEqual(requests[0].body.events, []);
  assert.deepEqual(requests[0].body.commands, ['addNote']);
  await assistant.prepareAssistant(context, { events: true }).catch(error => assert.equal(error.code, 'private_record_exists'));
  assert.equal(await context.readPrivate('assistant-key.json'), key, 'the adapter key is created once');
  assert.equal(first.proposed, 'd'.repeat(64));
  const hooks = await assistant.assistantIntegration({ context, session: {} });
  assert.equal(hooks.proposalId, 'd'.repeat(64));
  assert.equal(typeof hooks.startAdapter, 'function');
  assert.equal(hooks.onOnline, undefined, 'event forwarding stays opt-in');
});

/** A loopback host with the agent routes used by workspace init and page creation. */
async function host(t) {
  const calls = [];
  let mode = 'open';
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    calls.push([request.method, request.url]);
    response.setHeader('Content-Type', 'application/json');
    const json = (status, value) => { response.statusCode = status; response.end(JSON.stringify(value)); };
    if (request.url === '/api/readiness') return json(200, { schemaVersion: 1, serviceOrigin: origin, mode,
      environment: { id: origin, label: 'Local', kind: 'local' }, build: { coreRelease: 'test', runtimeId: 'a'.repeat(64), sourceCommit: null },
      creation: { available: mode === 'open', code: mode === 'open' ? null : 'creation_paused', message: 'State.', nextAction: 'Keep this origin.' },
      writes: { available: true, code: null }, readinessUrl: origin + '/api/readiness', statusUrl: origin + '/status', checkedAt: new Date().toISOString() });
    if (request.url === '/api/service') return json(200, { contract: 3, core_release: 'test', limits: {} });
    if (request.url === '/api/agents') return json(201, { id: AGENT, name: JSON.parse(body).name, token: TOKEN, account_state: 'unclaimed' });
    if (request.headers.authorization !== 'Bearer ' + TOKEN) return json(401, { error: { code: 'unauthorized', message: 'No' } });
    if (request.url === '/api/agent/pages' && request.method === 'POST')
      return json(201, { id: PAGE, name: JSON.parse(body).name, page_url: `https://${PAGE}.pages.test/s/${'e'.repeat(26)}/`, application: { id: '74'.repeat(32) } });
    json(404, { error: { code: 'not_found', message: 'No route' } });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { origin, calls, pause: () => { mode = 'creation_paused'; } };
}

test('page:new requires an empty page folder and open readiness, then copies its template into pages/<slug>/', { timeout: 60_000 }, async t => {
  const directory = await kit(t), fake = await host(t);
  const tendril = args => run(process.execPath, [join(directory, 'node_modules/@tendriller/tools/bin/tendril.mjs'), ...args], { cwd: directory, env: { ...process.env, TENDRIL_WORKSPACE: '' } });
  const created = JSON.parse((await tendril(['workspace', 'init', '--service', fake.origin, '--owner', 'owner@example.test', '--name', 'laptop'])).stdout);
  assert.equal(created.agent.id, AGENT);
  const npm = args => run('npm', ['run', '--silent', ...args], { cwd: directory });
  await mkdir(join(directory, 'pages/kept'), { recursive: true }); await writeFile(join(directory, 'pages/kept/notes.txt'), 'retained');
  await assert.rejects(npm(['page:new', '--', 'kept']), error => /page_folder_not_empty/.test(error.stderr) && /"notes.txt"/.test(error.stderr) && error.stdout === '');
  fake.pause();
  await assert.rejects(npm(['page:new', '--', 'notes']), error => /creation_paused/.test(error.stderr));
  assert(!fake.calls.some(([method, path]) => method === 'POST' && path === '/api/agent/pages'), 'no page before readiness');
  await assert.rejects(access(join(directory, 'pages/notes/agent.mjs')), { code: 'ENOENT' });
  const fresh = await host(t);
  const config = JSON.parse(await readFile(join(directory, 'tendriller.json'), 'utf8'));
  await writeFile(join(directory, 'tendriller.json'), JSON.stringify({ ...config, service: fresh.origin }));
  const credential = JSON.parse(await readFile(join(directory, '.tendriller/agent/credential.json'), 'utf8'));
  await rm(join(directory, '.tendriller/agent/credential.json'));
  await writeFile(join(directory, '.tendriller/agent/credential.json'), JSON.stringify({ ...credential, service: fresh.origin }), { mode: 0o600 });
  const page = JSON.parse((await npm(['page:new', '--', 'notes', '--name', 'Shared notes'])).stdout);
  assert.equal(page.id, PAGE); assert.equal(page.template, 'notes'); assert.match(page.next, /npm run init -- notes/);
  assert.deepEqual((await readdir(join(directory, 'pages/notes'))).sort(), (await readdir(join(directory, 'templates/notes'))).sort());
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'tendriller.json'), 'utf8')).pages, { notes: { id: PAGE } });
  const resumed = JSON.parse((await npm(['page:new', '--', 'notes'])).stdout);
  assert.equal(resumed.resumed, true);
  assert.equal(fresh.calls.filter(([method, path]) => method === 'POST' && path === '/api/agent/pages').length, 1, 'a retry never creates a second page');
  await assert.rejects(run(process.execPath, ['setup.mjs', 'unknown', 'notes'], { cwd: directory }),
    error => error.code !== 0 && /Use new, init/.test(error.stderr) && error.stdout === '');
});
