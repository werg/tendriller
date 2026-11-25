import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CORE_RELEASE } from '../../contract/index.mjs';
import { preflightReviewDeployment, preflightReviewSource, reviewComposition, reviewProvenance, reviewSource } from '../review/preflight.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'review-composition-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'dist')); mkdirSync(join(root, 'test/artifacts'), { recursive: true });
  const source = { repository: 'werg/tendriller', source: 'a'.repeat(40), sourceTree: 'b'.repeat(40), dirty: false };
  const artifact = (role, file, value) => {
    const bytes = Buffer.from(value); writeFileSync(join(root, 'dist', file), bytes);
    return { role, file, size: bytes.length, sha256: hash(bytes) };
  };
  // These synthetic bytes test identity matching; package execution is qualified separately.
  const components = ['sdk', 'runtime', 'engine', 'tools', 'session', 'starter'].map(role => artifact(role, role + '.tgz', 'current-' + role));
  const body = { format: 'tendriller-release-composition-v1', version: '0.3.0-test', contract: 3, core: source,
    runtime: 'e'.repeat(64), chronolog: { session: { repository: 'werg/chronolog-db', source: 'c'.repeat(40), sourceTree: 'd'.repeat(40), dirty: false } }, components };
  const composition = { ...body, id: hash(JSON.stringify(body)) };
  const extras = [artifact('composition', 'composition.json', JSON.stringify(composition)), artifact('first-app', 'first-app.tgz', 'complete-kit')];
  const manifest = { format: 'tendriller-core-release', version: body.version, contract: 3, source_commit: source.source,
    source_tree: source.sourceTree, runtime: body.runtime, composition: { file: 'composition.json', id: composition.id },
    first_app: { file: 'first-app.tgz' }, artifacts: [...components, ...extras] };
  writeFileSync(join(root, 'dist/manifest.json'), JSON.stringify(manifest));
  writeFileSync(join(root, 'test/artifacts/current.tgz'), 'current-session');
  writeFileSync(join(root, 'test/artifacts/old.tgz'), 'old-session');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: body.version,
    devDependencies: { '@chronolog/peer-session': 'file:test/artifacts/current.tgz' } }));
  return { root, source, qualified: reviewComposition(root, { source }) };
}
function readiness(origin, composition, mode = 'open') {
  return { schemaVersion: 1, serviceOrigin: origin, environment: { id: origin, kind: 'deployment', label: 'test' },
    build: composition.build, mode,
    creation: { available: mode === 'open', code: mode === 'open' ? null : mode === 'unavailable' ? 'unavailable' : 'creation_paused',
      message: mode, nextAction: 'Check the selected service' },
    writes: { available: ['open', 'creation_paused'].includes(mode), code: mode === 'read_only' ? 'read_only' : mode === 'unavailable' ? 'unavailable' : null },
    checkedAt: '2026-11-20T12:00:00Z', readinessUrl: origin + '/api/readiness', statusUrl: origin + '/status' };
}
function host(origin, document, { status = 200, serviceRelease = document.build.coreRelease } = {}) {
  const calls = [];
  return { calls, fetch: async (url, options) => {
    calls.push({ url, options });
    assert.equal(new URL(url).origin, origin);
    assert.equal(options.redirect, 'error');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.method ?? 'GET', 'GET');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.body, undefined);
    assert.equal(options.headers?.Authorization, undefined);
    if (url === origin + '/api/readiness') return Response.json(document, { status });
    assert.equal(url, origin + '/api/service');
    return Response.json({ contract: 3, core_release: serviceRelease, limits: {} });
  } };
}

test('review composition selects exact current SDK/session bytes and publishes only safe identities', t => {
  const { root, qualified } = fixture(t);
  assert.equal(qualified.packagePaths.session, join(root, 'dist/session.tgz'));
  assert.equal(qualified.session.sha256, hash('current-session'));
  const proof = reviewProvenance(qualified, readiness('https://selected.example', qualified));
  assert.equal(proof.sessionArtifact.sourceCommit, 'c'.repeat(40));
  assert.equal(proof.compositionId, qualified.build.compositionId);
  assert(!JSON.stringify(proof).includes(root), 'Public evidence must omit private filesystem paths');
});

test('same-version old session pins, altered archives and stale source checkpoints fail before networking', t => {
  const { root, source } = fixture(t);
  const pin = join(root, 'test/artifacts/current.tgz');
  writeFileSync(pin, 'old-session');
  assert.throws(() => reviewComposition(root, { source }), /different session/);
  writeFileSync(pin, 'current-session');
  writeFileSync(join(root, 'dist/sdk.tgz'), 'altered-sdk');
  assert.throws(() => reviewComposition(root, { source }), /artifact (size|digest) mismatch/);
  assert.throws(() => reviewComposition(root, { source: { ...source, source: 'f'.repeat(40) } }), /source checkpoint/);
  assert.throws(() => reviewComposition(root, { source: { ...source, dirty: true } }), /clean source/);
});

