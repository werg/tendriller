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
  for (const [scope, name, source] of [['@tendriller', 'core', 'dist/sdk'], ['@chronolog', 'peer-session', 'node_modules/@chronolog/peer-session'], ['@chronolog', 'authority', 'node_modules/@chronolog/authority']]) {
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
async function hostPeers(applicationId) {
  const p = await import('@chronolog/peer-session');
  const authority = await p.createSigningIdentity(), key = crypto.getRandomValues(new Uint8Array(32)), published = [];
  let configuration = null;
  const unavailable = () => { throw Error('Unexpected remote peer'); };
  const wait = signal => {
    const done = Promise.withResolvers(), close = () => done.resolve();
    signal?.addEventListener('abort', close, { once: true }); if (signal?.aborted) close();
    return { ready: Promise.resolve(), close, done: done.promise, closed: done.promise };
  };
  const metadata = () => ({ selection: { id: applicationId }, authority: null,
    publicationAuthority: { applicationId, grantId: 'f'.repeat(64), publisherKeys: configuration.publisherKeys } });
  return {
    published, key,
    /** The signed authority a recipient package would carry to the explicitly provisioned page device. */
    async bundle(member) {
      const descriptor = await p.signAppDescriptor({ applicationId, rootPrincipal: member, authorityPublicKey: authority.publicKey,
        executionManifestDigest: configuration.executionManifestDigest, finalityPolicy: { kind: 'none' } }, authority);
      const membership = await p.signMembership({ applicationId, revision: 0, previous: null, authorTimeAfterMs: -1n, epoch: 0,
        epochKeyDigest: await p.epochKeyCommitment(applicationId, 0, key),
        members: [{ publicKey: member, reader: true, writer: true, administrator: true, publisher: false, finalizer: false }] }, authority);
      return { descriptor, memberships: [membership] };
    },
    async prepare(value) { configuration = value; return metadata(); },
    application: async () => metadata(),
    publication: async () => null,
    publish: async (publication, assets) => { published.push({ publication, assets }); return { publication, version: published.length }; },
    exchange: unavailable,
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
  const peers = await hostPeers('74'.repeat(32)), reports = [];
  const host = { base: `https://service.test/api/agent/pages/${PAGE}`, peers,
    info: async () => ({ owner_account_id: 'acct_owner' }),
    async request(path, options) { requests.push({ path, ...options }); return { proposed: 'd'.repeat(64), reviewUrl: 'https://service.test/review', approved: false, applicationId: '74'.repeat(32) }; },
    socket() { const socket = new EventTarget(); socket.readyState = 1; socket.close = () => { socket.readyState = 3; socket.dispatchEvent(Object.assign(new Event('close'), { code: 1000 })); }; queueMicrotask(() => socket.dispatchEvent(new Event('open'))); return socket; },
  };
  const read = async (name, optional = false) => {
    try { return JSON.parse(await readFile(join(privateDir, name), 'utf8')); }
    catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
  };
  return { reports, peers, context: { workspace: directory, service: 'https://service.test', agent: { id: AGENT, handle: 'laptop', bio: '' },
    page: { id: PAGE, slug, name: 'Field notes', applicationId: '74'.repeat(32), pageUrl: `https://${PAGE}.pages.test/s/${'e'.repeat(26)}/`,
      directory: privateDir, source: join(directory, 'pages', slug) },
    host, signal, report: value => reports.push(value), signer: { publicKey: signer.publicKey },
    devicePath: join(privateDir, 'device.sqlite'),
    openDevice: ({ create = false } = {}) => openPageDevice({ path: join(privateDir, 'device.sqlite'), signer, create }),
    readPrivate: read, savePrivate: (name, value) => savePrivateJson(join(privateDir, name), value), privatePath: name => join(privateDir, name) } };
}

test('a renamed events page prepares publication with the shared agent key, builds its dist and, once explicitly provisioned, runs as an agent page owner', { timeout: 60_000 }, async t => {
  const directory = await kit(t), slug = 'field';
  await cp(join(directory, 'templates/notes'), join(directory, 'pages', slug), { recursive: true });
  await writeFile(join(directory, 'pages', slug, 'domain.mjs'), `
import { defineApplication, defineCommand, defineQuery, emit, program } from '@chronolog/peer-session';
// The starter page derives its list through this export, so a renamed domain keeps it.
export async function deriveNotes(view) { return view.readEvents({ topics: ['observation'] }).events.map(event => ({ id: event.operationId, text: event.payload.text })); }
export const definition = defineApplication({
  id: 'field-observations', version: '7',
  commands: { record: defineCommand({ description: 'Record one observation',
    input: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    prepare: ({text}) => program(emit('observation', {text})) }) },
  queries: { entries: defineQuery({ description: 'Read retained observations', input: {type:'null'},
    read: view => view.readEvents({topics:['observation']}).events.map(event => event.payload.text) }) },
});
`);
  const { context, reports, peers } = await pageContext(directory, slug);
  const page = join(directory, 'pages', slug), module = name => import(pathToFileURL(join(page, name)).href);
  const setup = await module('setup.mjs');
  // Preparation is browser-first metadata only: no page device, schema, data root or epoch key is created.
  const prepared = await setup.initializePage(context);
  assert.equal(prepared.prepared, true); assert.equal(prepared.initialized, false);
  assert.equal(await context.readPrivate('initialized.json', true), null, 'preparation never creates the provisioning marker');
  await assert.rejects(access(context.devicePath), { code: 'ENOENT' });
  const configuration = await context.readPrivate('host-configuration.json');
  assert.deepEqual(configuration.publisherKeys, [context.signer.publicKey], 'the shared agent key is the independent publisher');
  assert.deepEqual(await setup.initializePage(context), prepared, 'preparing again resumes the same retained configuration');
  await assert.rejects(setup.initializePage(context, { requestedFinality: { kind: 'threshold' } }), /Retained preparation differs/);
  assert.deepEqual(await context.readPrivate('host-configuration.json'), configuration);

  const { buildPage } = await module('build.mjs');
  await buildPage(context, { bundle: build });
  const publicConfiguration = JSON.parse(await readFile(join(page, 'dist/configuration.json'), 'utf8'));
  assert.equal(publicConfiguration.pageId, PAGE);
  assert.equal(publicConfiguration.serviceOrigin, 'https://service.test');
  assert.equal(publicConfiguration.applicationId, '74'.repeat(32));
  assert(!JSON.stringify(publicConfiguration).includes(TOKEN));
  assert(!JSON.stringify(publicConfiguration).includes('privateKey'));
  // Private records are immutable through the API, so tamper with the file itself to prove the build re-verifies it.
  const preparedPath = context.privatePath('prepared.json'), original = await readFile(preparedPath, 'utf8');
  await writeFile(preparedPath, JSON.stringify({ ...JSON.parse(original), publisherKey: 'f'.repeat(64) }), { mode: 0o600 });
  await assert.rejects(buildPage(context, { bundle: build }), /no publishable dist/);
  await assert.rejects(access(join(page, 'dist')), { code: 'ENOENT' });
  await writeFile(preparedPath, original, { mode: 0o600 });

  // The agent never invents keys: without the explicit recipient-bound provisioning import there is no native owner.
  const { openPage } = await module('agent.mjs');
  await assert.rejects(openPage(context), /explicit/i);
  await assert.rejects(access(context.devicePath), { code: 'ENOENT' }, 'a refused open creates no device or replacement keys');
  const { createAuthorityProvider } = await import('@chronolog/authority');
  const device = await context.openDevice({ create: true });
  await createAuthorityProvider({ store: device.store, bundle: await peers.bundle(device.identity.publicKey), epochKeys: [[0, peers.key]] });
  await device.close();
  await context.savePrivate('initialized.json', { applicationId: context.page.applicationId, publicKey: context.signer.publicKey,
    executionManifestDigest: configuration.executionManifestDigest, provisioned: true });

  const owner = await openPage(context);
  try {
    assert.equal(owner.session.identity.publicKey, context.signer.publicKey);
    assert(owner.control, 'the owner exposes its explicit publication control for attached publication');
    assert(owner.participation, 'peer participation is a separate controller from the application session');
    assert.equal(owner.session.status.canAuthor, true, 'local authoring needs only stored authority, keys and storage');
    const operation = await owner.session.command('record', { text: 'Retained observation' }, { operationId: 'record-one' });
    assert.equal((await operation.materialized()).outcome, 'accepted');
    assert.equal(operation.inspect().finalized, false);
    assert.deepEqual((await owner.session.query('entries', null)).value, ['Retained observation']);
    await flush();
    assert(reports.some(value => value.setup?.state === 'connected' || value.state === 'setup_connected' || value.setup), 'setup notices arrive through the page client socket');
  } finally { await owner.close(); }
  const reopened = await openPage(context);
  try { assert.deepEqual((await reopened.session.query('entries', null)).value, ['Retained observation']); }
  finally { await reopened.close(); }
});

/** A loopback host with the agent routes used by workspace init and page creation. */
async function host(t) {
  const calls = [], granted = [];
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
    if (request.url === '/api/agents') return json(201, { id: AGENT, handle: JSON.parse(body).handle, bio: JSON.parse(body).bio ?? '', token: TOKEN, account_state: 'unclaimed' });
    if (request.headers.authorization !== 'Bearer ' + TOKEN) return json(401, { error: { code: 'unauthorized', message: 'No' } });
    if (request.url === '/api/agent') return json(200, { id: AGENT, handle: 'laptop', bio: '', account_state: 'unclaimed', grants: granted.length });
    if (request.url === '/api/agent/pages' && request.method === 'GET') return json(200, { pages: granted, next_cursor: null });
    if (request.url === '/api/agent/pages' && request.method === 'POST') {
      const page = { id: PAGE, name: JSON.parse(body).name, page_url: `https://${PAGE}.pages.test/s/${'e'.repeat(26)}/`,
        application: { id: JSON.parse(body).application.id }, scopes: ['host:read', 'publication:write'] };
      granted.push(page); return json(201, page);
    }
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
  const created = JSON.parse((await tendril(['workspace', 'init', '--service', fake.origin, '--owner', 'owner@example.test', '--handle', 'laptop'])).stdout);
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
