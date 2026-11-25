import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const origin = 'https://staging.example.test';
const execute = promisify(execFile);

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'tutorial-account-setup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const file of ['account-setup.mjs', 'local.mjs'])
    await copyFile(join(root, 'docs/tutorial', file), join(directory, file));
  await mkdir(join(directory, 'helpers'));
  await copyFile(join(root, 'docs/tutorial/helpers/account-setup.mjs'), join(directory, 'helpers/account-setup.mjs'));
  await mkdir(join(directory, 'node_modules/@tendriller'), { recursive: true });
  await symlink(resolve(root, 'dist/sdk'), join(directory, 'node_modules/@tendriller/core'));
  const module = await import(pathToFileURL(join(directory, 'account-setup.mjs')).href);
  const path = name => join(directory, '.tendriller', name);
  const read = async name => JSON.parse(await readFile(path(name), 'utf8'));
  return { directory, module, path, read };
}

function receipt(intent) {
  const pageId = 'abcdefghijkl';
  return { schemaVersion: 1, serviceOrigin: intent.serviceOrigin, operationId: intent.operationId,
    requestDigest: intent.requestDigest, credentialCommitment: intent.credentialCommitment,
    applicationId: intent.applicationId, pageId, state: 'ready', code: null,
    nextAction: 'Prepare and publish before owner sign-in.', expiresAt: Date.now() + 86_400_000,
    page: { id: pageId, api: origin + '/api/t/' + pageId,
      page_url: `https://${pageId}.pages.example.test/s/${'a'.repeat(26)}/`,
      application: { id: intent.applicationId }, name: intent.name } };
}

test('account setup persists private intent before returning only public MCP arguments', async t => {
  const f = await fixture(t);
  const report = await f.module.prepareAccountSetup(origin, { name: 'Shared project', operationId: 'setup-1' });
  const intent = await f.read('account-setup.json');
  assert.match(intent.credential, /^tk_[a-z2-7]{32}$/);
  assert.equal(report.state, 'intent_saved');
  assert.equal(report.connected, false);
  assert.equal(report.prepare.tool, 'prepare_tendril_setup');
  assert.deepEqual(report.prepare.arguments, { operationId: intent.operationId, name: intent.name,
    mode: intent.mode, applicationId: intent.applicationId, credentialCommitment: intent.credentialCommitment });
  assert.deepEqual(report.inspect, { tool: 'inspect_tendril_setup', arguments: { operationId: 'setup-1' } });
  assert.equal(JSON.stringify(report).includes(intent.credential), false);
  assert.equal(Object.hasOwn(report.prepare.arguments, 'owner'), false);
  assert.deepEqual(await readdir(f.path('.')), ['account-setup.json']);
  if (process.platform !== 'win32') {
    assert.equal((await stat(f.path('.'))).mode & 0o777, 0o700);
    assert.equal((await stat(f.path('account-setup.json'))).mode & 0o777, 0o600);
  }
  await assert.rejects(access(f.path('handle.json')), { code: 'ENOENT' });
});

test('account setup resumes the original intent and refuses changed input or origin without replacing bytes', async t => {
  const f = await fixture(t);
  const first = await f.module.prepareAccountSetup(origin, { name: 'A retained project' });
  const bytes = await readFile(f.path('account-setup.json'));
  assert.deepEqual(await f.module.prepareAccountSetup(origin), first);
  for (const [service, options] of [[origin, { name: 'Changed' }], [origin, { operationId: 'replacement' }],
    [origin, { mode: 'dashboard' }], ['https://production.example.test', {}]]) {
    await assert.rejects(f.module.prepareAccountSetup(service, options), { code: 'setup_operation_conflict' });
    assert.deepEqual(await readFile(f.path('account-setup.json')), bytes);
  }
});

test('concurrent exact preparation converges on the flushed winning credential', async t => {
  const f = await fixture(t);
  const results = await Promise.all(Array.from({ length: 4 }, () => f.module.prepareAccountSetup(origin, { operationId: 'same-setup' })));
  for (const result of results) assert.deepEqual(result, results[0]);
  const intent = await f.read('account-setup.json');
  assert.equal(results[0].prepare.arguments.credentialCommitment, intent.credentialCommitment);
  assert.deepEqual(await readdir(f.path('.')), ['account-setup.json']);
});

test('a public ready receipt restores the original private handle and exact retries preserve it', async t => {
  const f = await fixture(t);
  await f.module.prepareAccountSetup(origin);
  const intent = await f.read('account-setup.json'), result = receipt(intent);
  const report = await f.module.finishAccountSetup(result);
  const handle = await f.read('handle.json'), saved = await readFile(f.path('handle.json'));
  assert.equal(handle.token, intent.credential);
  assert.equal(report.state, 'handle_saved');
  assert.equal(report.connected, false);
  assert.equal(report.page_url, handle.page_url);
  assert.equal(JSON.stringify(report).includes(handle.token), false);
  assert.equal((await f.module.finishAccountSetup(result)).resumed, true);
  assert.equal((await f.module.prepareAccountSetup(origin)).resumed, true);
  await f.module.finishAccountSetup({ ...result, page: { ...result.page, expires_at: null } });
  assert.deepEqual(await readFile(f.path('handle.json')), saved, 'later public metadata never rewrites the retained private handle');
  await assert.rejects(f.module.prepareAccountSetup('https://production.example.test'), { code: 'service_origin_mismatch' });
});

