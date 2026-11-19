import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceAgentAdapter } from '../workspace-agent.mjs';

const applicationId = 'a'.repeat(64), principal = { id: 'owner-one' };
const input = { applicationId, sourceEventId: 'event-1', operationId: 'trigger-1' };
function fixture(overrides = {}) {
  let state = {}, selected = true, allowed = true, now = 1000;
  const sent = [];
  const store = { async read() { return structuredClone(state); }, async transaction(fn) {
    const copy = structuredClone(state), result = fn(copy); state = copy; return structuredClone(result);
  } };
  const bridge = { async getEvent(id, eventId) { return selected ? {
    applicationId: id, revision: { generation: 'g1' }, event: { id: eventId, operationId: 'request-1', payload: { question: 'PRIVATE QUESTION', photo: 'PRIVATE IMAGE' } },
    projection: { name: 'assistant.help_requested', data: { request_id: 'request-1', summary: 'UNTRUSTED INSTRUCTIONS' } },
  } : null; }, assertSelection(id, revision) {
    assert.equal(id, applicationId);
    if (!selected || revision?.generation !== 'g1') throw Object.assign(Error('APPLICATION_VIEW_RECOVERED'), { code: 'APPLICATION_VIEW_RECOVERED' });
  } };
  const options = { store, bridge, triggerId: 'agtch_fixed', accessToken: 'private-token', authorize: async () => allowed,
    clock: () => now, fetchImpl: async (url, init) => {
      sent.push({ url, init });
      return new Response(JSON.stringify({ conversation_url: 'https://chatgpt.com/c/abc', agent_trigger_run_id: 'apirun_one' }), { status: 202 });
    }, ...overrides };
  return { store, bridge, options, sent, adapter: createWorkspaceAgentAdapter(options),
    setSelected(value) { selected = value; }, setAllowed(value) { allowed = value; }, setNow(value) { now = value; } };
}

test('fixed trigger persists intent before I/O and sends only metadata with stable keys', async () => {
  const f = fixture();
  const original = f.options.fetchImpl;
  f.options.fetchImpl = async (url, init) => {
    const record = Object.values((await f.store.read()).workspaceAgentOperations)[0];
    assert.equal(record.state, 'sending'); assert.equal(record.attempts, 1);
    return original(url, init);
  };
  const adapter = createWorkspaceAgentAdapter(f.options), result = await adapter.trigger(principal, input);
  assert.equal(result.state, 'accepted'); assert.equal(result.runStatus, 'queued');
  assert.equal(result.conversationUrl, 'https://chatgpt.com/c/abc'); assert.equal(result.answer, undefined);
  const request = f.sent[0];
  assert.equal(request.url, 'https://api.chatgpt.com/v1/workspace_agents/agtch_fixed/trigger');
  assert.equal(request.init.redirect, 'error'); assert.equal(request.init.headers.Authorization, 'Bearer private-token');
  assert.equal(request.init.headers['OpenAI-Beta'], 'workspace_agent_runs=v1');
  assert.match(request.init.headers['Idempotency-Key'], /^tendriller-[a-f0-9]{64}$/);
  assert.doesNotMatch(request.init.body, /PRIVATE|UNTRUSTED/);
  assert.match(JSON.parse(request.init.body).conversation_key, /^tendriller-[a-f0-9]{64}$/);
  await adapter.trigger(principal, input); assert.equal(f.sent.length, 1);
  assert.ok(!JSON.stringify(await f.store.read()).includes('private-token'));
});

test('operation identity is bound to the owner and source even across adapter restart', async () => {
  const f = fixture(); await f.adapter.trigger(principal, input);
  const restarted = createWorkspaceAgentAdapter(f.options);
  await assert.rejects(restarted.trigger(principal, { ...input, sourceEventId: 'other-event' }), /OPERATION_CONFLICT/);
  await assert.rejects(restarted.status({ id: 'other' }, { operationId: input.operationId }), /NOT_FOUND/);
  await restarted.trigger({ id: 'other' }, input);
  assert.equal(f.sent.length, 2);
  assert.notEqual(f.sent[0].init.headers['Idempotency-Key'], f.sent[1].init.headers['Idempotency-Key']);
});

