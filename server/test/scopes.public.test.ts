import { beforeAll, expect, inject, it } from 'vitest';
import { applyD1Migrations, env } from 'cloudflare:test';
import { create, api, apiJson, PageClient, inDO, req } from './helpers';
import { assertValid, RESOURCE_LIMITS, STREAM_LIMITS } from '../../contract/index.mjs';
import { mutate, registerScope, rotateScope, scopes } from '../src/scopes';

beforeAll(async () => { await applyD1Migrations(env.ACCOUNTS, inject('d1Migrations')); await env.ACCOUNTS.prepare("UPDATE service_state SET mode='open' WHERE id=1").run(); });
const command = (extra: Record<string, unknown> = {}) => ({ cid: crypto.randomUUID(), expected_generations: {}, ...extra });

it('replays scope creation and retirement after their state changes', async () => {
  const h = await create();
  const createCommand = command({ paths: [['notes']], operations: [] });
  const created = await apiJson(h, 'PUT', 'scopes/notebook', createCommand);
  expect(await apiJson(h, 'PUT', 'scopes/notebook', createCommand)).toEqual(created);
  const retireCommand = command({ expected_generations: { notebook: created.generation } });
  const retired = await apiJson(h, 'DELETE', 'scopes/notebook', retireCommand);
  expect(await apiJson(h, 'DELETE', 'scopes/notebook', retireCommand)).toEqual(retired);
  expect(retired).toEqual({ retired: true });
});

it('accepts publication preconditions for the full active-scope allowance', async () => {
  const h = await create();
  const expected_generations = Object.fromEntries(Array.from({ length: RESOURCE_LIMITS.active_scopes }, (_, index) =>
    [`scope-${String(index).padStart(3, '0')}-${'x'.repeat(120)}`, crypto.randomUUID()]));
  const body = command({ expected_generations, expected_version: 0 });
  expect(JSON.stringify(body).length).toBeGreaterThan(4096);
  expect((await api(h, 'POST', 'bundle/publish', body)).status).toBe(404);
});

it('publishes the same deployment descriptor and actual page limits through HTTP and WebSocket', async () => {
  const page = await create();
  const agent = await apiJson(page, 'GET', 'service');
  assertValid('serviceDescriptor', agent);
  expect(agent.limits.effective.streams.retained_bytes).toBe(STREAM_LIMITS.retained_bytes);
  expect(await (await req(page.page_url + '_tendril/service')).json()).toEqual(agent);
  const socket = await PageClient.connect(page.page_url);
  expect(socket.welcome.service).toEqual(agent); socket.close();
  const unclaimed = await create({ claim: false });
  const limited = await apiJson(unclaimed, 'GET', 'service');
  assertValid('serviceDescriptor', limited);
  expect(limited.limits.effective.streams.retained_bytes).toBe(STREAM_LIMITS.unclaimed_retained_bytes);
  expect(limited.limits.streams.retained_bytes).toBe(STREAM_LIMITS.retained_bytes);
});

it('counts reactivated scopes toward the active quota and rejects unrepresentable scope IDs', async () => {
  const h = await create();
  for (const id of ['__proto__', 'constructor', 'prototype'])
    expect((await api(h, 'PUT', `scopes/${id}`, command({ paths: [], operations: [] }))).status).toBe(400);
  await inDO(h.id, t => {
    registerScope(t, 'retired', { paths: [], operations: [] });
    rotateScope(t, 'retired', null, true);
    for (let i = 0; i < 128; i++) registerScope(t, `active:${i}`, { paths: [], operations: [] });
    expect(() => registerScope(t, 'retired', { paths: [], operations: [] })).toThrow('128 active');
  });
});