test('composition digest and unsafe artifact paths are rejected independently of package names', t => {
  const { root, source } = fixture(t), compositionPath = join(root, 'dist/composition.json');
  const saved = readFileSync(compositionPath);
  const changed = JSON.parse(saved); changed.runtime = 'f'.repeat(64);
  writeFileSync(compositionPath, JSON.stringify(changed));
  assert.throws(() => reviewComposition(root, { source }), /Composition digest mismatch/);
  writeFileSync(compositionPath, saved);
  const manifestPath = join(root, 'dist/manifest.json'), manifest = JSON.parse(readFileSync(manifestPath));
  manifest.artifacts[0].file = '../outside.tgz'; writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.throws(() => reviewComposition(root, { source }), /Unsafe release artifact path/);
});

test('live review preflight uses only same-origin anonymous reads and requires complete deployed identity', async t => {
  const { qualified } = fixture(t), origin = 'https://selected.example';
  const document = readiness(origin, qualified), service = host(origin, document);
  assert.deepEqual(await preflightReviewDeployment(origin, qualified, service), document);
  assert.deepEqual(service.calls.map(call => call.url), [origin + '/api/readiness', origin + '/api/service']);
  for (const key of ['coreRelease', 'runtimeId', 'sourceCommit', 'compositionId']) {
    const mismatched = { ...document, build: { ...document.build, [key]: key === 'coreRelease' ? 'older-release' : null } };
    await assert.rejects(preflightReviewDeployment(origin, qualified, host(origin, mismatched)));
  }
  await assert.rejects(preflightReviewDeployment(origin, qualified, host(origin, document, { serviceRelease: 'older-release' })), /descriptor release mismatch/);
});

test('missing, unavailable, redirected and wrong-origin readiness cannot advance to credential renewal', async t => {
  const { qualified } = fixture(t), origin = 'https://selected.example';
  const wrong = readiness('https://another.example', qualified);
  const attempts = [
    host(origin, wrong).fetch,
    host(origin, readiness(origin, qualified, 'unavailable'), { status: 503 }).fetch,
    async () => new Response('missing', { status: 404 }),
    async () => new Response(null, { status: 302, headers: { Location: 'https://another.example/api/readiness' } }),
    async () => new Response('{bad json'),
    async () => { throw Error('network unavailable'); },
  ];
  for (const fetch of attempts) {
    let renewals = 0;
    await assert.rejects((async () => { await preflightReviewDeployment(origin, qualified, { fetch }); renewals++; })());
    assert.equal(renewals, 0);
  }
});

test('paused staging and production never authorize credential renewal, a fixture or a mode override', async t => {
  const { qualified } = fixture(t), staging = 'https://staging.tendriller.dev';
  for (const [origin, mode] of [[staging, 'creation_paused'], ['https://tendriller.dev', 'creation_paused'], ['https://custom.example', 'creation_paused'], [staging, 'read_only']]) {
    const service = host(origin, readiness(origin, qualified, mode));
    let mutations = 0;
    await assert.rejects((async () => {
      await preflightReviewDeployment(origin, qualified, service); mutations++;
    })(), error => error.code === 'creation_paused');
    assert.equal(mutations, 0);
    assert.deepEqual(service.calls.map(call => call.url), [origin + '/api/readiness']);
  }
});

test('early readiness checks need no packages or private access and remain distinct from full composition evidence', async t => {
  const { root, source } = fixture(t);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: CORE_RELEASE }));
  // No build output is needed: the exact source commit determines the runtime.
  const snapshot = reviewSource(root, { source });
  assert.equal(snapshot.build.compositionId, undefined);
  assert.equal(snapshot.build.runtimeId, undefined);
  assert.equal(snapshot.packagePaths, undefined);
  const origin = 'https://selected.example', document = readiness(origin, { build: { ...snapshot.build, runtimeId: 'e'.repeat(64), compositionId: 'c'.repeat(64) } });
  assert.deepEqual(await preflightReviewSource(origin, snapshot, host(origin, document)), document);
  let installs = 0;
  await assert.rejects((async () => {
    await preflightReviewSource(origin, snapshot, host(origin, { ...document, build: { ...document.build, sourceCommit: 'f'.repeat(40) } }));
    installs++;
  })(), /identity mismatch/);
  assert.equal(installs, 0);
  assert.throws(() => reviewSource(root, { source: { ...source, dirty: true } }), /clean source/);
});
