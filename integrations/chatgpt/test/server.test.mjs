import test from 'node:test';
import assert from 'node:assert/strict';
import { createWidgetResource } from '../widget/resource.mjs';
import { createMcpHandler } from '../server.mjs';
import { createMemoryStore } from '../store.mjs';
import { createConsentService } from '../consent.mjs';

const APP = 'a'.repeat(64), ISSUER = 'https://issuer.example';
const ALL_SCOPES = ['tendrils:list', 'applications:read', 'applications:write', 'events:subscribe'];
async function fixture({ scopes = ALL_SCOPES, readEvents = true, queryImpl, commandImpl, inspectImpl, retryImpl, waitImpl, reapplyImpl,
  principals, authorizeImpl, providerImpl, requestsPerMinute } = {}) {
  const store = createMemoryStore(); let accountAllowed = true, queryCalls = 0, detailsCalls = 0, commands = 0;
  const consent = createConsentService({ store, authorizeOwner: async () => true });
  for (const id of ['alice', 'bob']) await consent.grant({ id, issuer: ISSUER }, { applicationId: APP,
    queries: ['assistanceStatus', 'kitchenContext'], commands: ['requestAssistance', 'replyToAssistance'], events: ['assistant.help_requested'], readEvents });
  const auth = { metadata: { resource: 'https://integration.example/mcp', authorization_servers: [ISSUER] },
    metadataUrl: 'https://integration.example/.well-known/oauth-protected-resource/mcp', challenge: () => 'Bearer resource_metadata="https://integration.example/.well-known/oauth-protected-resource/mcp"',
    async authenticate(request) {
      const token = request.headers.get('Authorization')?.replace('Bearer ', '');
      if (!principals?.[token] && !['alice', 'bob'].includes(token)) throw Object.assign(Error('unauthorized'), { status: 401, code: 'authentication_required' });
      return { id: token, issuer: ISSUER, scopes, ...structuredClone(principals?.[token] ?? {}) };
    },
  };
  const bridge = {
    listApplications: () => [{ id: APP, label: 'Kitchen' }],
    getStatus: async () => ({ applicationId: APP, deviceId: 'bridge-device', historyId: 'test-history', status: { phase: 'ready', generation: 'g1' }, ...await providerImpl?.() }),
    describeApplication: async () => ({ commands: [{ name: 'replyToAssistance' }, { name: 'dangerous' }], queries: [{ name: 'assistanceStatus' }, { name: 'private' }] }),
    query: async (...args) => { queryCalls++; return queryImpl ? queryImpl(...args) : { revision: { generation: 'g1' }, value: { requestId: 'r1', question: 'What next?', status: 'requested' } }; },
    command: async (...args) => { commands++; if (commandImpl) return commandImpl(...args);
      await args[3].beforeSubmit?.(); await args[3].onSaved?.(); return { status: 'saved', operationId: args[3].operationId }; },
    operation: async () => ({ status: 'applied', shared: false }),
    ...(inspectImpl ? { inspectOperation: inspectImpl } : {}),
    ...(retryImpl ? { retryOperation: retryImpl } : {}),
    ...(waitImpl ? { waitOperation: waitImpl } : {}),
    ...(reapplyImpl ? { reapplyOperation: reapplyImpl } : {}),
    getEvent: async () => { detailsCalls++; return { revision: { generation: 'g1' }, event: { payload: { question: 'Private question' } }, projection: { name: 'assistant.help_requested' } }; },
  };
  const outbox = { status: async () => ({ subscriptions: [], jobs: [] }), noteReply: async () => {}, resume: async (_p, args) => ({ ...args, resumed: true }) };
  const handler = createMcpHandler({ widget: createWidgetResource, auth, bridge, consent, outbox, store, resource: 'https://integration.example/mcp',
    authorizeAccountAccess: async (principal, id) => accountAllowed && id === APP && (!authorizeImpl || await authorizeImpl(principal, id)),
    ...(requestsPerMinute === undefined ? {} : { requestsPerMinute }),
    subscriptions: { list: async () => ({ events: [] }), subscribe: async (_p, params) => ({ name: params.name }), unsubscribe: async () => ({}) },
  });
  async function rpc(method, params = {}, { token = 'alice', origin, raw, contentType = 'application/json', path = '/mcp' } = {}) {
    return handler(new Request('https://integration.example' + path, { method: 'POST',
      headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), 'Content-Type': contentType, ...(origin ? { Origin: origin } : {}) },
      body: raw ?? JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }));
  }
  async function call(name, args, options) { return (await (await rpc('tools/call', { name, arguments: args }, options)).json()).result; }
  return { handler, rpc, call, store, consent, counters: () => ({ queryCalls, detailsCalls, commands }), account: value => { accountAllowed = value; } };
}

