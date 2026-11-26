/**
 * Hosted `/mcp` JSON-RPC gateway, `/v1/apps/:appId/*` HTTPS polling gateway, and `/connections` UI.
 *
 * Uses OAuth-token-wrapped keys (`wrapPrivateKey` extracted from the Bearer token in RAM only)
 * to execute directly inside each page's hosted Chronolog MCP participant with zero local daemon
 * or WebSocket adapter proxy.
 */
import { registerAccountAgent } from './agents';
import { getAccountEntitlements } from './billing/entitlements';
import { listActiveBroadcasts } from './broadcasts';
import type { Env } from './env';
import { assistantDiscovery, assistantGuide, assistantGuides } from './mcp-guide';
import { serviceIdentity } from './service-identity';
import { browserIdentity, ensureOAuthSchema, redirect } from './accounts/oauth-data';
import { inspectAccessToken } from './accounts/oauth-tokens';
import { base64url } from './accounts/oauth-support';
import { servicePage } from './accounts/ui';
import { escapeHtml } from './inject';
import { renderAccountExternalConnectionsSection } from './oauth-outbound/routes';
import { HttpError, isPlainObject, json, readBody } from './http';
import { sha256Hex } from './ids';
import { APP_ID, REQUEST_LIMIT, mcpOAuth, fields, listConnected, requireScope, resolveConnection, string, type McpPrincipal, type Rpc } from './mcp-shared';

const PROTOCOL = '2025-11-25';
const supported = [PROTOCOL, '2025-06-18', '2025-03-26', '2026-07-28'];
const discoveryMethods = new Set(['initialize', 'server/discover', 'ping', 'tools/list', 'resources/list', 'resources/templates/list', 'resources/read']);
const schemaString = { type: 'string', minLength: 1 };
const app = { applicationId: { type: 'string', pattern: '^[a-f0-9]{64}$' } };
const handlePattern = '^[a-z][a-z0-9_-]{1,31}$';

const tool = (name: string, description: string, scope: string | null, properties: object, required: string[], readOnlyHint = true) => ({
  name,
  description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
  securitySchemes: [{ type: 'oauth2', scopes: scope ? [scope] : [] }],
  annotations: { readOnlyHint, destructiveHint: !readOnlyHint, idempotentHint: true, openWorldHint: !readOnlyHint },
  scope,
});

