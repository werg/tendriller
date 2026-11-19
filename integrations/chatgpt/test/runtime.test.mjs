import test from 'node:test';
import assert from 'node:assert/strict';
import { createIntegration } from '../integration.mjs';
import { startHttpService } from '../run.mjs';
import { createMemoryStore } from '../store.mjs';

const APP = 'a'.repeat(64), principal = { id: 'owner', issuer: 'https://issuer.example', scopes: ['tendrils:list', 'applications:read', 'applications:write', 'events:subscribe'] };
const revision = { applicationId: APP, generation: 'g1' };
const pause = () => new Promise(resolve => setTimeout(resolve, 10));
async function until(check) { for (let n = 0; n < 200; n++) { if (await check()) return; await pause(); } throw Error('Runtime condition did not settle'); }
function config() {
  const store = createMemoryStore(); let observed = 0, stopped = 0, closed = false, nextEvent;
  const sent = [];
  const auth = { metadata: { resource: 'https://integration.example/mcp', authorization_servers: [principal.issuer] },
    metadataUrl: 'https://integration.example/.well-known/oauth-protected-resource', challenge: () => 'Bearer resource_metadata="https://integration.example/.well-known/oauth-protected-resource"',
    async authenticate(request) { if (request.headers.get('Authorization') !== 'Bearer fixture') throw Object.assign(Error('auth'), { status: 401 }); return principal; } };
  const bridge = {
    listApplications: () => [{ id: APP, label: 'Kitchen' }],
    getStatus: async () => ({ applicationId: APP, status: { phase: 'ready', generation: 'g1' } }),
    readEvents: async () => ({ applicationId: APP, revision, cursor: 'tail', hasMore: false, events: [] }),
    query: async () => ({ revision, value: { question: 'How should I cook this?', requestId: 'r1' } }),
    verifySource: async () => ({ selected: true }),
    async *observe(_id, { signal }) {
      observed++;
      try {
        while (!signal.aborted) {
          const event = await new Promise(resolve => {
            const stop = () => { signal.removeEventListener('abort', stop); resolve(null); };
            nextEvent = value => { signal.removeEventListener('abort', stop); resolve(value); };
            signal.addEventListener('abort', stop, { once: true });
          });
          if (event) yield { kind: 'events', applicationId: APP, cursor: 'next', revision, hasMore: false, events: [event] };
        }
      } finally { stopped++; }
    },
    async close() { closed = true; },
  };
  return {
    value: { resource: auth.metadata.resource, store, auth, bridge, tickMs: 25,
      authorizeAccountAccess: async (actor, id) => actor.id === principal.id && id === APP,
      authorizeOwner: async () => true,
      delivery: { send: async (_url, { body }) => { const parsed = JSON.parse(body);
        if (parsed.type === 'verification') return { status: 200, body: JSON.stringify({ challenge: parsed.challenge }) };
        sent.push(parsed); return { status: 202, body: '' };
      } } },
    sent, emit: value => nextEvent(value), observed: () => observed, stopped: () => stopped, closed: () => closed,
  };
}

test('actual HTTP listener routes MCP/auth/discovery and cleanly closes its enrolled bridge', async () => {
  const f = config(), service = await startHttpService({ ...f.value, port: 0 });
  const origin = `http://127.0.0.1:${service.address.port}`;
  try {
    const metadata = await fetch(origin + '/.well-known/oauth-protected-resource');
    assert.equal(metadata.status, 200); assert.equal((await metadata.json()).resource, f.value.resource);
    const unauthorized = await fetch(origin + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(unauthorized.status, 401); assert.match(unauthorized.headers.get('WWW-Authenticate'), /resource_metadata/); await unauthorized.text();
    const response = await fetch(origin + '/mcp', { method: 'POST', headers: { Authorization: 'Bearer fixture', 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }) });
    assert.equal((await response.json()).result.serverInfo.name, 'tendriller-assistant');
    const health = await (await fetch(origin + '/health')).json(); assert.equal(health.liveChatGptVerified, false);
  } finally { await service.close(); }
  assert.equal(f.closed(), true);
});

test('worker consumes native change notifications, dispatches persisted events, and stops on disconnect', async () => {
  const f = config(), service = await createIntegration(f.value);
  try {
    const consent = await service.consent.grant(principal, { applicationId: APP, queries: ['assistanceStatus'],
      events: ['assistant.help_requested'], readEvents: false });
    const sub = await service.subscriptions.subscribe(principal, { name: 'assistant.help_requested', arguments: { application_id: APP },
      delivery: { mode: 'webhook', url: 'https://callback.example/event', secret: 'whsec_' + Buffer.alloc(32).toString('base64') } });
    service.start(); service.start();
    await until(() => f.observed() === 1);
    f.emit({ name: 'assistant.help_requested', sourceEventId: 'source-1', sourceOperationId: 'op-1', revision,
      data: { request_id: 'r1', summary: 'Help requested' } });
    await until(() => f.sent.length === 1);
    assert.equal((await service.store.read()).subscriptions[sub.id].sourceCursor, 'next');
    assert.equal((await service.outbox.status(principal, APP)).jobs[0].state, 'accepted');
    await service.consent.revoke(principal, { id: consent.id });
    assert.equal((await service.subscriptions.active()).length, 0);
    await until(() => f.stopped() === 1);
    assert.equal((await service.store.read()).subscriptions[sub.id].secret, undefined);
  } finally { await service.close(); }
  assert.throws(() => service.start(), /closed/);
});

test('per-principal rate limits apply before MCP work without exposing credentials', async () => {
  const f = config(), service = await createIntegration({ ...f.value, requestsPerMinute: 1 });
  const request = () => new Request(f.value.resource, { method: 'POST', headers: { Authorization: 'Bearer fixture', 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) });
  try {
    assert.equal((await service.handler(request())).status, 200);
    const limited = await service.handler(request()); assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('Retry-After')) > 0); assert.doesNotMatch(await limited.text(), /fixture/);
  } finally { await service.close(); }
});
