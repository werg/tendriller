import test from 'node:test';
import assert from 'node:assert/strict';
import { createIntegration } from '../integration.mjs';
import { startHttpService } from '../run.mjs';
import { createMemoryStore } from '../store.mjs';
import { createSessionBridge } from '../bridge.mjs';

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

test('configured journal limits are enforced and zero cannot silently become a default', async () => {
  const f = config(); f.value.bridge.command = async () => ({ state: 'saved' });
  const service = await createIntegration({ ...f.value, maxOperations: 1 });
  try {
    await service.consent.grant(principal, { applicationId: APP, commands: ['replyToAssistance'] });
    const call = async operationId => (await (await service.handler(new Request(f.value.resource, {
      method: 'POST', headers: { Authorization: 'Bearer fixture', 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'call_application_command',
        arguments: { applicationId: APP, operationId, command: 'replyToAssistance', input: { requestId: 'r1' } } } }),
    }))).json()).result;
    assert.equal((await call('op-1')).isError, undefined);
    assert.equal((await call('op-2')).structuredContent.code, 'OPERATION_JOURNAL_FULL');
    assert.equal(Object.keys((await service.store.read()).commandOperations).length, 1);
  } finally { await service.close(); }
  await assert.rejects(createIntegration({ ...config().value, maxProfiles: 0 }), /positive bounded/);
});

test('an explicitly configured management path reaches the authenticated consent UI', async () => {
  const f = config(), service = await createIntegration({ ...f.value, management: {
    path: '/settings/connections', authenticate: async () => principal,
    applicationsForPrincipal: async () => [{ applicationId: APP, queries: ['assistanceStatus'], commands: [], events: [] }], csrfKey: Buffer.alloc(32),
  } });
  try {
    const response = await service.handler(new Request('https://integration.example/settings/connections'));
    assert.equal(response.status, 200); const html = await response.text(); assert.match(html, /Connect ChatGPT/);
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)[1];
    const saved = await service.handler(new Request('https://integration.example/settings/connections', {
      method: 'POST', headers: { Origin: 'https://integration.example', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf, action: 'grant', applicationId: APP, queries: 'assistanceStatus', days: '30' }),
    }));
    assert.equal(saved.status, 303); assert.equal(saved.headers.get('Location'), '/settings/connections');
    assert.equal((await service.handler(new Request('https://integration.example/connections'))).status, 404);
  } finally { await service.close(); }
});

test('disconnect invalidates an in-flight subscription refresh even if consent is subsequently regranted', async () => {
  const f = config(); let hold = false, release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  f.value.delivery.send = async (_url, { body }) => {
    const payload = JSON.parse(body);
    if (hold) { entered(); await new Promise(resolve => { release = resolve; }); }
    return { status: 200, body: JSON.stringify({ challenge: payload.challenge }) };
  };
  const service = await createIntegration(f.value);
  try {
    const selection = { applicationId: APP, events: ['assistant.help_requested'] };
    const consent = await service.consent.grant(principal, selection);
    const input = { name: 'assistant.help_requested', arguments: { application_id: APP },
      delivery: { mode: 'webhook', url: 'https://callback.example/event', secret: 'whsec_' + Buffer.alloc(32).toString('base64') } };
    await service.subscriptions.subscribe(principal, input);
    hold = true;
    const pending = service.subscriptions.subscribe(principal, { ...input, delivery: { ...input.delivery, secret: 'whsec_' + Buffer.alloc(32, 1).toString('base64') } });
    await ready; await service.consent.revoke(principal, { id: consent.id });
    await service.consent.grant(principal, selection); release();
    await assert.rejects(pending, /changed while/);
    assert.equal((await service.subscriptions.active()).length, 0);
  } finally { await service.close(); }
});

test('shutdown aborts a native control lookup before awaiting its blocked observer', async () => {
  const f = config(); let entered, nativeAborted = false;
  const ready = new Promise(resolve => { entered = resolve; });
  const bridge = createSessionBridge({ applications: [{ id: APP, allowedQueries: [], allowedCommands: [], eventTopics: [],
    openSession: async () => ({ session: { applicationId: APP, deviceId: 'b'.repeat(64), close: async () => {} },
      control: { application: async ({ signal }) => new Promise((_resolve, reject) => {
        entered(); signal.addEventListener('abort', () => { nativeAborted = true; reject(signal.reason); }, { once: true });
      }) },
    }),
  }] });
  const service = await createIntegration({ ...f.value, bridge });
  try {
    await service.consent.grant(principal, { applicationId: APP, events: ['assistant.help_requested'] });
    await service.store.transaction(state => { state.subscriptions = { sub: { id: 'sub', applicationId: APP, owner: principal,
      active: true, version: 1, activationId: 'activation', name: 'assistant.help_requested', sourceCursor: null, expiresAt: Date.now() + 60000 } }; });
    service.start(); await ready;
    let timer;
    await Promise.race([service.close(), new Promise((_resolve, reject) => { timer = setTimeout(() => reject(Error('Shutdown stayed blocked in native control')), 1000); })]).finally(() => clearTimeout(timer));
    assert.equal(nativeAborted, true);
  } finally { await bridge.close(); await service.close(); }
});

