import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseArgs, intFlag } from '../lib/args.mjs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { saveConfig } from '../lib/config.mjs';

const run = promisify(execFile), cli = fileURLToPath(new URL('../bin/tendril.mjs', import.meta.url));
test('CLI accepts explicit stable operation flags and refuses missing values', () => {
  assert.deepEqual(parseArgs(['command', 'claim', '{}', '--operation', 'claim-1', '--saved']), {
    cmd: 'command', args: ['claim', '{}'], flags: { operation: 'claim-1', saved: true },
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
test('reapplication cannot be issued without a reviewed revision', async () => {
  await assert.rejects(run(process.execPath, [cli, 'reapply', 'old', 'claim', '{}', '--operation', 'new']),
    error => error.code === 64 && /--based-on/.test(error.stderr));
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'tendril-guide-'));
  const calls = [];
  const server = createServer((request, response) => {
    calls.push({ path: request.url, authorization: request.headers.authorization, method: request.method });
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ contract: 3, path: request.url }));
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
  assert.deepEqual(guide.workflow.map(item => item.id), ['create', 'claim', 'define', 'configure', 'connect', 'publish', 'verify']);
  assert.match(guide.prerequisites.join(' '), /page token alone does not grant/);
  assert.doesNotMatch(result.stdout, /private-fixture-token/);
  assert.deepEqual(calls, []);
  await assert.rejects(access(env.TENDRIL_CONFIG_DIR), { code: 'ENOENT' });
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