const tools = [
  {
    ...tool('tendril_guide', 'Start here to build a Tendriller app, connect an existing app, discover UI and sensor capabilities, or recover setup. Returns complete maintained instructions without a browsing tool.', null,
      { topic: { type: 'string', enum: Object.keys(assistantGuides), default: 'start' } }, []),
    securitySchemes: [{ type: 'noauth' }],
  },
  {
    ...tool('get_broadcasts', 'Read active Ed25519-signed system broadcasts (dependency upgrade notices, security advisories, maintenance windows) and public verification keys for this service.', null,
      {
        audience: { type: 'string', enum: ['agents', 'mcp', 'page_owners', 'page_all', 'dashboard'] },
        since: { type: 'integer', minimum: 0 },
      }, []),
    securitySchemes: [{ type: 'noauth' }],
  },
  {
    ...tool('get_profile', 'Identify the linked account and this service origin.', null, {}, []),
    _meta: { 'openai/profile': true },
    outputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' }, serviceOrigin: { type: 'string' }, environment: { type: 'object' }, build: { type: 'object' },
        readiness: { type: 'object' }, setup: { type: 'object' }, broadcasts: { type: 'object' }, account: { type: 'object' },
      },
      required: ['id'],
    },
  },
  tool('register_agent', 'Register a workspace maintenance agent under this linked account. Choose a short, speakable lowercase handle (e.g. atlas, reviewer) and optional bio, generate an Ed25519 signing key and an X25519 key-wrap key pair first (`tendril workspace key` prints both public keys), and send only the public keys. Returns a private agent token once; calling again with the same handle rotates the token and keys.',
    'tendrils:create',
    {
      handle: { type: 'string', pattern: handlePattern, description: 'Self-chosen lowercase handle (2-32 chars: a-z, 0-9, _, -).' },
      bio: { type: 'string', maxLength: 160, description: 'Optional short summary of this agent’s role or capabilities.' },
      publicKey: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' },
      wrapKey: { type: 'string', pattern: '^[0-9a-f]{64}$', description: 'X25519 key-wrap public key (64 lowercase hex) that page members seal data keys to.' },
    },
    ['handle', 'publicKey', 'wrapKey'], false),
  tool('list_tendrils', 'List applications opted into hosted MCP for this OAuth grant, 100 per call.',
    'tendrils:list', { cursor: { type: 'string', pattern: '^[a-z2-7]{12}$' } }, []),
  tool('describe_application', 'Inspect allowed commands, queries, page agent @handle roster, and primary-agent status.',
    'applications:read', app, ['applicationId']),
  tool('agents_list', 'List all agents on this page (handles, bios, public keys, primary status).',
    'applications:read', app, ['applicationId']),
  tool('agent_feed', 'Read the page’s multi-agent chat conversation, agent-to-agent activity backchannel, and receipts.',
    'applications:read', app, ['applicationId']),
  tool('agent_message', 'Post a signed message in the page’s Chronolog multi-agent pipe (`chat` for user-visible conversation, `agents` for agent-to-agent backchannel). Target specific peers by @handle or public key, or leave `to` empty for the primary agent. Set `expectReply: false` on acknowledgments/final handoffs to prevent loops.',
    'applications:write',
    {
      ...app,
      channel: { type: 'string', enum: ['chat', 'agents'], default: 'chat' },
      to: { type: 'array', items: schemaString, maxItems: 16 },
      text: { type: 'string', minLength: 1, maxLength: 8000 },
      data: { type: 'object' },
      attachments: { type: 'array', maxItems: 8, items: { type: 'object' } },
      inReplyTo: { type: 'object', properties: { author: schemaString, operationId: schemaString }, required: ['author', 'operationId'], additionalProperties: false },
      hopCount: { type: 'integer', minimum: 0, maximum: 5 },
      expectReply: { type: 'boolean' },
      replyToUser: { type: 'boolean' },
      operationId: schemaString,
    },
    ['applicationId', 'text', 'operationId'], false),
  tool('query_application', 'Run a declared application query against the page’s Chronolog state.',
    'applications:read', { ...app, query: schemaString, input: {} }, ['applicationId', 'query', 'input']),
  tool('call_application_command', 'Execute a declared application command directly as this hosted Chronolog participant. Keep operationId and input unchanged on retry.',
    'applications:write', { ...app, command: schemaString, input: {}, operationId: schemaString },
    ['applicationId', 'command', 'input', 'operationId'], false),
  tool('call_application_commands_batch', 'Execute a sequential batch of up to 16 idempotent declared commands. Each command keeps its own stable operationId.',
    'applications:write',
    {
      ...app,
      commands: {
        type: 'array', maxItems: 16, items: {
          type: 'object', additionalProperties: false,
          properties: { command: schemaString, input: {}, operationId: schemaString },
          required: ['command', 'input', 'operationId'],
        },
      },
      stopOnError: { type: 'boolean' },
    },
    ['applicationId', 'commands'], false),
  tool('inspect_application_operation', 'Inspect an operation’s stored and materialized status by its original operationId.',
    'applications:read', { ...app, operationId: schemaString }, ['applicationId', 'operationId']),
  tool('read_application_events', 'Catch up on retained decrypted events during the current turn.',
    'applications:read',
    {
      ...app,
      topics: { type: 'array', items: schemaString, maxItems: 24 },
      cursor: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 256 },
    },
    ['applicationId']),
];

const instructions =
  'Start with tendril_guide to build or connect a Tendriller app on this service origin. ' +
  'Every agent chooses its own short, speakable lowercase @handle and optional bio. ' +
  'Multi-agent rule: check describe_application / agents_list to know whether you are the page’s primary agent. ' +
  'If you are NOT primary, stay silent on general messages and respond only when specifically addressed by @handle or delegated a task. ' +
  'If you ARE primary, handle general messages and step back when a message explicitly targets only another agent. ' +
  'Use `agent_message` with `channel: "agents"` for agent-to-agent coordination and set `expectReply: false` on final answers/acks to avoid loops. ' +
  'Preserve command operationId unchanged on retry.';

