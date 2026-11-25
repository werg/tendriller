import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseArgs, intFlag } from '../lib/args.mjs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { mkdtemp, rm, access, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { saveConfig } from '../lib/config.mjs';

const run = promisify(execFile), cli = fileURLToPath(new URL('../bin/tendril.mjs', import.meta.url));
test('CLI accepts explicit stable operation flags and refuses missing values', () => {
  assert.deepEqual(parseArgs(['command', 'claim', '{}', '--operation', 'claim-1', '--wait', 'materialized']), {
    cmd: 'command', args: ['claim', '{}'], flags: { operation: 'claim-1', wait: 'materialized' },
  });
  assert.throws(() => parseArgs(['command', 'claim', '{}', '--operation']), /needs a value/);
  assert.throws(() => intFlag('1.5', 'timeout', 30), /safe integer/);
  assert.deepEqual(parseArgs(['self', '--mode', 'attach', '--profile', 'retained', '--run', 'review']), {
    cmd: 'self', args: [], flags: { mode: 'attach', profile: 'retained', run: 'review' },
  });
});
test('public CLI advertises one session and rejects removed host data commands before opening a session', async () => {
  const result = await run(process.execPath, [cli, '--help']);
  assert.match(result.stdout, /--session/); assert.match(result.stdout, /publish <directory>/);
  assert.match(result.stdout, /--mode attach/); assert.match(result.stdout, /only\s+detaches that client/);
  assert.doesNotMatch(result.stdout, /state get|events socket|scopes register|collector spool/);
  for (const command of ['state', 'stream', 'workflow', 'ack', 'rollback']) {
    await assert.rejects(run(process.execPath, [cli, command]), error => error.code === 64 && /Unknown command/.test(error.stderr));
  }
});
test('invalid ownership mode or missing independent profile is rejected before bootstrap import', async () => {
  await assert.rejects(run(process.execPath, [cli, 'self', '--mode', 'automatic', '--session', 'missing.mjs']),
    error => error.code === 64 && /Use --mode/.test(error.stderr));
  await assert.rejects(run(process.execPath, [cli, 'self', '--mode', 'independent', '--session', 'missing.mjs']),
    error => error.code === 64 && /requires --profile/.test(error.stderr));
});
test('removed ordering commands are not accepted as aliases', async () => {
  for (const command of ['reapply', 'recovery']) await assert.rejects(run(process.execPath, [cli, command]), error => error.code === 64 && /Unknown command/.test(error.stderr));
});

test('CLI deadline remains explicit when cancellation closes an in-flight session', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tendril-timeout-')), path = join(root, 'session.mjs');
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path, `export async function openSession(){let reject;return {session:{query(){return new Promise((_,r)=>{reject=r})}},close(){reject(Error('APPLICATION_SESSION_CLOSED'))}}}`);
  await assert.rejects(run(process.execPath, [cli, '--session', path, 'query', 'notes', 'null', '--timeout', '1']), error => {
    const result = JSON.parse(error.stderr);
    return result.error.code === 'invocation_timeout' && /Invocation timed out/.test(result.error.message);
  });
});

test('CLI reports a completed publication even when local ownership cleanup fails', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tendril-published-')), path = join(root, 'session.mjs');
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'index.html'), '<main>published</main>');
  await writeFile(path, `export async function openSession(){return {session:{},control:{preparePublication:async()=>({id:'signed',payload:{operationId:'original'}}),publish:async publication=>({publication,version:1})},close(){throw Error('local cleanup failed')}}}`);
  await assert.rejects(run(process.execPath, [cli, '--session', path, 'publish', root, '--operation', 'original']), error => {
    const result = JSON.parse(error.stderr);
    return error.stdout === '' && result.publication.outcome === 'committed' && result.publication.operationId === 'original'
      && result.publication.receipt.version === 1 && result.error.message === 'local cleanup failed';
  });
});

