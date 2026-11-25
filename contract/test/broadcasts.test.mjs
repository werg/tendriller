import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalizeBroadcastPayload,
  compareSemver,
  evaluateBroadcastMatch,
  generateBroadcastKeyPair,
  matchesBroadcast,
  satisfiesVersionConstraint,
  signBroadcastPayload,
  validateBroadcastInput,
  validateClientVersions,
  verifyBroadcastSignature,
} from '../broadcasts.mjs';

test('Ed25519 broadcast signing and verification succeeds and rejects tampering, wrong issuer, or unknown key', async () => {
  const { kid, publicJwk, privateJwk } = await generateBroadcastKeyPair();
  const payload = {
    schema_version: 1,
    id: 'bc_' + 'a'.repeat(26),
    seq: 1,
    issuer: 'https://tendriller.dev',
    kind: 'upgrade',
    severity: 'urgent',
    audiences: ['agents', 'dashboard'],
    title: 'Upgrade @chronolog/peer-session',
    summary: 'Upgrade to 0.5.0 for the relay fix.',
    body: 'Run npm install with the updated kit.',
    docs_url: 'https://tendriller.dev/docs/RELEASE_COMPOSITION.md',
    action: { kind: 'upgrade_dependencies', packages: { '@chronolog/peer-session': '>=0.5.0' }, requires_republish: true },
    match: { packages: { '@chronolog/peer-session': '<0.5.0' } },
    dismissible: true,
    created_at: 1764000000000,
    expires_at: null,
    superseded_by: null,
  };
  const signed = await signBroadcastPayload(payload, privateJwk);
  assert.equal(signed.signature.alg, 'Ed25519');
  assert.equal(signed.signature.kid, kid);

  const ok = await verifyBroadcastSignature(signed, [publicJwk], { issuer: 'https://tendriller.dev' });
  assert.deepEqual(ok, { valid: true, kid });

  // Key order inside payload must not matter because canonicalization sorts keys.
  const reordered = { payload: { ...payload, title: payload.title }, signature: signed.signature };
  assert.equal(canonicalizeBroadcastPayload(payload), canonicalizeBroadcastPayload(reordered.payload));
  assert.equal((await verifyBroadcastSignature(reordered, [publicJwk], { issuer: 'https://tendriller.dev' })).valid, true);

  // Tampered payload fails verification.
  const tampered = { payload: { ...payload, title: 'Tampered' }, signature: signed.signature };
  const bad = await verifyBroadcastSignature(tampered, [publicJwk], { issuer: 'https://tendriller.dev' });
  assert.equal(bad.valid, false);
  assert.equal(bad.reason, 'signature_mismatch');

  // Wrong issuer fails verification.
  const wrongIssuer = await verifyBroadcastSignature(signed, [publicJwk], { issuer: 'https://staging.tendriller.dev' });
  assert.equal(wrongIssuer.valid, false);
  assert.equal(wrongIssuer.reason, 'issuer_mismatch');

  // Unknown key fails verification.
  const other = await generateBroadcastKeyPair();
  const wrongKey = await verifyBroadcastSignature(signed, [other.publicJwk], { issuer: 'https://tendriller.dev' });
  assert.equal(wrongKey.valid, false);
  assert.equal(wrongKey.reason, 'unknown_key_id');
});

test('semver comparisons and version constraints handle prereleases and compound ranges', () => {
  assert.equal(compareSemver('0.3.0-rc.17', '0.3.0-rc.18'), -1);
  assert.equal(compareSemver('0.3.0-rc.17', '0.3.0'), -1);
  assert.equal(compareSemver('0.4.0', '0.3.9'), 1);
  assert.equal(satisfiesVersionConstraint('0.3.0-rc.17', '<0.3.1'), true);
  assert.equal(satisfiesVersionConstraint('0.3.1', '<0.3.1'), false);
  assert.equal(satisfiesVersionConstraint('0.4.2', '>=0.4.0 <0.5.0'), true);
  assert.equal(satisfiesVersionConstraint('0.5.0', '>=0.4.0 <0.5.0'), false);
});

test('evaluateBroadcastMatch filters by audience, packages, runtime ids, published_before, agentless_only, and expiry', () => {
  const base = {
    schema_version: 1,
    id: 'bc_' + 'b'.repeat(26),
    seq: 2,
    issuer: 'https://tendriller.dev',
    kind: 'security',
    severity: 'critical',
    audiences: ['agents', 'page_owners'],
    title: 'Security fix',
    summary: 'Republish older pages.',
    body: '',
    docs_url: null,
    action: null,
    match: {
      packages: { '@chronolog/peer-session': '<0.5.0' },
    },
    dismissible: false,
    created_at: 1000,
    expires_at: 5000,
    superseded_by: null,
  };

  assert.equal(matchesBroadcast(base, { audience: 'agents', versions: { chronolog: '0.4.9' }, now: 2000 }), true);
  assert.equal(matchesBroadcast(base, { audience: 'agents', versions: { chronolog: '0.5.0' }, now: 2000 }), false);
  assert.equal(matchesBroadcast(base, { audience: 'page_all', versions: { chronolog: '0.4.9' }, now: 2000 }), false);
  assert.equal(matchesBroadcast(base, { audience: 'agents', versions: { chronolog: '0.4.9' }, now: 6000 }), false);

  const pageNotice = {
    ...base,
    audiences: ['page_owners'],
    match: {
      runtime_id_not_in: ['f'.repeat(64)],
      agentless_only: true,
      published_before: 3000,
    },
  };
  assert.equal(evaluateBroadcastMatch(pageNotice, {
    audience: 'page_owners',
    runtimeId: 'a'.repeat(64),
    publishedAt: 2000,
    activeAgents: 0,
    now: 2500,
  }).matched, true);
  assert.equal(evaluateBroadcastMatch(pageNotice, {
    audience: 'page_owners',
    runtimeId: 'a'.repeat(64),
    publishedAt: 2000,
    activeAgents: 1,
    now: 2500,
  }).matched, false);
  assert.equal(evaluateBroadcastMatch(pageNotice, {
    audience: 'page_owners',
    runtimeId: 'f'.repeat(64),
    publishedAt: 2000,
    activeAgents: 0,
    now: 2500,
  }).matched, false);
});

test('validateBroadcastInput and validateClientVersions reject malformed fields', () => {
  const valid = validateBroadcastInput({
    kind: 'upgrade',
    severity: 'recommended',
    audiences: ['agents', 'dashboard'],
    title: 'Upgrade kit',
    summary: 'New release available.',
    docs_url: 'https://tendriller.dev/docs/RELEASE_COMPOSITION.md',
    match: { packages: { '@tendriller/core': '<0.4.0' } },
    action: { kind: 'upgrade_dependencies', requires_republish: true },
  });
  assert.deepEqual(valid.audiences, ['agents', 'dashboard']);
  assert.throws(() => validateBroadcastInput({ kind: 'bogus', severity: 'info', audiences: ['agents'], title: 'x', summary: 'y' }));
  assert.throws(() => validateBroadcastInput({ kind: 'upgrade', severity: 'info', audiences: ['agents'], title: 'x', summary: 'y', docs_url: 'javascript:alert(1)' }));

  const v = validateClientVersions({ core: '0.3.0-rc.17', chronolog: '0.4.1', packages: { '@tendriller/core': '0.3.0-rc.17' } });
  assert.equal(v.core, '0.3.0-rc.17');
  assert.throws(() => validateClientVersions({ core: 'invalid version with spaces!' }));
});
