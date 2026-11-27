import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adminOrigin, adminRequest, generateCredentialFiles, parseAdminArgs, runAdmin } from '../admin.mjs';

const NOW = Date.parse('2026-11-27T12:00:00Z');
const ID = '9fedfdd7-780d-4006-87bd-7c793ead44e5';
const TOKEN = 'td_admin_' + 'ab'.repeat(32);

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'tendriller-admin-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tokenFile = join(root, 'operator.token'), configFile = join(root, 'operator.credentials.json');
  return { root, tokenFile, configFile };
}
function tokenFixture(t) {
  const result = fixture(t);
  writeFileSync(result.tokenFile, TOKEN + '\n', { mode: 0o600 });
  return result;
}
function captured() {
  const out = [], err = [];
  return { out, err, stdout: text => out.push(text), stderr: text => err.push(text) };
}

test('credential generation creates private separate files with hash-only config and bounded lifetime', async t => {
  const { tokenFile, configFile } = fixture(t);
  const output = captured();
  assert.equal(await runAdmin(['generate-credential', '--id', 'test-operator', '--scopes', 'analytics:read,premium:write',
    '--expires-in-days', '90', '--token-file', tokenFile, '--config-file', configFile], { ...output, now: NOW }), 0);
  const token = readFileSync(tokenFile, 'utf8').trim();
  assert.match(token, /^td_admin_[a-f0-9]{64}$/);
  const [record] = JSON.parse(readFileSync(configFile, 'utf8'));
  assert.deepEqual(record, {
    id: 'test-operator', sha256: createHash('sha256').update(token).digest('hex'),
    scopes: ['analytics:read', 'premium:write'], issuedAt: NOW, expiresAt: NOW + 90 * 86_400_000,
  });
  if (process.platform !== 'win32') {
    assert.equal(statSync(tokenFile).mode & 0o777, 0o600);
    assert.equal(statSync(configFile).mode & 0o777, 0o600);
  }
  assert(!readFileSync(configFile, 'utf8').includes(token));
  assert(!output.out.join('').includes(token));
  assert.equal(output.err.length, 0);
});

test('generation refuses existing files and symlinks without overwriting targets or leaving a second credential', async t => {
  const { root, tokenFile, configFile } = fixture(t);
  const options = { id: 'test-operator', scopes: ['analytics:read'], tokenFile, configFile };
  writeFileSync(configFile, 'existing');
  await assert.rejects(generateCredentialFiles(options, { now: NOW }), /new writable paths/);
  assert.equal(readFileSync(configFile, 'utf8'), 'existing');
  assert(!existsSync(tokenFile));
  rmSync(configFile);
  const target = join(root, 'target');
  writeFileSync(target, 'unchanged');
  symlinkSync(target, tokenFile);
  await assert.rejects(generateCredentialFiles(options, { now: NOW }), /new writable paths/);
  assert.equal(readFileSync(target, 'utf8'), 'unchanged');
  assert(!existsSync(configFile));
});

test('invalid scope, identity, lifetime and duplicate output paths cannot generate credentials', async t => {
  const { tokenFile, configFile } = fixture(t);
  const valid = { id: 'operator', scopes: ['analytics:read'], tokenFile, configFile };
  for (const changes of [
    { id: 'root@example.com' }, { scopes: [] }, { scopes: ['admin:*'] }, { scopes: ['analytics:read', 'analytics:read'] },
    { expiresInDays: 0 }, { expiresInDays: 91 }, { expiresInDays: 1.5 }, { configFile: tokenFile },
  ]) await assert.rejects(generateCredentialFiles({ ...valid, ...changes }, { now: NOW }));
  assert(!existsSync(tokenFile));
  assert(!existsSync(configFile));
});

test('CLI never accepts tokens on argv or silently ignores unknown, duplicate and positional arguments', () => {
  for (const args of [
    ['grant', '--token', TOKEN], ['grants', '--server', 'https://host.example', '--server', 'https://other.example'],
    ['analytics', '--from'], ['analytics', '2026-11-20'], ['audit', '--help', '--server', 'https://host.example'],
    ['constructor'], ['grant', '--id=' + ID],
  ]) assert.throws(() => parseAdminArgs(args));
  assert.equal(parseAdminArgs(['grant', '--help']).command, 'help');
});