test('uncertain, mismatched or secret-bearing public results never save a handle', async t => {
  const f = await fixture(t);
  await f.module.prepareAccountSetup(origin);
  const intent = await f.read('account-setup.json'), result = receipt(intent);
  const original = await readFile(f.path('account-setup.json'));
  await assert.rejects(f.module.finishAccountSetup({ ...result, state: 'provisioning' }), { code: 'setup_not_ready' });
  for (const patch of [{ serviceOrigin: 'https://production.example.test' }, { operationId: 'new-operation' },
    { requestDigest: 'b'.repeat(64) }, { credentialCommitment: 'c'.repeat(64) }, { applicationId: 'd'.repeat(64) },
    { page: { ...result.page, token: intent.credential } },
    { page: { ...result.page, api: 'https://production.example.test/api/t/' + result.pageId } }]) {
    await assert.rejects(f.module.finishAccountSetup({ ...result, ...patch }), { code: 'setup_receipt_mismatch' });
    await assert.rejects(access(f.path('handle.json')), { code: 'ENOENT' });
  }
  assert.deepEqual(await readFile(f.path('account-setup.json')), original);
});

test('missing or corrupt private intent never mints a replacement during completion', async t => {
  const f = await fixture(t);
  await assert.rejects(f.module.finishAccountSetup({}), { code: 'setup_storage_required' });
  await assert.rejects(access(f.path('.')), { code: 'ENOENT' });
  await f.module.prepareAccountSetup(origin);
  const intent = await f.read('account-setup.json'), result = receipt(intent);
  await writeFile(f.path('account-setup.json'), JSON.stringify({ ...intent, requestDigest: 'e'.repeat(64) }));
  const corrupted = await readFile(f.path('account-setup.json'));
  await assert.rejects(f.module.finishAccountSetup(result), { code: 'setup_state_invalid' });
  await assert.rejects(f.module.prepareAccountSetup(origin), { code: 'setup_state_invalid' });
  assert.deepEqual(await readFile(f.path('account-setup.json')), corrupted);
  await assert.rejects(access(f.path('handle.json')), { code: 'ENOENT' });
});

test('account setup does not replace an existing email-created application', async t => {
  const f = await fixture(t);
  await mkdir(f.path('.'), { mode: 0o700 });
  const handle = { id: 'abcdefghijkl', api: origin + '/api/t/abcdefghijkl', token: 'existing-private-token',
    page_url: 'https://abcdefghijkl.pages.example.test/s/' + 'a'.repeat(26) + '/', application: { id: 'f'.repeat(64) } };
  await writeFile(f.path('handle.json'), JSON.stringify(handle));
  const original = await readFile(f.path('handle.json'));
  const resumed = await f.module.prepareAccountSetup(origin);
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.page_url, handle.page_url);
  assert.equal(JSON.stringify(resumed).includes(handle.token), false);
  await assert.rejects(access(f.path('account-setup.json')), { code: 'ENOENT' });
  await assert.rejects(f.module.prepareAccountSetup(origin, { operationId: 'replacement' }), { code: 'setup_handle_conflict' });
  assert.deepEqual(await readFile(f.path('handle.json')), original);
});

test('the real prepare/finish CLI needs no local OAuth token or networking and never prints its credential', async t => {
  const f = await fixture(t);
  await writeFile(join(f.directory, 'no-network.mjs'), "globalThis.fetch = () => { throw Error('Unexpected network request'); };\n");
  const run = args => execute(process.execPath, ['--import', './no-network.mjs', 'account-setup.mjs', ...args],
    { cwd: f.directory, timeout: 10_000 });
  const prepared = await run(['prepare', origin, 'CLI project']);
  const intent = await f.read('account-setup.json');
  assert.equal(JSON.parse(prepared.stdout).prepare.tool, 'prepare_tendril_setup');
  assert.equal((prepared.stdout + prepared.stderr).includes(intent.credential), false);
  await writeFile(join(f.directory, 'public-result.json'), JSON.stringify(receipt(intent)));
  const completed = await run(['finish', 'public-result.json']);
  assert.equal(JSON.parse(completed.stdout).state, 'handle_saved');
  assert.equal((completed.stdout + completed.stderr).includes(intent.credential), false);
});

test('malformed private JSON never echoes credential fragments through CLI errors', async t => {
  const f = await fixture(t);
  await f.module.prepareAccountSetup(origin);
  const intent = await f.read('account-setup.json');
  await writeFile(f.path('account-setup.json'), intent.credential);
  await writeFile(join(f.directory, 'public-result.json'), JSON.stringify(receipt(intent)));
  for (const args of [['prepare', origin], ['finish', 'public-result.json']]) {
    await assert.rejects(execute(process.execPath, ['account-setup.mjs', ...args], { cwd: f.directory, timeout: 10_000 }), error => {
      assert.equal(JSON.parse(error.stderr).error.code, 'setup_state_invalid');
      assert.equal((error.stdout + error.stderr).includes(intent.credential.slice(0, 10)), false);
      return true;
    });
  }
  assert.equal(await readFile(f.path('account-setup.json'), 'utf8'), intent.credential);
  await assert.rejects(access(f.path('handle.json')), { code: 'ENOENT' });
});
