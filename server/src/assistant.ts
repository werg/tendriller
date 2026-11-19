import { withWorkerAssistant } from '../../integrations/chatgpt/worker-runtime.mjs';
import { activeGrant, ensureOAuthSchema } from './accounts/oauth-data';
import { oauthConfig, OAUTH_SCOPES } from './accounts/oauth-support';
import { inspectAccessToken } from './accounts/oauth-tokens';
import { serviceSession } from './accounts/auth';
import { selectedApplication } from './application';
import { authenticateAgentToken, pagePolicy } from './access';
import { closePeerRelayRoutes } from './peer-relay';
import { handlePeers } from './peers';
import { HttpError, json } from './http';
import { initializeAssistantDevice, openAssistantSession } from './assistant-peer.mjs';
import { requireWritesOpen } from './service-state';
import type { Tendril } from './tendril';

export function assistantEnabled(t: Tendril): boolean {
  return !!t.env.ASSISTANT_PAGE_ID && t.env.ASSISTANT_PAGE_ID === t.tid && !t.db.get('disabled', false);
}

export async function withPageAssistant<T>(t: Tendril, work: Parameters<typeof withWorkerAssistant<T>>[2]): Promise<T> {
  if (!assistantEnabled(t)) throw new HttpError(404, 'not_found');
  const oauth = await oauthConfig(t.env);
  if (!oauth || oauth.resource !== oauth.issuer + '/mcp' || !t.env.ASSISTANT_PAGE_TOKEN || !t.env.ASSISTANT_STORE_KEY)
    throw new HttpError(503, 'assistant_unavailable');
  await ensureOAuthSchema(t.env);
  const { id: applicationId } = selectedApplication(t);
  const metadataUrl = oauth.issuer + '/.well-known/oauth-protected-resource/mcp';
  const challenge = (scopes: string[] = [], error?: string) =>
    `Bearer resource_metadata="${metadataUrl}"${scopes.length ? `, scope="${scopes.join(' ')}"` : ''}${error ? `, error="${error}"` : ''}`;

  let deviceId: string | undefined;
  try { return await withWorkerAssistant(t, {
    applicationId,
    oauth,
    auth: {
      metadata: { resource: oauth.resource, authorization_servers: [oauth.issuer], scopes_supported: OAUTH_SCOPES,
        bearer_methods_supported: ['header'] },
      metadataUrl,
      challenge,
      async authenticate(request) {
        const token = /^Bearer ([A-Za-z0-9_.-]{1,16384})$/i.exec(request.headers.get('Authorization') ?? '')?.[1];
        const access = token ? await inspectAccessToken(t.env, oauth, token) : null;
        if (!access) throw new HttpError(401, 'invalid_token');
        if (t.env.AUTH_RATE && !(await t.env.AUTH_RATE.limit({ key: 'assistant:' + access.sub })).success)
          throw new HttpError(429, 'rate_limited');
        return { id: access.sub, issuer: access.iss, oauthGrantId: access.sid, scopes: access.scope.split(' ').filter(Boolean),
          expiresAt: access.exp * 1000 };
      },
    },
    async authenticateOwner(request) {
      const session = await serviceSession(request, t.env);
      return session && { id: session.accountId, issuer: oauth.issuer };
    },
    async authorizeOwner(principal, id) {
      return id === applicationId && principal.issuer === oauth.issuer &&
        principal.id === t.db.get<string | null>('owner_account', null) && await pagePolicy(t, principal.id) === 'active';
    },
    async authorizeAccountAccess(principal, id) {
      if (id !== applicationId || principal.issuer !== oauth.issuer || !principal.oauthGrantId ||
          principal.id !== t.db.get<string | null>('owner_account', null) ||
          principal.expiresAt !== undefined && principal.expiresAt <= t.now() ||
          await pagePolicy(t, principal.id) !== 'active') return false;
      return !!await activeGrant(t.env, oauth, principal.oauthGrantId, principal.id);
    },
    openSession(definition) {
      async function principal() {
        const actor = await authenticateAgentToken(t, t.env.ASSISTANT_PAGE_TOKEN!);
        if (await pagePolicy(t) !== 'active') throw new HttpError(403, 'assistant_page_unavailable');
        return actor;
      }
      return openAssistantSession(t, {
        applicationId, definition, onDevice: publicKey => { deviceId = publicKey; },
        async exchange(path, options) {
          const url = new URL(path, 'https://tendril.internal/');
          const request = new Request(url, { method: options.method, body: options.body === undefined ? undefined : JSON.stringify(options.body),
            headers: { 'Content-Type': 'application/json' }, signal: options.signal });
          const response = await handlePeers(t, request, url, path, await principal());
          if (!response.ok) { await response.body?.cancel(); throw new HttpError(response.status, 'assistant_peer_exchange_failed'); }
          return response.json();
        },
        async upgrade(url, protocols) {
          return handlePeers(t, new Request(url, { headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': protocols.join(', ') } }),
            url, url.pathname.slice(1), await principal());
        },
      });
    },
  }, work); } finally { if (deviceId) closePeerRelayRoutes(t, deviceId); }
}

export async function runAssistantDelivery(t: Tendril, observe: boolean) {
  if (!assistantEnabled(t) || await pagePolicy(t) !== 'active') return { more: false, nextDue: null };
  await requireWritesOpen(t.env);
  return t.serializeAssistant(() => withPageAssistant(t, assistant => assistant.drain({ observe, signal: AbortSignal.timeout(20_000) })));
}

export async function assistantRequest(t: Tendril, req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (!assistantEnabled(t)) throw new HttpError(404, 'not_found');
  if (url.pathname === '/connections' && req.method === 'GET' && !await serviceSession(req, t.env))
    return new Response(null, { status: 303, headers: { Location: '/auth?return_to=%2Fconnections' } });
  if (req.method === 'POST') await requireWritesOpen(t.env);
  return t.serializeAssistant(() => withPageAssistant(t, async assistant => {
    const response = await assistant.handler(req);
    // A direct user request can restart work suspended after bounded retries.
    if (req.method === 'POST' && response.ok && t.hasDeferredAssistantWork()) await t.wakeAssistant();
    return response;
  }));
}

export async function assistantAgentAction(t: Tendril, action: 'device' | 'wake'): Promise<Response> {
  if (!assistantEnabled(t) || !t.db.get('owner_account', null)) throw new HttpError(404, 'not_found');
  if (action === 'device') {
    const publicKey = await t.serializeAssistant(() => initializeAssistantDevice(t, true));
    return json({ publicKey, applicationId: selectedApplication(t).id });
  }
  if (await withPageAssistant(t, assistant => assistant.active())) await t.wakeAssistant();
  return new Response(null, { status: 204 });
}
