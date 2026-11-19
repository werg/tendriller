import test from 'node:test';
import assert from 'node:assert/strict';
import { projectKitchen, summarizeKitchen, boundAssistance, visibleAssistanceStatus, kitchenEventProjection } from '../examples/kitchen/projection.mjs';
import { createAssistanceClient } from '../examples/kitchen/client.mjs';
import { createPendingStorage } from '../examples/kitchen/pending-storage.mjs';

function pendingFixture() {
  const values = new Map(); let tail = Promise.resolve();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const locks = { request(name, options, action) {
    assert.equal(options.mode, 'exclusive');
    const result = tail.then(action); tail = result.catch(() => {}); return result;
  } };
  const open = () => createPendingStorage({ key: 'application:pending', storage, locks, now: () => 100 });
  return { open, storage, locks };
}

const event = (id, payload, author = 'cook') => ({ id, topic: 'assistant', payload, author,
  operationId: `op-${id}`, authorTimestampMs: 200 });
const selectedStep = event('step-original', { type: 'step.selected', stepId: 's1', text: 'Prepare' });
const project = events => projectKitchen([selectedStep, ...events]);
const request = event('r1', { type: 'help.requested', requestId: 'request-1', kind: 'recipe_help',
  question: 'How long?', cookingStepId: 's1', cookingStepEventId: 'step-original', contextRevision: 'revision-1', expiresAtMs: 1000 });
const answer = event('a1', { type: 'help.answered', requestId: 'request-1', requestEventId: 'r1',
  answer: 'Check the texture.', suggestedSteps: ['Stir'], cookingStepId: 's1', basedOnContextRevision: 'revision-1' }, 'assistant');

test('selected history correlates one response and labels changed steps without inventing finality', () => {
  const result = project([request, answer]);
  assert.equal(result.requests[0].status, 'answered');
  assert.equal(result.requests[0].answer.operationId, 'op-a1');
  const changed = project([request, answer, event('s2', { type: 'step.selected', stepId: 's2', text: 'Serve' })]);
  assert.equal(changed.requests[0].status, 'stale');
  assert.equal(changed.requests[0].answer.answer, 'Check the texture.');
  assert.equal(project([request]).requests[0].answer, null); // Recovery excludes the response.
  const initialStep = event('step-original', { type: 'step.selected', stepId: 's1', text: 'Prepare' });
  const changedSameId = event('step-updated', { type: 'step.selected', stepId: 's1', text: 'Different preparation' });
  assert.equal(project([initialStep, request, answer]).requests[0].status, 'answered');
  assert.equal(project([initialStep, request, answer, changedSameId]).requests[0].status, 'stale');
  // The requester read the old event, but a same-name update orders first.
  assert.equal(project([changedSameId, request, answer]).requests[0].status, 'stale');
  assert.equal(project([changedSameId, request, answer]).requests[0].capturedStepEventId, selectedStep.id);
  assert.equal(projectKitchen([request, answer]).requests[0].status, 'stale');
});

test('conflicting requests, context and additional responses remain visible', () => {
  const duplicate = { ...request, id: 'r2', payload: { ...request.payload, question: 'Different?' } };
  const stale = { ...answer, id: 'a0', payload: { ...answer.payload, basedOnContextRevision: 'wrong' } };
  const value = project([request, duplicate, stale, answer, { ...answer, id: 'a2' }]).requests[0];
  assert.equal(value.question, 'How long?');
  assert.equal(value.status, 'conflicting');
  assert.equal(value.answer.eventId, 'a1');
  assert.deepEqual(value.conflicts.map(x => x.type), ['duplicate-request', 'stale-reply', 'additional-reply']);
  assert.equal(project([answer, request]).requests[0].answer, null);
  assert.equal(project([request, request, answer]).requests[0].conflicts.length, 0);
});

