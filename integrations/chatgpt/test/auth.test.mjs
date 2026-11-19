import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import { createOAuthVerifier, OAuthError, requireScopes } from '../auth.mjs';

const issuer = 'https://identity.example.test';
const resource = 'https://mcp.example.test/mcp';
const now = 1_800_000_000_000;
const keys = [
  { ...generateKeyPairSync('ed25519'), alg: 'EdDSA', kid: 'ed25519-one' },
  { ...generateKeyPairSync('ec', { namedCurve: 'P-256' }), alg: 'ES256', kid: 'p256-one' },
  { ...generateKeyPairSync('rsa', { modulusLength: 2048 }), alg: 'RS256', kid: 'rsa-one' },
];
const jwk = key => ({ ...key.publicKey.export({ format: 'jwk' }), kid: key.kid, alg: key.alg, use: 'sig' });
const baseClaims = { iss: issuer, aud: resource, sub: 'stable-user-123', exp: now / 1000 + 600, scope: 'applications:read events:subscribe' };
function token(claims = {}, key = keys[0], header = {}, rawPayload) {
  const parts = [
    Buffer.from(JSON.stringify({ alg: key.alg, kid: key.kid, typ: 'at+jwt', ...header })).toString('base64url'),
    Buffer.from(rawPayload ?? JSON.stringify({ ...baseClaims, ...claims })).toString('base64url'),
  ];
  const input = Buffer.from(parts.join('.'));
  const signature = sign(key.alg === 'EdDSA' ? null : 'sha256', input,
    key.alg === 'ES256' ? { key: key.privateKey, dsaEncoding: 'ieee-p1363' } : key.privateKey);
  return [...parts, signature.toString('base64url')].join('.');
}
const request = value => new Request(resource, { headers: { authorization: `Bearer ${value}` } });
function fixture(overrides = {}) {
  let calls = 0;
  let body = { keys: keys.map(jwk) };
  const verifier = createOAuthVerifier({
    issuer, resource, jwksUri: `${issuer}/keys`, clock: () => now,
    fetch: async (url, options) => {
      calls++;
      assert.equal(url, `${issuer}/keys`);
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.accept, 'application/json');
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    },
    ...overrides,
  });
  return { verifier, calls: () => calls, setBody: next => { body = next; } };
}

test('verifies the supported asymmetric algorithms without exposing tokens or peer grants', async () => {
  const { verifier } = fixture();
  for (const key of keys) {
    const principal = await verifier.authenticate(request(token({}, key)), { requiredScopes: ['applications:read'] });
    assert.deepEqual(principal, { id: baseClaims.sub, scopes: ['applications:read', 'events:subscribe'], issuer, expiresAt: baseClaims.exp * 1000 });
    assert.equal(principal.grants, undefined);
  }
});

test('publishes resource metadata and an actionable scope challenge', async () => {
  const { verifier } = fixture({ scopesSupported: ['applications:read'] });
  assert.deepEqual(verifier.metadata, { resource, authorization_servers: [issuer], scopes_supported: ['applications:read'], bearer_methods_supported: ['header'] });
  await assert.rejects(verifier.authenticate(new Request(resource), { requiredScopes: ['applications:read'] }), error => {
    assert.equal(error.status, 401);
    assert.match(error.challenge, /resource_metadata="https:\/\/mcp\.example\.test\/\.well-known\/oauth-protected-resource"/);
    assert.match(error.challenge, /scope="applications:read"/);
    return true;
  });
});

test('enforces audience, issuer, stable subject, expiry, not-before and issuance time', async () => {
  const { verifier } = fixture();
  for (const claims of [
    { iss: `${issuer}/` }, { aud: 'https://another.example.test' }, { aud: [resource, 1] },
    { sub: '' }, { sub: '   ' }, { exp: now / 1000 }, { exp: undefined }, { exp: '1800000600' },
    { nbf: now / 1000 + 1 }, { nbf: 'yesterday' }, { iat: now / 1000 + 1 },
  ]) {
    await assert.rejects(verifier.authenticate(request(token(claims))), error => error.code === 'invalid_token' && error.status === 401);
  }
  assert.equal((await verifier.authenticate(request(token({ aud: ['another-audience', resource], nbf: now / 1000 })))).id, baseClaims.sub);
});

test('rejects tampered signatures, unsigned/symmetric algorithms, embedded keys and critical headers', async () => {
  const { verifier } = fixture();
  const original = token();
  const [head, payload, signature] = original.split('.');
  const changed = `${head}.${Buffer.from(JSON.stringify({ ...baseClaims, sub: 'other-user' })).toString('base64url')}.${signature}`;
  await assert.rejects(verifier.authenticate(request(changed)), { code: 'invalid_token' });
  for (const header of [{ alg: 'none' }, { alg: 'HS256' }, { alg: 'RS256' }, { crit: ['aud'] }, { b64: true }, { jwk: jwk(keys[0]) }, { jku: `${issuer}/attacker` }, { x5u: `${issuer}/certificate` }, { typ: 'id_token' }, { kid: '' }]) {
    await assert.rejects(verifier.authenticate(request(token({}, keys[0], header))), { code: 'invalid_token' });
  }
});