it('keeps accepted receipts at quota and atomically rejects new mutations without discarding history', async () => {
  const h = await create();
  await inDO(h.id, t => {
    const first = registerScope(t, 'quota', { paths: [['value']], operations: [] });
    const accepted = command({ expected_generations: { quota: first.generation } });
    t.db.run('UPDATE command_usage SET count=?,bytes=0 WHERE id=1', RESOURCE_LIMITS.command_receipts - 1);
    const execute = () => mutate(t, 'quota-test', accepted, { scopes: ['quota'] }, { value: 'saved' }, () => ({ rev: t.applyState([{ op: 'set', path: ['value'], value: 'saved' }], 'quota-test', undefined, accepted as any) }));
    expect(execute()).toEqual({ rev: 1 });
    const before = t.db.one('SELECT count,bytes FROM command_usage WHERE id=1');
    const rejected = command({ expected_generations: { quota: first.generation } });
    let effect = false;
    expect(() => mutate(t, 'quota-test', rejected, { scopes: ['quota'] }, {}, () => {
      t.applyState([{ op: 'set', path: ['value'], value: 'must roll back' }], 'quota-test', undefined, rejected as any);
      rotateScope(t, 'quota'); t.afterCommit(() => { effect = true; });
      return { ok: true };
    })).toThrow('durable command receipt allowance');
    expect(t.getState().state).toEqual({ value: 'saved' });
    expect(scopes(t)[0].generation).toBe(first.generation);
    expect(t.db.one('SELECT cid FROM commands WHERE cid=?', rejected.cid)).toBeNull();
    expect(t.db.one('SELECT count,bytes FROM command_usage WHERE id=1')).toEqual(before);
    expect(effect).toBe(false);
    expect(execute()).toEqual({ rev: 1 });
    expect(t.getState().rev).toBe(1);
    t.db.run('UPDATE command_usage SET count=1,bytes=? WHERE id=1', RESOURCE_LIMITS.command_receipt_bytes - 1);
    expect(() => mutate(t, 'quota-test', command(), {}, {}, () => ({ stored: true }))).toThrow('durable command receipt allowance');
    expect(t.db.all('SELECT cid FROM commands')).toHaveLength(1);
  });
});

it('bounds lifetime scope bindings while permitting explicit reactivation of a retained ID', async () => {
  const h = await create();
  await inDO(h.id, t => {
    t.transaction(() => {
      for (let i = 0; i < RESOURCE_LIMITS.scope_bindings; i++)
        t.db.run("INSERT INTO scopes(id,generation,paths,operations,retired,owner) VALUES(?,?,'[]','[]',1,NULL)", `history:${i}`, crypto.randomUUID());
    });
    expect(() => registerScope(t, 'new-binding', { paths: [], operations: [] })).toThrow('lifetime scope binding allowance');
    const before = t.db.one<{ generation: string }>("SELECT generation FROM scopes WHERE id='history:0'")!;
    const reactivated = registerScope(t, 'history:0', { paths: [], operations: [] });
    expect(reactivated.generation).not.toBe(before.generation);
    expect(scopes(t)).toEqual([reactivated]);
  });
});

it('round-trips formerly special payloads and state names as opaque application data', async () => {
  const h = await create();
  const state = { experiment: { session_id: 'application-owned' }, notebook: { entries: [1] }, guide_progress: 7, facilitation: 'opaque' };
  await apiJson(h, 'PUT', 'state', command({ state }));
  expect((await apiJson(h, 'GET', 'state')).state).toEqual(state);
  const payload = { type: 'experiment.status', session: 'job-123' };
  const accepted = await apiJson(h, 'POST', 'events', command({ data: payload }));
  const events = (await apiJson(h, 'GET', 'events?after=0')).events;
  expect(events.find((event: any) => event.seq === accepted.seq)).toMatchObject({ data: payload, context: { generations: {} } });
  expect(events.find((event: any) => event.seq === accepted.seq).context.workflow).toBeUndefined();
  expect((await api(h, 'POST', 'workflows/sessions/activate', command({ data: { scope: 'experiment' } }))).status).toBe(404);
});

