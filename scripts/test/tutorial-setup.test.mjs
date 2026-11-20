import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, copyFile, symlink, readFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

async function fixture(t, initialMode = 'open') {
  const directory = await mkdtemp(join(tmpdir(), 'tutorial-setup-'));
  for (const name of ['setup.mjs', 'local.mjs', 'domain.mjs']) await copyFile(join(root, 'docs/tutorial', name), join(directory, name));
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
      response.end(JSON.stringify({ schemaVersion: 1, serviceOrigin: origin, mode,
        environment: { id: origin, label: 'Local qualification', kind: 'local' },
        build: { coreRelease: 'test', runtimeId: 'a'.repeat(64), sourceCommit: null },
        creation: { available: mode === 'open', code: mode === 'open' ? null : 'creation_paused', message: 'Current service state.', nextAction: 'Keep this origin.' },
        writes: { available: mode !== 'read_only', code: mode === 'read_only' ? 'read_only' : null },
        readinessUrl: origin + '/api/readiness', statusUrl: origin + '/status', checkedAt: new Date().toISOString() }));
    } else if (request.url === '/api/service') response.end(JSON.stringify({ contract: 3, core_release: 'test', limits: {} }));
    else if (request.url === '/api/tendrils' && request.method === 'POST') {
      if (creationPaused) { response.writeHead(503); response.end(JSON.stringify({ error: { code: 'creation_paused', message: 'New tendrils are temporarily paused' } })); return; }
      response.writeHead(201);
      response.end(JSON.stringify({ id: 'page', api: origin + '/api/t/page', token: 'test-only-token',
        page_url: 'https://page.example.test/s/test/', application: { id: 'a'.repeat(64) } }));
    } else { response.writeHead(404); response.end('{}'); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  return { directory, origin, calls, setup: await import(pathToFileURL(join(directory, 'setup.mjs')).href),
    setMode: value => { mode = value; }, pauseAtCreation: () => { creationPaused = true; } };
}

test('downloadable setup resumes only the same service without creating or overwriting private state', async t => {
  const { directory, origin, calls, setup, setMode } = await fixture(t);
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
  assert.equal(await readFile(join(directory, '.tendriller/handle.json'), 'utf8'), saved);
});

test('downloadable setup creates no private state on paused, unsupported, or raced creation', async t => {
  for (const mode of ['creation_paused', 'read_only', 'unsupported', 'open']) {
    const { directory, origin, calls, setup, pauseAtCreation } = await fixture(t, mode);
    if (mode === 'open') pauseAtCreation();
    await assert.rejects(setup.createProject(origin, 'owner@example.test'), { code: mode === 'unsupported' ? 'readiness_unsupported' : 'creation_paused' });
    assert.deepEqual(calls, mode === 'open'
      ? [['GET', '/api/readiness'], ['GET', '/api/service'], ['POST', '/api/tendrils']] : [['GET', '/api/readiness']]);
    await assert.rejects(access(join(directory, '.tendriller/handle.json')), { code: 'ENOENT' });
  }
});