test('only requester cancellation is honored; expiry is explicit display evidence', () => {
  const bad = event('c1', { type: 'help.cancelled', requestId: 'request-1' }, 'assistant');
  assert.equal(project([request, bad]).requests[0].cancelled, false);
  assert.equal(project([request, { ...bad, author: 'cook' }]).requests[0].status, 'cancelled');
  assert.equal(visibleAssistanceStatus(project([request]).requests[0], 1001), 'expired');
  const late = project([request, { ...answer, authorTimestampMs: 1001 }]).requests[0];
  assert.equal(late.answer, null);
  assert.deepEqual(late.replies[0].reasons, ['late-by-author-clock']);
});

test('egress sends request metadata and never reply text or a self-triggering response', () => {
  const outbound = kitchenEventProjection(request);
  assert.equal(outbound.name, 'assistant.help_requested');
  assert.equal(outbound.data.request_id, 'request-1');
  assert.equal(JSON.stringify(outbound).includes('How long?'), false);
  assert.equal(kitchenEventProjection(answer), null);
});

test('context and single-request details stay bounded with long answer history', () => {
  const events = [];
  for (let i = 0; i < 70; i++) {
    events.push({ ...request, id: `request-${i}`, payload: { ...request.payload, requestId: `request-${i}`, question: 'q'.repeat(4000) } });
    events.push({ ...answer, id: `answer-${i}`, payload: { ...answer.payload, requestId: `request-${i}`, requestEventId: `request-${i}`, answer: 'a'.repeat(8000) } });
  }
  const value = project(events), summary = summarizeKitchen(value);
  assert.ok(Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024);
  assert.equal(summary.requestCount, 70); assert.equal(summary.requests.length, 20); assert.equal(summary.requestsTruncated, true);
  assert.ok(summary.requests.every(value => value.questionPreview.length === 240 && !('answer' in value) && !('replies' in value)));
  assert.ok(Buffer.byteLength(JSON.stringify(summary)) < 20000);
  const repeated = project([request, ...Array.from({ length: 100 }, (_, i) => ({ ...answer, id: `repeat-${i}`,
    payload: { ...answer.payload, answer: '😀'.repeat(4000), suggestedSteps: Array(12).fill('😀'.repeat(250)) } }))]).requests[0];
  const detail = boundAssistance(repeated);
  assert.equal(detail.replyCount, 100); assert.equal(detail.replies.length, 8); assert.equal(detail.repliesTruncated, true);
  assert.equal(detail.conflictCount, 99); assert.equal(detail.conflicts.length, 32); assert.equal(detail.conflictsTruncated, true);
  assert.equal(detail.answer.eventId, 'repeat-0');
  assert.ok(Buffer.byteLength(JSON.stringify(detail)) < 512 * 1024);
});

test('uncertain submit survives restart with its exact operation and input', async () => {
  let saved = null, calls = [], fail = true;
  const pendingStorage = pendingFixture().open();
  const session = { operations: { async get() { return saved; } },
    async command(name, input, options) { calls.push({ name, input, options }); if (fail) throw Error('response lost'); return {}; },
    async retry(id) { calls.push({ retry: id }); return {}; } };
  const options = { pendingStorage,
    now: () => 100, randomId: (() => { let id = 0; return () => `id-${++id}`; })() };
  const client = createAssistanceClient(session, options);
  await assert.rejects(client.request({ question: 'Help', cookingStepId: 's1', cookingStepEventId: 'step-1', contextRevision: 'r1' }), /response lost/);
  await assert.rejects(client.request({ question: 'Again', cookingStepId: 's1', cookingStepEventId: 'step-1', contextRevision: 'r1' }), /UNRESOLVED/);
  fail = false;
  await createAssistanceClient(session, options).resume();
  assert.deepEqual(calls[0], calls[1]);
  saved = { status: 'saved' };
  await client.resume();
  assert.deepEqual(calls[2], { retry: 'id-2' });
  saved = { status: 'abandoned' };
  await assert.rejects(client.resume(), /EXPLICIT_REAPPLICATION/);
  await assert.rejects(client.acknowledge(), /UNCERTAIN/);
  saved = { status: 'applied', outcome: 'accepted' };
  await client.acknowledge();
  assert.equal(pendingStorage.load(), null);
});