test('MCP discovery is authenticated, metadata challenges are public, and hostile browser origins fail', async () => {
  const f = await fixture();
  const missing = await f.rpc('initialize', {}, { token: null });
  assert.equal(missing.status, 401); assert.match(missing.headers.get('WWW-Authenticate'), /resource_metadata/);
  const metadata = await f.handler(new Request('https://integration.example/.well-known/oauth-protected-resource/mcp'));
  assert.equal(metadata.status, 200);
  const init = await (await f.rpc('initialize', { protocolVersion: '2025-11-25' })).json();
  assert.equal(init.result.protocolVersion, '2025-11-25'); assert.deepEqual(init.result.capabilities.events, {});
  const discovery = await (await f.rpc('server/discover')).json(); assert.deepEqual(discovery.result.supportedVersions, ['2026-07-28']);
  assert.equal((await f.rpc('ping', {}, { origin: 'https://attacker.example' })).status, 403);
});

test('scopes, account access, exact query consent and changing authorization are independent boundaries', async () => {
  const noScopes = await fixture({ scopes: ['tendrils:list'] });
  const denied = await noScopes.call('query_application', { applicationId: APP, query: 'assistanceStatus', input: { requestId: 'r1' } });
  assert.equal(denied.isError, true); assert.ok(denied._meta['mcp/www_authenticate']);
  assert.equal(noScopes.counters().queryCalls, 0);
  const f = await fixture();
  assert.equal((await f.call('query_application', { applicationId: APP, query: 'private', input: null })).isError, true);
  f.account(false);
  assert.equal((await f.call('get_kitchen_context', { applicationId: APP })).isError, true);
  assert.equal(f.counters().queryCalls, 0);
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const race = await fixture({ queryImpl: async () => { entered(); await new Promise(resolve => { release = resolve; }); return { value: 'private', revision: {} }; } });
  const pending = race.call('get_kitchen_context', { applicationId: APP }); await ready; race.account(false); release();
  assert.equal((await pending).isError, true);
});

test('event details need explicit content consent and returned declarations are filtered', async () => {
  const f = await fixture({ readEvents: false });
  assert.equal((await f.call('get_event_details', { applicationId: APP, sourceEventId: 'source' })).isError, true);
  assert.equal(f.counters().detailsCalls, 0);
  const described = await f.call('describe_application', { applicationId: APP });
  assert.deepEqual(described.structuredContent.commands.map(item => item.name), ['replyToAssistance']);
  assert.deepEqual(described.structuredContent.queries.map(item => item.name), ['assistanceStatus']);
});

test('command operation identities bind exact input and consumer without colliding across accounts', async () => {
  const f = await fixture();
  const args = { applicationId: APP, operationId: 'op-1', requestId: 'r1', requestEventId: 'event-1', answer: 'Stir gently',
    suggestedSteps: [], basedOnContextRevision: 'context-1', cookingStepId: 'step-1' };
  assert.equal((await f.call('reply_to_assistance', args)).structuredContent.operationId, 'op-1');
  assert.equal((await f.call('reply_to_assistance', args)).isError, undefined);
  assert.equal((await f.call('reply_to_assistance', { ...args, answer: 'Changed answer' })).structuredContent.code, 'OPERATION_ID_CONFLICT');
  assert.equal((await f.call('get_operation_status', { applicationId: APP, operationId: 'op-1' }, { token: 'bob' })).structuredContent.code, 'OPERATION_NOT_FOUND');
  const bob = (await f.call('reply_to_assistance', args, { token: 'bob' })).structuredContent;
  assert.equal(bob.operationId, 'op-1'); assert.match(bob.operationReference.operationId, /^integration_v2_/u);
  assert.equal(f.counters().commands, 3);
  const records = Object.values((await f.store.read()).commandOperations);
  assert.equal(records.length, 2); assert.notEqual(records[0].operationId, records[1].operationId);
  assert.equal((await f.call('get_operation_status', { applicationId: APP, operationId: 'op-1' })).structuredContent.operation.status, 'applied');
});

