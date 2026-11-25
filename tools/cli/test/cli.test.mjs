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
import { onboardingDescriptor } from '@tendriller/core/onboarding';
import { onboardingGuide } from '../lib/guide.mjs';

const run = promisify(execFile), cli = fileURLToPath(new URL('../bin/tendril.mjs', import.meta.url));
const runner = fileURLToPath(new URL('./support/run-cli.mjs', import.meta.url));
test('CLI accepts explicit stable operation flags and refuses missing values', () => {
  assert.deepEqual(parseArgs(['command', 'claim', '{}', '--operation', 'claim-1', '--wait', 'materialized']), {
    cmd: 'command', args: ['claim', '{}'], flags: { operation: 'claim-1', wait: 'materialized' },
  });
  assert.throws(() => parseArgs(['command', 'claim', '{}', '--operation']), /needs a value/);
  assert.throws(() => intFlag('1.5', 'timeout', 30), /safe integer/);
  assert.deepEqual(parseArgs(['self', '--page', 'notes']), { cmd: 'self', args: [], flags: { page: 'notes' } });
});
test('public CLI advertises the workspace, one agent program and page-scoped commands', async () => {
  const result = await run(process.execPath, [cli, '--help']);
  for (const text of ['workspace init --service', 'page new <slug>', 'agent run', 'mcp-stdio', '--page <slug|id>', 'publish <directory>'])
    assert(result.stdout.includes(text), text);
  assert.doesNotMatch(result.stdout, /--session|--mode|--tendril|token create|TENDRIL_TOKEN|\bnew \[name\]/);
  for (const command of ['state', 'stream', 'workflow', 'ack', 'rollback', 'new', 'token', 'peer', 'serve']) {
    await assert.rejects(run(process.execPath, [cli, command]), error => error.code === 64 && /Unknown command/.test(error.stderr));
  }
  for (const flag of ['--session', '--mode', '--tendril', '--profile'])
    await assert.rejects(run(process.execPath, [cli, 'self', flag, 'x']), error => error.code === 64 && /does not accept/.test(error.stderr));
});
test('removed ordering commands are not accepted as aliases', async () => {
  for (const command of ['reapply', 'recovery']) await assert.rejects(run(process.execPath, [cli, command]), error => error.code === 64 && /Unknown command/.test(error.stderr));
});

test('CLI deadline remains explicit when cancellation closes an in-flight session', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tendril-timeout-')), path = join(root, 'session.mjs');
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path, `export async function attach(){let reject;return {session:{query(){return new Promise((_,r)=>{reject=r})}},detach(){reject(Error('APPLICATION_SESSION_CLOSED'))}}}`);
  await assert.rejects(run(process.execPath, [runner, '--fixture', path, '--page', 'notes', 'query', 'notes', 'null', '--timeout', '1']), error => {
    const result = JSON.parse(error.stderr);
    return result.error.code === 'invocation_timeout' && /Invocation timed out/.test(result.error.message);
  });
});

test('CLI reports a completed publication even when local ownership cleanup fails', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tendril-published-')), path = join(root, 'session.mjs');
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'index.html'), '<main>published</main>');
  await writeFile(path, `export async function attach(){return {session:{},control:{preparePublication:async()=>({id:'signed',payload:{operationId:'original'}}),publish:async publication=>({publication,version:1})},detach(){throw Error('local cleanup failed')}}}`);
  await assert.rejects(run(process.execPath, [runner, '--fixture', path, '--page', 'notes', 'publish', root, '--operation', 'original']), error => {
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
  const env = { ...process.env, TENDRIL_WORKSPACE: '', TENDRIL_SERVER: '' };
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  return { origin, calls, env, root };
}

test('guide starts from a domain offline and does not open or create a workspace', async t => {
  const { origin, calls, env, root } = await fixture(t);
  const result = await run(process.execPath, [cli, 'guide', '--server', origin, '--pretty'], { env, cwd: root });
  const guide = JSON.parse(result.stdout);
  assert.equal(guide.service, origin);
  assert.equal(guide.network_checked, false);
  assert.equal(guide.start_here, `${origin}/docs/BUILD_AN_APP.md`);
  assert.equal(guide.troubleshooting, `${origin}/docs/TROUBLESHOOTING.md`);
  assert.equal(guide.service_descriptor, `${origin}/api/service`);
  assert.deepEqual(guide.workflow.map(item => item.id), ['create', 'define', 'configure', 'publish', 'claim', 'connect', 'verify']);
  assert.match(guide.prerequisites.join(' '), /agent page access alone does not grant/);
  assert.match(guide.prerequisites.join(' '), /tendril workspace init/);
  assert.deepEqual(calls, []);
  await assert.rejects(access(join(root, 'tendriller.json')), { code: 'ENOENT' });
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

test('readiness reports current mode anonymously', async t => {
  const { origin, calls, env } = await fixture(t, (_request, origin) => ({ body: readiness(origin, 'read_only') }));
  const result = await run(process.execPath, [cli, 'readiness', '--server', origin], { env });
  assert.equal(JSON.parse(result.stdout).creation.available, false);
  assert.deepEqual(calls, [{ path: '/api/readiness', method: 'GET', authorization: undefined }]);
  await assert.rejects(run(process.execPath, [cli, 'readiness'], { env }), error => error.code === 64 && /selected connector service origin/.test(error.stderr));
});

test('public service discovery is anonymous and rejects unsafe origins without echoing them', async t => {
  const { origin, calls, env } = await fixture(t, () => ({ body: { contract: 3, core_release: 'test', limits: {}, attestationKey: 'ab'.repeat(32) } }));
  for (const args of [['service', '--server', origin]]) {
    const result = await run(process.execPath, [cli, ...args], { env });
    assert.equal(JSON.parse(result.stdout).contract, 3);
  }
  const ambient = await run(process.execPath, [cli, 'service'], { env: { ...env, TENDRIL_SERVER: origin } });
  assert.equal(JSON.parse(ambient.stdout).core_release, 'test');
  assert.deepEqual(calls, [
    { path: '/api/service', authorization: undefined, method: 'GET' },
    { path: '/api/service', authorization: undefined, method: 'GET' },
  ]);
  await assert.rejects(run(process.execPath, [cli, 'guide', '--page', 'notes'], { env }),
    error => error.code === 64 && /does not accept --page/.test(error.stderr));
  await assert.rejects(run(process.execPath, [cli, 'guide', '--server', 'https://user:secret@example.com'], { env }),
    error => error.code === 64 && !/secret/.test(error.stderr));
  assert.equal(calls.length, 2);
});

test('guide uses the chosen service origin for all hosted links and validates public origins', () => {
  const guide = onboardingGuide({}, { TENDRIL_SERVER: 'https://staging.example.com/' });
  assert.deepEqual(guide.onboarding, onboardingDescriptor('https://staging.example.com'));
  assert.equal(guide.mcp_guide, guide.onboarding.documentation.mcp);
  assert.deepEqual(guide.workflow, guide.onboarding.workflow);
  for (const key of ['start_here', 'agent_guide', 'troubleshooting', 'service_descriptor'])
    assert.equal(new URL(guide[key]).origin, 'https://staging.example.com');
  assert.equal(onboardingGuide({ server: 'https://branch.example.com' }, { TENDRIL_SERVER: 'https://ignored.example.com' }).service,
    'https://branch.example.com');
  for (const server of ['http://example.com', 'https://example.com/page', 'https://example.com/?token=secret', 'https://example.com/#page', 'file:///tmp/service'])
    assert.throws(() => onboardingGuide({ server }, {}), /service origin/);
});
