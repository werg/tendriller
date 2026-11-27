import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile), cli = fileURLToPath(new URL('../bin/tendril.mjs', import.meta.url));
const root = fileURLToPath(new URL('../../../', import.meta.url));
const PAGE = 'aaaaaaaaaaaa', TOKEN = 'ta_' + 'b'.repeat(32), AGENT = 'ag_' + 'c'.repeat(26);

function readiness(origin, mode = 'open') {
  return { schemaVersion: 1, serviceOrigin: origin, mode, environment: { id: origin, kind: 'local', label: 'Local test' },
    build: { coreRelease: 'test', runtimeId: 'a'.repeat(64), sourceCommit: null },
    creation: { available: mode === 'open', code: mode === 'open' ? null : 'creation_paused', message: 'Current state.', nextAction: 'Keep this origin.' },
    writes: { available: mode !== 'read_only', code: mode === 'read_only' ? 'read_only' : null },
    readinessUrl: origin + '/api/readiness', statusUrl: origin + '/status', checkedAt: new Date().toISOString() };
}

/** A loopback host with the agent routes; the hub upgrade is refused so the agent keeps retrying it. */
async function host(t, { mode = 'open' } = {}) {
  const calls = [], registered = [], pages = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    calls.push({ method: request.method, path: request.url, authorization: request.headers.authorization ?? null });
    response.setHeader('Content-Type', 'application/json');
    const json = (status, value) => { response.statusCode = status; response.end(JSON.stringify(value)); };
    const authorized = request.headers.authorization === 'Bearer ' + TOKEN;
    if (request.url === '/api/readiness') return json(200, readiness(origin, mode));
    if (request.url === '/api/service') return json(200, { contract: 3, core_release: 'test', limits: {}, attestationKey: 'ab'.repeat(32) });
    if (request.url === '/api/agents' && request.method === 'POST') {
      const value = JSON.parse(body); registered.push(value);
      return json(201, { id: AGENT, handle: value.handle, bio: value.bio ?? '', token: TOKEN, account_state: 'unclaimed' });
    }
    if (!authorized) return json(401, { error: { code: 'unauthorized', message: 'Agent token required' } });
    if (request.url === '/api/agent' && request.method === 'PATCH') {
      const patch = JSON.parse(body);
      return json(200, { id: AGENT, handle: patch.handle ?? 'laptop', bio: patch.bio ?? '' });
    }
    if (request.url === '/api/agent') return json(200, { id: AGENT, handle: 'laptop', bio: '', account_state: 'unclaimed', grants: pages.length });
    if (request.url === '/api/agent/pages' && request.method === 'POST') {
      // The host adopts the exact application identity of the retained creation intent.
      const requested = JSON.parse(body);
      const page = { id: PAGE, name: requested.name, page_url: `https://${PAGE}.pages.test/s/${'d'.repeat(26)}/`,
        application: { id: requested.application.id }, scopes: ['host:read', 'publication:write'] };
      pages.push(page); return json(201, page);
    }
    if (request.url.startsWith('/api/agent/pages')) {
      if (request.url === '/api/agent/pages') return json(200, { pages, next_cursor: null });
      if (request.url === `/api/agent/pages/${PAGE}/push`) return json(200, { delivered: 0 });
      if (request.url === `/api/agent/pages/${PAGE}`) return json(200, { id: PAGE, page_url: pages[0]?.page_url });
    }
    json(404, { error: { code: 'not_found', message: 'No route' } });
  });
  server.on('upgrade', (_request, socket) => socket.end('HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n'));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { origin, calls, registered, pages };
}

