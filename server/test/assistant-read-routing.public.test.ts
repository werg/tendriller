import { beforeAll, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { createPeerIdentity, participantGrant, signTransitionRequest, generationStartRoot,
  type AuthorityBundle, type SignedGeneration } from '@chronolog/peer-generation/control';
import { agentPrincipal, create, inDO } from './helpers';
import { peerApiJson } from './peer-exchange';
import { assistantRequest } from '../src/assistant';
import { selectProvider } from '../src/assistant-bindings';

const origin = 'https://tendriller.dev', scope = 'applications:read applications:write';
const definition = { id: 'read-routing', version: '1', schema: null,
  queries: [{ name: 'notes', description: 'Notes', input: { type: 'null' } }],
  commands: [{ name: 'append', description: 'Append', input: { type: 'null' } }] } as const;
let signing: string;
beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  signing = JSON.stringify({ ...await crypto.subtle.exportKey('jwk', pair.privateKey), alg: 'ES256', kid: 'read-routing' });
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture(count = 1) {
  const handle = await create({ listener: false }), device = await createPeerIdentity();
  const authority = await peerApiJson<AuthorityBundle>(handle, 'control/configure', {
    historyId: 'read-routing', executionManifestDigest: '12'.repeat(32),
    definition,
    schemaAdministrator: device.publicKey, epoch: 0, keyDigest: '34'.repeat(32),
    members: [{ grant: participantGrant(device.publicKey, { administrator: true }) }],
  });
  const select = async (current: SignedGeneration | null) => peerApiJson<SignedGeneration>(handle, 'control/select', {
    request: await signTransitionRequest({ applicationId: handle.application.id, profile: authority.descriptor.payload.profile,
      policy: authority.descriptor.payload.policy, transitionId: crypto.randomUUID(), requester: device.publicKey,
      coordinator: device.publicKey, expectedGeneration: current?.id ?? null, controlRevision: 0,
      reason: current ? 'takeover' : 'create', base: current ? { point: { generation: current.id, sequence: 0,
        root: await generationStartRoot(current) }, receipt: null, bridge: [] } : null }, device),
  });
  const generation = await select(null), grant = crypto.randomUUID(), now = Date.now();
  const account = await inDO(handle.id, t => t.db.get<string>('owner_account', ''));
  await env.ACCOUNTS.prepare(`INSERT INTO integration_oauth_grants(id,account_id,client_id,resource,scope,created_at,expires_at)
    VALUES(?,?,'read-routing',?,?,?,?)`).bind(grant, account, origin + '/mcp', scope, now, now + 3600000).run();
  const calls = Array.from({ length: count }, () => deferred<{ id: string }>()), clients: WebSocket[] = [];
  await inDO(handle.id, async t => {
    t.env.OAUTH_SIGNING_JWK = signing;
    t.env.OAUTH_CONFIG_JSON = JSON.stringify({ resource: origin + '/mcp', clients: [{ id: 'read-routing',
      redirectUris: ['https://chatgpt.com/connector_platform_oauth_redirect'], scopes: scope.split(' ') }] });
    const agent = agentPrincipal(t, handle), version = crypto.randomUUID();
    t.db.set('assistant_connection', { id: version, version, inboxVersion: version, owner: account,
      applicationId: handle.application.id, label: 'Routing fixture', queries: definition.queries,
      commands: definition.commands, events: [] });
    const hashes = Array.from({ length: Math.max(1, count) }, (_, i) => String(i + 1).repeat(64));
    t.db.set('assistant_adapters', { agent, hashes });
    // Exact post-approval boundary; no application bytes or native execution are needed.
    if (hashes.length) selectProvider(t, hashes[0]);
    for (const [i, hash] of hashes.slice(0, count).entries()) {
      t.db.set('assistant_adapter_epoch:' + hash, 1);
      const [client, server] = Object.values(new WebSocketPair());
      t.ctx.acceptWebSocket(server, ['application-mcp']);
      server.serializeAttachment({ tag: 'application-mcp', adapterHash: hash, deviceId: device.publicKey, connectionEpoch: 1, agentId: agent.agentId, principal: agent });
      client.addEventListener('message', event => { const body = JSON.parse(event.data as string); if (body.type === 'call') calls[i].resolve(body); });
      client.accept(); clients.push(client);
    }
  });
  // Drive the real callAssistantAdapter timeout callback after actual dispatch,
  // without waiting five seconds or changing any production timeout.
  const timers: (() => void)[] = [], realTimeout = globalThis.setTimeout;
  const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (ms === 5000) timers.push(() => callback(...args));
    return realTimeout(callback, ms, ...args);
  }) as typeof setTimeout);
  const run = (method = 'query_application') => inDO(handle.id, async t => {
    const response = await assistantRequest(t, new Request('https://tendril.internal/assistant', {
      method: 'POST', body: JSON.stringify({ applicationId: handle.application.id, method,
        params: method === 'query_application' ? { query: 'notes', input: null } : { command: 'append', input: null, operationId: 'original-write' },
        principal: { account, grant, client: 'read-routing', scopes: scope.split(' '), expires: now + 3600000 } }),
    }));
    return response.json();
  });
  return { handle, grant, generation, select, calls, clients, run,
    timeout() { expect(timers.length).toBeGreaterThan(0); timers.shift()!(); },
    close() { spy.mockRestore(); for (const client of clients) client.close(); },
  };
}