test('origin validation prevents accidental HTTP credentials, credentials in URLs and off-origin paths', () => {
  assert.equal(adminOrigin('https://service.example/'), 'https://service.example');
  for (const value of ['http://localhost:8790', 'http://127.0.0.1:8790', 'http://[::1]:8790']) assert.equal(adminOrigin(value), value);
  for (const value of [
    'http://service.example', 'http://localhost.example', 'https://operator:secret@service.example',
    'https://service.example/api', 'https://service.example?next=evil', 'https://service.example#fragment',
    'file:///tmp/key', 'https://service.example\\@evil.example',
  ]) assert.throws(() => adminOrigin(value));
});

test('grant sends a retained operation UUID and exact body once, without cookies or credential redirects', async t => {
  const { tokenFile } = tokenFixture(t), output = captured(), calls = [];
  const argv = ['grant', '--server', 'https://service.example', '--token-file', tokenFile, '--id', ID,
    '--account-id', 'account-123', '--plan', 'pro', '--expires-at', '2026-12-27T12:00:00Z', '--reason', 'Manual test'];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.headers.Authorization, 'Bearer ' + TOKEN);
    assert.equal(options.headers.Cookie, undefined);
    assert.equal(options.method, 'POST');
    assert(options.signal instanceof AbortSignal);
    return Response.json({ grant: { id: ID } }, { status: 201 });
  };
  assert.equal(await runAdmin(argv, { ...output, fetchImpl, now: NOW }), 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://service.example/api/admin/v1/premium-grants');
  assert.deepEqual(JSON.parse(calls[0].options.body), { id: ID, accountId: 'account-123', plan: 'pro', expiresAt: Date.parse('2026-12-27T12:00:00Z'), reason: 'Manual test' });
  assert(!output.out.join('').includes(TOKEN));
});

test('read APIs encode bounded parameters and revoke uses only the named grant', async t => {
  const { tokenFile } = tokenFixture(t), output = captured(), calls = [];
  const common = ['--server', 'https://service.example', '--token-file', tokenFile];
  const fetchImpl = async (url, options) => { calls.push({ url, options }); return Response.json({ ok: true }); };
  for (const args of [
    ['grants', ...common, '--account-id', 'account-123', '--before', 'opaque+/=cursor', '--limit', '20'],
    ['analytics', ...common, '--from', '2026-11-01', '--to', '2026-11-27'],
    ['audit', ...common, '--limit', '10'],
    ['revoke', ...common, '--id', ID, '--reason', 'Testing complete'],
  ]) assert.equal(await runAdmin(args, { ...output, fetchImpl, now: NOW }), 0);
  assert.equal(new URL(calls[0].url).searchParams.get('before'), 'opaque+/=cursor');
  assert.equal(new URL(calls[1].url).pathname, '/api/admin/v1/analytics');
  assert.equal(new URL(calls[2].url).pathname, '/api/admin/v1/audit');
  assert.equal(new URL(calls[3].url).pathname, `/api/admin/v1/premium-grants/${ID}/revoke`);
  assert.deepEqual(JSON.parse(calls[3].options.body), { reason: 'Testing complete' });
});

test('invalid commands fail before credential reads or network traffic', async () => {
  const common = ['--server', 'https://service.example', '--token-file', '/does/not/exist'];
  const grant = ['grant', ...common, '--id', ID, '--account-id', 'account-123', '--plan', 'pro', '--reason', 'Testing'];
  const output = captured();
  for (const args of [
    [...grant, '--expires-at', '2026-02-30T00:00:00Z'], [...grant, '--expires-at', '2026-12-27'],
    ['analytics', ...common, '--from', '2026-02-30', '--to', '2026-11-27'],
    ['analytics', ...common, '--from', '2026-11-27', '--to', '2026-11-01'],
    ['audit', ...common, '--limit', '101'], ['grants', ...common],
  ]) {
    assert.equal(await runAdmin(args, { ...output, now: NOW, fetchImpl: () => assert.fail('Must not fetch') }), 1);
  }
  assert(!output.err.join('').includes('Cannot read'));
});