const result = (id: Rpc['id'], value: unknown) => json({ jsonrpc: '2.0', id, result: value });
const toolResult = (value: unknown, modern = false) => ({
  ...(modern || isPlainObject(value) ? { structuredContent: value } : {}),
  content: [{ type: 'text', text: JSON.stringify(value) }],
});

const QUOTA_ERROR_KEYS = ['quota', 'plan', 'used', 'limit', 'resetsAt', 'localAlternative', 'upgradeUrl', 'pricingUrl', 'selfHostUrl'] as const;

function extractQuotaFields(error: unknown): Record<string, unknown> {
  if (!(error instanceof HttpError) || !error.extra) return {};
  if (error.code !== 'quota_exceeded' && error.code !== 'quota') return {};
  return Object.fromEntries(QUOTA_ERROR_KEYS.filter(k => error.extra![k] !== undefined).map(k => [k, error.extra![k]]));
}

function failure(id: Rpc['id'], error: unknown, toolCall: boolean, modern: boolean) {
  const expected = error instanceof HttpError;
  const message = expected ? error.message : 'Application connection unavailable';
  const reason = expected ? error.code : 'mcp_unavailable';
  const quotaFields = extractQuotaFields(error);
  if (!expected) console.error('MCP routing failed', error);
  if (toolCall) return result(id, { ...(modern ? { resultType: 'complete' } : {}), ...toolResult({ code: reason, message, ...quotaFields }), isError: true });
  return json({
    jsonrpc: '2.0', id,
    error: {
      code: expected ? error.extra?.rpcCode ?? -32000 : -32603,
      message,
      data: { code: reason, ...(expected && error.extra?.reason ? { reason: error.extra.reason } : {}), ...quotaFields },
    },
  }, modern && expected && (error.extra?.rpcCode === -32601 || error.extra?.rpcCode === -32602) ? error.status : 200);
}

function stub(env: Env, id: string) {
  return env.TENDRIL.get(env.TENDRIL.idFromName(id));
}

async function pageMcpRequest(env: Env, pageId: string, req: Request, principal: McpPrincipal, applicationId: string, method: string, params: Record<string, unknown>) {
  const { wrapPrivateKey, ...rest } = principal;
  const response = await stub(env, pageId).fetch(new Request('https://tendril.internal/mcp', {
    method: 'POST',
    body: JSON.stringify({
      principal: { ...rest, wrapPrivateKeyBase64: wrapPrivateKey ? base64url(wrapPrivateKey) : null },
      applicationId,
      method,
      params,
    }),
    signal: req.signal,
    headers: { 'Content-Type': 'application/json' },
  }));
  const body = await response.json<{ error?: Record<string, unknown> & { code: string; message: string; rpcCode?: number; reason?: string }; value?: unknown }>();
  if (!response.ok || body.error) {
    const err = body.error;
    const { code: _c, message: _m, ...restExtra } = err ?? {};
    throw new HttpError(response.status, err?.code ?? 'mcp_unavailable', err?.message, restExtra);
  }
  return body;
}

function parseCommandBatch(value: unknown) {
  const batch = fields(value, ['commands', 'stopOnError'], ['commands']);
  if (!Array.isArray(batch.commands) || batch.commands.length > 16)
    throw new HttpError(400, 'batch_limit_exceeded', 'Supply an array of 0..16 commands.');
  if (batch.stopOnError !== undefined && typeof batch.stopOnError !== 'boolean')
    throw new HttpError(400, 'invalid_arguments');
  const commands = batch.commands.map(item => {
    const parsed = fields(item, ['command', 'input', 'operationId'], ['command', 'input', 'operationId']);
    string(parsed.command, 128);
    string(parsed.operationId, 512);
    return parsed;
  });
  return { commands, stopOnError: batch.stopOnError === true };
}

