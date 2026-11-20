import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url)), origin = 'https://staging.example.test';
const execute = promisify(execFile), pageId = 'abcdefghijkl', applicationId = 'a'.repeat(64);
const original = { id: pageId, application: { id: applicationId }, api: `${origin}/api/t/${pageId}`,
  page_url: `https://${pageId}.pages.example.test/s/${'a'.repeat(26)}/`, token: 'tk_' + 'a'.repeat(32) };
const delegated = { ...original, token: 'tk_' + 'b'.repeat(32) };

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'tutorial-host-adoption-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const file of ['host-adoption.mjs', 'account-setup.mjs', 'local.mjs'])
    await copyFile(join(root, 'docs/tutorial', file), join(directory, file));
  await mkdir(join(directory, 'node_modules/@tendriller'), { recursive: true });
  await symlink(resolve(root, 'dist/sdk'), join(directory, 'node_modules/@tendriller/core'));
  await mkdir(join(directory, '.tendriller'), { mode: 0o700 });
  const path = name => join(directory, '.tendriller', name);
  const read = async name => JSON.parse(await readFile(path(name), 'utf8'));
  const save = (name, value) => writeFile(path(name), JSON.stringify(value), { mode: 0o600 });
  await save('handle.json', original);
  await save('descriptor.json', { payload: { applicationId } });
  await writeFile(path('device.sqlite'), 'retained-signer-journal');
  await save('genesis-request.json', { signature: 'retained-signed-operation' });
  await writeFile(path('delegation-code.txt'), pageId + '-123456\n', { mode: 0o600 });
  const module = await import(pathToFileURL(join(directory, 'host-adoption.mjs')).href);
  const local = await import(pathToFileURL(join(directory, 'local.mjs')).href);
  return { directory, module, local, path, read, save, code: path('delegation-code.txt'),
    adopt: options => module.adoptHostCredential(origin, path('delegation-code.txt'), { ...options, fetch: (url, init) => {
      if (init.method === 'GET') {
        assert.equal(url, origin + '/api/adopt'); assert.equal(init.redirect, 'error'); assert.equal(init.body, undefined);
        return reply({ schemaVersion: 1, serviceOrigin: origin, delegation: { applicationBound: true, nonReplacing: true, responseRecovery: false } });
      }
      return options.fetch(url, init);
    } }) };
}
const reply = handle => new Response(JSON.stringify(handle), { headers: { 'Content-Type': 'application/json' } });

test('reviewed host delegation saves before send and selects the same app without changing its private identity', async t => {
  const f = await fixture(t);
  const retained = await Promise.all(['handle.json', 'device.sqlite', 'genesis-request.json', 'descriptor.json'].map(name => readFile(f.path(name))));
  const report = await f.adopt({ fetch: async (url, options) => {
    assert.equal(url, origin + '/api/adopt');
    assert.equal(options.redirect, 'error');
    assert.deepEqual(options.headers, { 'Content-Type': 'application/json' });
    assert.deepEqual(JSON.parse(options.body), { code: pageId + '-123456', expectedMode: 'delegate', applicationId });
    const attempts = (await readdir(f.path('.'))).filter(name => /^host-adoption-[a-f0-9]{64}\.json$/.test(name));
    assert.equal(attempts.length, 1, 'the flushed submission record precedes the request');
    assert.equal((await f.read(attempts[0])).applicationId, applicationId);
    return reply(delegated);
  } });
  assert.equal(report.state, 'host_credential_saved'); assert.equal(report.connected, false);
  for (const secret of [original.token, delegated.token, pageId + '-123456']) assert.equal(JSON.stringify(report).includes(secret), false);
  assert.deepEqual(await f.local.readHostHandle(), delegated);
  assert.deepEqual((await f.local.project()).handle, delegated);
  for (const [index, name] of ['handle.json', 'device.sqlite', 'genesis-request.json', 'descriptor.json'].entries())
    assert.deepEqual(await readFile(f.path(name)), retained[index]);
  if (process.platform !== 'win32') {
    for (const name of (await readdir(f.path('.'))).filter(name => name.startsWith('host-')))
      assert.equal((await stat(f.path(name))).mode & 0o777, 0o600);
  }
  const setup = await import(pathToFileURL(join(f.directory, 'account-setup.mjs')).href);
  assert.equal((await setup.prepareAccountSetup(origin)).resumed, true);
  await assert.rejects(access(f.path('account-setup.json')), { code: 'ENOENT' });
});