test('consent is rechecked after the native authority wait and before a command can submit', async () => {
  let release, entered, submitted = false;
  const ready = new Promise(resolve => { entered = resolve; });
  const f = await fixture({ commandImpl: async (_app, _name, _input, options) => {
    entered(); await new Promise(resolve => { release = resolve; });
    await options.beforeSubmit(); submitted = true; await options.onSaved(); return { status: 'saved' };
  } });
  const args = { applicationId: APP, operationId: 'blocked-command', command: 'replyToAssistance', input: { requestId: 'r1' } };
  const pending = f.call('call_application_command', args); await ready;
  const connection = (await f.consent.list({ id: 'alice', issuer: ISSUER }))[0];
  await f.consent.revoke({ id: 'alice', issuer: ISSUER }, { id: connection.id });
  release(); assert.equal((await pending).isError, true); assert.equal(submitted, false);
});

test('a rejected native collision cannot make an unrelated native operation visible through status', async () => {
  const f = await fixture({ commandImpl: async () => { throw Object.assign(Error('Native input conflict'), { code: 'OPERATION_ID_CONFLICT' }); } });
  const args = { applicationId: APP, operationId: 'existing-native-id', command: 'replyToAssistance', input: { requestId: 'r1' } };
  assert.equal((await f.call('call_application_command', args)).isError, true);
  assert.equal((await f.call('get_operation_status', { applicationId: APP, operationId: args.operationId })).structuredContent.code, 'OPERATION_IDENTITY_UNCONFIRMED');
});

test('a durably saved command remains inspectable after its response is lost, with signed header identity checked', async () => {
  let matching = true;
  const f = await fixture({ commandImpl: async (_app, _name, _input, options) => {
    await options.beforeSubmit(); await options.onSaved(); throw Error('Lost operation response');
  }, inspectImpl: async (_app, operationId) => ({ state: { status: 'applied' }, deviceId: 'bridge-device',
    identity: { applicationId: APP, operationId, command: matching ? 'replyToAssistance' : 'privateCommand', author: 'bridge-device' } }) });
  const args = { applicationId: APP, operationId: 'saved-command', command: 'replyToAssistance', input: { requestId: 'r1' } };
  assert.equal((await f.call('call_application_command', args)).structuredContent.outcome, 'uncertain');
  assert.equal((await f.call('get_operation_status', { applicationId: APP, operationId: args.operationId })).structuredContent.operation.status, 'applied');
  matching = false;
  assert.equal((await f.call('get_operation_status', { applicationId: APP, operationId: args.operationId })).structuredContent.code, 'OPERATION_IDENTITY_MISMATCH');
});

test('tools and widget work without events; correlation metadata never changes account identity', async () => {
  const f = await fixture();
  const one = await f.call('get_profile', {}), two = await f.call('get_profile', {});
  assert.equal(one.structuredContent.id, two.structuredContent.id);
  const response = await (await f.rpc('tools/call', { name: 'get_profile', arguments: {}, _meta: { 'openai/session': 'different-account-or-chat' } })).json();
  assert.equal(response.result.structuredContent.id, one.structuredContent.id);
  const tools = (await (await f.rpc('tools/list')).json()).result.tools;
  assert.ok(tools.find(item => item.name === 'get_assistance_status')._meta.ui.resourceUri);
  const widget = (await (await f.rpc('resources/read', { uri: 'ui://tendriller/assistance.html' })).json()).result.contents[0];
  assert.equal(widget.mimeType, 'text/html;profile=mcp-app');
  assert.equal((await f.call('get_assistance_status', { applicationId: APP, requestId: 'r1' })).structuredContent.assistance.question, 'What next?');
});

test('malformed, unknown and oversized input does not execute tools', async () => {
  const f = await fixture();
  assert.equal((await f.rpc('ping', {}, { raw: '{' })).status, 400);
  assert.equal((await f.rpc('ping', {}, { raw: JSON.stringify({ data: 'x'.repeat(270000) }) })).status, 413);
  assert.equal((await f.rpc('ping', {}, { contentType: 'text/plain' })).status, 415);
  assert.equal((await f.call('get_kitchen_context', { applicationId: APP, sql: 'DROP TABLE' })).isError, true);
  assert.equal(f.counters().queryCalls, 0);
});

const agent = (id, commands = ['requestAssistance', 'replyToAssistance']) => ({ id: 'alice', issuer: ISSUER,
  agentBinding: { id, revision: 1, applications: { [APP]: { queries: ['assistanceStatus', 'kitchenContext'], commands,
    events: ['assistant.help_requested'], readEvents: true } } } });
const commandArgs = (operationId = 'same-short-id') => ({ applicationId: APP, operationId,
  command: 'replyToAssistance', input: { requestId: 'r1' }, context: { runId: 'run-1', documentPath: '/kitchen' } });