async function submitCommandBatch(env: Env, pageId: string, req: Request, applicationId: string, principal: McpPrincipal, input: unknown) {
  const { commands, stopOnError } = parseCommandBatch(input);
  const results = [];
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('BATCH_TIMEOUT')), 25_000);
  const signal = AbortSignal.any([req.signal, ac.signal]);
  const bounded = new Request(req.url, { signal });
  try {
    for (const item of commands) {
      if (signal.aborted) break;
      try {
        const { value } = await pageMcpRequest(env, pageId, bounded, principal, applicationId, 'call_application_command', item);
        results.push({ ok: true, operationId: item.operationId, command: item.command, result: value });
        if (stopOnError && isPlainObject(value) && (!isPlainObject(value.materialized) || value.materialized.outcome !== 'accepted')) break;
      } catch (error) {
        const expected = error instanceof HttpError;
        results.push({
          ok: false, operationId: item.operationId, command: item.command,
          error: {
            code: expected ? error.code : 'mcp_unavailable',
            message: expected ? error.message : 'Command failed',
            ...extractQuotaFields(error),
          },
        });
        if (stopOnError) break;
      }
    }
  } finally {
    clearTimeout(timer);
  }
  return { applicationId, results, complete: results.length === commands.length, nextIndex: results.length };
}