test('concurrent or restarted adoption sends the one-use code only once', async t => {
  const f = await fixture(t), entered = Promise.withResolvers(), release = Promise.withResolvers();
  let sends = 0;
  const first = f.adopt({ fetch: async () => { sends++; entered.resolve(); await release.promise; return reply(delegated); } });
  await entered.promise;
  await assert.rejects(f.adopt({ fetch: async () => { sends++; throw Error('must not send'); } }), { code: 'adoption_outcome_unknown' });
  release.resolve();
  const completed = await first;
  const resumed = await f.adopt({ fetch: async () => { sends++; throw Error('must not send'); } });
  assert.equal(sends, 1); assert.equal(resumed.resumed, true); assert.equal(resumed.attemptId, completed.attemptId);
});

test('a later explicit reviewed renewal atomically selects a new credential and retains both histories', async t => {
  const f = await fixture(t);
  const first = await f.adopt({ fetch: async () => reply(delegated) });
  const retained = await readdir(f.path('.'));
  const originalBytes = await readFile(f.path('handle.json'));
  const firstEvidence = new Map(await Promise.all(retained.filter(name => name.startsWith('host-adoption-'))
    .map(async name => [name, await readFile(f.path(name))])));
  await writeFile(f.code, pageId + '-654321');
  const renewed = { ...original, token: 'tk_' + 'c'.repeat(32) };
  const second = await f.adopt({ fetch: async () => reply(renewed) });
  assert.notEqual(second.attemptId, first.attemptId);
  assert.deepEqual(await f.local.readHostHandle(), renewed);
  assert.equal((await f.read('host-credential.json')).attemptId, second.attemptId);
  assert.deepEqual(await readFile(f.path('handle.json')), originalBytes);
  for (const [name, bytes] of firstEvidence) assert.deepEqual(await readFile(f.path(name)), bytes);
  assert.equal((await readdir(f.path('.'))).filter(name => name.endsWith('-response.json')).length, 2);
});

test('a lost response retains uncertainty until the owner explicitly approves a different code', async t => {
  const f = await fixture(t); let sends = 0;
  const uncertain = { fetch: async () => { sends++; throw Error('transport lost after redemption'); } };
  await assert.rejects(f.adopt(uncertain), { code: 'adoption_outcome_unknown' });
  await assert.rejects(f.adopt(uncertain), { code: 'adoption_outcome_unknown' });
  assert.equal(sends, 1); assert.deepEqual(await f.local.readHostHandle(), original);
  await writeFile(f.code, pageId + '-654321');
  await f.adopt({ fetch: async () => { sends++; return reply(delegated); } });
  assert.equal(sends, 2);
  assert.equal((await readdir(f.path('.'))).filter(name => /^host-adoption-[a-f0-9]{64}\.json$/.test(name)).length, 2);
});

test('a saved response completes after a local selection failure without another redemption', async t => {
  const f = await fixture(t); let sends = 0;
  await mkdir(f.path('host-credential.json'));
  await assert.rejects(f.adopt({ fetch: async () => { sends++; return reply(delegated); } }));
  await rm(f.path('host-credential.json'), { recursive: true });
  await f.adopt({ fetch: async () => { sends++; throw Error('no second request'); } });
  assert.equal(sends, 1); assert.deepEqual(await f.local.readHostHandle(), delegated);
});