test('approved consumers within one account isolate operations, retain rotation identity and revoke narrowly', async () => {
  const principals = { planner: agent('planner'), reviewer: agent('reviewer'), rotated: { ...agent('planner'), oauthGrantId: 'new-credential' }, reader: agent('reader', []) };
  const revoked = new Set();
  const f = await fixture({ principals, authorizeImpl: async principal => !revoked.has(principal.agentBinding?.id) });
  const first = (await f.call('call_application_command', commandArgs(), { token: 'planner' })).structuredContent;
  const second = (await f.call('call_application_command', commandArgs(), { token: 'reviewer' })).structuredContent;
  assert.notEqual(first.operationReference.operationId, second.operationReference.operationId);
  assert.equal(first.operationReference.consumer.agentBindingId, 'planner');
  assert.equal(first.operationReference.sourceContext.evidence, 'caller-asserted');
  const same = (await f.call('call_application_command', commandArgs(), { token: 'rotated' })).structuredContent;
  assert.equal(same.operationReference.operationId, first.operationReference.operationId);
  assert.equal((await f.call('call_application_command', { ...commandArgs(), context: { runId: 'changed-run' } }, { token: 'rotated' })).structuredContent.code, 'OPERATION_ID_CONFLICT');
  assert.equal((await f.call('call_application_command', commandArgs(), { token: 'reader' })).structuredContent.code, 'AGENT_BINDING_SCOPE_REQUIRED');
  assert.equal((await f.call('describe_application', { applicationId: APP }, { token: 'reader' })).structuredContent.commands.length, 0);
  revoked.add('planner');
  assert.equal((await f.call('get_operation_status', { applicationId: APP, operationId: 'same-short-id' }, { token: 'rotated' })).structuredContent.code, 'ACCOUNT_ACCESS_DENIED');
  assert.equal((await f.call('get_operation_status', { applicationId: APP, operationId: 'same-short-id' }, { token: 'reviewer' })).structuredContent.operation.status, 'applied');
  const spoof = (await (await f.rpc('tools/call', { name: 'get_profile', arguments: {}, _meta: { agentBindingId: 'reviewer', 'openai/session': 'reviewer' } }, { token: 'rotated' })).json()).result.structuredContent;
  assert.equal(spoof.consumer.agentBindingId, 'planner');
  assert.equal(Object.keys((await f.store.read()).commandOperations).length, 2);
});

test('lost replies recover exact native identity; retry and reviewed reapply remain distinct and signer pinned', async () => {
  const saved = new Map(); let retries = 0, reapplies = 0, replacement = false, unreachable = false;
  const persist = async (id, name, input, options) => {
    await options.beforeSubmit();
    const state = saved.get(options.operationId) ?? { status: 'saved', attemptId: `attempt-${saved.size + 1}`, operationId: options.operationId, generation: 'g1' };
    saved.set(options.operationId, state); await options.onSaved(); return state;
  };
  const f = await fixture({ principals: { planner: agent('planner'), sibling: agent('sibling') },
    providerImpl: async () => { if (unreachable) throw Error('original provider offline'); return replacement ? { deviceId: 'replacement-device' } : {}; },
    commandImpl: async (...args) => { await persist(...args); throw Error('connection lost after durable save'); },
    inspectImpl: async (_id, operationId) => saved.has(operationId) ? { state: saved.get(operationId), deviceId: 'bridge-device', identity: {
      applicationId: APP, historyId: 'test-history', operationId, command: 'replyToAssistance', author: 'bridge-device', generation: 'g1' } } : null,
    retryImpl: async (_id, operationId, options) => { await options.beforeSubmit(); retries++; return saved.get(operationId); },
    waitImpl: async (_id, operationId) => saved.get(operationId),
    reapplyImpl: async (id, originalId, name, input, options) => { assert.ok(saved.has(originalId)); reapplies++; return persist(id, name, input, options); },
  });
  const args = commandArgs(), token = { token: 'planner' };
  const uncertain = (await f.call('call_application_command', args, token)).structuredContent;
  assert.equal(uncertain.outcome, 'uncertain'); assert.equal(saved.size, 1);
  const inspected = (await f.call('inspect_application_operation', { applicationId: APP, operationId: args.operationId }, token)).structuredContent;
  assert.equal(inspected.operationReference.attemptId, 'attempt-1');
  const retry = (await f.call('retry_application_operation', { applicationId: APP, operationId: args.operationId }, token)).structuredContent;
  assert.equal(retry.operationReference.attemptId, 'attempt-1'); assert.equal(retries, 1); assert.equal(saved.size, 1);
  assert.equal((await f.call('retry_application_operation', { applicationId: APP, operationId: args.operationId }, { token: 'sibling' })).structuredContent.code, 'OPERATION_NOT_FOUND');
  const reviewed = { ...args, operationId: 'reviewed-new-id', originalOperationId: args.operationId, basedOn: { applicationId: APP, historyId: 'test-history', generation: 'g2' } };
  const reapplied = (await f.call('reapply_application_operation', reviewed, token)).structuredContent;
  assert.equal(reapplied.operationReference.attemptId, 'attempt-2'); assert.equal(reapplies, 1); assert.equal(saved.size, 2);
  replacement = true;
  const fenced = (await f.call('retry_application_operation', { applicationId: APP, operationId: args.operationId }, token)).structuredContent;
  assert.equal(fenced.code, 'PROVIDER_IDENTITY_CHANGED'); assert.equal(fenced.operationReference.deviceId, 'bridge-device');
  assert.equal(fenced.operationReference.attemptId, 'attempt-1'); assert.equal(retries, 1);
  assert.equal((await f.call('call_application_command', args, token)).structuredContent.code, 'PROVIDER_IDENTITY_CHANGED');
  unreachable = true;
  const offline = (await f.call('inspect_application_operation', { applicationId: APP, operationId: args.operationId }, token)).structuredContent;
  assert.equal(offline.code, 'PROVIDER_UNREACHABLE'); assert.equal(offline.operationReference.attemptId, 'attempt-1');
  assert.equal(offline.operationReference.historyId, 'test-history'); assert.equal(offline.outcome, 'uncertain');
  assert.equal((await f.call('call_application_command', args, token)).structuredContent.operationReference.attemptId, 'attempt-1');
});

