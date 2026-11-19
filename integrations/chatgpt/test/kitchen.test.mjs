import test from 'node:test';
import assert from 'node:assert/strict';
import { projectKitchen, visibleAssistanceStatus, kitchenEventProjection } from '../examples/kitchen/projection.mjs';
import { createAssistanceClient } from '../examples/kitchen/client.mjs';

const event = (id, payload, author = 'cook') => ({ id, topic: 'assistant', payload, author,
  operationId: `op-${id}`, authorTimestampMs: 200 });
const request = event('r1', { type: 'help.requested', requestId: 'request-1', kind: 'recipe_help',
  question: 'How long?', cookingStepId: 's1', contextRevision: 'revision-1', expiresAtMs: 1000 });
const answer = event('a1', { type: 'help.answered', requestId: 'request-1', requestEventId: 'r1',
  answer: 'Check the texture.', suggestedSteps: ['Stir'], cookingStepId: 's1', basedOnContextRevision: 'revision-1' }, 'assistant');

test('selected history correlates one response and labels changed steps without inventing finality', () => {
  const result = projectKitchen([request, answer]);
  assert.equal(result.requests[0].status, 'answered');
  assert.equal(result.requests[0].answer.operationId, 'op-a1');
  const changed = projectKitchen([request, answer, event('s2', { type: 'step.selected', stepId: 's2', text: 'Serve' })]);
  assert.equal(changed.requests[0].status, 'stale');
  assert.equal(changed.requests[0].answer.answer, 'Check the texture.');
  assert.equal(projectKitchen([request]).requests[0].answer, null); // Recovery excludes the response.
});

test('conflicting requests, context and additional responses remain visible', () => {
  const duplicate = { ...request, id: 'r2', payload: { ...request.payload, question: 'Different?' } };
  const stale = { ...answer, id: 'a0', payload: { ...answer.payload, basedOnContextRevision: 'wrong' } };
  const value = projectKitchen([request, duplicate, stale, answer, { ...answer, id: 'a2' }]).requests[0];
  assert.equal(value.question, 'How long?');
  assert.equal(value.status, 'conflicting');
  assert.equal(value.answer.eventId, 'a1');
  assert.deepEqual(value.conflicts.map(x => x.type), ['duplicate-request', 'stale-reply', 'additional-reply']);
  assert.equal(projectKitchen([answer, request]).requests[0].answer, null);
  assert.equal(projectKitchen([request, request, answer]).requests[0].conflicts.length, 0);
});

test('only requester cancellation is honored; expiry is explicit display evidence', () => {
  const bad = event('c1', { type: 'help.cancelled', requestId: 'request-1' }, 'assistant');
  assert.equal(projectKitchen([request, bad]).requests[0].cancelled, false);
  assert.equal(projectKitchen([request, { ...bad, author: 'cook' }]).requests[0].status, 'cancelled');
  assert.equal(visibleAssistanceStatus(projectKitchen([request]).requests[0], 1001), 'expired');
  const late = projectKitchen([request, { ...answer, authorTimestampMs: 1001 }]).requests[0];
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

test('uncertain submit survives restart with its exact operation and input', async () => {
  let pending = null, saved = null, calls = [], fail = true;
  const session = { operations: { async get() { return saved; } },
    async command(name, input, options) { calls.push({ name, input, options }); if (fail) throw Error('response lost'); return {}; },
    async retry(id) { calls.push({ retry: id }); return {}; } };
  const options = { savePending: async value => { pending = structuredClone(value); }, loadPending: async () => pending,
    now: () => 100, randomId: (() => { let id = 0; return () => `id-${++id}`; })() };
  const client = createAssistanceClient(session, options);
  await assert.rejects(client.request({ question: 'Help', cookingStepId: 's1', contextRevision: 'r1' }), /response lost/);
  await assert.rejects(client.request({ question: 'Again', cookingStepId: 's1', contextRevision: 'r1' }), /UNRESOLVED/);
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
  assert.equal(pending, null);
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
      await link.close(); await a.session.close();
      const reopened = await fixture.open(0, true);
      assert.equal((await reopened.session.query('assistanceStatus', { requestId: 'help-1' })).value.answer.answer, 'Check its texture.');
    } finally { await fixture?.close(); await rm(directory, { recursive: true, force: true }); }
  });
