import { beforeAll, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { createPeerIdentity, participantGrant, signTransitionRequest, type AuthorityBundle } from '@chronolog/peer-generation/control';
import { create, inDO } from './helpers';
import { peerApiJson } from './peer-exchange';
import { authenticateAgentToken } from '../src/access';
import { selectProvider } from '../src/assistant-bindings';
import { route } from '../src/router';
import { oauthConfig as loadOAuthConfig, signAccessToken } from '../src/accounts/oauth-support';
import { sha256Hex } from '../src/ids';

const ORIGIN = 'https://tendriller.dev';
const SCOPE = 'applications:read applications:write tendrils:list';
const DEFINITION = {
  id: 'http-gateway-test', version: '1', schema: null,
  queries: [{ name: 'notes', description: 'Notes', input: { type: 'null' } }],
  commands: [{ name: 'add', description: 'Add', input: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } }],
} as const;

let signingJwk: string;
beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  signingJwk = JSON.stringify({ ...await crypto.subtle.exportKey('jwk', pair.privateKey), alg: 'ES256', kid: 'gw-key' });
});

it('serves outbound HTTPS polling gateway (/v1/apps/:appId/*) and batched MCP commands over real OAuth + DO admission', async () => {
  const handle = await create({ listener: false });
  const device = await createPeerIdentity();
  const authority = await peerApiJson<AuthorityBundle>(handle, 'control/configure', {
    historyId: 'gw-history', executionManifestDigest: '12'.repeat(32), definition: DEFINITION,
    schemaAdministrator: device.publicKey, epoch: 0, keyDigest: '34'.repeat(32),
    members: [{ grant: participantGrant(device.publicKey, { administrator: true }) }],
  });
  const gen = await peerApiJson<{ id: string }>(handle, 'control/select', {
    request: await signTransitionRequest({
      applicationId: handle.application.id, profile: authority.descriptor.payload.profile,
      policy: authority.descriptor.payload.policy, transitionId: crypto.randomUUID(),
      requester: device.publicKey, coordinator: device.publicKey, expectedGeneration: null,
      controlRevision: 0, reason: 'create', base: null,
    }, device),
  });

  const account = await inDO(handle.id, t => t.db.get<string>('owner_account', ''));
  const grant = crypto.randomUUID();
  const now = Date.now();
  await env.ACCOUNTS.prepare(`INSERT INTO integration_oauth_grants(id,account_id,client_id,resource,scope,created_at,expires_at)
    VALUES(?,?,'gw-client',?,?,?,?)`).bind(grant, account, `${ORIGIN}/mcp`, SCOPE, now, now + 3_600_000).run();
  await env.ACCOUNTS.prepare(`INSERT INTO assistant_connections(page_id,owner_account,application_id,label,enabled)
    VALUES(?,?,?,?,1)`).bind(handle.id, account, handle.application.id, 'GW Test').run();

  const oauthConfig = JSON.stringify({
    resource: `${ORIGIN}/mcp`,
    clients: [{ id: 'gw-client', redirectUris: ['https://chatgpt.com/connector_platform_oauth_redirect'], scopes: SCOPE.split(' ') }],
  });

  let clientSocket!: WebSocket;
  const recordedOps = new Map<string, { operationId: string; text: string }>();
  await inDO(handle.id, async t => {
    t.env.OAUTH_SIGNING_JWK = signingJwk;
    t.env.OAUTH_CONFIG_JSON = oauthConfig;
    const agent = await authenticateAgentToken(t, handle.token);
    const version = crypto.randomUUID();
    t.db.set('assistant_connection', {
      id: version, version, inboxVersion: version, owner: account,
      applicationId: handle.application.id, label: 'GW Test',
      queries: DEFINITION.queries, commands: DEFINITION.commands, events: [],
    });
    const hash = 'a'.repeat(64);
    t.db.set('assistant_adapters', { agent, hashes: [hash] });
    selectProvider(t, hash);
    t.db.set('assistant_adapter_epoch:' + hash, 1);
    const [client, server] = Object.values(new WebSocketPair());
    t.ctx.acceptWebSocket(server, ['application-mcp']);
    server.serializeAttachment({ tag: 'application-mcp', adapterHash: hash, deviceId: device.publicKey, connectionEpoch: 1 });
    client.addEventListener('message', event => {
      const msg = JSON.parse(event.data as string);
      if (msg.type !== 'call') return;
      if (msg.kind === 'query') {
        client.send(JSON.stringify({ type: 'result', id: msg.id, value: { revision: { generation: gen.id, sequence: recordedOps.size }, value: [...recordedOps.values()] } }));
      } else if (msg.kind === 'command') {
        recordedOps.set(msg.operationId, { operationId: msg.operationId, text: msg.input.text });
        client.send(JSON.stringify({
          type: 'result', id: msg.id,
          value: { state: { status: 'applied', outcome: msg.input.text === 'reject' ? 'rejected' : 'accepted', operationId: msg.operationId, author: device.publicKey, generation: gen.id, sequence: recordedOps.size, attemptId: 'att-' + recordedOps.size } },
        }));
      } else if (msg.kind === 'operation') {
        const hit = recordedOps.get(msg.operationId);
        client.send(JSON.stringify({
          type: 'result', id: msg.id,
          value: hit ? { state: { status: 'applied', outcome: msg.input.text === 'reject' ? 'rejected' : 'accepted', operationId: msg.operationId, author: device.publicKey, generation: gen.id, sequence: 1, attemptId: 'att-1' } } : null,
        }));
      }
    });
    client.accept();
    clientSocket = client;
  });

  const testEnv = { ...env, PUBLIC_BASE: ORIGIN, OAUTH_SIGNING_JWK: signingJwk, OAUTH_CONFIG_JSON: oauthConfig };
  const cfg = (await loadOAuthConfig(testEnv))!;
  const issuedAt = Math.floor(now / 1000);
  const expiresAt = issuedAt + cfg.accessTokenTtlSeconds;
  const jti = crypto.randomUUID();
  const token = await signAccessToken(cfg, {
    iss: cfg.issuer, sub: account, aud: cfg.resource, client_id: 'gw-client',
    scope: SCOPE, iat: issuedAt, exp: expiresAt, jti, sid: grant,
  });
  await env.ACCOUNTS.prepare(`INSERT INTO integration_oauth_access(hash,grant_id,jti,scope,created_at,expires_at)
    VALUES(?,?,?,?,?,?)`).bind(await sha256Hex(token), grant, jti, SCOPE, issuedAt * 1000, expiresAt * 1000).run();
  const authHeader = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  try {
    // 1. Unauthenticated HTTPS gateway returns 401 challenge
    const denied = await route(new Request(`${ORIGIN}/v1/apps/${handle.application.id}/query?query=notes`), testEnv);
    expect(denied.status).toBe(401);

    // A malformed later item must not partially submit the valid first item.
    for (const commands of [null, {}, [null], [{ command: 'add', input: { text: 'must-not-submit' }, operationId: 'invalid-batch-first' }, null]]) {
      const invalid = await route(new Request(`${ORIGIN}/v1/apps/${handle.application.id}/commands/batch`, {
        method: 'POST', headers: authHeader, body: JSON.stringify({ commands }),
      }), testEnv);
      expect(invalid.status).toBe(400);
      expect(recordedOps.size).toBe(0);
      const mcpInvalid = await route(new Request(`${ORIGIN}/mcp`, {
        method: 'POST', headers: authHeader, body: JSON.stringify({ jsonrpc: '2.0', id: 2,
          method: 'tools/call', params: { name: 'call_application_commands_batch', arguments: { applicationId: handle.application.id, commands } } }),
      }), testEnv);
      expect((await mcpInvalid.json<{ result: { isError: boolean } }>()).result.isError).toBe(true);
      expect(recordedOps.size).toBe(0);
    }
    for (const suffix of ['query?query=notes&input=bad-json', 'events?since=not-json', 'events?limit=100']) {
      const invalid = await route(new Request(`${ORIGIN}/v1/apps/${handle.application.id}/${suffix}`, { headers: authHeader }), testEnv);
      expect(invalid.status).toBe(400);
    }
    const crossOrigin = await route(new Request(`${ORIGIN}/v1/apps/${handle.application.id}/query?query=notes`, {
      headers: { ...authHeader, Origin: 'https://elsewhere.example' },
    }), testEnv);
    expect(crossOrigin.status).toBe(403);

    // 2. HTTPS Polling Gateway batched commands
    const batchRes = await route(new Request(`${ORIGIN}/v1/apps/${handle.application.id}/commands/batch`, {
      method: 'POST', headers: authHeader,
      body: JSON.stringify({
        commands: [
          { command: 'add', input: { text: 'one' }, operationId: 'http-op-1' },
          { command: 'add', input: { text: 'two' }, operationId: 'http-op-2' },
        ],
      }),
    }), testEnv);
    expect(batchRes.status).toBe(200);
    const batchJson = await batchRes.json<{ results: { ok: boolean; operationId: string; result: { outcome: string } }[] }>();
    expect(batchJson.results.map(r => [r.ok, r.operationId, r.result.outcome])).toEqual([
      [true, 'http-op-1', 'applied'],
      [true, 'http-op-2', 'applied'],
    ]);

    // 3. HTTPS Polling Gateway operation inspect + query + events
    const inspectRes = await route(new Request(`${ORIGIN}/v1/apps/${handle.application.id}/operations/http-op-1`, { headers: authHeader }), testEnv);
    expect(inspectRes.status).toBe(200);
    expect((await inspectRes.json<{ outcome: string }>()).outcome).toBe('applied');

    const queryRes = await route(new Request(`${ORIGIN}/v1/apps/${handle.application.id}/query`, {
      method: 'POST', headers: authHeader, body: JSON.stringify({ query: 'notes', input: null }),
    }), testEnv);
    expect(queryRes.status).toBe(200);
    expect((await queryRes.json<{ value: unknown[] }>()).value).toHaveLength(2);

    const eventsRes = await route(new Request(`${ORIGIN}/v1/apps/${handle.application.id}/events?limit=5`, { headers: authHeader }), testEnv);
    expect(eventsRes.status).toBe(200);

    // 4. MCP batched command tool
    const mcpBatch = await route(new Request(`${ORIGIN}/mcp`, {
      method: 'POST', headers: authHeader,
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'call_application_commands_batch', arguments: {
          applicationId: handle.application.id,
          commands: [{ command: 'add', input: { text: 'three' }, operationId: 'mcp-op-3' }],
        } },
      }),
    }), testEnv);
    expect(mcpBatch.status).toBe(200);
    const mcpBody = await mcpBatch.json<{ result: { structuredContent: { results: { ok: boolean }[] } } }>();
    expect(mcpBody.result.structuredContent.results[0].ok).toBe(true);
    const stopped = await route(new Request(`${ORIGIN}/v1/apps/${handle.application.id}/commands/batch`, {
      method: 'POST', headers: authHeader, body: JSON.stringify({ stopOnError: true, commands: [
        { command: 'add', input: { text: 'reject' }, operationId: 'reject-first' },
        { command: 'add', input: { text: 'must-not-submit' }, operationId: 'after-rejection' },
      ] }),
    }), testEnv);
    const stoppedBody = await stopped.json<{ results: unknown[]; complete: boolean; nextIndex: number }>();
    expect(stoppedBody.results).toHaveLength(1);
    expect(stoppedBody.complete).toBe(false);
    expect(stoppedBody.nextIndex).toBe(1);
    expect(recordedOps.size).toBe(4);
  } finally {
    await inDO(handle.id, () => { clientSocket.close(); });
  }
});