test('same subject from another issuer cannot read receipts or reuse the conversation', async () => {
  const f = fixture(), one = { id: 'shared-subject', issuer: 'https://issuer.one' }, two = { id: 'shared-subject', issuer: 'https://issuer.two' };
  await f.adapter.trigger(one, input);
  await assert.rejects(f.adapter.status(two, { operationId: input.operationId }), /NOT_FOUND/);
  await f.adapter.trigger(two, input);
  assert.notEqual(JSON.parse(f.sent[0].init.body).conversation_key, JSON.parse(f.sent[1].init.body).conversation_key);
  const owners = Object.values((await f.store.read()).workspaceAgentOperations).map(value => value.ownerId);
  assert.deepEqual(owners, [JSON.stringify([one.issuer, one.id]), JSON.stringify([two.issuer, two.id])]);
});

test('journal capacity rejects new operations before provider I/O and preserves exact retries', async () => {
  const f = fixture({ maxOperations: 1 });
  await f.adapter.trigger(principal, input);
  await assert.rejects(f.adapter.trigger(principal, { ...input, operationId: 'beyond-limit' }), /OPERATION_LIMIT/);
  assert.equal(f.sent.length, 1);
  assert.equal(Object.keys((await f.store.read()).workspaceAgentOperations).length, 1);
  assert.equal((await f.adapter.trigger(principal, input)).state, 'accepted');
  assert.equal(f.sent.length, 1);
  assert.throws(() => createWorkspaceAgentAdapter({ ...f.options, maxOperations: 0 }), /CONFIGURATION_INVALID/);
});

test('concurrent calls recheck identity and use the persisted delivery lease', async () => {
  let enter, finish;
  const entered = new Promise(resolve => { enter = resolve; }), response = new Promise(resolve => { finish = resolve; });
  let calls = 0;
  const f = fixture({ fetchImpl: async () => { calls++; enter(); return response; } });
  const first = f.adapter.trigger(principal, input);
  await entered;
  await assert.rejects(f.adapter.trigger(principal, { ...input, sourceEventId: 'different' }), /OPERATION_CONFLICT/);
  assert.equal((await f.adapter.trigger(principal, input)).state, 'sending');
  f.setAllowed(false);
  await assert.rejects(f.adapter.trigger(principal, input), /ACCESS_DENIED/);
  finish(new Response(JSON.stringify({ conversation_url: 'https://chatgpt.com/c/abc' }), { status: 202 }));
  assert.equal((await first).state, 'accepted'); assert.equal(calls, 1);
});

test('lost acceptance retries the original input and key, and recovery blocks new triggers', async () => {
  const requests = []; let fail = true;
  const f = fixture({ fetchImpl: async (url, init) => {
    requests.push({ url, init }); if (fail) throw Error('socket includes private-token');
    return new Response(JSON.stringify({ conversation_url: 'https://chatgpt.com/c/abc' }), { status: 202 });
  } });
  assert.equal((await f.adapter.trigger(principal, input)).state, 'uncertain');
  assert.ok(!JSON.stringify(await f.store.read()).includes('private-token'));
  f.setSelected(false);
  await assert.rejects(createWorkspaceAgentAdapter(f.options).trigger(principal, input), /SOURCE_NOT_SELECTED/);
  assert.equal(requests.length, 1);
  f.setSelected(true); fail = false;
  const result = await createWorkspaceAgentAdapter(f.options).trigger(principal, input);
  assert.equal(result.state, 'accepted'); assert.equal(result.attempts, 2);
  assert.equal(requests[0].init.body, requests[1].init.body);
  assert.equal(requests[0].init.headers['Idempotency-Key'], requests[1].init.headers['Idempotency-Key']);
  f.setSelected(false);
  assert.equal((await f.adapter.trigger(principal, input)).sourceCurrent, false);
  assert.equal(requests.length, 2);
});

