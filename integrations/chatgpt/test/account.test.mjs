import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createTendrillerAccountAdapter } from '../account.mjs';

const HOST = 'https://accounts.tendriller.example', RESOURCE = 'https://assistant.example/mcp', APP = 'a'.repeat(64);
const SECRET = 'private-bridge-secret-'.padEnd(43, 's');
const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'test-key', use: 'sig', alg: 'ES256' };
function fixture() {
  const now = Date.now(), state = { active: true, access: true, owner: true, grant: true, mismatched: false, oversized: false, outage: false };
  const calls = [], scopes = ['applications:read', 'applications:write', 'events:subscribe'];
  const claims = { sub: 'account-1', iss: HOST, aud: RESOURCE, iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 300, scope: scopes.join(' '), sid: 'grant-1' };
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'at+jwt', kid: jwk.kid })).toString('base64url');
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const token = `${header}.${body}.${sign('sha256', Buffer.from(`${header}.${body}`), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
  const fetch = async (url, options) => {
    assert.equal(new URL(url).origin, HOST); assert.equal(options.redirect, 'error');
    if (new URL(url).pathname === '/oauth/jwks') return Response.json({ keys: [jwk] });
    assert.equal(options.headers.Authorization, `Bearer ${SECRET}`);
    if (state.outage) throw Error('Private connection detail');
    const value = options.headers['Content-Type'] === 'application/json' ? JSON.parse(options.body) : Object.fromEntries(options.body);
    calls.push({ path: new URL(url).pathname, value });
    if (state.oversized) return Response.json({ padding: 'x'.repeat(40000) });
    if (new URL(url).pathname === '/oauth/introspect') {
      assert.equal(value.token, token);
      return Response.json(state.grant ? { active: true, ...claims, client_id: 'chatgpt-client' } : { active: false });
    }
    assert.equal(new URL(url).pathname, '/oauth/account-access');
    return Response.json({ active: state.active, access: state.access, owner: state.owner,
      oauthAuthorized: state.grant && value.grantId === claims.sid, scopes,
      account: state.active ? { id: state.mismatched ? 'wrong' : claims.sub, issuer: HOST, email: 'verified@example.test' } : undefined,
      ...(value.applicationId ? { applicationId: value.applicationId, pageId: value.pageId } : {}),
    });
  };
  const config = { origin: HOST, resource: RESOURCE, bridgeId: 'bridge-1', bridgeSecret: SECRET, fetch, clock: () => now,
    applications: [{ id: APP, pageId: 'actual-page', label: 'Kitchen', allowedQueries: ['kitchenContext'],
      allowedCommands: ['replyToAssistance'], allowedEvents: ['assistant.help_requested'], allowEventDetails: true }] };
  const adapter = createTendrillerAccountAdapter(config);
  const request = () => new Request(RESOURCE, { headers: { Authorization: `Bearer ${token}` } });
  return { adapter, state, calls, config, request, token, scopes };
}

test('host adapter cryptographically verifies then introspects tokens and binds access to the exact current grant', async () => {
  const f = fixture(), principal = await f.adapter.auth.authenticate(f.request());
  assert.equal(principal.id, 'account-1'); assert.equal(principal.oauthGrantId, 'grant-1');
  assert.equal(await f.adapter.authorizeAccountAccess(principal, APP), true);
  assert.deepEqual(f.calls.at(-1).value, { issuer: HOST, subject: 'account-1', applicationId: APP, pageId: 'actual-page', grantId: 'grant-1' });
  assert.equal(await f.adapter.authorizeAccountAccess({ id: principal.id, issuer: HOST }, APP), false);
  assert.equal(await f.adapter.authorizeAccountAccess({ ...principal, oauthGrantId: 'another-grant' }, APP), false);
  f.state.grant = false;
  assert.equal(await f.adapter.authorizeAccountAccess(principal, APP), false);
  await assert.rejects(f.adapter.auth.authenticate(f.request()), { code: 'invalid_token' });
  assert.equal(JSON.stringify(principal).includes(f.token), false);
});

test('management ownership comes from current host page policy and exact configured mappings', async () => {
  const f = fixture(), browser = { id: 'account-1', issuer: HOST };
  assert.equal(await f.adapter.authorizeOwner(browser, APP), true);
  assert.equal((await f.adapter.applicationsForPrincipal(browser))[0].applicationId, APP);
  f.state.owner = false;
  assert.equal(await f.adapter.authorizeOwner(browser, APP), false);
  assert.deepEqual(await f.adapter.applicationsForPrincipal(browser), []);
  const calls = f.calls.length;
  assert.equal(await f.adapter.authorizeOwner({ ...browser, issuer: 'https://other.example' }, APP), false);
  assert.equal(await f.adapter.authorizeOwner(browser, 'b'.repeat(64)), false);
  assert.equal(f.calls.length, calls);
  f.state.active = false;
  assert.equal(await f.adapter.authorizeOwner(browser, APP), false);
});

test('host verification outages and malformed results fail closed without converting them into account revocation', async () => {
  const f = fixture(), principal = await f.adapter.auth.authenticate(f.request());
  f.state.outage = true;
  await assert.rejects(f.adapter.authorizeAccountAccess(principal, APP), error => error.status === 503 && !error.message.includes(SECRET));
  f.state.outage = false; f.state.mismatched = true;
  await assert.rejects(f.adapter.authorizeAccountAccess(principal, APP), { code: 'HOST_ACCOUNT_RESPONSE_INVALID' });
  f.state.mismatched = false; f.state.oversized = true;
  await assert.rejects(f.adapter.authorizeAccountAccess(principal, APP), { code: 'HOST_ACCOUNT_RESPONSE_INVALID' });
  f.state.oversized = false;
  assert.equal(await f.adapter.ownerEmailForPrincipal(principal), 'verified@example.test');
  assert.equal(await f.adapter.ownerEmailForPrincipal({ id: principal.id, issuer: HOST }), null);
});

test('host adapter validates deployment settings and propagates request cancellation', async () => {
  const f = fixture();
  for (const value of [{ origin: 'http://accounts.example' }, { bridgeSecret: 'short' }, { applications: [{ id: APP }] }, { requestTimeoutMs: 0 }])
    assert.throws(() => createTendrillerAccountAdapter({ ...f.config, ...value }), { code: 'HOST_ACCOUNT_CONFIGURATION_INVALID' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.adapter.authorizeOwner({ id: 'account-1', issuer: HOST, requestSignal: controller.signal }, APP), { name: 'AbortError' });
});
