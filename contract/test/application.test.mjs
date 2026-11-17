import test from 'node:test';
import assert from 'node:assert/strict';
import { APPLICATION_LIMITS, applicationSelection, createApplicationBinding, validateCloudflareProgram, applicationFilter, publishConversation, createCloudflareApplicationBackend } from '../application.mjs';

test('one selected backend owns the history and readiness never silently falls back', async () => {
  const selected = createApplicationBinding({ kind: 'peer', id: 'history-1' });
  assert.throws(() => selected.backend, { code: 'backend_unavailable' });
  const backend = { id: 'history-1', capabilities: ['events'], async submit() {}, readView() {}, async *changes() {},
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

test('durable subscriptions pull one whole batch at a time and carry empty scan progress', async () => {
  const calls = [], stop = new AbortController();
  const backend = createCloudflareApplicationBackend({ id: 'cf:page', request: async path => {
    calls.push(path);
    return { revision: 'view-1', transactions: [], scannedThrough: `cursor-${calls.length}`, hasMore: true };
  } });
  const iterator = backend.events.subscribe({ topics: [], signal: stop.signal })[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value.scannedThrough, 'cursor-1');
  await Promise.resolve(); assert.equal(calls.length, 1, 'receiving progress must not start another read');
  assert.equal((await iterator.next()).value.scannedThrough, 'cursor-2');
  assert.equal(new URL(calls[1], 'https://service.test/').searchParams.get('cursor'), 'cursor-1');
  stop.abort(); assert.equal((await iterator.next()).done, true);
});

test('operation receipt validation prevents unverified responses from retiring authored work', async () => {
  const program = { version: 1, expected_generations: {}, steps: [{ kind: 'emit', topic: 'tasks', payload: null }] };
  for (const receipt of [{ operationId: 'other', proposalId: 'p', status: 'final', outcome: 'accepted' },
    { operationId: 'original', proposalId: 'p', status: 'final' }, { operationId: 'original', proposalId: 'p', status: 'queued' },
    { operationId: 'original', proposalId: 'p', status: 'rejected', outcome: 'rejected' },
    { operationId: 'original', proposalId: '', status: 'final', outcome: 'rejected' }]) {
    const backend = createCloudflareApplicationBackend({ id: 'cf:page', request: async () => receipt });
    await assert.rejects(backend.submit(program, { operationId: 'original' }), { code: 'invalid_response' });
  }
});

test('acceptance and finality remain independent for retained and admission rejections', async () => {
  const program = { version: 1, expected_generations: {}, steps: [{ kind: 'emit', topic: 'tasks', payload: null }] };
  for (const receipt of [
    { operationId: 'original', proposalId: 'p', status: 'final', outcome: 'rejected', error: 'state_conflict' },
    { operationId: 'original', proposalId: '', status: 'final', outcome: 'rejected', error: 'history_quota' },
  ]) {
    const backend = createCloudflareApplicationBackend({ id: 'cf:page', request: async () => receipt });
    assert.deepEqual(await backend.submit(program, { operationId: 'original' }), receipt);
    const statuses = [];
    for await (const value of backend.operations.subscribe({ operationId: 'original' })) statuses.push(value);
    assert.deepEqual(statuses, [receipt]);
  }
});

test('changes observe current state, coalesce socket invalidations and include writes during reads', async () => {
  const stop = new AbortController();
  let notify, revision = 'r1', reads = 0, released = 0, duringRead = false;
  const backend = createCloudflareApplicationBackend({ id: 'cf:page',
    onChange(value) { notify = value; return () => { released++; }; },
    async request(path) {
      assert.equal(path, 'application/revision?view=local'); reads++;
      const current = { view: 'local', revision, finalRevision: revision };
      if (duringRead) { duringRead = false; revision = 'r3'; notify(); }
      return current;
    },
  });
  const iterator = backend.changes({ view: 'local', signal: stop.signal })[Symbol.asyncIterator]();
  assert.deepEqual((await iterator.next()).value, { view: 'local', revision: 'r1', finalRevision: 'r1' });
  for (let index = 0; index < 100; index++) notify();
  assert.equal(reads, 1, 'a paused consumer holds no queue and performs no background reads');
  revision = 'r2'; duringRead = true;
  assert.equal((await iterator.next()).value.revision, 'r2');
  assert.equal((await iterator.next()).value.revision, 'r3', 'a change during the preceding read is retained as an invalidation');
  const pending = iterator.next();
  await Promise.resolve();
  stop.abort();
  assert.equal((await pending).done, true);
  assert.equal(released, 1);
});

test('event readers require host-authenticated provenance outside user payloads', async () => {
  const origin = { kind: 'hosted', applicationId: 'cf:page', authorId: 'agent:worker', operationId: 'original', role: 'agent' };
  const event = { id: 'p:0', proposalId: 'p', eventOrdinal: 0, topic: 'tasks', payload: { authorId: 'owner:forged', role: 'owner' }, origin };
  const batch = { revision: 'r1', transactions: [{ proposalId: 'p', events: [event] }], scannedThrough: 'c1', hasMore: false };
  const backend = createCloudflareApplicationBackend({ id: 'cf:page', request: async () => structuredClone(batch) });
  assert.deepEqual((await backend.events.read()).transactions[0].events[0].origin, origin);
  delete event.origin;
  await assert.rejects(backend.events.read(), { code: 'invalid_response' });
});


test('Cloudflare read views reject non-object state roots before publishing a snapshot', async () => {
  for (const state of [null, [], 'invalid', true, 42]) {
    const backend = createCloudflareApplicationBackend({ id: 'cf:page', request: async () => ({ revision: 'r1', state, scopes: [] }) });
    await assert.rejects(backend.readView(), { code: 'invalid_response' });
  }
});