test('an old account denial cannot disable a subsequently refreshed subscription', async () => {
  const f = config(); let hold = false, held = false, release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  f.value.authorizeAccountAccess = async () => {
    if (hold && !held) { held = true; entered(); await new Promise(resolve => { release = resolve; }); return false; }
    return true;
  };
  const service = await createIntegration(f.value);
  try {
    const selection = { applicationId: APP, events: ['assistant.help_requested'] };
    await service.consent.grant(principal, selection);
    const input = { name: 'assistant.help_requested', arguments: { application_id: APP },
      delivery: { mode: 'webhook', url: 'https://callback.example/event', secret: 'whsec_' + Buffer.alloc(32).toString('base64') } };
    const first = await service.subscriptions.subscribe(principal, input);
    await pause();
    hold = true;
    const oldRecheck = service.consent.grant(principal, selection);
    await ready;
    await service.subscriptions.subscribe(principal, input);
    const refreshed = (await service.store.read()).subscriptions[first.id];
    release(); await oldRecheck;
    const current = (await service.store.read()).subscriptions[first.id];
    assert.equal(current.active, true); assert.equal(current.version, refreshed.version);
    assert.equal(current.secret, input.delivery.secret); assert.equal(current.stopReason, undefined);
  } finally { release?.(); await service.close(); }
});

test('HTTP shutdown drains admitted requests before closing their shared dependencies', async () => {
  const f = config(); let entered, release;
  const ready = new Promise(resolve => { entered = resolve; });
  f.value.authorizeAccountAccess = async () => { entered(); await new Promise(resolve => { release = resolve; }); return true; };
  const service = await startHttpService({ ...f.value, port: 0 });
  const pending = fetch(`http://127.0.0.1:${service.address.port}/mcp`, { method: 'POST',
    headers: { Authorization: 'Bearer fixture', 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_tendrils', arguments: {} } }) }).then(async response => response.json());
  await ready;
  const closing = service.close(); await pause(); assert.equal(f.closed(), false);
  release(); const result = await pending; assert.equal(result.result.structuredContent.applications.length, 1);
  await closing; assert.equal(f.closed(), true);
});

test('HTTP shutdown deadline aborts a pending account request before closing its store', async () => {
  const f = config(); let entered, aborted = false;
  const ready = new Promise(resolve => { entered = resolve; });
  f.value.authorizeAccountAccess = async actor => new Promise((_resolve, reject) => {
    entered(); actor.requestSignal.addEventListener('abort', () => { aborted = true; reject(actor.requestSignal.reason); }, { once: true });
  });
  const service = await startHttpService({ ...f.value, port: 0, shutdownTimeoutMs: 25 });
  const pending = fetch(`http://127.0.0.1:${service.address.port}/mcp`, { method: 'POST',
    headers: { Authorization: 'Bearer fixture', 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_kitchen_context', arguments: { applicationId: APP } } }) }).catch(error => error);
  await ready; await service.close(); await pending;
  assert.equal(aborted, true); assert.equal(f.closed(), true);
});

test('HTTP shutdown deadline also releases a blocked native read before store closure', async () => {
  const f = config(); let entered, rejectRead;
  const ready = new Promise(resolve => { entered = resolve; });
  f.value.bridge.getStatus = async () => new Promise((_resolve, reject) => { entered(); rejectRead = reject; });
  const originalClose = f.value.bridge.close;
  f.value.bridge.close = async () => { rejectRead?.(new DOMException('Native owner stopped', 'AbortError')); await originalClose(); };
  const service = await startHttpService({ ...f.value, port: 0, shutdownTimeoutMs: 25 });
  await service.integration.consent.grant(principal, { applicationId: APP, queries: ['assistanceStatus'] });
  const pending = fetch(`http://127.0.0.1:${service.address.port}/mcp`, { method: 'POST',
    headers: { Authorization: 'Bearer fixture', 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_application_status', arguments: { applicationId: APP } } }) }).catch(error => error);
  await ready; await service.close(); await pending; assert.equal(f.closed(), true);
});
