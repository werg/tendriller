import test from 'node:test';
import assert from 'node:assert/strict';
import { createPage, describeService, describeReadiness, requireCreationReady, requireServiceOrigin } from '../client.mjs';

const origin = 'https://staging.example.test';
const readiness = (mode = 'open') => ({ schemaVersion: 1, serviceOrigin: origin,
  environment: { id: origin, label: 'staging.example.test', kind: 'deployment' },
  build: { coreRelease: 'test', runtimeId: 'a'.repeat(64), sourceCommit: null }, mode,
  creation: { available: mode === 'open', code: mode === 'open' ? null : mode === 'unavailable' ? 'unavailable' : 'creation_paused',
    message: mode === 'open' ? 'Creation is open.' : 'Creation is unavailable.', nextAction: 'Check the selected service status; do not change origins.' },
  writes: { available: mode === 'open' || mode === 'creation_paused', code: mode === 'read_only' ? 'read_only' : mode === 'unavailable' ? 'unavailable' : null },
  readinessUrl: origin + '/api/readiness', statusUrl: origin + '/status', checkedAt: new Date().toISOString(),
});

test('readiness is anonymous, uncached, and bound to the selected service', async () => {
  const calls = [], signal = new AbortController().signal;
  const value = await describeReadiness(origin, { signal, fetch: async (...args) => { calls.push(args); return Response.json(readiness()); } });
  assert.equal(requireCreationReady(value, { service: origin }), value);
  assert.deepEqual(calls, [[origin + '/api/readiness', { signal, redirect: 'error', cache: 'no-store' }]]);
  await assert.rejects(describeReadiness(origin, { fetch: async () => Response.json({ ...readiness(), serviceOrigin: 'https://production.example.test' }) }), { code: 'service_origin_mismatch' });
  assert.throws(() => requireCreationReady(value, { service: 'https://other.example.test' }), { code: 'service_origin_mismatch' });
});

test('every non-open mode blocks creation without choosing a different origin', async () => {
  for (const mode of ['creation_paused', 'read_only', 'unavailable']) {
    const value = await describeReadiness(origin, { fetch: async () => Response.json(readiness(mode), { status: mode === 'unavailable' ? 503 : 200 }) });
    assert.throws(() => requireCreationReady(value), error => error.status === 503 && error.code === value.creation.code && /do not change origins/.test(error.message));
  }
  await assert.rejects(describeReadiness(origin, { fetch: async () => Response.json({ ...readiness('read_only'), creation: readiness().creation }) }), { code: 'readiness_invalid' });
});

test('missing, malformed, failing, or redirected readiness never authorizes creation', async () => {
  await assert.rejects(describeReadiness(origin, { fetch: async () => new Response('missing', { status: 404 }) }), { code: 'readiness_unsupported' });
  await assert.rejects(describeReadiness(origin, { fetch: async () => new Response('<html>sign in</html>') }), { code: 'readiness_invalid' });
  await assert.rejects(describeReadiness(origin, { fetch: async () => Response.json({ error: 'broken' }, { status: 500 }) }), { code: 'readiness_unavailable' });
  const failure = Error('redirect refused');
  await assert.rejects(describeReadiness(origin, { fetch: async () => { throw failure; } }), error => error.code === 'readiness_unavailable' && error.cause === failure);
  const stop = new AbortController(), reason = Error('cancelled'); stop.abort(reason);
  await assert.rejects(describeReadiness(origin, { signal: stop.signal, fetch: async () => { throw reason; } }), error => error === reason);
});

test('an open mode alone cannot authorize creation without coherent build and availability evidence', async () => {
  for (const patch of [{ environment: undefined }, { build: undefined }, { writes: undefined }, { checkedAt: undefined },
    { build: { ...readiness().build, runtimeId: 'unknown' } }, { build: { ...readiness().build, compositionId: 'invalid' } },
    { environment: { ...readiness().environment, id: 'https://wrong.test' } },
    { writes: { available: false, code: 'read_only' } }, { checkedAt: 'not a timestamp' }]) {
    await assert.rejects(describeReadiness(origin, { fetch: async () => Response.json({ ...readiness(), ...patch }) }), { code: 'readiness_invalid' });
  }
});

test('contract discovery uses the same validated origin and refuses redirects', async () => {
  let calls = 0;
  const fetch = async (url, options) => {
    calls++; assert.equal(url, origin + '/api/service'); assert.equal(options.redirect, 'error');
    return Response.json({ contract: 3, core_release: 'test', limits: {} });
  };
  await describeService(origin, { fetch });
  await assert.rejects(describeService(origin + '/api/private', { fetch }), { code: 'invalid_service_origin' });
  assert.equal(calls, 1);
});

test('service origin validation rejects credentials, paths and non-loopback HTTP without leaking input', () => {
  assert.equal(requireServiceOrigin(origin + '/'), origin);
  assert.equal(requireServiceOrigin('http://127.0.0.1:3000'), 'http://127.0.0.1:3000');
  for (const value of ['https://user:private@example.test', origin + '/api/t/private', origin + '?token=private', 'http://example.test', 'not a URL']) {
    assert.throws(() => requireServiceOrigin(value), error => error.code === 'invalid_service_origin' && !error.message.includes('private'));
  }
});

test('creation enforces origin and retains a service-mode race as the actual creation error', async () => {
  const handle = { id: 'page', api: origin + '/api/t/page', token: 'fixture', page_url: 'https://page.example.test/s/key/', application: { id: 'a'.repeat(64) } };
  let options;
  await createPage(origin, { owner: 'owner@example.test' }, { fetch: async (_url, value) => { options = value; return Response.json(handle); } });
  assert.equal(options.redirect, 'error');
  await assert.rejects(createPage(origin, { owner: 'owner@example.test' }, { fetch: async () => Response.json({ ...handle, api: 'https://production.example.test/api/t/page' }) }), { code: 'service_origin_mismatch' });
  requireCreationReady(readiness());
  await assert.rejects(createPage(origin, { owner: 'owner@example.test' }, { fetch: async () => Response.json({ error: { code: 'creation_paused', message: 'New tendrils are temporarily paused' } }, { status: 503 }) }), { code: 'creation_paused', status: 503 });
});