export async function routeMcp(req: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;
  const config = await mcpOAuth(env);

  if (path === '/connections' || path.startsWith('/connections/')) {
    if (req.method !== 'GET') throw new HttpError(405, 'method_not_allowed');
    const owner = await browserIdentity(req, env);
    if (!owner) return redirect('/auth?return_to=' + encodeURIComponent(path));
    let mcpSection = '';
    if (config && config.issuer === url.origin) {
      const rows = await env.ACCOUNTS.prepare(`SELECT c.page_id,c.grant_id,c.handle,c.label,g.client_id
        FROM mcp_connections c
        JOIN integration_oauth_grants g ON g.id=c.grant_id
        JOIN tendrils t ON t.id=c.page_id
        WHERE c.account_id=? AND t.owner_account=c.account_id AND t.state='active' AND g.revoked_at IS NULL AND g.expires_at>?
        ORDER BY c.page_id LIMIT 50`).bind(owner.id, Date.now()).all<{ page_id: string; grant_id: string; handle: string; label: string; client_id: string }>();
      const listHtml = rows.results.length
        ? '<ul class="list">' + rows.results.map(row => {
            const clientName = config.clients.find(c => c.id === row.client_id)?.name ?? row.client_id;
            return `<li class="list-item"><div class="list-item-main"><div class="list-item-title">${escapeHtml(row.label)} <span class="badge ok">@${escapeHtml(row.handle)}</span></div><p class="list-item-sub">Hosted MCP via ${escapeHtml(clientName)} · keys wrapped to OAuth token</p></div><a class="button sm secondary" href="/dashboard">Open from dashboard</a></li>`;
          }).join('') + '</ul>'
        : '<p class="empty">No pages are opted into hosted MCP yet. Open any page and use <strong>Page options → Agents</strong> to opt it in.</p>';
      mcpSection = `<section class="card"><span class="eyebrow">Hosted MCP</span><h2>Assistant page connections</h2><p class="lead">Opt-in pages whose keys are wrapped to your OAuth clients’ Bearer tokens (zero plaintext keys stored on Tendriller).</p>${listHtml}<div class="actions" style="margin-top:1rem"><a class="button secondary sm" href="/oauth/connections">Manage OAuth clients</a></div></section>`;
    }
    const external = await renderAccountExternalConnectionsSection(env, owner.id);
    return servicePage(
      'Connections',
      `<div class="page-head"><span class="eyebrow">Integrations</span><h1>Connections</h1><p class="lead">Opt-in hosted MCP pages, external OAuth integrations, and verified organization memberships.</p></div>${mcpSection}${external.html}<div class="actions" style="margin-top:1.5rem"><a class="button ghost" href="/dashboard">Back to dashboard</a></div>`,
      external.script,
    );
  }

  if (!config || config.issuer !== url.origin) throw new HttpError(404, 'not_found');

  if (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp') {
    if (req.method !== 'GET') throw new HttpError(405, 'method_not_allowed');
    return json({
      resource: config.resource,
      authorization_servers: [config.issuer],
      scopes_supported: [...new Set(config.clients.flatMap(client => client.scopes))],
      bearer_methods_supported: ['header'],
    });
  }

  if (req.headers.has('Origin') && req.headers.get('Origin') !== config.issuer) throw new HttpError(403, 'invalid_origin');
  if (env.AGENT_RATE && !(await env.AGENT_RATE.limit({ key: 'mcp:' + (req.headers.get('CF-Connecting-IP') ?? 'unknown') })).success)
    throw new HttpError(429, 'rate_limited');
  const authorization = req.headers.get('Authorization');
  const challenge = () => json({ error: 'invalid_token' }, 401, {
    'WWW-Authenticate': `Bearer resource_metadata="${config.issuer}/.well-known/oauth-protected-resource/mcp"`,
  });
  if (req.method !== 'POST') return authorization || req.method === 'GET'
    ? json({ error: 'method_not_allowed' }, 405, { Allow: 'POST' }) : challenge();
  if (req.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json')
    return authorization === null ? challenge() : json({ error: 'unsupported_media_type' }, 415);

  let message;
  try { message = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await readBody(req, REQUEST_LIMIT, 3000))); }
  catch (error) {
    if (error instanceof HttpError) throw error;
    return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } }, 400);
  }
  if (!isPlainObject(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' ||
      message.id !== undefined && message.id !== null && typeof message.id !== 'number' && typeof message.id !== 'string')
    return json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } }, 400);

  let principal: McpPrincipal | null = null;
  if (authorization !== null) {
    const token = /^Bearer ([A-Za-z0-9_.-]{1,16384})$/i.exec(authorization)?.[1];
    if (!token) return challenge();
    await ensureOAuthSchema(env);
    const access = await inspectAccessToken(env, config, token);
    if (!access) return challenge();
    principal = {
      account: access.sub,
      grant: access.sid,
      client: access.client_id,
      scopes: access.scope.split(' ').filter(Boolean),
      expires: access.exp * 1000,
      wrapPublicKey: access.wrap_public_key,
      wrapPrivateKey: access.wrap_private_key,
    };
  }

  if (message.id === undefined && message.method === 'notifications/initialized') return new Response(null, { status: 202 });
  const publicGuideCall = message.method === 'tools/call' && isPlainObject(message.params) && (message.params.name === 'tendril_guide' || message.params.name === 'get_broadcasts');
  if (!principal && !discoveryMethods.has(message.method) && !publicGuideCall) return challenge();
  if (message.id === undefined) return new Response(null, { status: 202 });

  const id = message.id, method = message.method;
  const modern = req.headers.get('Mcp-Protocol-Version') === '2026-07-28';
  const complete = (payload: object) => result(id, { ...(modern ? { resultType: 'complete' } : {}), ...payload });

  try {
    if (message.params !== undefined && !isPlainObject(message.params)) throw new HttpError(400, 'invalid_arguments');
    const { _meta, ...params } = message.params ?? {};
    void _meta;
    if (modern && (req.headers.get('Mcp-Method') !== method ||
        method === 'tools/call' && req.headers.get('Mcp-Name') !== params.name ||
        method === 'resources/read' && req.headers.get('Mcp-Name') !== params.uri)) {
      throw new HttpError(400, 'invalid_mcp_headers', 'The MCP request headers must match its method and name.', { rpcCode: -32602 });
    }

    if (method === 'initialize') {
      const mcpFeed = await listActiveBroadcasts(env, { audiences: ['mcp', 'agents'] }).catch(() => null);
      const urgent = mcpFeed?.broadcasts.filter(b => b.payload.severity === 'urgent' || b.payload.severity === 'critical') ?? [];
      const advisoryNote = urgent.length
        ? ` Active service advisories (${urgent.length}): ${urgent.map(b => `[${b.payload.severity}] ${b.payload.title}`).join('; ')}. Call get_broadcasts for full signed details.`
        : '';
      return result(id, {
        protocolVersion: supported.includes(String(params.protocolVersion)) ? params.protocolVersion : PROTOCOL,
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: 'tendriller', version: serviceIdentity(env).build.coreRelease },
        _meta: {
          'tendriller/service': serviceIdentity(env),
          ...(mcpFeed ? { 'tendriller/broadcasts': { latestSeq: mcpFeed.latest_seq, activeCount: mcpFeed.broadcasts.length, urgentCount: urgent.length } } : {}),
        },
        instructions: instructions + ' Connected service: ' + config.issuer + '. All guide links target this deployment. If tendril_guide is missing from the installed tools, read ' + config.issuer + assistantGuides.start + ' directly. Never substitute another service origin.' + advisoryNote,
      });
    }
    if (method === 'server/discover') return result(id, {
      resultType: 'complete', supportedVersions: ['2026-07-28'],
      capabilities: { tools: {}, resources: {} }, _meta: { 'tendriller/service': serviceIdentity(env) },
    });
    if (method === 'ping') return result(id, {});
    if (method === 'tools/list') {
      return complete({ tools: tools.filter(item => !item.scope || !principal || principal.scopes.includes(item.scope)).map(({ scope, ...item }) => item) });
    }
    if (method === 'resources/list') {
      return complete({
        resources: [
          { name: 'Tendriller setup and app-building guide', description: 'Start here when building an app or when no applications are connected.', uri: config.issuer + assistantGuides.start, mimeType: 'text/markdown' },
        ],
      });
    }
    if (method === 'resources/templates/list') return complete({ resourceTemplates: [] });
    if (method === 'resources/read') {
      const guideTopic = Object.entries(assistantGuides).find(([, p]) => params.uri === config.issuer + p)?.[0];
      if (!guideTopic) throw new HttpError(404, 'unknown_resource');
      const guide = await assistantGuide(env, config.issuer, guideTopic);
      return complete({ contents: [{ uri: guide.url, mimeType: 'text/markdown', text: guide.text }] });
    }
    if (method === 'tools/call' && params.name === 'tendril_guide') {
      fields(params, ['name', 'arguments'], ['name']);
      const args = fields(params.arguments ?? {}, ['topic'], []);
      return complete(toolResult(await assistantGuide(env, config.issuer, args.topic)));
    }
    if (method === 'tools/call' && params.name === 'get_broadcasts') {
      fields(params, ['name', 'arguments'], ['name']);
      const args = fields(params.arguments ?? {}, ['audience', 'since'], []);
      const audience = typeof args.audience === 'string' ? args.audience : undefined;
      if (audience !== undefined && !['agents', 'mcp', 'page_owners', 'page_all', 'dashboard'].includes(audience)) {
        throw new HttpError(400, 'invalid_arguments', 'Invalid broadcast audience');
      }
      const since = args.since === undefined ? 0 : Number(args.since);
      if (!Number.isSafeInteger(since) || since < 0) throw new HttpError(400, 'invalid_arguments', 'since must be a non-negative integer');
      const feed = await listActiveBroadcasts(env, audience ? { audience: audience as 'agents' | 'mcp' | 'page_owners' | 'page_all' | 'dashboard', since } : { audiences: ['mcp', 'agents'], since });
      return complete(toolResult({ issuer: feed.issuer, keys: feed.keys, latest_seq: feed.latest_seq, broadcasts: feed.broadcasts }));
    }
    if (!principal) return challenge();

    if (method === 'tools/call') {
      fields(params, ['name', 'arguments'], ['name']);
      const selected = tools.find(candidate => candidate.name === params.name);
      if (!selected) throw new HttpError(404, 'unknown_tool');
      if (selected.scope) requireScope(principal, selected.scope);
      const args = fields(params.arguments ?? {}, Object.keys(selected.inputSchema.properties), selected.inputSchema.required);
      if (selected.name === 'register_agent') {
        return complete(toolResult(await registerAccountAgent(env, principal.account, args.handle, args.publicKey, args.wrapKey, args.bio)));
      }
      if (selected.name === 'get_profile') {
        const [discovery, feed, ent] = await Promise.all([
          assistantDiscovery(env, config.issuer),
          listActiveBroadcasts(env, { audiences: ['mcp', 'agents'] }),
          getAccountEntitlements(env, principal.account).catch(() => null),
        ]);
        return complete(toolResult({
          id: 'profile_' + await sha256Hex(JSON.stringify([config.issuer, principal.account])),
          ...discovery,
          ...(ent ? {
            account: {
              plan: ent.plan,
              unlimitedHost: ent.unlimitedHost,
              paygEnabled: ent.paygEnabled,
              quotas: {
                pages: ent.quotas.pages,
                residents: ent.quotas.residents,
                agents: ent.quotas.agents,
                guestsPerPage: ent.quotas.guestsPerPage,
                mcpPages: ent.quotas.mcpPages,
                mcpCallsPerMonth: ent.quotas.mcpCallsPerMonth,
                sfuEnabled: ent.quotas.sfuEnabled,
                sfuMaxPeers: ent.quotas.sfuMaxPeers,
                hostBrokeredOAuth: ent.quotas.hostBrokeredOAuth,
                teamOrgOAuth: ent.quotas.teamOrgOAuth,
              },
              usage: {
                period: ent.usage.period,
                resetsAt: ent.usage.resetsAt,
                mcpCalls: ent.usage.mcpCalls,
                mediaBytes: ent.usage.mediaBytes,
                relayMs: ent.usage.relayMs,
              },
              billingUrl: `${config.issuer}/dashboard/billing`,
              pricingUrl: `${config.issuer}/pricing`,
              selfHostUrl: `${config.issuer}/self-host`,
            },
          } : {}),
          broadcasts: {
            latestSeq: feed.latest_seq,
            issuer: feed.issuer,
            keys: feed.keys,
            active: feed.broadcasts,
          },
        }));
      }
      if (selected.name === 'list_tendrils') {
        const { applications, nextCursor } = await listConnected(env, principal.account, principal.grant, args.cursor === undefined ? null : string(args.cursor, 12));
        return complete(toolResult({ applications, nextCursor, ...await assistantDiscovery(env, config.issuer, applications.length === 0 && args.cursor === undefined) }));
      }
      const applicationId = string(args.applicationId, 64, APP_ID);
      const connected = await resolveConnection(env, principal.account, principal.grant, applicationId);
      if (selected.name === 'call_application_commands_batch') {
        const { commands, stopOnError } = args;
        return complete(toolResult(await submitCommandBatch(env, connected.pageId, req, applicationId, principal,
          { commands, ...(stopOnError === undefined ? {} : { stopOnError }) }), modern));
      }
      const { value } = await pageMcpRequest(env, connected.pageId, req, principal, applicationId, selected.name, args);
      return complete(toolResult(value, modern));
    }

    throw new HttpError(404, 'method_not_found', 'Unknown MCP method', { rpcCode: -32601 });
  } catch (error) {
    return failure(id, error, method === 'tools/call' && !(error instanceof HttpError && error.extra?.rpcCode === -32602), modern);
  }
}

