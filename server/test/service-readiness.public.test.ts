import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { CORE_RELEASE } from '../../contract/index.mjs';
import type { Env } from '../src/env';
import { route } from '../src/router';
import { createAgent, testPublicKey, testWrapKey } from './helpers';
import { BASE } from './helpers';

const read = (settings: Env = env, method = 'GET') => route(new Request(new URL('/api/readiness', settings.PUBLIC_BASE), { method }), settings);
const counts = () => env.ACCOUNTS.prepare('SELECT (SELECT COUNT(*) FROM accounts) AS accounts, (SELECT COUNT(*) FROM tendrils) AS pages').first();

it.each([
  { mode: 'open', creation: true, writes: true, creationCode: null, writeCode: null },
  { mode: 'creation_paused', creation: false, writes: true, creationCode: 'creation_paused', writeCode: null },
  { mode: 'read_only', creation: false, writes: false, creationCode: 'creation_paused', writeCode: 'read_only' },
])('reports $mode before installation without reserving a page or claiming authorization', async (state) => {
  const before = await counts();
  await env.ACCOUNTS.prepare('UPDATE service_state SET mode=? WHERE id=1').bind(state.mode).run();
  try {
    const response = await read();
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Link')).toContain(`<${BASE}/api/readiness>; rel="monitor"`);
    const value = await response.json() as any;
    expect(value).toMatchObject({ schemaVersion: 1, serviceOrigin: BASE,
      environment: { id: BASE }, build: { coreRelease: CORE_RELEASE, runtimeId: expect.stringMatching(/^[a-f0-9]{64}$/), compositionId: null },
      mode: state.mode, creation: { available: state.creation, code: state.creationCode },
      writes: { available: state.writes, code: state.writeCode }, readinessUrl: BASE + '/api/readiness', statusUrl: BASE + '/status',
    });
    expect(Number.isFinite(Date.parse(value.checkedAt))).toBe(true);
    if (!state.creation) {
      expect(value.creation.nextAction).toContain('before downloading or installing packages');
      expect(value.creation.nextAction).toContain(BASE);
      expect(value.creation.nextAction).toContain('fall back to another host');
    }
    const head = await read(env, 'HEAD');
    expect(head.status).toBe(200);
    expect(head.headers.get('Content-Type')).toBe(response.headers.get('Content-Type'));
    expect(await head.text()).toBe('');
    expect((await read(env, 'POST')).status).toBe(405);
    expect(await counts()).toEqual(before);
  } finally { await env.ACCOUNTS.prepare("UPDATE service_state SET mode='open' WHERE id=1").run(); }
});

it('fails closed when readiness cannot be read and does not expose internal errors', async () => {
  const secret = 'private-database-diagnostic';
  const settings = { ...env, ACCOUNTS: { prepare() { throw new Error(secret); } } as unknown as D1Database };
  const response = await read(settings);
  expect(response.status).toBe(503);
  const value = await response.json() as any;
  expect(value).toMatchObject({ schemaVersion: 1, serviceOrigin: BASE, mode: 'unavailable',
    creation: { available: false, code: 'unavailable' }, writes: { available: false, code: 'unavailable' },
  });
  expect(value.creation.nextAction).toContain('Stop new-app setup');
  expect(JSON.stringify(value)).not.toContain(secret);
  const head = await read(settings, 'HEAD');
  expect(head.status).toBe(503);
  expect(await head.text()).toBe('');
});

it.each([
  { origin: 'https://sandbox.example:8443', suffix: '', kind: 'deployment' },
  { origin: 'https://preview.example', suffix: '--p-0123456789ab', kind: 'preview' },
  { origin: 'http://localhost:8787', suffix: '', kind: 'local' },
])('keeps readiness on $origin without inferring a production deployment', async ({ origin, suffix, kind }) => {
  const settings: Env = { ...env, PUBLIC_BASE: origin + '/', PAGE_HOST_SUFFIX: suffix,
    SERVICE_ENVIRONMENT: 'Prototype test', SERVICE_SOURCE_COMMIT: 'b'.repeat(40), SERVICE_COMPOSITION_ID: 'c'.repeat(64) };
  const response = await read(settings);
  expect(response.status).toBe(200);
  const value = await response.json() as any;
  expect(value).toMatchObject({ serviceOrigin: origin, environment: { id: origin, label: 'Prototype test', kind },
    build: { sourceCommit: 'b'.repeat(40), compositionId: 'c'.repeat(64) }, readinessUrl: origin + '/api/readiness', statusUrl: origin + '/status',
  });
  expect(JSON.stringify(value)).not.toContain('https://tendriller.dev');
  const mismatched = await route(new Request('https://wrong.example/api/readiness'), settings);
  expect(mismatched.status).toBe(404);
  const invalid = await read({ ...settings, SERVICE_SOURCE_COMMIT: 'not-a-source-checkpoint', SERVICE_COMPOSITION_ID: 'not-a-composition' });
  expect((await invalid.json() as any).build).toMatchObject({ sourceCommit: null, compositionId: null });
});

it('rechecks service state at creation after a previously successful preflight', async () => {
  expect((await (await read()).json() as any).creation.available).toBe(true);
  const agent = await createAgent('readiness-owner@example.com');
  await env.ACCOUNTS.prepare("UPDATE service_state SET mode='creation_paused' WHERE id=1").run();
  try {
    for (const [path, body, headers] of [
      ['/api/agents', { owner: 'readiness-test@example.com', handle: 'readiness', publicKey: testPublicKey(), wrapKey: testWrapKey() }, {}],
      ['/api/agent/pages', {}, { Authorization: `Bearer ${agent.token}` }],
    ] as const) {
      const response = await route(new Request(BASE + path, { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.18.11.23', ...headers },
        body: JSON.stringify(body),
      }), env);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: 'creation_paused' } });
    }
  } finally { await env.ACCOUNTS.prepare("UPDATE service_state SET mode='open' WHERE id=1").run(); }
});
