import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, copyFile, symlink, readFile, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const pageId = 'abcdefghijkl';
const handleFor = origin => ({ id: pageId, api: `${origin}/api/t/${pageId}`, token: 'tk_' + 'a'.repeat(32),
  page_url: `https://${pageId}.pages.example.test/s/${'a'.repeat(26)}/`, application: { id: 'a'.repeat(64) } });

async function fixture(t, initialMode = 'open', variant = 'events') {
  const directory = await mkdtemp(join(tmpdir(), 'tutorial-setup-'));
  const source = join(root, 'docs/tutorial', variant === 'sql' ? 'sql' : '');
  for (const name of ['setup.mjs', 'local.mjs', 'domain.mjs']) await copyFile(join(source, name), join(directory, name));
  let engine;
  if (variant === 'sql') {
    // Qualify the actual downloadable setup and SDK HTTP boundary without
    // compiling the optional SQL engine. Count whether its loader was reached.
    await writeFile(join(directory, 'engine.mjs'), `
export let calls = 0, failure;
export const fail = value => { failure = value; };
export async function createNativeEngine() { calls++; if (failure) throw failure; return {}; }
`);
    engine = await import(pathToFileURL(join(directory, 'engine.mjs')).href);
  }
  for (const [scope, name, source] of [['@tendriller', 'core', 'dist/sdk'], ['@chronolog', 'peer-session', 'node_modules/@chronolog/peer-session']]) {
    await mkdir(join(directory, 'node_modules', scope), { recursive: true });
    await symlink(resolve(root, source), join(directory, 'node_modules', scope, name));
  }
  let mode = initialMode, creationPaused = false;
  const calls = [];
  const server = createServer((request, response) => {
    calls.push([request.method, request.url]);
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/api/readiness') {
      if (mode === 'unsupported') { response.writeHead(404); response.end('{}'); return; }
      if (mode === 'unavailable') response.writeHead(503);
      response.end(JSON.stringify({ schemaVersion: 1, serviceOrigin: origin, mode,
        environment: { id: origin, label: 'Local qualification', kind: 'local' },
        build: { coreRelease: 'test', runtimeId: 'a'.repeat(64), sourceCommit: null },
        creation: { available: mode === 'open', code: mode === 'open' ? null : mode === 'unavailable' ? 'unavailable' : 'creation_paused', message: 'Current service state.', nextAction: 'Keep this origin.' },
        writes: { available: mode === 'open' || mode === 'creation_paused', code: mode === 'unavailable' ? 'unavailable' : mode === 'read_only' ? 'read_only' : null },
        readinessUrl: origin + '/api/readiness', statusUrl: origin + '/status', checkedAt: new Date().toISOString() }));
    } else if (request.url === '/api/service') response.end(JSON.stringify({ contract: 3, core_release: 'test', limits: {} }));
    else if (request.url === '/api/tendrils' && request.method === 'POST') {
      if (creationPaused) { response.writeHead(503); response.end(JSON.stringify({ error: { code: 'creation_paused', message: 'New tendrils are temporarily paused' } })); return; }
      response.writeHead(201);
      response.end(JSON.stringify(handleFor(origin)));
    } else { response.writeHead(404); response.end('{}'); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  return { directory, origin, calls, engine, handle: handleFor(origin), setup: await import(pathToFileURL(join(directory, 'setup.mjs')).href),
    setMode: value => { mode = value; }, pauseAtCreation: () => { creationPaused = true; } };
}

for (const variant of ['events', 'sql']) {
test(`downloadable ${variant} setup resumes only the same service without creating or overwriting private state`, async t => {
  const { directory, origin, calls, setup, setMode, engine } = await fixture(t, 'open', variant);
  const created = await setup.createProject(origin, 'owner@example.test');
  const saved = await readFile(join(directory, '.tendriller/handle.json'), 'utf8');
  assert.equal(created.serviceOrigin, origin);
  assert.deepEqual(calls, [['GET', '/api/readiness'], ['GET', '/api/service'], ['POST', '/api/tendrils']]);
  setMode('creation_paused');
  const resumed = await setup.createProject(origin, 'owner@example.test');
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.page_url, created.page_url);
  await assert.rejects(setup.createProject('https://production.example.test', 'owner@example.test'), { code: 'service_origin_mismatch' });
  assert.equal(calls.length, 3);
  if (engine) assert.equal(engine.calls, 1, 'resumption and origin mismatch never load a native engine');
  assert.equal(await readFile(join(directory, '.tendriller/handle.json'), 'utf8'), saved);
});

test(`downloadable ${variant} setup creates no private state on paused, unavailable, unsupported, or raced creation`, async t => {
  for (const mode of ['creation_paused', 'read_only', 'unavailable', 'unsupported', 'open']) {
    const { directory, origin, calls, setup, pauseAtCreation, engine } = await fixture(t, mode, variant);
    if (mode === 'open') pauseAtCreation();
    await assert.rejects(setup.createProject(origin, 'owner@example.test'), { code: mode === 'unsupported' ? 'readiness_unsupported' : mode === 'unavailable' ? 'unavailable' : 'creation_paused' });
    assert.deepEqual(calls, mode === 'open'
      ? [['GET', '/api/readiness'], ['GET', '/api/service'], ['POST', '/api/tendrils']] : [['GET', '/api/readiness']]);
    if (engine) assert.equal(engine.calls, mode === 'open' ? 1 : 0, 'blocked readiness never loads optional native code');
    await assert.rejects(access(join(directory, '.tendriller/handle.json')), { code: 'ENOENT' });
  }
});

test(`downloadable ${variant} setup rejects invalid origins before networking or private state`, async t => {
  const { directory, calls, setup, engine } = await fixture(t, 'open', variant);
  await assert.rejects(setup.createProject('https://example.test/path', 'owner@example.test'), { code: 'invalid_service_origin' });
  assert.deepEqual(calls, []);
  if (engine) assert.equal(engine.calls, 0);
  await assert.rejects(access(join(directory, '.tendriller')), { code: 'ENOENT' });
});
}

async function recoveredProject(f) {
  const privatePath = join(f.directory, '.tendriller');
  await mkdir(privatePath, { mode: 0o700 });
  const selected = { schemaVersion: 1, attemptId: 'reviewed-existing-app', previousAttemptId: null,
    serviceOrigin: f.origin, pageId, applicationId: f.handle.application.id, submittedAt: Date.now(),
    handle: { ...f.handle, token: 'tk_' + 'b'.repeat(32) } };
  await writeFile(join(privatePath, 'host-credential.json'), JSON.stringify(selected));
  await writeFile(join(privatePath, 'descriptor.json'), JSON.stringify({ payload: { applicationId: f.handle.application.id } }));
  await writeFile(join(privatePath, 'device.sqlite'), 'retained-native-signer-journal');
  return { privatePath, selected };
}

test('create resumes reviewed credentials plus the retained descriptor after the original handle is lost', async t => {
  const f = await fixture(t, 'creation_paused');
  const { privatePath, selected } = await recoveredProject(f);
  const before = await Promise.all(['host-credential.json', 'descriptor.json', 'device.sqlite'].map(name => readFile(join(privatePath, name))));
  const resumed = await f.setup.createProject(f.origin, 'owner@example.test');
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.page_url, f.handle.page_url);
  assert.deepEqual(f.calls, [], 'resuming this identity does not preflight or allocate a new page');
  await assert.rejects(f.setup.createProject('https://different.example.test', 'owner@example.test'), { code: 'service_origin_mismatch' });
  const local = await import(pathToFileURL(join(f.directory, 'local.mjs')).href);
  assert.deepEqual(await local.readHostHandle(), selected.handle);
  for (const [index, name] of ['host-credential.json', 'descriptor.json', 'device.sqlite'].entries())
    assert.deepEqual(await readFile(join(privatePath, name)), before[index]);
  await assert.rejects(access(join(privatePath, 'handle.json')), { code: 'ENOENT' });
  assert.deepEqual(f.calls, []);
});