function parseQueryJson(value: string): unknown {
  try { return JSON.parse(value); }
  catch { throw new HttpError(400, 'invalid_arguments', 'Query parameters must contain valid JSON.'); }
}

/** Outbound HTTPS-only Command/Query/Events Gateway for environments without WebSockets/WebRTC. */
export async function routeMcpHttpGateway(req: Request, env: Env, url: URL): Promise<Response> {
  const config = await mcpOAuth(env);
  if (!config || config.issuer !== url.origin) throw new HttpError(404, 'not_found');
  if (req.headers.has('Origin') && req.headers.get('Origin') !== config.issuer) throw new HttpError(403, 'invalid_origin');
  const match = /^\/v1\/apps\/([a-f0-9]{64})\/(commands(?:\/batch)?|operations\/([A-Za-z0-9_.:-]{1,200})|query|events|agents)$/.exec(url.pathname);
  if (!match) throw new HttpError(404, 'not_found');
  if (env.AGENT_RATE && !(await env.AGENT_RATE.limit({ key: 'mcp-http:' + (req.headers.get('CF-Connecting-IP') ?? 'unknown') })).success)
    throw new HttpError(429, 'rate_limited');

  const authorization = req.headers.get('Authorization');
  const token = authorization ? /^Bearer ([A-Za-z0-9_.-]{1,16384})$/i.exec(authorization)?.[1] : null;
  if (!token) {
    return json({ error: 'invalid_token' }, 401, {
      'WWW-Authenticate': `Bearer resource_metadata="${config.issuer}/.well-known/oauth-protected-resource/mcp"`,
    });
  }
  await ensureOAuthSchema(env);
  const access = await inspectAccessToken(env, config, token);
  if (!access) {
    return json({ error: 'invalid_token' }, 401, {
      'WWW-Authenticate': `Bearer resource_metadata="${config.issuer}/.well-known/oauth-protected-resource/mcp"`,
    });
  }
  const principal: McpPrincipal = {
    account: access.sub,
    grant: access.sid,
    client: access.client_id,
    scopes: access.scope.split(' ').filter(Boolean),
    expires: access.exp * 1000,
    wrapPublicKey: access.wrap_public_key,
    wrapPrivateKey: access.wrap_private_key,
  };
  const applicationId = match[1];
  const action = match[2];
  const opIdParam = match[3];
  const connected = await resolveConnection(env, principal.account, principal.grant, applicationId);

  const readJsonBody = async () => {
    if (req.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json')
      throw new HttpError(415, 'unsupported_media_type');
    try {
      const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await readBody(req, REQUEST_LIMIT, 3000)));
      if (!isPlainObject(parsed)) throw new HttpError(400, 'invalid_arguments', 'Expected JSON object body.');
      return parsed;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, 'bad_json', 'Invalid JSON body.');
    }
  };

  if (action === 'commands') {
    if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed');
    requireScope(principal, 'applications:write');
    const body = await readJsonBody();
    const { value } = await pageMcpRequest(env, connected.pageId, req, principal, applicationId, 'call_application_command', body);
    return json(value);
  }
  if (action === 'commands/batch') {
    if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed');
    requireScope(principal, 'applications:write');
    return json(await submitCommandBatch(env, connected.pageId, req, applicationId, principal, await readJsonBody()));
  }
  if (opIdParam !== undefined) {
    if (req.method !== 'GET') throw new HttpError(405, 'method_not_allowed');
    requireScope(principal, 'applications:read');
    const { value } = await pageMcpRequest(env, connected.pageId, req, principal, applicationId, 'inspect_application_operation', { operationId: opIdParam });
    return json(value);
  }
  if (action === 'query') {
    if (req.method !== 'GET' && req.method !== 'POST') throw new HttpError(405, 'method_not_allowed');
    requireScope(principal, 'applications:read');
    const params = req.method === 'POST'
      ? await readJsonBody()
      : { query: url.searchParams.get('query') ?? '', input: parseQueryJson(url.searchParams.get('input') ?? 'null') };
    const { value } = await pageMcpRequest(env, connected.pageId, req, principal, applicationId, 'query_application', params);
    return json(value);
  }
  if (action === 'agents') {
    if (req.method !== 'GET') throw new HttpError(405, 'method_not_allowed');
    requireScope(principal, 'applications:read');
    const { value } = await pageMcpRequest(env, connected.pageId, req, principal, applicationId, 'agents_list', {});
    return json(value);
  }
  if (action === 'events') {
    if (req.method !== 'GET') throw new HttpError(405, 'method_not_allowed');
    requireScope(principal, 'applications:read');
    const cursor = url.searchParams.get('cursor');
    const limit = url.searchParams.get('limit');
    const params: Record<string, unknown> = {};
    if (cursor !== null) params.cursor = cursor;
    if (limit !== null) {
      if (!/^(?:[1-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-6])$/.test(limit)) throw new HttpError(400, 'invalid_arguments');
      params.limit = Number(limit);
    }
    const { value } = await pageMcpRequest(env, connected.pageId, req, principal, applicationId, 'read_application_events', params);
    return json(value);
  }
  throw new HttpError(404, 'not_found');
}