test('separate tabs atomically reserve one pending operation and can retry it exactly', async () => {
  const f = pendingFixture(), calls = [], options = { now: () => 100 };
  const session = { command: async (...args) => { calls.push(args); return {}; }, operations: { get: async () => null } };
  const one = createAssistanceClient(session, { ...options, pendingStorage: f.open(), randomId: () => 'one' });
  const two = createAssistanceClient(session, { ...options, pendingStorage: f.open(), randomId: () => 'two' });
  const results = await Promise.allSettled([
    one.selectStep({ stepId: 's1', text: 'Prepare' }), two.selectStep({ stepId: 's2', text: 'Serve' }),
  ]);
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
  assert.match(results.find(value => value.status === 'rejected').reason.message, /UNRESOLVED/);
  assert.equal(calls.length, 1); assert.equal(f.open().load().operationId, 'one');
  await two.resume(); assert.deepEqual(calls[1], calls[0]);
});

test('a late acknowledge cannot clear a newer tab reservation', async () => {
  const storage = pendingFixture().open(); let finish;
  const nativeState = new Promise(resolve => { finish = resolve; });
  await storage.reserve({ command: 'setCookingStep', input: { stepId: 's1', text: 'Prepare' }, operationId: 'old' });
  const client = createAssistanceClient({ operations: { get: async () => nativeState } }, { pendingStorage: storage });
  const acknowledging = client.acknowledge();
  await Promise.resolve(); // The old operation has been captured before its native read.
  await storage.clear('old');
  await storage.reserve({ command: 'setCookingStep', input: { stepId: 's2', text: 'Serve' }, operationId: 'new' });
  finish({ status: 'applied' }); await acknowledging;
  assert.equal(storage.load().operationId, 'new');
});

test('terminal resolution requires review, retains its exact reference, and never reapplies', async () => {
  const storage = pendingFixture().open(), pending = { command: 'setCookingStep', input: { stepId: 's1', text: 'Prepare' }, operationId: 'old' };
  await storage.reserve(pending); let status = 'saved', sends = 0;
  const client = createAssistanceClient({ operations: { get: async () => ({ status }) },
    command: async () => { sends++; }, retry: async () => { sends++; } }, { pendingStorage: storage });
  await assert.rejects(client.resolve({ operationId: 'old' }), /CONFIRMATION_REQUIRED/);
  await assert.rejects(client.resolve({ operationId: 'old', confirmed: true }), /UNCERTAIN/);
  status = 'abandoned';
  await assert.rejects(client.resume(), /EXPLICIT_REAPPLICATION/);
  await client.resolve({ operationId: 'old', confirmed: true });
  assert.equal(storage.load(), null); assert.equal(sends, 0);
  assert.deepEqual(storage.resolved(), [{ pending, status: 'abandoned', resolvedAt: 100 }]);
  assert.equal(storage.lastOperationId(), 'old');
  await storage.reserve({ ...pending, operationId: 'new' });
  assert.equal(await storage.resolve('old', 'needsReapply'), false);
  assert.equal(storage.load().operationId, 'new');
});

test('invalid trimmed input and unavailable atomic storage never create a pending command', async () => {
  const f = pendingFixture(), pendingStorage = f.open(); let sends = 0;
  const session = { command: async () => { sends++; } }, client = createAssistanceClient(session, { pendingStorage });
  for (const input of [{ stepId: ' ', text: 'Prepare' }, { stepId: 's1', text: '\n ' }]) {
    assert.throws(() => client.selectStep(input), /INPUT_INVALID/);
  }
  await assert.rejects(client.request({ question: ' \n', cookingStepId: 's1', contextRevision: 'r1' }), /INPUT_INVALID/);
  await assert.rejects(client.request({ question: 'Help', cookingStepId: 's1', contextRevision: 'r1', kind: 'unknown' }), /INPUT_INVALID/);
  assert.equal(pendingStorage.load(), null); assert.equal(sends, 0);
  const unavailable = createAssistanceClient(session, { pendingStorage: createPendingStorage({ key: 'other', storage: f.storage, locks: null }) });
  await assert.rejects(unavailable.selectStep({ stepId: 's1', text: 'Prepare' }), /CROSS_TAB_LOCK_UNAVAILABLE/);
  assert.equal(sends, 0);
});