test('rejects duplicate escaped members, invalid UTF-8, malformed JSON and oversized tokens', async () => {
  const { verifier } = fixture();
  for (const raw of [
    `{"iss":"wrong","iss":${JSON.stringify(issuer)}}`,
    `{"iss":"wrong","i\\u0073s":${JSON.stringify(issuer)}}`,
    '{"nested":{"x":1,"x":2}}', '[]', '{} trailing', '{"x":NaN}',
  ]) await assert.rejects(verifier.authenticate(request(token({}, keys[0], {}, raw))), { code: 'invalid_token' });
  const encoded = token().split('.');
  encoded[1] = Buffer.from([0xff]).toString('base64url');
  await assert.rejects(verifier.authenticate(request(encoded.join('.'))), { code: 'invalid_token' });
  await assert.rejects(verifier.authenticate(request('a'.repeat(20_000))), { code: 'invalid_token' });
  const duplicatedHeader = Buffer.from('{"alg":"none","alg":"EdDSA","kid":"ed25519-one"}').toString('base64url');
  await assert.rejects(verifier.authenticate(request(`${duplicatedHeader}.${encoded[1]}.${encoded[2]}`)), { code: 'invalid_token' });
});

test('rejects duplicate Authorization headers for both Fetch and Node requests', async () => {
  const { verifier } = fixture();
  const bearer = `Bearer ${token()}`;
  const headers = new Headers();
  headers.append('authorization', bearer); headers.append('authorization', bearer);
  await assert.rejects(verifier.authenticate({ headers }), { code: 'invalid_token' });
  await assert.rejects(verifier.authenticate({ headers: { authorization: bearer }, rawHeaders: ['Authorization', bearer, 'authorization', bearer] }), { code: 'invalid_token' });
  assert.equal((await verifier.authenticate({ headers: { Authorization: bearer } })).id, baseClaims.sub);
});

test('enforces OAuth scopes and rejects conflicting provider scope claims', async () => {
  const { verifier } = fixture();
  await assert.rejects(verifier.authenticate(request(token()), { requiredScopes: ['pages:publish'] }), error => error.status === 403 && error.code === 'insufficient_scope' && error.challenge.includes('pages:publish'));
  await assert.rejects(verifier.authenticate(request(token({ scp: ['pages:publish'] }))), { code: 'invalid_token' });
  await assert.rejects(verifier.authenticate(request(token({ scope: ['applications:read'] }))), { code: 'invalid_token' });
  const principal = await verifier.authenticate(request(token({ scope: undefined, scp: ['applications:read'] })));
  assert.deepEqual(principal.scopes, ['applications:read']);
  assert.throws(() => requireScopes(principal, ['events:subscribe']), { code: 'insufficient_scope' });
});

test('bounds cache lifetime and coalesces concurrent JWKS reads', async () => {
  let current = now;
  const f = fixture({ clock: () => current, cacheTtlMs: 10_000 });
  await Promise.all(Array.from({ length: 12 }, () => f.verifier.authenticate(request(token()))));
  assert.equal(f.calls(), 1);
  current += 9_000;
  await f.verifier.authenticate(request(token()));
  assert.equal(f.calls(), 1);
  current += 1_000;
  await f.verifier.authenticate(request(token()));
  assert.equal(f.calls(), 2);
});

test('refreshes unknown key IDs without turning attacker IDs into an unbounded fetch loop', async () => {
  let current = now;
  const f = fixture({ clock: () => current });
  f.setBody({ keys: [jwk(keys[0])] });
  await f.verifier.authenticate(request(token()));
  f.setBody({ keys: [jwk(keys[0]), jwk(keys[1])] });
  await assert.rejects(f.verifier.authenticate(request(token({}, keys[1]))), { code: 'invalid_token' });
  assert.equal(f.calls(), 1);
  current += 5_000;
  await f.verifier.authenticate(request(token({}, keys[1])));
  assert.equal(f.calls(), 2);
  for (let i = 0; i < 5; i++) await assert.rejects(f.verifier.authenticate(request(token({}, keys[0], { kid: `unknown-${i}` }))), { code: 'invalid_token' });
  assert.equal(f.calls(), 2);
});

test('fails closed on duplicate, private, incompatible or malformed JWKS keys', async () => {
  const badSets = [
    { keys: [jwk(keys[0]), jwk(keys[0])] },
    { keys: [{ ...jwk(keys[0]), d: 'private' }] },
    { keys: [{ ...jwk(keys[0]), alg: 'HS256' }] },
    { keys: [{ ...jwk(keys[0]), key_ops: ['sign', 'verify'] }] },
    { keys: [] }, { keys: Array.from({ length: 129 }, () => jwk(keys[0])) },
    '{"keys":[],"keys":[]}',
  ];
  for (const body of badSets) {
    const f = fixture(); f.setBody(body);
    await assert.rejects(f.verifier.authenticate(request(token())), error => error instanceof OAuthError && error.status === 503 && error.code === 'authorization_unavailable');
  }
});

test('rejects redirected, unavailable and excessive JWKS responses without logging secret material', async () => {
  for (const response of [new Response('{}', { status: 500 }), new Response('x'.repeat(1_048_577)), new Response('{}', { headers: { 'content-length': '1048577' } })]) {
    const f = fixture({ fetch: async () => response });
    await assert.rejects(f.verifier.authenticate(request(token())), error => error.code === 'authorization_unavailable' && !error.message.includes(token()));
  }
  const f = fixture({ fetch: async () => { throw new Error('private network details'); } });
  await assert.rejects(f.verifier.authenticate(request(token())), error => !error.message.includes('private network details'));
});

test('rejects unsafe configuration before accepting requests', () => {
  for (const overrides of [{ issuer: 'http://identity.test' }, { jwksUri: 'https://user:password@identity.test/jwks' }, { resource: 'https://mcp.test/#fragment' }, { algorithms: ['HS256'] }, { cacheTtlMs: Infinity }, { requestTimeoutMs: 0 }, { scopesSupported: ['bad scope'] }]) {
    assert.throws(() => fixture(overrides), TypeError);
  }
});