test('revocation is checked before reading and again before the provider request', async () => {
  const f = fixture(); f.setAllowed(false);
  let reads = 0; f.options.bridge = { ...f.bridge, getEvent: async () => { reads++; return null; } };
  await assert.rejects(createWorkspaceAgentAdapter(f.options).trigger(principal, input), /ACCESS_DENIED/);
  assert.equal(reads, 0); assert.equal(f.sent.length, 0);
  const g = fixture(); g.options.getAccessToken = async () => { g.setAllowed(false); return 'private-token'; };
  await assert.rejects(createWorkspaceAgentAdapter(g.options).trigger(principal, input), /ACCESS_DENIED/);
  assert.equal(g.sent.length, 0);
});

test('crash lease and attempt budget prevent unbounded sends', async () => {
  const f = fixture({ maxAttempts: 2, fetchImpl: async () => { throw Error('lost'); } });
  await f.adapter.trigger(principal, input);
  await f.store.transaction(state => { const row = Object.values(state.workspaceAgentOperations)[0]; row.state = 'sending'; row.leaseId = 'crashed'; row.leaseUntil = 10000; });
  assert.equal((await createWorkspaceAgentAdapter(f.options).trigger(principal, input)).attempts, 1);
  f.setNow(10001);
  assert.equal((await createWorkspaceAgentAdapter(f.options).trigger(principal, input)).attempts, 2);
  await assert.rejects(f.adapter.trigger(principal, input), /RECONCILIATION_REQUIRED/);
});

test('lease/state is checked after slow authorization before any provider request', async () => {
  const f = fixture();
  f.options.authorize = async () => {
    await f.store.transaction(state => {
      const row = Object.values(state.workspaceAgentOperations ?? {})[0];
      if (row?.state === 'sending') {
        row.state = 'accepted'; row.conversationUrl = 'https://chatgpt.com/c/other-worker-receipt';
        row.acceptedAt = 1001; delete row.leaseId; delete row.leaseUntil;
      }
    });
    return true;
  };
  const result = await createWorkspaceAgentAdapter(f.options).trigger(principal, input);
  assert.equal(result.state, 'accepted'); assert.equal(result.conversationUrl, 'https://chatgpt.com/c/other-worker-receipt');
  assert.equal(f.sent.length, 0);
});

test('recovery during final asynchronous consent is reread before provider egress', async () => {
  const f = fixture();
  f.options.authorize = async () => {
    const record = Object.values((await f.store.read()).workspaceAgentOperations ?? {})[0];
    if (record?.state === 'sending') f.setSelected(false);
    return true;
  };
  await assert.rejects(createWorkspaceAgentAdapter(f.options).trigger(principal, input), /SOURCE_NOT_SELECTED/);
  assert.equal(f.sent.length, 0);
  const row = Object.values((await f.store.read()).workspaceAgentOperations)[0];
  assert.equal(row.sourceCurrent, false); assert.equal(row.state, 'prepared');
  assert.equal(row.leaseId, undefined);
});

test('native revision fence blocks recovery during the final durable lease read', async () => {
  const f = fixture(), read = f.store.read;
  f.store.read = async () => {
    const state = await read();
    if (Object.values(state.workspaceAgentOperations ?? {})[0]?.state === 'sending') f.setSelected(false);
    return state;
  };
  await assert.rejects(f.adapter.trigger(principal, input), /APPLICATION_VIEW_RECOVERED/);
  assert.equal(f.sent.length, 0);
  const row = Object.values((await read()).workspaceAgentOperations)[0];
  assert.equal(row.sourceCurrent, false); assert.equal(row.state, 'prepared');
  assert.equal(row.leaseId, undefined);
});