test('actual native kitchen definition correlates a second-device response and survives reopen',
  { skip: !process.env.CHRONOLOG_SESSION_PACKAGE, timeout: 30000 }, async () => {
    const { createNativeFixture, loadNativePackage } = await import('./native-fixture.mjs');
    const { mkdtemp, cp, mkdir, symlink, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { pathToFileURL } = await import('node:url');
    const { packagePath } = await loadNativePackage();
    // Install only the exact public package into an isolated consumer. The
    // authored definition retains its normal package import unchanged.
    const directory = await mkdtemp(join(tmpdir(), 'kitchen-definition-'));
    let fixture;
    try {
      await mkdir(join(directory, 'node_modules', '@chronolog'), { recursive: true });
      await symlink(packagePath, join(directory, 'node_modules', '@chronolog', 'peer-session'), 'dir');
      for (const name of ['domain.mjs', 'projection.mjs']) await cp(new URL(`../examples/kitchen/${name}`, import.meta.url), join(directory, name));
      const { definition } = await import(pathToFileURL(join(directory, 'domain.mjs')).href);
      fixture = await createNativeFixture(definition, { historyId: 'kitchen-native-test' });
      const a = await fixture.open(0), b = await fixture.open(1);
      const link = fixture.track(await fixture.peer.connectApplications(a.session, b.session));
      const applied = async (session, name, input, operationId) => {
        const operation = await session.command(name, input, { operationId });
        const state = await operation.applied({ signal: AbortSignal.timeout(5000) });
        assert.equal(state.outcome, 'accepted');
        await link.synchronize();
      };
      await applied(a.session, 'setCookingStep', { stepId: 's1', text: 'Prepare' }, 'step-1');
      const context = await a.session.query('kitchenContext', null);
      const input = { requestId: 'help-1', question: 'How long?', kind: 'recipe_help', cookingStepId: 's1',
        cookingStepEventId: context.value.currentStep.eventId,
        contextRevision: JSON.stringify(context.revision), expiresAtMs: Date.now() + 900000 };
      await applied(a.session, 'requestAssistance', input, 'request-1');
      const request = await b.session.query('assistanceStatus', { requestId: 'help-1' });
      assert.equal(request.value.status, 'requested');
      const reply = { requestId: 'help-1', requestEventId: request.value.requestEventId, answer: 'Check its texture.',
        suggestedSteps: ['Stir'], cookingStepId: 's1', basedOnContextRevision: request.value.contextRevision };
      await applied(b.session, 'replyToAssistance', reply, 'reply-1');
      const original = await b.session.operations.inspect('reply-1');
      await applied(b.session, 'replyToAssistance', reply, 'reply-1');
      assert.deepEqual((await b.session.operations.inspect('reply-1')).attempt, original.attempt);
      const status = await a.session.query('assistanceStatus', { requestId: 'help-1' });
      assert.equal(status.value.status, 'answered'); assert.equal(status.value.replies.length, 1);
      assert.equal(status.value.answer.author, b.session.deviceId);
      await applied(a.session, 'setCookingStep', { stepId: 's1', text: 'Serve' }, 'step-2');
      await applied(a.session, 'requestAssistance', { ...input, requestId: 'raced-help' }, 'raced-request');
      const raced = await b.session.query('assistanceStatus', { requestId: 'raced-help' });
      assert.equal(raced.value.status, 'stale');
      assert.equal(raced.value.capturedStepEventId, context.value.currentStep.eventId);
      await applied(b.session, 'replyToAssistance', { ...reply, requestId: 'raced-help', requestEventId: raced.value.requestEventId }, 'raced-reply');
      assert.equal((await a.session.query('assistanceStatus', { requestId: 'raced-help' })).value.status, 'stale');
      await link.close(); await a.session.close();
      const reopened = await fixture.open(0, true);
      assert.equal((await reopened.session.query('assistanceStatus', { requestId: 'help-1' })).value.answer.answer, 'Check its texture.');
    } finally { await fixture?.close(); await rm(directory, { recursive: true, force: true }); }
  });