test('one busy consumer cannot occupy siblings; named bindings share the account rate budget', async () => {
  const principals = { first: agent('first'), second: agent('second') };
  let entered = 0, release;
  const waiting = new Promise(resolve => { release = resolve; });
  let bothReady; const ready = new Promise(resolve => { bothReady = resolve; });
  const f = await fixture({ principals, queryImpl: async () => { if (++entered === 2) bothReady(); await waiting; return { value: true, revision: {} }; } });
  const one = f.call('get_kitchen_context', { applicationId: APP }, { token: 'first' });
  const two = f.call('get_kitchen_context', { applicationId: APP }, { token: 'first' });
  await ready;
  try {
    assert.equal((await f.rpc('ping', {}, { token: 'first' })).status, 429);
    assert.equal((await f.rpc('ping', {}, { token: 'second' })).status, 200);
  } finally { release(); await Promise.all([one, two]); }
  const budget = await fixture({ principals, requestsPerMinute: 2 });
  assert.equal((await budget.rpc('ping', {}, { token: 'first' })).status, 200);
  assert.equal((await budget.rpc('ping', {}, { token: 'second' })).status, 200);
  assert.equal((await budget.rpc('ping', {}, { token: 'second' })).status, 429);
});

test('consumer admission bounds slow request bodies before reading and releases failed body slots', async () => {
  const f = await fixture({ principals: { first: agent('first'), sibling: agent('sibling') } });
  const controllers = []; let reading = 0, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const request = body => new Request('https://integration.example/mcp', { method: 'POST', duplex: 'half',
    headers: { Authorization: 'Bearer first', 'Content-Type': 'application/json' }, body });
  const pending = Array.from({ length: 2 }, () => f.handler(request(new ReadableStream({
    start(controller) { controllers.push(controller); }, pull() { if (++reading === 2) entered(); },
  }, { highWaterMark: 0 }))));
  await ready;
  let rejectedReads = 0;
  try {
    const rejected = await f.handler(request(new ReadableStream({ pull(controller) {
      rejectedReads++; controller.enqueue(new TextEncoder().encode('{}')); controller.close();
    } }, { highWaterMark: 0 })));
    assert.equal(rejected.status, 429); assert.equal(rejectedReads, 0);
    assert.equal((await f.rpc('ping', {}, { token: 'sibling' })).status, 200);
  } finally { for (const controller of controllers) controller.error(Error('body disconnected')); }
  for (const response of await Promise.all(pending)) assert.equal(response.status, 400);
  assert.equal((await f.rpc('ping', {}, { token: 'first' })).status, 200);
});