test('conflicting or corrupt reviewed recovery records fail before any creation request', async t => {
  for (const conflict of ['descriptor', 'origin', 'handle', 'malformed']) {
    const f = await fixture(t);
    const { privatePath, selected } = await recoveredProject(f);
    if (conflict === 'descriptor') await writeFile(join(privatePath, 'descriptor.json'), JSON.stringify({ payload: { applicationId: 'c'.repeat(64) } }));
    if (conflict === 'origin') selected.serviceOrigin = 'https://other.example.test';
    if (conflict === 'handle') selected.handle.application = { id: 'c'.repeat(64) };
    if (conflict !== 'descriptor') await writeFile(join(privatePath, 'host-credential.json'), conflict === 'malformed' ? selected.handle.token : JSON.stringify(selected));
    await assert.rejects(f.setup.createProject(f.origin, 'owner@example.test'), error => {
      assert(['host_identity_required', 'host_handle_mismatch', 'host_state_invalid'].includes(error.code));
      assert.equal(error.message.includes(selected.handle.token), false);
      return true;
    });
    assert.deepEqual(f.calls, []);
    await assert.rejects(access(join(privatePath, 'handle.json')), { code: 'ENOENT' });
  }
});

test('incomplete retained setup or recovery evidence never becomes permission to create a replacement', async t => {
  for (const name of ['descriptor.json', 'account-setup.json', 'account-setup-result.json',
    'owner-page-url.txt', 'host-adoption-' + 'd'.repeat(64) + '-response.json', 'device.sqlite']) {
    const f = await fixture(t);
    const privatePath = join(f.directory, '.tendriller');
    await mkdir(privatePath, { mode: 0o700 });
    await writeFile(join(privatePath, name), 'retained-original-evidence');
    await assert.rejects(f.setup.createProject(f.origin, 'owner@example.test'), { code: 'setup_recovery_required' });
    assert.deepEqual(f.calls, []);
    assert.equal(await readFile(join(privatePath, name), 'utf8'), 'retained-original-evidence');
    await assert.rejects(access(join(privatePath, 'handle.json')), { code: 'ENOENT' });
  }
});

