import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const built = await build({
  entryPoints: [new URL('../src/agents.ts', import.meta.url).pathname],
  bundle: true,
  format: 'iife',
  globalName: 'Agents',
  platform: 'browser',
  write: false,
});

function setup({ cached = null, fetchImpl } = {}) {
  const storage = new Map();
  if (cached) storage.set('tendril:agents:pg1234567890', JSON.stringify(cached));
  const calls = [];
  const context = {
    URL,
    location: { href: 'https://page.example/p/' },
    localStorage: {
      getItem: k => storage.get(k) ?? null,
      setItem: (k, v) => storage.set(k, v),
    },
    fetch: async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null });
      if (fetchImpl) return fetchImpl(String(url), init);
      return { ok: true, status: 200, json: async () => ({ primary_agent_id: null, agents: [], can_manage: true }) };
    },
  };
  runInNewContext(built.outputFiles[0].text, context);
  const controller = context.Agents.createAgentsStore({
    id: 'pg1234567890',
    base: '/p/',
    version: 1,
    documentPath: null,
    application: { id: 'a'.repeat(64) },
    features: { speech: null, shared_by: 'Owner' },
  });
  return { controller, api: controller.api, storage, calls };
}

test('createAgentsStore caches roster per page, resolves @handles and public keys, and merges live status', async () => {
  const aKey = 'a'.repeat(64), bKey = 'b'.repeat(64);
  const { controller, api, calls } = setup({
    cached: {
      primary_agent_id: 'ag_1',
      agents: [
        { id: 'ag_1', handle: 'atlas', bio: 'Primary', public_key: aKey, kind: 'account', is_primary: true },
        { id: 'ag_2', handle: 'reviewer', bio: 'Secondary', public_key: bKey, kind: 'account', is_primary: false },
      ],
    },
    fetchImpl: async (url, init) => {
      if (url.endsWith('_tendril/agents/primary') && init.method === 'PUT') {
        const body = JSON.parse(init.body);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            primary_agent_id: body.agent_id,
            agents: [
              { id: 'ag_1', handle: 'atlas', bio: 'Primary', public_key: aKey, kind: 'account', is_primary: body.agent_id === 'ag_1' },
              { id: 'ag_2', handle: 'reviewer', bio: 'Secondary', public_key: bKey, kind: 'account', is_primary: body.agent_id === 'ag_2' },
            ],
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ primary_agent_id: 'ag_1', agents: [], can_manage: true }) };
    },
  });

  const events = [];
  const off = api.onChange(snap => events.push(snap));

  assert.equal(api.snapshot().primary_agent_id, 'ag_1');
  assert.equal(api.resolveHandle('@ATLAS')?.id, 'ag_1');
  assert.equal(api.resolveHandle(bKey)?.handle, 'reviewer');
  assert.equal(api.resolveHandle('unknown'), null);

  api.reportLiveStatus({ [aKey]: 'online', [bKey]: 'offline' });
  assert.equal(api.snapshot().live[aKey], 'online');
  assert.equal(events.length, 1);

  await api.setPrimary('ag_2');
  assert.equal(calls.at(-1).method, 'PUT');
  assert.deepEqual(calls.at(-1).body, { agent_id: 'ag_2' });
  assert.equal(api.snapshot().primary_agent_id, 'ag_2');

  controller.applyNotice({
    type: 'agents',
    version: 1,
    primary_agent_id: 'ag_1',
    agents: [
      { id: 'ag_1', handle: 'atlas', bio: 'Primary', public_key: aKey, kind: 'account', is_primary: true },
    ],
  });
  assert.equal(api.snapshot().agents.length, 1);
  assert.equal(api.snapshot().primary_agent_id, 'ag_1');
  off();
});