test('unsafe token files are rejected without a request', async t => {
  const { root, tokenFile } = tokenFixture(t);
  const request = path => adminRequest({ server: 'https://service.example', tokenFile: path, path: '/api/admin/v1/audit' }, { fetchImpl: () => assert.fail('Must not fetch') });
  const linked = join(root, 'linked.token');
  symlinkSync(tokenFile, linked);
  await assert.rejects(request(linked), /private regular file/);
  await assert.rejects(request(root), /private regular file/);
  if (process.platform !== 'win32') {
    chmodSync(tokenFile, 0o644);
    await assert.rejects(request(tokenFile), /private regular file/);
    chmodSync(tokenFile, 0o600);
  }
  for (const content of ['invalid', TOKEN + '\nextra', TOKEN + ' '.repeat(2048)]) {
    writeFileSync(tokenFile, content);
    await assert.rejects(request(tokenFile), /private regular file/);
  }
});

test('redirects, network errors, oversized responses and timeouts fail without retrying or exposing credentials', async t => {
  const { tokenFile } = tokenFixture(t);
  const request = { server: 'https://service.example', tokenFile, path: '/api/admin/v1/audit' };
  for (const fetchImpl of [
    async () => new Response(null, { status: 302, headers: { Location: 'https://other.example' } }),
    async () => { throw new Error(TOKEN); },
    async () => new Response('x'.repeat(1024 * 1024 + 1)),
    async () => new Response('<html>Sign in</html>'),
  ]) {
    let calls = 0;
    await assert.rejects(adminRequest(request, { fetchImpl: (...args) => { calls++; return fetchImpl(...args); } }), error => !error.message.includes(TOKEN));
    assert.equal(calls, 1);
  }
  let signal;
  await assert.rejects(adminRequest(request, { timeoutMs: 10, fetchImpl: async (_url, options) => {
    signal = options.signal;
    return await new Promise(() => {});
  } }), /timed out/);
  assert.equal(signal.aborted, true);
});

test('API error responses exit nonzero and reflected credentials are redacted', async t => {
  const { tokenFile } = tokenFixture(t), output = captured();
  assert.equal(await runAdmin(['audit', '--server', 'https://service.example', '--token-file', tokenFile], {
    ...output, fetchImpl: async () => Response.json({ error: { code: 'forbidden', message: TOKEN } }, { status: 403 }),
  }), 1);
  assert.equal(output.out.length, 0);
  assert(output.err.join('').includes('forbidden'));
  assert(output.err.join('').includes('[redacted]'));
  assert(!output.err.join('').includes(TOKEN));
});

test('an expired grant timestamp can be retried unchanged to retrieve its original result', async t => {
  const { tokenFile } = tokenFixture(t), output = captured();
  const expiresAt = '2026-11-20T00:00:00Z';
  assert.equal(await runAdmin(['grant', '--server', 'https://service.example', '--token-file', tokenFile, '--id', ID,
    '--account-id', 'account-123', '--plan', 'pro', '--expires-at', expiresAt, '--reason', 'Manual test'], {
    ...output, now: NOW, fetchImpl: async (_url, options) => {
      assert.equal(JSON.parse(options.body).expiresAt, Date.parse(expiresAt));
      return Response.json({ grant: { id: ID, expiresAt: Date.parse(expiresAt) }, created: false });
    },
  }), 0);
});

test('the request deadline also bounds a stalled response body and aborts its reader', async t => {
  const { tokenFile } = tokenFixture(t);
  let aborted = false;
  await assert.rejects(adminRequest({ server: 'https://service.example', tokenFile, path: '/api/admin/v1/audit' }, {
    timeoutMs: 10,
    fetchImpl: async (_url, options) => new Response(new ReadableStream({ start(controller) {
      options.signal.addEventListener('abort', () => { aborted = true; controller.error(new Error(TOKEN)); }, { once: true });
    } })),
  }), error => /timed out/.test(error.message) && !error.message.includes(TOKEN));
  assert(aborted);
});