test('an original handle does not hide a conflicting retained application descriptor', async t => {
  const f = await fixture(t), privatePath = join(f.directory, '.tendriller');
  await mkdir(privatePath, { mode: 0o700 });
  await writeFile(join(privatePath, 'handle.json'), JSON.stringify(f.handle));
  await writeFile(join(privatePath, 'descriptor.json'), JSON.stringify({ payload: { applicationId: 'c'.repeat(64) } }));
  await assert.rejects(f.setup.createProject(f.origin, 'owner@example.test'), { code: 'host_identity_required' });
  assert.deepEqual(f.calls, []);
  assert.deepEqual(JSON.parse(await readFile(join(privatePath, 'handle.json'), 'utf8')), f.handle);
});

test('downloadable SQL setup diagnoses a missing engine after readiness but before page creation', async t => {
  const { directory, origin, calls, setup, engine } = await fixture(t, 'open', 'sql');
  const failure = Object.assign(Error('Install the matching SQL-native archive.'), { code: 'SQL_ENGINE_UNAVAILABLE' });
  engine.fail(failure);
  await assert.rejects(setup.createProject(origin, 'owner@example.test'), error => error === failure);
  assert.deepEqual(calls, [['GET', '/api/readiness'], ['GET', '/api/service']]);
  assert.equal(engine.calls, 1);
  await assert.rejects(access(join(directory, '.tendriller/handle.json')), { code: 'ENOENT' });
});