test('wrong application, host or owner page never becomes the selected credential', async t => {
  for (const changed of [{ application: { id: 'c'.repeat(64) } }, { api: 'https://other.example/api/t/' + pageId },
    { page_url: `https://${pageId}.other.example/s/${'b'.repeat(26)}/` }]) {
    const f = await fixture(t);
    await assert.rejects(f.adopt({ fetch: async () => reply({ ...delegated, ...changed }) }), { code: 'host_handle_mismatch' });
    assert.deepEqual(await f.local.readHostHandle(), original);
    await assert.rejects(access(f.path('host-credential.json')), { code: 'ENOENT' });
    const response = (await readdir(f.path('.'))).find(name => name.endsWith('-response.json'));
    assert((await readFile(f.path(response), 'utf8')).includes(delegated.token), 'private evidence survives for inspection');
  }
});

test('known refusal remains inspectable and never repeats or replaces an existing credential', async t => {
  const f = await fixture(t); let sends = 0;
  const options = { fetch: async () => { sends++; return new Response(JSON.stringify({ error: { code: 'adoption_mode_mismatch', message: delegated.token } }), { status: 409 }); } };
  for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(f.adopt(options), error => {
    assert.equal(error.code, 'adoption_mode_mismatch'); assert.equal(error.message.includes(delegated.token), false); return true;
  });
  assert.equal(sends, 1); assert.deepEqual(await f.local.readHostHandle(), original);
});

test('lost setup credential can use original public inspection and retained descriptor without a new signer', async t => {
  const f = await fixture(t);
  await f.save('account-setup-result.json', { serviceOrigin: origin, operationId: 'retained-operation', pageId,
    applicationId, state: 'expired', code: 'setup_expired' });
  await rm(f.path('handle.json'));
  const before = await readFile(f.path('device.sqlite'));
  await f.adopt({ fetch: async () => reply(delegated) });
  assert.deepEqual(await f.local.readHostHandle(), delegated);
  assert.deepEqual(await readFile(f.path('device.sqlite')), before);
  await assert.rejects(access(f.path('handle.json')), { code: 'ENOENT' });
  await assert.rejects(access(f.path('account-setup.json')), { code: 'ENOENT' });
});

test('origin, retained identity and private code checks fail before any network submission', async t => {
  const f = await fixture(t); let sends = 0;
  const options = { fetch: async () => { sends++; throw Error('unexpected network'); } };
  await assert.rejects(f.module.adoptHostCredential('https://other.example', f.code, options), { code: 'host_identity_required' });
  await assert.rejects(f.module.adoptHostCredential(origin, pageId + '-123456', options), { code: 'private_code_required' });
  await writeFile(f.code, 'mmmmmmmmmmmm-123456');
  await assert.rejects(f.adopt(options), { code: 'adoption_page_mismatch' });
  await rm(f.path('handle.json'));
  await assert.rejects(f.adopt(options), { code: 'host_identity_required' });
  assert.equal(sends, 0);
});

test('malformed retained private JSON never appears in CLI errors', async t => {
  const f = await fixture(t);
  await writeFile(f.path('handle.json'), delegated.token);
  await assert.rejects(execute(process.execPath, ['host-adoption.mjs', origin, f.code], { cwd: f.directory, timeout: 10_000 }), error => {
    assert.equal((error.stdout + error.stderr).includes(delegated.token), false);
    assert.equal((error.stdout + error.stderr).includes(pageId + '-123456'), false);
    assert.equal(JSON.parse(error.stderr).error.code, 'host_identity_required'); return true;
  });
});

test('older, mismatched or unavailable hosts receive no code and no uncertain submission is recorded', async t => {
  for (const support of [new Response('Use POST', { status: 405 }), reply({ schemaVersion: 1, serviceOrigin: 'https://other.example',
    delegation: { applicationBound: true, nonReplacing: true, responseRecovery: false } }), reply({ schemaVersion: 1, serviceOrigin: origin })]) {
    const f = await fixture(t); let calls = 0;
    await assert.rejects(f.module.adoptHostCredential(origin, f.code, { fetch: async (_url, options) => {
      calls++; assert.equal(options.method, 'GET'); assert.equal(options.body, undefined); assert.equal(options.headers, undefined); return support;
    } }), { code: 'delegation_unavailable' });
    assert.equal(calls, 1);
    assert.equal((await readdir(f.path('.'))).some(name => name.startsWith('host-adoption-')), false);
    assert.deepEqual(await f.local.readHostHandle(), original);
  }
});
