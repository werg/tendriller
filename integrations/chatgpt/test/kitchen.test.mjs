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
