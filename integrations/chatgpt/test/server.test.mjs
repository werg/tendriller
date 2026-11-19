import test from 'node:test';
import assert from 'node:assert/strict';
import { createMcpHandler } from '../server.mjs';
import { createMemoryStore } from '../store.mjs';
import { createConsentService } from '../consent.mjs';

const APP = 'a'.repeat(64), ISSUER = 'https://issuer.example';
const ALL_SCOPES = ['tendrils:list', 'applications:read', 'applications:write', 'events:subscribe'];
async function fixture({ scopes = ALL_SCOPES, readEvents = true, queryImpl } = {}) {
  const store = createMemoryStore(); let accountAllowed = true, queryCalls = 0, detailsCalls = 0, commands = 0;
  const consent = createConsentService({ store, authorizeOwner: async () => true });
  for (const id of ['alice', 'bob']) await consent.grant({ id, issuer: ISSUER }, { applicationId: APP,
    queries: ['assistanceStatus', 'kitchenContext'], commands: ['requestAssistance', 'replyToAssistance'], events: ['assistant.help_requested'], readEvents });
  const auth = { metadata: { resource: 'https://integration.example/mcp', authorization_servers: [ISSUER] },
    metadataUrl: 'https://integration.example/.well-known/oauth-protected-resource/mcp', challenge: () => 'Bearer resource_metadata="https://integration.example/.well-known/oauth-protected-resource/mcp"',
    async authenticate(request) {
      const token = request.headers.get('Authorization')?.replace('Bearer ', '');
      if (!['alice', 'bob'].includes(token)) throw Object.assign(Error('unauthorized'), { status: 401, code: 'authentication_required' });
      return { id: token, issuer: ISSUER, scopes };
    },
  };
  const bridge = {
    listApplications: () => [{ id: APP, label: 'Kitchen' }],
    getStatus: async () => ({ applicationId: APP, status: { phase: 'ready', generation: 'g1' } }),
    describeApplication: async () => ({ commands: [{ name: 'replyToAssistance' }, { name: 'dangerous' }], queries: [{ name: 'assistanceStatus' }, { name: 'private' }] }),
    query: async (...args) => { queryCalls++; return queryImpl ? queryImpl(...args) : { revision: { generation: 'g1' }, value: { requestId: 'r1', question: 'What next?', status: 'requested' } }; },
    command: async () => { commands++; return { status: 'saved', operationId: 'op-1' }; },
    operation: async () => ({ status: 'applied', shared: false }),
    getEvent: async () => { detailsCalls++; return { revision: { generation: 'g1' }, event: { payload: { question: 'Private question' } }, projection: { name: 'assistant.help_requested' } }; },
  };
  const outbox = { status: async () => ({ subscriptions: [], jobs: [] }), noteReply: async () => {}, resume: async (_p, args) => ({ ...args, resumed: true }) };
  const handler = createMcpHandler({ auth, bridge, consent, outbox, store, resource: 'https://integration.example/mcp',
    authorizeAccountAccess: async (_principal, id) => accountAllowed && id === APP,
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

test('command operation identities bind exact input and caller, and status cannot inspect another account attempt', async () => {
  const f = await fixture();
  const args = { applicationId: APP, operationId: 'op-1', requestId: 'r1', requestEventId: 'event-1', answer: 'Stir gently',
    suggestedSteps: [], basedOnContextRevision: 'context-1', cookingStepId: 'step-1' };
  assert.equal((await f.call('reply_to_assistance', args)).structuredContent.operationId, 'op-1');
  assert.equal((await f.call('reply_to_assistance', args)).isError, undefined);
  assert.equal((await f.call('reply_to_assistance', { ...args, answer: 'Changed answer' })).structuredContent.code, 'OPERATION_ID_CONFLICT');
  assert.equal((await f.call('reply_to_assistance', args, { token: 'bob' })).structuredContent.code, 'OPERATION_ID_CONFLICT');
  assert.equal(f.counters().commands, 2);
  assert.equal((await f.call('get_operation_status', { applicationId: APP, operationId: 'op-1' }, { token: 'bob' })).structuredContent.code, 'OPERATION_NOT_FOUND');
  assert.equal((await f.call('get_operation_status', { applicationId: APP, operationId: 'op-1' })).structuredContent.operation.status, 'applied');
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
