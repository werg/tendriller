import test from 'node:test';
import assert from 'node:assert/strict';
import { APPLICATION_LIMITS, applicationSelection, createApplicationBinding, validateCloudflareProgram, applicationFilter, publishConversation, createCloudflareApplicationBackend } from '../application.mjs';

test('one selected backend owns the history and readiness never silently falls back', async () => {
  const selected = createApplicationBinding({ kind: 'peer', id: 'history-1' });
  assert.throws(() => selected.backend, { code: 'backend_unavailable' });
  const backend = { id: 'history-1', capabilities: ['events'], async submit() {}, readView() {},
    events: { publish() {}, read() {}, subscribe() {} }, operations: { get() {}, subscribe() {} } };
  assert.throws(() => selected.install({ ...backend, id: 'other' }), { code: 'invalid_backend' });
  const ready = selected.ready(); selected.install(backend);
  assert.equal(await ready, backend); assert.equal(selected.backend, backend);
  assert.throws(() => selected.install(backend), { code: 'backend_already_selected' });
  assert.deepEqual(applicationSelection(undefined, 'page'), { kind: 'cloudflare', id: 'page' });
});
test('programs bind all steps and preserve captured scope guards', () => {
  const input = { version: 1, scope: 'work', expected_generations: { work: 'original' }, steps: [
    { kind: 'state', ops: [{ op: 'set', path: 'task.status', value: 'done' }], conditions: [{ path: 'task.status', equals: 'open' }] },
    { kind: 'emit', topic: 'tasks', payload: { type: 'task.completed' } },
  ] };
  const result = validateCloudflareProgram(input);
  input.expected_generations.work = 'rotated'; input.steps[1].payload.type = 'changed';
  assert.equal(result.expected_generations.work, 'original'); assert.equal(result.steps[1].payload.type, 'task.completed');
  assert.deepEqual(result.steps[0].ops[0].path, ['task', 'status']);
  assert.throws(() => validateCloudflareProgram({ ...result, steps: [{ kind: 'sql', sql: 'DELETE' }] }), { code: 'invalid_program' });
  assert.throws(() => validateCloudflareProgram({ ...result, steps: [{ kind: 'emit', topic: 'x', payload: 'x'.repeat(APPLICATION_LIMITS.eventBytes) }] }), { code: 'program_too_large' });
  assert.throws(() => validateCloudflareProgram({ ...result, steps: Array(APPLICATION_LIMITS.events + 1).fill({ kind: 'emit', topic: 'x', payload: null }) }), { code: 'program_too_large' });
  assert.deepEqual(applicationFilter(['b', 'a', 'a']), ['a', 'b']);
});
test('conversation helpers preserve message and retry identities without performing effects', async () => {
  const calls = [];
  await publishConversation({ publish: async (...args) => { calls.push(args); return { id: 'p' }; } }, { messageId: 'message-1', text: 'Hello', inReplyTo: 'message-0' }, { operationId: 'send-1' });
  assert.deepEqual(calls, [['conversation', { type: 'message.posted', version: 1, messageId: 'message-1', text: 'Hello', inReplyTo: 'message-0' }, { operationId: 'send-1' }]]);
});
test('Cloudflare captured read views retain their event prefix and release explicitly', async () => {
  const calls = [];
  const backend = createCloudflareApplicationBackend({ id: 'cf:page', request: async path => {
    calls.push(path);
    return path === 'application/view' ? { revision: 'opaque-1', state: { count: 1 }, scopes: [] }
      : { revision: 'opaque-1', transactions: [], scannedThrough: 'cursor-1', hasMore: false };
  } });
  const view = await backend.readView();
  const state = view.query('state'); state.count = 99;
  assert.equal(view.query('state').count, 1);
  await view.readEvents({ topics: ['chat'] });
  assert.match(calls.at(-1), /revision=opaque-1/);
  view.release(); assert.throws(() => view.query('state'), { code: 'view_released' });
});