it('keeps an online read timeout after exhausting candidates instead of saying start a participant', async () => {
  const f = await fixture();
  try {
    const pending = f.run(); const result = expect(pending).rejects.toMatchObject({ status: 504, code: 'application_call_timed_out' });
    await f.calls[0].promise; f.timeout(); await result;
    expect(f.clients[0].readyState).toBe(WebSocket.READY_STATE_OPEN);
  } finally { f.close(); }
});
it('reports offline when no participant was initially online', async () => {
  const f = await fixture(0);
  try { await expect(f.run()).rejects.toMatchObject({ status: 503, code: 'application_participant_offline' }); }
  finally { f.close(); }
});
it('allows a healthy fallback to answer after the first read times out', async () => {
  const f = await fixture(2);
  try {
    const pending = f.run(); await f.calls[0].promise; f.timeout();
    const call = await f.calls[1].promise;
    f.clients[1].send(JSON.stringify({ type: 'result', id: call.id, value: ['backup'] }));
    expect(await pending).toEqual({ value: ['backup'] });
  } finally { f.close(); }
});
it('retains the timeout when the remaining fallback disconnects', async () => {
  const f = await fixture(2);
  try {
    const pending = f.run(), result = expect(pending).rejects.toMatchObject({ status: 504, code: 'application_call_timed_out' });
    await f.calls[0].promise; f.timeout(); await f.calls[1].promise; f.clients[1].close(); await result;
  } finally { f.close(); }
});
it('rechecks authorization instead of returning a remembered timeout after revocation', async () => {
  const f = await fixture();
  try {
    const pending = f.run(), result = expect(pending).rejects.toMatchObject({ status: 403, code: 'authorization_revoked' });
    await f.calls[0].promise;
    await env.ACCOUNTS.prepare('UPDATE integration_oauth_grants SET revoked_at=? WHERE id=?').bind(Date.now(), f.grant).run();
    f.timeout(); await result;
  } finally { f.close(); }
});
it('rechecks the selected generation before returning a remembered timeout', async () => {
  const f = await fixture();
  try {
    const pending = f.run(), result = expect(pending).rejects.toMatchObject({ status: 409, code: 'application_generation_changed' });
    await f.calls[0].promise; await f.select(f.generation); f.timeout(); await result;
  } finally { f.close(); }
});
it('keeps timed out writes uncertain under their original operation identity', async () => {
  const f = await fixture();
  try {
    const pending = f.run('call_application_command'); await f.calls[0].promise; f.timeout();
    expect(await pending).toMatchObject({ value: { operationId: 'original-write', outcome: 'uncertain',
      code: 'operation_uncertain', reason: 'application_call_timed_out' } });
  } finally { f.close(); }
});

it('keeps the timeout after every online read candidate times out', async () => {
  const f = await fixture(2);
  try {
    const pending = f.run(), result = expect(pending).rejects.toMatchObject({ status: 504, code: 'application_call_timed_out' });
    await f.calls[0].promise; f.timeout(); await f.calls[1].promise; f.timeout(); await result;
    expect(f.clients.every(client => client.readyState === WebSocket.READY_STATE_OPEN)).toBe(true);
  } finally { f.close(); }
});