it('requires exact generations for descendants, ancestors and full-document replacement', async () => {
  const h = await create();
  const first = await apiJson(h, 'PUT', 'scopes/job', command({ paths: [['jobs', 'active']], operations: [] }));
  const other = await apiJson(h, 'PUT', 'scopes/other', command({ paths: [['other']], operations: [] }));
  for (const ops of [[{ op: 'set', path: ['jobs', 'active', 'progress'], value: 1 }], [{ op: 'set', path: ['jobs'], value: {} }], [{ op: 'set', path: [], value: {} }]]) {
    expect((await api(h, 'PATCH', 'state', command({ ops }))).status).toBe(428);
    expect((await api(h, 'PATCH', 'state', command({ ops, scope: 'other', expected_generations: { other: other.generation } }))).status).toBe(428);
    expect((await api(h, 'PATCH', 'state', command({ ops, expected_generations: { job: 'forged' } }))).status).toBe(409);
  }
  expect((await api(h, 'PUT', 'state', command({ state: { untouched: true } }))).status).toBe(428);
  expect((await api(h, 'PUT', 'state', command({ state: { jobs: { active: 2 }, other: {} }, expected_generations: { job: first.generation, other: other.generation } }))).status).toBe(200);
});

it('retains the original meaning across rebinding, rotation and retirement', async () => {
  const h = await create();
  const old = await apiJson(h, 'PUT', 'scopes/job', command({ paths: [['job']], operations: ['event'] }));
  const queued = command({ scope: 'job', expected_generations: { job: old.generation }, data: { type: 'anything' } });
  const rotated = await apiJson(h, 'POST', 'scopes/job/rotate', command({ expected_generations: { job: old.generation } }));
  expect(rotated.generation).not.toBe(old.generation);
  expect((await api(h, 'POST', 'events', queued)).status).toBe(409);
  const rebind = await apiJson(h, 'PUT', 'scopes/job', command({ expected_generations: { job: rotated.generation }, paths: [['replacement']], operations: [] }));
  expect((await api(h, 'PATCH', 'state', command({ expected_generations: { job: rotated.generation }, ops: [{ op: 'set', path: ['job'], value: 1 }] }))).status).toBe(409);
  await apiJson(h, 'DELETE', 'scopes/job', command({ expected_generations: { job: rebind.generation } }));
  expect((await api(h, 'PATCH', 'state', command({ expected_generations: { job: rebind.generation }, ops: [{ op: 'set', path: ['replacement'], value: 1 }] }))).status).toBe(409);
  expect((await apiJson(h, 'GET', 'scopes')).scopes).toEqual([]);
});

it('deduplicates exact commands and rejects a reused ID for different work', async () => {
  const h = await create();
  const body = command({ state: { n: 1 } });
  const first = await apiJson(h, 'PUT', 'state', body);
  expect(await apiJson(h, 'PUT', 'state', body)).toEqual(first);
  expect((await api(h, 'PUT', 'state', { ...body, state: { n: 2 } })).status).toBe(409);
  expect((await apiJson(h, 'GET', 'state')).rev).toBe(1);
});

it('applies the same guards over WebSocket and emits validated context outside data', async () => {
  const h = await create();
  const entry = await apiJson(h, 'PUT', 'scopes/job', command({ paths: [['job']], operations: ['capture'] }));
  const page = await PageClient.connect(h.page_url);
  try {
    const missing = await page.request({ t: 'state', expected_generations: {}, ops: [{ op: 'set', path: ['job'], value: 1 }] });
    expect(missing.error).toBe('generation_required');
    const ok = await page.request({ t: 'state', expected_generations: { job: entry.generation }, ops: [{ op: 'set', path: ['job'], value: 2 }] });
    expect(ok.rev).toBe(1);
    const send = await page.request({ t: 'send', scope: 'job', expected_generations: { job: entry.generation }, data: { type: 'notebook.observation', session: 'my-json' }, wake: false });
    expect(send.seq).toBeGreaterThan(0);
    const event = (await apiJson(h, 'GET', 'events?after=0')).events.find((item: any) => item.seq === send.seq);
    expect(event.context).toEqual({ scope: 'job', generations: { job: entry.generation } });
    expect(event.data.session).toBe('my-json');
    expect((await page.request({ t: 'capture_complete', expected_generations: {}, blob: 'b_missing', data: {} })).error).toBe('generation_required');
  } finally { page.close(); }
});

