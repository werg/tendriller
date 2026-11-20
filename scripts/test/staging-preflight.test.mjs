import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { transform } from 'esbuild';
import { CORE_RELEASE } from '../../contract/index.mjs';
import { preflightStaging, STAGING_ORIGIN } from '../staging-preflight.mjs';
import { runStagingAcceptance } from '../run-staging-acceptance.mjs';

const source = { build: { coreRelease: CORE_RELEASE, runtimeId: 'a'.repeat(64), sourceCommit: 'b'.repeat(40) } };
function host(mode = 'open', build = source.build) {
  const calls = [];
  return { calls, fetch: async (url, options) => {
    calls.push(url);
    assert.equal(options.method ?? 'GET', 'GET'); assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit'); assert.equal(options.body, undefined);
    if (url === STAGING_ORIGIN + '/api/service') return Response.json({ contract: 3, core_release: CORE_RELEASE, limits: {} });
    assert.equal(url, STAGING_ORIGIN + '/api/readiness');
    return Response.json({ schemaVersion: 1, serviceOrigin: STAGING_ORIGIN, environment: { id: STAGING_ORIGIN, kind: 'deployment', label: 'staging' },
      build, mode, creation: { available: mode === 'open', code: mode === 'open' ? null : mode === 'unavailable' ? 'unavailable' : 'creation_paused', message: mode, nextAction: 'Ask the operator to restore readiness.' },
      writes: { available: mode === 'open' || mode === 'creation_paused', code: mode === 'read_only' ? 'read_only' : mode === 'unavailable' ? 'unavailable' : null },
      readinessUrl: STAGING_ORIGIN + '/api/readiness', statusUrl: STAGING_ORIGIN + '/status', checkedAt: '2026-11-20T12:00:00Z' });
  } };
}

test('staging launch performs only read-only exact-source checks before starting any fixture', async () => {
  const remote = host(), signals = new EventEmitter(); let spawned = 0;
  const result = await runStagingAcceptance({ args: ['--grep', 'owner'], signals,
    preflight: () => preflightStaging({ source, fetch: remote.fetch }), spawn(_node, args) {
      assert.deepEqual(remote.calls, [STAGING_ORIGIN + '/api/readiness', STAGING_ORIGIN + '/api/service']);
      assert.deepEqual(args.slice(-2), ['--grep', 'owner']); spawned++;
      const child = new EventEmitter(); queueMicrotask(() => child.emit('exit', 0, null)); return child;
    } });
  assert.equal(result, 0); assert.equal(spawned, 1); assert.equal(signals.listenerCount('SIGTERM'), 0);
});

test('paused, read-only, unavailable and mismatched staging never spawn a fixture or mutate a mode', async () => {
  for (const [mode, build] of [['creation_paused', source.build], ['read_only', source.build], ['unavailable', source.build],
    ['open', { ...source.build, sourceCommit: 'c'.repeat(40) }]]) {
    const remote = host(mode, build); let spawned = false;
    await assert.rejects(runStagingAcceptance({ signals: new EventEmitter(), preflight: () => preflightStaging({ source, fetch: remote.fetch }),
      spawn() { spawned = true; throw Error('must not start'); } }));
    assert.equal(spawned, false); assert.deepEqual(remote.calls, [STAGING_ORIGIN + '/api/readiness']);
  }
});

test('staging signals stop only the running fixture and preserve its interrupted result', async () => {
  const signals = new EventEmitter(), child = new EventEmitter();
  child.kill = signal => child.emit('exit', null, signal);
  const result = runStagingAcceptance({ signals, preflight: async () => {}, spawn() { queueMicrotask(() => signals.emit('SIGTERM')); return child; } });
  assert.equal(await result, 143); assert.equal(signals.listenerCount('SIGTERM'), 0);
});

test('direct staging fixtures refuse account/session writes when readiness is blocked', async () => {
  const fixture = readFileSync(new URL('../../test/e2e/staging-session.ts', import.meta.url), 'utf8');
  const compiled = await transform(fixture.replace("'../../scripts/staging-preflight.mjs'", JSON.stringify(new URL('../staging-preflight.mjs', import.meta.url).href)), { loader: 'ts', format: 'esm' });
  const { stagingSession } = await import('data:text/javascript;base64,' + Buffer.from(compiled.code).toString('base64'));
  const writes = [];
  await assert.rejects(stagingSession({ preflight: async () => { throw Error('creation_paused'); }, write: sql => writes.push(sql) }), /creation_paused/);
  assert.deepEqual(writes, []);
  const order = [];
  const session = await stagingSession({ preflight: async () => { order.push('preflight'); }, write: sql => { order.push('write'); writes.push(sql); } });
  assert.deepEqual(order, ['preflight', 'write']); assert(writes[0].includes('INSERT INTO sessions'));
  session.close(); assert(writes[1].includes('DELETE FROM accounts'));
  assert(fixture.includes("'ACCOUNTS', '--remote'")); assert(!fixture.includes('s9-accounts'));
});

test('workflow gates dependency builds and runner has no service-mode mutation path', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/staging-acceptance.yml', import.meta.url), 'utf8');
  assert.match(workflow, /fixture:\s+needs: \[readiness\]/);
  assert(workflow.indexOf('--source-only --origin https://staging.tendriller.dev') < workflow.indexOf('repository: werg/chronolog-db'));
  const runner = readFileSync(new URL('../run-staging-acceptance.mjs', import.meta.url), 'utf8');
  assert(!runner.includes('UPDATE service_state')); assert(!runner.includes('d1'));
});