async function fixture(t, respond = () => undefined) {
  const root = await mkdtemp(join(tmpdir(), 'tendril-guide-'));
  const calls = [];
  const server = createServer((request, response) => {
    calls.push({ path: request.url, authorization: request.headers.authorization, method: request.method });
    response.setHeader('Content-Type', 'application/json');
    const result = respond(request, origin);
    response.statusCode = result?.status ?? 200;
    response.end(JSON.stringify(result?.body ?? { contract: 3, path: request.url }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const env = { ...process.env, TENDRIL_CONFIG_DIR: join(root, 'handles'), TENDRIL_NAME: '',
    TENDRIL_API: '', TENDRIL_TOKEN: '', TENDRIL_SERVER: '' };
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  return { origin, calls, env };
}

test('guide starts from a domain offline and does not open a saved handle or create one', async t => {
  const { origin, calls, env } = await fixture(t);
  const result = await run(process.execPath, [cli, 'guide', '--server', origin, '--pretty'], {
    env: { ...env, TENDRIL_NAME: 'missing-handle', TENDRIL_TOKEN: 'private-fixture-token' },
  });
  const guide = JSON.parse(result.stdout);
  assert.equal(guide.service, origin);
  assert.equal(guide.network_checked, false);
  assert.equal(guide.start_here, `${origin}/docs/BUILD_AN_APP.md`);
  assert.equal(guide.troubleshooting, `${origin}/docs/TROUBLESHOOTING.md`);
  assert.equal(guide.service_descriptor, `${origin}/api/service`);
  assert.deepEqual(guide.workflow.map(item => item.id), ['create', 'define', 'configure', 'publish', 'claim', 'connect', 'verify']);
  assert.match(guide.prerequisites.join(' '), /page token alone does not grant/);
  assert.doesNotMatch(result.stdout, /private-fixture-token/);
  assert.deepEqual(calls, []);
  await assert.rejects(access(env.TENDRIL_CONFIG_DIR), { code: 'ENOENT' });
});

function readiness(origin, mode = 'open') {
  return { schemaVersion: 1, serviceOrigin: origin, mode,
    environment: { id: origin, kind: 'local', label: 'Local test' },
    build: { coreRelease: 'test', runtimeId: 'a'.repeat(64), sourceCommit: null },
    creation: { available: mode === 'open', code: mode === 'open' ? null : 'creation_paused',
      message: mode === 'open' ? 'Creation is open.' : 'Creation is paused.', nextAction: 'Inspect this service; keep the selected origin.' },
    writes: { available: mode !== 'read_only', code: mode === 'read_only' ? 'read_only' : null },
    readinessUrl: origin + '/api/readiness', statusUrl: origin + '/status', checkedAt: new Date().toISOString() };
}

test('creation requires an explicit origin and stops at paused or unsupported readiness', async t => {
  for (const mode of ['creation_paused', 'read_only', 'unsupported']) {
    const { origin, calls, env } = await fixture(t, (_request, origin) => mode === 'unsupported'
      ? { status: 404, body: { error: { code: 'not_found' } } }
      : { body: readiness(origin, mode) });
    await assert.rejects(run(process.execPath, [cli, 'new', '--owner', 'owner@example.test', '--server', origin], { env }),
      error => JSON.parse(error.stderr).error.code === (mode === 'unsupported' ? 'readiness_unsupported' : 'creation_paused'));
    assert.deepEqual(calls.map(({ path, method, authorization }) => [path, method, authorization]), [['/api/readiness', 'GET', undefined]]);
    await assert.rejects(access(env.TENDRIL_CONFIG_DIR), { code: 'ENOENT' });
    await assert.rejects(run(process.execPath, [cli, 'new', '--owner', 'owner@example.test'], { env }),
      error => error.code === 64 && /selected connector service origin/.test(error.stderr));
    assert.equal(calls.length, 1);
  }
});

test('creation rechecks server policy and never saves a handle after a preflight race', async t => {
  const { origin, calls, env } = await fixture(t, (request, origin) => request.url === '/api/readiness'
    ? { body: readiness(origin) } : request.url === '/api/tendrils'
      ? { status: 503, body: { error: { code: 'creation_paused', message: 'New tendrils are temporarily paused' } } }
      : undefined);
  await assert.rejects(run(process.execPath, [cli, 'new', '--owner', 'owner@example.test', '--server', origin], { env }),
    error => JSON.parse(error.stderr).error.code === 'creation_paused');
  assert.deepEqual(calls.map(({ path, method }) => [path, method]), [['/api/readiness', 'GET'], ['/api/service', 'GET'], ['/api/tendrils', 'POST']]);
  await assert.rejects(access(env.TENDRIL_CONFIG_DIR), { code: 'ENOENT' });
});

test('readiness reports current mode anonymously despite ambient page credentials', async t => {
  const { origin, calls, env } = await fixture(t, (_request, origin) => ({ body: readiness(origin, 'read_only') }));
  const result = await run(process.execPath, [cli, 'readiness', '--server', origin], {
    env: { ...env, TENDRIL_NAME: 'unrelated', TENDRIL_TOKEN: 'private-fixture' },
  });
  assert.equal(JSON.parse(result.stdout).creation.available, false);
  assert.deepEqual(calls, [{ path: '/api/readiness', method: 'GET', authorization: undefined }]);
  assert.doesNotMatch(result.stdout, /private-fixture/);
});

test('public service discovery works before creation and explicit server ignores ambient page credentials', async t => {
  const { origin, calls, env } = await fixture(t);
  for (const [args, variables] of [
    [['service'], { ...env, TENDRIL_SERVER: origin }],
    [['service', '--server', origin], { ...env, TENDRIL_NAME: 'missing-handle', TENDRIL_API: 'https://unused.invalid/api/t/private', TENDRIL_TOKEN: 'fixture-token' }],
  ]) {
    const result = await run(process.execPath, [cli, ...args], { env: variables });
    assert.equal(JSON.parse(result.stdout).path, '/api/service');
  }
  assert.deepEqual(calls, [
    { path: '/api/service', authorization: undefined, method: 'GET' },
    { path: '/api/service', authorization: undefined, method: 'GET' },
  ]);
});

test('service still supports the selected page and rejects ambiguous discovery flags', async t => {
  const { origin, calls, env } = await fixture(t);
  saveConfig({ id: 'page', api: `${origin}/api/t/page`, token: 'fixture-token', application: { id: 'a'.repeat(64) } }, 'sample', env, origin);
  const result = await run(process.execPath, [cli, 'service', '--tendril', 'sample'], { env });
  assert.equal(JSON.parse(result.stdout).path, '/api/t/page/service');
  assert.deepEqual(calls, [{ path: '/api/t/page/service', authorization: 'Bearer fixture-token', method: 'GET' }]);
  await assert.rejects(run(process.execPath, [cli, 'service', '--server', origin, '--tendril', 'sample'], { env }),
    error => error.code === 64 && /Choose public service/.test(error.stderr));
  await assert.rejects(run(process.execPath, [cli, 'guide', '--session', 'missing.mjs'], { env }),
    error => error.code === 64 && /does not accept --session/.test(error.stderr));
  await assert.rejects(run(process.execPath, [cli, 'guide', '--server', 'https://user:secret@example.com'], { env }),
    error => error.code === 64 && !/secret/.test(error.stderr));
  assert.equal(calls.length, 1);
});