it('rolls back state, scope generation, command receipt and post-commit effects together', async () => {
  const h = await create();
  await inDO(h.id, t => {
    const first = registerScope(t, 'atomic', { paths: [['data']], operations: [] });
    let delivered = false;
    const body = command({ expected_generations: { atomic: first.generation } });
    expect(() => mutate(t, 'test', body, { scopes: ['atomic'] }, {}, () => {
      t.applyState([{ op: 'set', path: ['data'], value: 'pending' }], 'test', undefined, body);
      rotateScope(t, 'atomic');
      t.afterCommit(() => { delivered = true; });
      throw new Error('injected failure');
    })).toThrow('injected failure');
    expect(t.getState().state).toEqual({});
    expect(scopes(t)[0].generation).toBe(first.generation);
    expect(t.db.one('SELECT cid FROM commands WHERE cid=?', body.cid)).toBeNull();
    expect(delivered).toBe(false);
  });
});

it('MCP state writes use the same admission and cannot hide guards in app JSON', async () => {
  const h = await create();
  const entry = await apiJson(h, 'PUT', 'scopes/job', command({ paths: [['protected']], operations: [] }));
  const rpc = (body: unknown) => apiJson(h, 'POST', 'mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'update_state', arguments: body } });
  const denied = await rpc(command({ state: { protected: { expected_generations: { job: entry.generation } } } }));
  expect(denied.result.isError).toBe(true);
  expect((await apiJson(h, 'GET', 'state')).state).toEqual({});
  const accepted = await rpc(command({ expected_generations: { job: entry.generation }, ops: [{ op: 'set', path: ['protected'], value: 1 }] }));
  expect(accepted.result.structuredContent.rev).toBe(1);
});

it('bundle restore checks current guards atomically and an acknowledged retry never repeats the restore', async () => {
  const h = await create({ mode: 'dashboard' });
  const entry = await apiJson(h, 'PUT', 'scopes/job', command({ paths: [['protected']], operations: [] }));
  const bundle = { format: 'tendriller-bundle', version: 1, name: 'Scoped restore', files: [{ path: 'index.html', type: 'text/html', base64: btoa('<h1>Fresh</h1>') }], media: [], state: { protected: { session_id: 'only application JSON' } } };
  expect((await api(h, 'PUT', 'bundle', { ...bundle, scopes: [entry] })).status).toBe(400);
  await apiJson(h, 'PUT', 'bundle', bundle, 202);
  expect((await api(h, 'POST', 'bundle/publish', command({ expected_version: 0 }))).status).toBe(428);
  expect((await apiJson(h, 'GET', 'state')).state).toEqual({});
  const accepted = command({ expected_generations: { job: entry.generation }, expected_version: 0 });
  const publication = await apiJson(h, 'POST', 'bundle/publish', accepted);
  expect((await apiJson(h, 'GET', 'state')).state).toEqual(bundle.state);
  const next = await apiJson(h, 'POST', 'scopes/job/rotate', command({ expected_generations: { job: entry.generation } }));
  await apiJson(h, 'PUT', 'state', command({ state: { protected: 'new generation' }, expected_generations: { job: next.generation } }));
  expect(await apiJson(h, 'POST', 'bundle/publish', accepted)).toEqual(publication);
  expect((await apiJson(h, 'GET', 'state')).state).toEqual({ protected: 'new generation' });
});
