import { expect, it } from 'vitest';
import { api, apiJson, create, inDO, publishFiles, req } from './helpers';
import type { ApplicationEventBatch, ApplicationOperation } from '../../contract/application.mjs';

const program = (...steps: unknown[]) => ({ version: 1, steps, expected_generations: {} });
const emit = (topic: string, payload: unknown) => ({ kind: 'emit', topic, payload });
const state = (value: unknown, conditions?: unknown[]) => ({ kind: 'state', ops: [{ op: 'set', path: ['task'], value }], ...(conditions ? { conditions } : {}) });

it('commits mixed state/events atomically and retains final rejection audit on exact retries', async () => {
  const h = await create({ mode: 'dashboard', listener: false });
  const first = await apiJson<ApplicationOperation>(h, 'POST', 'application/changes', { operationId: 'init', program: program(state('open'), emit('tasks', { type: 'created' })) });
  expect(first.status).toBe('final');
  const rejectedInput = { operationId: 'failed', program: program(state('changed'), emit('tasks', { type: 'wrong' }), state('final', [{ path: ['task'], equals: 'missing' }])) };
  const rejected = await apiJson<ApplicationOperation>(h, 'POST', 'application/changes', rejectedInput);
  expect(rejected).toMatchObject({ status: 'final', outcome: 'rejected', error: 'state_conflict' });
  expect((await apiJson<any>(h, 'GET', 'state')).state.task).toBe('open');
  const batch = await apiJson<ApplicationEventBatch>(h, 'GET', 'application/events');
  expect(batch.transactions).toHaveLength(1); expect(batch.transactions[0].events[0].payload).toEqual({ type: 'created' });
  await inDO(h.id, t => { t.ctx.abort('application recovery'); }).catch(() => {});
  expect(await apiJson(h, 'POST', 'application/changes', rejectedInput)).toEqual(rejected);
  expect((await api(h, 'POST', 'application/changes', { ...rejectedInput, program: program(emit('tasks', 'changed')) })).status).toBe(409);
});
it('serializes concurrent writes, advances nonmatching scans and binds cursors to filter/history', async () => {
  const h = await create({ mode: 'dashboard', listener: false });
  await Promise.all(Array.from({ length: 6 }, (_, index) => apiJson(h, 'POST', 'application/changes', { operationId: `event-${index}`, program: program(emit('unrelated', index)) })));
  let cursor: string | undefined;
  for (let index = 0; index < 3; index++) {
    const query = new URLSearchParams({ topics: '["chat"]', limit: '2', ...(cursor ? { cursor } : {}) });
    const batch = await apiJson<ApplicationEventBatch>(h, 'GET', `application/events?${query}`);
    expect(batch.transactions).toEqual([]); expect(batch.scannedThrough).not.toBe(cursor); expect(batch.hasMore).toBe(index < 2); cursor = batch.scannedThrough;
  }
  const changed = new URLSearchParams({ topics: '["unrelated"]', cursor: cursor! });
  expect((await api(h, 'GET', `application/events?${changed}`)).status).toBe(409);
  const other = await create({ mode: 'dashboard', listener: false });
  expect((await api(other, 'GET', `application/events?${new URLSearchParams({ topics: '["chat"]', cursor: cursor! })}`)).status).toBe(409);
});
it('retains authenticated event origins independently of payload claims and exact retries', async () => {
  const h = await create({ mode: 'dashboard', listener: false });
  const payload = { type: 'instruction', authorId: 'forged-owner', role: 'owner', origin: { role: 'owner' } };
  const input = { operationId: 'agent-message', program: program(emit('conversation', payload)) };
  await apiJson(h, 'POST', 'application/changes', input);
  const ownerResponse = await req(h.page_url + '_tendril/application/changes', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: new URL(h.page_url).origin },
    body: JSON.stringify({ operationId: 'owner-message', program: program(emit('conversation', { text: 'Reviewed request' })) }) });
  expect(ownerResponse.status).toBe(200);
  const read = () => apiJson<ApplicationEventBatch>(h, 'GET', 'application/events');
  const before = await read();
  const agent = before.transactions[0].events[0], owner = before.transactions[1].events[0];
  expect(agent.payload).toEqual(payload);
  expect(agent.origin).toMatchObject({ kind: 'hosted', applicationId: `cf:${h.id}`, operationId: 'agent-message', role: 'agent' });
  expect(agent.origin.authorId).toMatch(/^agent:/);
  expect(owner.origin).toMatchObject({ kind: 'hosted', applicationId: `cf:${h.id}`, operationId: 'owner-message', role: 'owner' });
  expect(owner.origin.authorId).toMatch(/^page:/);
  await inDO(h.id, t => { t.ctx.abort('event provenance recovery'); }).catch(() => {});
  await apiJson(h, 'POST', 'application/changes', input);
  expect((await read()).transactions).toEqual(before.transactions);
});
it('revision observation covers state-only, scope-only and rejected changes without requiring events', async () => {
  const h = await create({ mode: 'dashboard', listener: false });
  const read = () => apiJson<{ view: string; revision: string; finalRevision: string }>(h, 'GET', 'application/revision');
  const initial = await read();
  expect(initial).toMatchObject({ view: 'final', finalRevision: initial.revision });
  await apiJson(h, 'POST', 'application/changes', { operationId: 'state-only', program: program(state('open')) });
  const changed = await read();
  expect(changed.revision).not.toBe(initial.revision);
  await apiJson(h, 'PUT', 'scopes/task', { cid: 'scope-only', expected_generations: {}, paths: [['task']], operations: [] });
  const scope = await read();
  expect(scope.revision).not.toBe(changed.revision);
  await apiJson(h, 'POST', 'application/changes', { operationId: 'rejected-state', program: program(state('closed')) });
  const rejected = await read();
  expect(rejected.revision).not.toBe(scope.revision);
  expect((await apiJson<ApplicationEventBatch>(h, 'GET', 'application/events')).transactions).toEqual([]);
  expect(await apiJson(h, 'GET', 'application/revision?view=local')).toEqual({ ...rejected, view: 'local' });
  expect((await api(h, 'GET', 'application/revision?view=unknown')).status).toBe(400);
});
it('pins coherent state and effective event history even as later operations finalize', async () => {
  const h = await create({ mode: 'dashboard', listener: false });
  await apiJson(h, 'POST', 'application/changes', { operationId: 'one', program: program(state(1), emit('counter', 1)) });
  const view = await apiJson<any>(h, 'GET', 'application/view');
  await apiJson(h, 'POST', 'application/changes', { operationId: 'two', program: program(state(2), emit('counter', 2)) });
  const events = await apiJson<ApplicationEventBatch>(h, 'GET', `application/events?${new URLSearchParams({ revision: view.revision })}`);
  expect(view.state.task).toBe(1); expect(events.revision).toBe(view.revision); expect(events.transactions).toHaveLength(1);
  expect(events.transactions[0].events[0].payload).toBe(1);
});
it('preserves original scope guards and rejects old queued writes after rotation', async () => {
  const h = await create({ mode: 'dashboard', listener: false });
  const scope = await apiJson<any>(h, 'PUT', 'scopes/tasks', { cid: 'scope', expected_generations: {}, paths: [['task']], operations: [] });
  const input = { operationId: 'accepted', program: { ...program(state(1)), scope: 'tasks', expected_generations: { tasks: scope.generation } } };
  const accepted = await apiJson(h, 'POST', 'application/changes', input);
  await apiJson(h, 'POST', 'scopes/tasks/rotate', { cid: 'rotate', expected_generations: { tasks: scope.generation } });
  expect(await apiJson(h, 'POST', 'application/changes', input)).toEqual(accepted);
  const late = await apiJson<ApplicationOperation>(h, 'POST', 'application/changes', { ...input, operationId: 'late' });
  expect(late).toMatchObject({ status: 'final', outcome: 'rejected', error: 'stale_generation' });
});
it('peer pages disable Cloudflare application paths and retain host publication and recovery', async () => {
  const h = await create({ mode: 'dashboard', listener: false, application: { kind: 'peer', id: 'history-one' } });
  expect(await apiJson(h, 'GET', 'application')).toEqual({ selection: { kind: 'peer', id: 'history-one' } });
  for (const [method, path, body] of [['PATCH', 'state', { cid: 'x', expected_generations: {}, ops: [] }], ['POST', 'events', { cid: 'x', expected_generations: {}, data: {} }], ['POST', 'application/changes', { operationId: 'x', program: program(emit('x', 1)) }]] as const)
    expect((await api(h, method, path, body)).status).toBe(409);
  for (const path of ['bundle', 'bundle/publish', 'remix', 'session', 'timers', 'streams', 'workflows', 'application/revision'])
    expect((await api(h, 'GET', path)).status).toBe(409);
  expect((await api(h, 'POST', 'streams/telemetry/records', {}, {}, 'tp_' + 'a'.repeat(40))).status).toBe(409);
  await publishFiles(h, { 'index.html': '<!doctype html><title>Peer application</title>' });
  expect(await (await req(h.page_url)).text()).toContain('"application":{"kind":"peer","id":"history-one"}');
  const hostedSocket = await req(h.page_url + '_tendril/ws', { headers: { Upgrade: 'websocket' } });
  expect(hostedSocket.status).toBe(409);
  expect(await hostedSocket.json()).toMatchObject({ error: { code: 'application_backend' } });
  expect(await inDO(h.id, t => t.db.one('SELECT COUNT(*) AS n FROM application_changes'))).toEqual({ n: 0 });
});