async function workspaceDir(t) {
  const directory = await mkdtemp(join(tmpdir(), 'tendril-workspace-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [scope, name, source] of [['@tendriller', 'core', 'dist/sdk'], ['@chronolog', 'peer-session', 'node_modules/@chronolog/peer-session']]) {
    await mkdir(join(directory, 'node_modules', scope), { recursive: true });
    await symlink(resolve(root, source), join(directory, 'node_modules', scope, name));
  }
  return directory;
}
const env = directory => ({ ...process.env, TENDRIL_WORKSPACE: '', TENDRIL_SERVER: '', HOME: directory });
const tendril = (directory, args) => run(process.execPath, [cli, ...args], { cwd: directory, env: env(directory) });

// The fixture page owns a locally signed authority, so the agent program composes a real
// Chronolog session, shared signer, per-page device store and attach socket without a live host.
const PAGE_MODULE = `
import { existsSync } from 'node:fs';
import * as p from '@chronolog/peer-session';
import { createApplicationOwner } from '@chronolog/peer-session/worker';
const NOTES_REDUCER = \`
export default {
  reduce(state, tx) {
    const list = Array.isArray(state?.notes) ? state.notes.concat([tx.payload]) : [tx.payload];
    return { ok: true, state: { notes: list }, events: [{ topic: 'note', payload: tx.payload }] };
  },
  query(state) { return Array.isArray(state?.notes) ? state.notes : []; },
};
\`;
export const definition = p.defineApplication({ id: 'workspace-notes', version: '1', commands: {
  add: p.defineCommand({ description: 'Add a note', input: { type: 'string' }, prepare: text => [{ topic: 'notes', input: { text } }] }),
}, queries: { notes: p.defineQuery({ description: 'Read notes', input: { type: 'null' }, read: view => view.topic('notes')?.notes ?? [] }) } });
export async function openPage(context) {
  const device = await context.openDevice({ create: !existsSync(context.devicePath) });
  if (device.identity.publicKey !== context.signer.publicKey) throw Error('SHARED_SIGNER_EXPECTED');
  const signer = device.identity.publicKey;
  let retained = await device.store.get('fixture/genesis-v2');
  let casNodes = [];
  let key = await device.store.get('fixture/epoch-key');
  if (!retained) {
    const created = await p.createLogGenesis({
      creator: { publicKey: signer, wrapKey: context.wrapKey.publicKey, reader: true, writer: true, administrator: true, publisher: true, finalizer: true },
      imports: { 'app/notes': NOTES_REDUCER },
      topics: { notes: { module: 'app/notes', initialState: { notes: [] } } },
    });
    retained = created.genesisBytes;
    casNodes = created.casNodes;
    key = created.epoch0Key;
    await device.store.put('fixture/genesis-v2', retained);
    await device.store.put('fixture/cas-nodes', p.encodeRecord(casNodes));
    await device.store.put('fixture/epoch-key', key);
  } else {
    const savedCas = await device.store.get('fixture/cas-nodes');
    if (savedCas) casNodes = p.decodeRecord(savedCas);
  }
  const session = await p.createApplicationSession({ device, definition, genesis: retained, casNodes, epochKeys: new Map([[0, key]]) });
  context.report({ state: 'fixture_opened', hostPage: context.host.base });
  return createApplicationOwner(session);
}
`;

test('workspace init registers one agent key; page new creates a granted page and its folder', async t => {
  const fake = await host(t), directory = await workspaceDir(t);
  await assert.rejects(tendril(directory, ['workspace', 'init', '--service', fake.origin, '--owner', 'owner@example.test']),
    error => JSON.parse(error.stderr).error.code === 'invalid_agent_handle');
  const created = JSON.parse((await tendril(directory, ['workspace', 'init', '--service', fake.origin, '--owner', 'owner@example.test', '--handle', 'laptop', '--bio', 'Dev agent'])).stdout);
  assert.equal(created.agent.id, AGENT);
  assert.equal(created.agent.handle, 'laptop');
  assert.equal(fake.registered.length, 1);
  assert.equal(fake.registered[0].owner, 'owner@example.test');
  assert.equal(fake.registered[0].handle, 'laptop');
  assert.equal(Buffer.from(fake.registered[0].publicKey, 'base64url').toString('hex'), created.publicKey);
  const config = JSON.parse(await readFile(join(directory, 'tendriller.json'), 'utf8'));
  assert.deepEqual(config, { schemaVersion: 1, service: fake.origin, agent: { id: AGENT, handle: 'laptop', bio: 'Dev agent' }, pages: {} });
  assert.doesNotMatch(await readFile(join(directory, 'tendriller.json'), 'utf8'), /ta_/);
  const credential = join(directory, '.tendriller/agent/credential.json');
  assert.equal((await stat(credential)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(credential, 'utf8')).token, TOKEN);
  assert.match(await readFile(join(directory, '.gitignore'), 'utf8'), /^\.tendriller\/$/m);
  await assert.rejects(tendril(directory, ['workspace', 'init', '--service', fake.origin, '--owner', 'owner@example.test', '--handle', 'laptop']),
    error => JSON.parse(error.stderr).error.code === 'workspace_exists');
  assert.equal(fake.registered.length, 1, 'a second init never registers another agent');
  const updated = JSON.parse((await tendril(directory, ['agent', 'profile', '--handle', 'atlas', '--bio', 'Primary builder'])).stdout);
  assert.deepEqual(updated, { id: AGENT, handle: 'atlas', bio: 'Primary builder' });
  assert.equal(JSON.parse(await readFile(join(directory, 'tendriller.json'), 'utf8')).agent.handle, 'atlas');

  const page = JSON.parse((await tendril(directory, ['page', 'new', 'notes', '--name', 'Shared notes'])).stdout);
  assert.equal(page.id, PAGE); assert.equal(page.slug, 'notes');
  await access(join(directory, 'pages/notes'));
  const record = JSON.parse(await readFile(join(directory, `.tendriller/pages/${PAGE}/page.json`), 'utf8'));
  assert.equal(record.page_url, fake.pages[0].page_url);
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'tendriller.json'), 'utf8')).pages, { notes: { id: PAGE } });
  // The retained creation intent binds name and application identity: repeating it resumes the same page; changing it is refused.
  assert.equal(JSON.parse((await tendril(directory, ['page', 'new', 'notes', '--name', 'Shared notes'])).stdout).id, PAGE);
  assert.equal(fake.pages.length, 1, 'repeating the exact request never creates a second page');
  await assert.rejects(tendril(directory, ['page', 'new', 'notes', '--name', 'Another name']), error => JSON.parse(error.stderr).error.code === 'page_creation_intent_mismatch');
  assert.equal(fake.pages.length, 1);
  const status = JSON.parse((await tendril(directory, ['status'])).stdout);
  assert.equal(status.agent.remote.grants, 1);
  assert.deepEqual(status.pages.map(value => [value.slug, value.granted, value.initialized]), [['notes', true, false]]);
  const info = JSON.parse((await tendril(join(directory, 'pages/notes'), ['info'])).stdout);
  assert.equal(info.page_url, '[REDACTED; use --show-url privately]', 'per-page commands find the workspace from a page folder');
  assert(fake.calls.filter(call => call.path === '/api/agent' || call.path.startsWith('/api/agent/')).every(call => call.authorization === 'Bearer ' + TOKEN));
});