test('late accepted receipt survives an expired lease and a later uncertain attempt', async () => {
  let entered, resolveFirst;
  const waiting = new Promise(resolve => { entered = resolve; }), firstResponse = new Promise(resolve => { resolveFirst = resolve; });
  let sends = 0;
  const f = fixture({ timeoutMs: 10, fetchImpl: async () => {
    sends++;
    if (sends === 1) { entered(); return firstResponse; }
    return new Response('', { status: 500 });
  } });
  const first = f.adapter.trigger(principal, input);
  await waiting; f.setNow(10000);
  assert.equal((await createWorkspaceAgentAdapter(f.options).trigger(principal, input)).state, 'uncertain');
  f.setSelected(false);
  await assert.rejects(f.adapter.trigger(principal, input), /SOURCE_NOT_SELECTED/);
  resolveFirst(new Response(JSON.stringify({ conversation_url: 'https://chatgpt.com/c/late-accepted' }), { status: 202 }));
  const result = await first;
  assert.equal(result.state, 'accepted'); assert.equal(result.sourceCurrent, false); assert.equal(result.attempts, 2);
  assert.equal((await f.adapter.trigger(principal, input)).conversationUrl, 'https://chatgpt.com/c/late-accepted');
  assert.equal(sends, 2);
});

test('invalid accepted receipts and redirects remain uncertain and reveal no unsafe link', async () => {
  for (const response of [
    () => new Response(JSON.stringify({ conversation_url: 'https://evil.example/c/abc' }), { status: 202 }),
    () => new Response(JSON.stringify({ conversation_url: 'https://chatgpt.com/c/abc', agent_trigger_run_id: '../../other' }), { status: 202 }),
    () => new Response('x'.repeat(70000), { status: 202 }),
    () => new Response('', { status: 302, headers: { location: 'https://evil.example/' } }),
  ]) {
    const f = fixture({ fetchImpl: async () => response() });
    const result = await f.adapter.trigger(principal, input);
    assert.equal(result.state, 'uncertain'); assert.equal(result.conversationUrl, undefined);
  }
});

test('run status checks fixed provider identity and never claims a signed write-back', async () => {
  const f = fixture(); await f.adapter.trigger(principal, input);
  let polls = 0;
  f.options.fetchImpl = async (url, init) => {
    polls++; assert.equal(url, 'https://api.chatgpt.com/v1/workspace_agents/agtch_fixed/runs/apirun_one');
    assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error');
    return new Response(JSON.stringify({ object: 'workspace_agent.trigger_run', id: 'apirun_one', api_trigger_id: 'agtch_fixed',
      conversation_url: 'https://chatgpt.com/c/abc', status: 'completed', error: null }));
  };
  const restarted = createWorkspaceAgentAdapter(f.options);
  const status = await restarted.status(principal, { operationId: input.operationId });
  assert.equal(status.runStatus, 'completed'); assert.equal(status.answer, undefined); assert.match(status.writeback, /does not return the answer/);
  await restarted.status(principal, { operationId: input.operationId }); assert.equal(polls, 1);
});

test('approved sibling agents keep independent provider keys and conversations across token rotation', async () => {
  const f = fixture(), first = { ...principal, agentBindingId: 'planner' }, second = { ...principal, agentBindingId: 'reviewer' };
  await f.adapter.trigger(first, input);
  await assert.rejects(f.adapter.status(second, { operationId: input.operationId }), /NOT_FOUND/);
  await f.adapter.trigger(second, input);
  assert.equal(f.sent.length, 2);
  assert.notEqual(f.sent[0].init.headers['Idempotency-Key'], f.sent[1].init.headers['Idempotency-Key']);
  assert.notEqual(JSON.parse(f.sent[0].init.body).conversation_key, JSON.parse(f.sent[1].init.body).conversation_key);
  await createWorkspaceAgentAdapter(f.options).trigger({ ...first, oauthGrantId: 'new-token' }, input);
  assert.equal(f.sent.length, 2);
});