test('workspace init stops at paused readiness before creating a signer or registering', async t => {
  const fake = await host(t, { mode: 'creation_paused' }), directory = await workspaceDir(t);
  await assert.rejects(tendril(directory, ['workspace', 'init', '--service', fake.origin, '--owner', 'owner@example.test', '--handle', 'laptop']),
    error => JSON.parse(error.stderr).error.code === 'creation_paused');
  await assert.rejects(access(join(directory, '.tendriller')), { code: 'ENOENT' });
  await assert.rejects(tendril(directory, ['workspace', 'init', '--owner', 'owner@example.test', '--handle', 'laptop']),
    error => error.code === 64 && /never defaults to production/.test(error.stderr));
  assert.deepEqual(fake.registered, []);
});

test('agent run serves an initialized page through one attach socket; CLI commands name the page', { timeout: 60_000 }, async t => {
  const fake = await host(t), directory = await workspaceDir(t);
  await tendril(directory, ['workspace', 'init', '--service', fake.origin, '--owner', 'owner@example.test', '--handle', 'laptop']);
  await tendril(directory, ['page', 'new', 'notes']);
  await writeFile(join(directory, 'pages/notes/agent.mjs'), PAGE_MODULE);
  await writeFile(join(directory, `.tendriller/pages/${PAGE}/initialized.json`), '{}', { mode: 0o600 });
  await assert.rejects(tendril(directory, ['--page', 'notes', 'self']), error => JSON.parse(error.stderr).error.code === 'OWNER_UNREACHABLE');
  const agent = spawn(process.execPath, [cli, 'agent', 'run'], { cwd: directory, env: env(directory), stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(agent, 'exit');
  t.after(async () => { if (agent.exitCode === null && agent.signalCode === null) { agent.kill('SIGKILL'); await exited; } });
  let output = '', stderr = '';
  agent.stderr.on('data', chunk => { stderr += chunk; });
  const reports = [];
  const running = new Promise((resolve, reject) => {
    agent.stdout.on('data', chunk => {
      output += chunk;
      const lines = output.split('\n'); output = lines.pop();
      for (const line of lines) { const value = JSON.parse(line); reports.push(value); if (value.state === 'running' && value.page === PAGE) resolve(value); }
    });
    agent.once('exit', () => reject(Error('agent exited: ' + stderr)));
  });
  const opened = await Promise.race([running, new Promise((_, reject) => setTimeout(() => reject(Error('the page never reached running; reports=' + JSON.stringify(reports) + ' stderr=' + stderr)), 30_000))]);
  assert.equal(opened.slug, 'notes');
  assert(reports.some(value => value.running === true && value.agent === AGENT));
  assert(reports.some(value => value.state === 'fixture_opened' && value.hostPage === `${fake.origin}/api/agent/pages/${PAGE}`));
  const self = JSON.parse((await tendril(directory, ['--page', 'notes', 'self'])).stdout);
  assert.equal(self.identity.publicKey, opened.publicKey); assert.equal(self.mode, 'attach'); assert.equal(self.applicationId, opened.applicationId);
  const applied = JSON.parse((await tendril(directory, ['--page', PAGE, 'command', 'add', '"from the terminal"', '--operation', 'first', '--wait', 'materialized'])).stdout);
  assert.equal(applied.stored, true); assert.equal(applied.materialized.outcome, 'accepted');
  assert.equal(applied.finalized, false); assert.deepEqual(applied.retained, []);
  const notes = JSON.parse((await tendril(directory, ['--page', 'notes', 'query', 'notes', 'null'])).stdout);
  assert.deepEqual(notes.value, [{ text: 'from the terminal' }]);
  const watched = await tendril(directory, ['watch', '--events', '--timeout', '2']).catch(error => error);
  const batch = JSON.parse(watched.stdout.trim().split('\n')[0]);
  assert.equal(batch.page, PAGE);
  assert.deepEqual(batch.events.map(event => event.payload), [{ text: 'from the terminal' }]);
  assert.equal(JSON.parse(watched.stderr).watch.cursors[PAGE], batch.cursor);
  await assert.rejects(tendril(directory, ['--page', 'other', 'self']), error => JSON.parse(error.stderr).error.code === 'page_unknown');
  agent.kill('SIGTERM');
  const [code] = await exited;
  assert.equal(code, 0, stderr);
  assert(reports.some(value => value.state === 'closed' && value.page === PAGE));
  assert(reports.some(value => value.hub === 'reconnecting'), 'a refused hub stays retrying without stopping the pages');
});

/** Starts the workspace's one agent program and collects its fixed-shape JSON reports. */
function startAgent(t, directory) {
  const agent = spawn(process.execPath, [cli, 'agent', 'run'], { cwd: directory, env: env(directory), stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(agent, 'exit'), reports = [], waiters = new Set();
  let output = '', stderr = '';
  t.after(async () => { if (agent.exitCode === null && agent.signalCode === null) { agent.kill('SIGKILL'); await exited; } });
  agent.stderr.on('data', chunk => { stderr += chunk; });
  agent.stdout.on('data', chunk => {
    output += chunk;
    const lines = output.split('\n'); output = lines.pop();
    for (const line of lines) { const value = JSON.parse(line); reports.push(value); for (const waiter of [...waiters]) waiter(); }
  });
  const waitFor = predicate => new Promise((resolve, reject) => {
    const check = () => { const found = reports.find(predicate); if (found) { waiters.delete(check); resolve(found); } };
    waiters.add(check); check();
    agent.once('exit', () => reject(Error('agent exited: ' + stderr)));
  });
  return { agent, reports, waitFor, exited, stderr: () => stderr,
    async stop() { agent.kill('SIGTERM'); const [code] = await exited; return code; } };
}

test('agent run waits for explicit initialization and never opens a page device or signer for an uninitialized page', { timeout: 60_000 }, async t => {
  const fake = await host(t), directory = await workspaceDir(t);
  await tendril(directory, ['workspace', 'init', '--service', fake.origin, '--owner', 'owner@example.test', '--handle', 'laptop']);
  await tendril(directory, ['page', 'new', 'notes']);
  await writeFile(join(directory, 'pages/notes/agent.mjs'), PAGE_MODULE);
  const run = startAgent(t, directory);
  const waiting = await run.waitFor(value => value.state === 'awaiting_initialization' && value.page === PAGE);
  assert.equal(waiting.slug, 'notes');
  await assert.rejects(access(join(directory, `.tendriller/pages/${PAGE}/device.sqlite`)), { code: 'ENOENT' }, 'no replacement keys or device exist before the page is initialized');
  await assert.rejects(tendril(directory, ['--page', 'notes', 'self']), error => JSON.parse(error.stderr).error.code === 'OWNER_UNREACHABLE');
  assert.equal(await run.stop(), 0, run.stderr());
  assert.equal(run.reports.some(value => value.state === 'running'), false);
});

test('a page whose owner fails to open is reported and retried while the agent program stays up and exits cleanly on SIGTERM', { timeout: 60_000 }, async t => {
  const fake = await host(t), directory = await workspaceDir(t);
  await tendril(directory, ['workspace', 'init', '--service', fake.origin, '--owner', 'owner@example.test', '--handle', 'laptop']);
  await tendril(directory, ['page', 'new', 'notes']);
  await writeFile(join(directory, 'pages/notes/agent.mjs'), 'export async function openPage() { throw Object.assign(Error("fixture refused"), { code: "FIXTURE_REFUSED" }); }\n');
  await writeFile(join(directory, `.tendriller/pages/${PAGE}/initialized.json`), '{}', { mode: 0o600 });
  const run = startAgent(t, directory);
  const failed = await run.waitFor(value => value.state === 'page_failed' && value.page === PAGE);
  assert.equal(failed.code, 'FIXTURE_REFUSED');
  const retry = await run.waitFor(value => value.state === 'page_retry' && value.page === PAGE);
  assert(retry.retryInMs > 0, 'a failed page retries with backoff instead of stopping the agent');
  assert.equal(run.agent.exitCode, null);
  await assert.rejects(tendril(directory, ['--page', 'notes', 'self']), error => JSON.parse(error.stderr).error.code === 'OWNER_UNREACHABLE', 'no second signer is opened as a fallback');
  assert.equal(await run.stop(), 0, run.stderr());
});

test('agent run outside an initialized workspace fails closed with a structured error, a nonzero exit and no output on stdout', async t => {
  const directory = await workspaceDir(t);
  await assert.rejects(tendril(directory, ['agent', 'run']), error => error.code !== 0 && error.stdout === '' && typeof JSON.parse(error.stderr).error.code === 'string');
});

test('SIGTERM during a slow page open aborts that open, closes nothing it never opened and still exits 0', { timeout: 60_000 }, async t => {
  const fake = await host(t), directory = await workspaceDir(t);
  await tendril(directory, ['workspace', 'init', '--service', fake.origin, '--owner', 'owner@example.test', '--handle', 'laptop']);
  await tendril(directory, ['page', 'new', 'notes']);
  const marker = join(directory, 'open-aborted');
  await writeFile(join(directory, 'pages/notes/agent.mjs'), `import { writeFile } from 'node:fs/promises';
export async function openPage(context) {
  context.report({ state: 'fixture_opening' });
  await new Promise((_, reject) => context.signal.addEventListener('abort', () => writeFile(${JSON.stringify(marker)}, 'aborted').then(() => reject(context.signal.reason)), { once: true }));
}
`);
  await writeFile(join(directory, `.tendriller/pages/${PAGE}/initialized.json`), '{}', { mode: 0o600 });
  const run = startAgent(t, directory);
  await run.waitFor(value => value.state === 'fixture_opening' && value.page === PAGE);
  assert.equal(await run.stop(), 0, run.stderr());
  assert.equal(await readFile(marker, 'utf8'), 'aborted', 'the in-flight open received the page lifetime abort');
  assert.equal(run.reports.some(value => value.state === 'running'), false);
  assert.equal(run.reports.at(-1).running, false, 'the agent reports its own stop last');
});

test('account-linked MCP route: workspace key prints register_agent arguments and adopt retains only a verified credential', { timeout: 30_000 }, async t => {
  const { mkdtemp: temp, writeFile: write, rm: remove, readFile: read } = await import('node:fs/promises');
  const { tmpdir: tmp } = await import('node:os');
  const { join: joinPath } = await import('node:path');
  const { createServer: serve } = await import('node:http');
  const { workspaceKey, adoptWorkspace } = await import('../lib/workspace.mjs');
  const dir = await temp(joinPath(tmp(), 'ws-adopt-'));
  t.after(() => remove(dir, { recursive: true, force: true }));
  const token = 'ta_' + 'd'.repeat(32), seen = [];
  const server = serve((request, response) => {
    seen.push([request.url, request.headers.authorization]);
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/api/service') return response.end(JSON.stringify({ contract: 3, core_release: 'test', limits: {}, attestationKey: 'ab'.repeat(32) }));
    if (request.url === '/api/agent' && request.headers.authorization === 'Bearer ' + token)
      return response.end(JSON.stringify({ id: 'ag_' + 'e'.repeat(26), handle: 'assistant', bio: '', account_state: 'claimed', grants: 0 }));
    response.statusCode = 401; response.end(JSON.stringify({ error: { code: 'unauthorized', message: 'No' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const service = `http://127.0.0.1:${server.address().port}`;
  const key = await workspaceKey(dir, { service, handle: 'assistant' });
  assert.match(key.register_agent.publicKey, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(key.register_agent.handle, 'assistant');
  assert.deepEqual((await workspaceKey(dir, { service, handle: 'assistant' })).register_agent, key.register_agent, 'the key is created once');
  await write(joinPath(dir, 'bad.json'), JSON.stringify({ structuredContent: { id: 'ag_' + 'e'.repeat(26), handle: 'assistant', token: 'ta_' + 'f'.repeat(32) } }));
  await assert.rejects(adoptWorkspace(dir, { service, credential: 'bad.json' }), { status: 401 });
  await assert.rejects(read(joinPath(dir, 'tendriller.json')), { code: 'ENOENT' });
  await write(joinPath(dir, 'result.json'), JSON.stringify({ structuredContent: { id: 'ag_' + 'e'.repeat(26), handle: 'assistant', token } }));
  const adopted = await adoptWorkspace(dir, { service, credential: 'result.json' });
  assert.equal(adopted.agent.id, 'ag_' + 'e'.repeat(26));
  assert.equal(JSON.parse(await read(joinPath(dir, '.tendriller/agent/credential.json'), 'utf8')).token, token);
  assert.equal(JSON.parse(await read(joinPath(dir, 'tendriller.json'), 'utf8')).agent.handle, 'assistant');
  assert(seen.some(([url, auth]) => url === '/api/agent' && auth === 'Bearer ' + token), 'the token was verified before retention');
});
