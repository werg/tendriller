/**
 * Outbound third-party OAuth 2.1 routes (Issue #136):
 * - Tier A (`agent-held`): zero-trust X25519 sealed handoff to agent wrapKey + stateless confidential refresh broker.
 * - Tier B (`host-brokered`): zero-plaintext-at-rest AES-256-GCM wrapped token storage under client-held K_conn
 *   (both `personal` and `page` custody), SSRF-checked typed action proxy, atomic K_conn re-keying, and HMAC webhooks.
 */
import type { Env } from '../env';
import type { Tendril } from '../tendril';
import type { PagePrincipal } from '../access';
import { allows } from '../access';
import { addActivity } from '../activity';
import { readControlState } from '../authority';
import { serviceSession } from '../accounts/auth';
import { authenticateAgentRequest, type GrantedAgent } from '../agents';
import { HttpError, isPlainObject, json, readJson } from '../http';
import { AGENT_ID_RE, randomB32, sha256Hex, TENDRIL_ID_RE } from '../ids';
import { publicBase } from '../urls';
import { base64url } from '../accounts/oauth-support';
import { escapeHtml } from '../inject';
import { servicePage } from '../accounts/ui';
import {
  assertSafeExternalHost,
  assertSafeExternalUrl,
  buildOutboundRequest,
  CUSTOM_SLUG_RE,
  listBuiltinProviderViews,
  PROVIDER_ID_RE,
  resolveProvider,
  type CustomProviderRecord,
  type OutboundCustody,
  type OutboundTier,
  type ResolvedProvider,
} from './providers';
import {
  generateConnectionKey,
  sealAgentTokens,
  sealHostConfigSecret,
  unsealHostConfigSecret,
  unwrapConnectionTokens,
  verifyHmacSha256,
  wrapConnectionTokens,
  type OutboundTokenSet,
} from './crypto';
import { requireHostBrokeredEntitlement, resolveOAuthEntitlements } from './entitlements';

export const CONNECTION_ID_RE = /^oc_[a-z2-7]{26}$/;
const STATE_TTL_MS = 10 * 60_000;
const REFRESH_SKEW_MS = 60_000;

export interface OutboundConnectionRow {
  id: string;
  account_id: string;
  provider: string;
  label: string;
  tier: OutboundTier;
  custody: OutboundCustody;
  page_id: string | null;
  agent_id: string | null;
  scopes: string;
  actions: string;
  wrapped_tokens: string | null;
  sealed_handoff: string | null;
  external_subject: string | null;
  external_label: string | null;
  webhook_secret_hash: string | null;
  created_at: number;
  updated_at: number;
  revoked_at: number | null;
}

interface OutboundStateRow {
  hash: string;
  connection_id: string;
  account_id: string;
  provider: string;
  tier: OutboundTier;
  custody: OutboundCustody;
  agent_id: string | null;
  agent_wrap_key: string | null;
  page_id: string | null;
  label: string;
  scopes: string;
  actions: string;
  verifier: string;
  return_to: string;
  created_at: number;
  expires_at: number;
}

function newConnectionId(): string { return `oc_${randomB32(26)}`; }
function randomToken(): string { return base64url(crypto.getRandomValues(new Uint8Array(32))); }

function aadFor(id: string, accountId: string, custody: OutboundCustody): string {
  return `${id}:${accountId}:${custody}`;
}

function safeReturnTo(value: unknown, env?: Env): string {
  if (typeof value !== 'string' || !value.trim()) return '/connections';
  const trimmed = value.trim().slice(0, 512);
  if (trimmed.startsWith('/') && !trimmed.startsWith('//') && !trimmed.includes('\\')) {
    return trimmed;
  }
  // Allow same-service or page-subdomain HTTPS return URLs (e.g. for zero-copy-paste `#tendril-connection=` handoff).
  if (env) {
    try {
      const parsed = new URL(trimmed);
      const serviceOrigin = new URL(publicBase(env)).origin;
      const pageBase = (env.PAGE_BASE_DOMAIN ?? '').toLowerCase();
      const host = parsed.hostname.toLowerCase();
      if (parsed.origin === serviceOrigin) return parsed.toString();
      if (pageBase && (parsed.protocol === 'https:' || parsed.protocol === 'http:') && host.endsWith(`.${pageBase}`)) {
        return parsed.toString();
      }
    } catch { /* fallback */ }
  }
  return '/connections';
}

function parseStringList(value: unknown, maxItems = 32, maxLen = 160): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new HttpError(400, 'bad_request', `Expected an array of at most ${maxItems} strings`);
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim() || item.length > maxLen) {
      throw new HttpError(400, 'bad_request', 'List items must be bounded non-empty strings');
    }
    const clean = item.trim();
    if (!out.includes(clean)) out.push(clean);
  }
  return out;
}

function requireSameOrigin(req: Request, env: Env): void {
  const origin = req.headers.get('Origin');
  if (origin && origin !== new URL(publicBase(env)).origin) {
    throw new HttpError(403, 'bad_origin', 'Invalid request origin');
  }
}

export function connectionView(row: OutboundConnectionRow, opts: { includeSealedHandoff?: boolean } = {}) {
  return {
    id: row.id,
    provider: row.provider,
    label: row.label,
    tier: row.tier,
    custody: row.custody,
    page_id: row.page_id,
    agent_id: row.agent_id,
    scopes: JSON.parse(row.scopes) as string[],
    actions: JSON.parse(row.actions) as string[],
    external_subject: row.external_subject,
    external_label: row.external_label,
    has_wrapped_tokens: Boolean(row.wrapped_tokens),
    pending_handoff: Boolean(row.sealed_handoff),
    ...(opts.includeSealedHandoff && row.sealed_handoff ? { sealed_handoff: JSON.parse(row.sealed_handoff) } : {}),
    has_webhook: Boolean(row.webhook_secret_hash),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function notifyAgentHubEvent(env: Env, agentId: string, pageId: string | null, kind: string, data: Record<string, unknown>): Promise<void> {
  if (!env.AGENT_HUB) return;
  if (pageId !== null && !TENDRIL_ID_RE.test(pageId)) return;
  try {
    const res = await env.AGENT_HUB.get(env.AGENT_HUB.idFromName(agentId)).fetch(new Request('https://hub.internal/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ page: pageId, kind, data }),
    }));
    await res.body?.cancel();
  } catch { /* best-effort live notification */ }
}

/** Initiate an outbound OAuth authorize flow (called by account session or agent API). */
export async function startOutboundConnect(
  env: Env,
  accountId: string,
  body: Record<string, unknown>,
  defaults: { agentId?: string | null; agentWrapKey?: string | null } = {},
): Promise<{ connection_id: string; authorize_url: string; state: string; tier: OutboundTier; custody: OutboundCustody; provider: string; scopes: string[]; actions: string[]; expires_at: number }> {
  const providerId = typeof body.provider === 'string' ? body.provider.trim().toLowerCase() : '';
  if (!PROVIDER_ID_RE.test(providerId)) {
    throw new HttpError(400, 'invalid_provider', 'provider must be a valid built-in or custom:<slug> provider id');
  }
  const tier: OutboundTier = body.tier === 'host-brokered' ? 'host-brokered'
    : body.tier === 'agent-held' || body.tier === undefined ? 'agent-held'
    : (() => { throw new HttpError(400, 'invalid_tier', 'tier must be "agent-held" or "host-brokered"'); })();
  const custody: OutboundCustody = body.custody === 'page' ? 'page'
    : body.custody === 'personal' || body.custody === undefined ? 'personal'
    : (() => { throw new HttpError(400, 'invalid_custody', 'custody must be "personal" or "page"'); })();

  if (tier === 'host-brokered') {
    await requireHostBrokeredEntitlement(env, accountId, custody);
  }
  if (custody === 'page' && tier !== 'host-brokered') {
    throw new HttpError(400, 'invalid_custody', 'custody="page" applies only to tier="host-brokered" connections');
  }

  const resolved = await resolveProvider(env, accountId, providerId);
  const scopes = body.scopes !== undefined ? parseStringList(body.scopes, 32, 160) : [...resolved.spec.defaultScopes];
  const requestedActions = body.actions !== undefined
    ? parseStringList(body.actions, 64, 128)
    : resolved.spec.actions.map(a => a.id);

  // Validate requested actions exist on built-in provider (or http:request)
  if (!resolved.isCustom) {
    const validIds = new Set([...resolved.spec.actions.map(a => a.id), 'http:request']);
    for (const act of requestedActions) {
      if (!validIds.has(act)) throw new HttpError(400, 'unknown_action', `Unknown action "${act}" for provider "${providerId}"`);
    }
  }

  let agentId: string | null = defaults.agentId ?? (typeof body.agent_id === 'string' && body.agent_id ? body.agent_id : null);
  let agentWrapKey: string | null = defaults.agentWrapKey ?? null;
  if (tier === 'agent-held') {
    if (!agentId || !AGENT_ID_RE.test(agentId)) {
      throw new HttpError(400, 'agent_required', 'tier="agent-held" requires an agent_id with a registered X25519 wrapKey');
    }
    if (!agentWrapKey) {
      const ag = await env.ACCOUNTS.prepare('SELECT wrap_key FROM agents WHERE id = ? AND account_id = ? AND revoked_at IS NULL')
        .bind(agentId, accountId).first<{ wrap_key: string }>();
      if (!ag) throw new HttpError(404, 'agent_not_found', 'Target agent was not found on this account');
      agentWrapKey = ag.wrap_key;
    }
  }

  let pageId: string | null = typeof body.page_id === 'string' && body.page_id ? body.page_id : null;
  if (custody === 'page' && (!pageId || !TENDRIL_ID_RE.test(pageId))) {
    throw new HttpError(400, 'page_required', 'custody="page" requires a valid page_id owned by this account');
  }
  if (pageId) {
    if (!TENDRIL_ID_RE.test(pageId)) throw new HttpError(400, 'invalid_page_id', 'Invalid page_id');
    const owned = await env.ACCOUNTS.prepare('SELECT 1 AS x FROM tendrils WHERE id = ? AND owner_account = ?')
      .bind(pageId, accountId).first();
    if (!owned) throw new HttpError(404, 'page_not_found', 'Page not found on this account');
  }

  const label = typeof body.label === 'string' ? body.label.trim().slice(0, 80) : resolved.spec.name;
  const connectionId = newConnectionId();
  const state = randomToken();
  const verifier = randomToken();
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const now = Date.now();
  const expiresAt = now + STATE_TTL_MS;

  await env.ACCOUNTS.prepare(`INSERT INTO outbound_oauth_states
    (hash, connection_id, account_id, provider, tier, custody, agent_id, agent_wrap_key, page_id, label, scopes, actions, verifier, return_to, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      await sha256Hex(state), connectionId, accountId, providerId, tier, custody,
      agentId, agentWrapKey, pageId, label, JSON.stringify(scopes), JSON.stringify(requestedActions),
      verifier, safeReturnTo(body.return_to, env), now, expiresAt,
    ).run();

  const callback = `${publicBase(env)}/auth/outbound/callback/${encodeURIComponent(providerId)}`;
  const auth = new URL(resolved.spec.authorizeUrl);
  auth.searchParams.set('client_id', resolved.clientId);
  auth.searchParams.set('redirect_uri', callback);
  auth.searchParams.set('response_type', 'code');
  auth.searchParams.set('state', state);
  if (scopes.length) auth.searchParams.set('scope', scopes.join(resolved.spec.scopeDelimiter ?? ' '));
  if (resolved.spec.pkce) {
    auth.searchParams.set('code_challenge', challenge);
    auth.searchParams.set('code_challenge_method', 'S256');
  }
  if (resolved.spec.extraAuthParams) {
    for (const [k, v] of Object.entries(resolved.spec.extraAuthParams)) auth.searchParams.set(k, v);
  }

  return {
    connection_id: connectionId,
    authorize_url: auth.toString(),
    state,
    tier,
    custody,
    provider: providerId,
    scopes,
    actions: requestedActions,
    expires_at: expiresAt,
  };
}

function buildTokenRequest(
  resolved: ResolvedProvider,
  fields: Record<string, string>,
): { headers: Record<string, string>; body: string | URLSearchParams } {
  const useBasic = resolved.spec.tokenAuthMethod === 'basic' && Boolean(resolved.clientSecret);
  const useJson = resolved.spec.tokenContentType === 'json';
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': 'Tendriller-OAuth-Broker/1.0',
  };
  const payload: Record<string, string> = { ...fields };
  if (useBasic) {
    headers.Authorization = `Basic ${btoa(`${resolved.clientId}:${resolved.clientSecret}`)}`;
  } else {
    payload.client_id = resolved.clientId;
    if (resolved.clientSecret) payload.client_secret = resolved.clientSecret;
  }
  if (useJson) {
    headers['Content-Type'] = 'application/json';
    return { headers, body: JSON.stringify(payload) };
  }
  headers['Content-Type'] = 'application/x-www-form-urlencoded';
  return { headers, body: new URLSearchParams(payload) };
}

function parseTokenResponse(data: Record<string, unknown>, fallbackRefresh?: string): OutboundTokenSet {
  // Slack returns HTTP 200 with `{ ok: false, error: "..." }` on OAuth errors.
  if (data.ok === false) {
    throw new HttpError(502, 'oauth_exchange_failed', `Provider returned error: ${String(data.error ?? 'unknown')}`);
  }
  const authedUser = data.authed_user && typeof data.authed_user === 'object' ? data.authed_user as Record<string, unknown> : null;
  const accessToken = typeof data.access_token === 'string' && data.access_token
    ? data.access_token
    : typeof authedUser?.access_token === 'string' && authedUser.access_token
      ? authedUser.access_token
      : '';
  if (!accessToken) throw new HttpError(502, 'oauth_exchange_failed', 'Provider did not issue an access_token');
  const expiresIn = typeof data.expires_in === 'number' && Number.isFinite(data.expires_in) ? data.expires_in : null;
  const refresh = typeof data.refresh_token === 'string' && data.refresh_token
    ? data.refresh_token
    : typeof authedUser?.refresh_token === 'string' && authedUser.refresh_token
      ? authedUser.refresh_token
      : (fallbackRefresh ?? null);
  const scope = typeof data.scope === 'string'
    ? data.scope
    : typeof authedUser?.scope === 'string'
      ? authedUser.scope
      : undefined;
  return {
    access_token: accessToken,
    refresh_token: refresh,
    token_type: typeof data.token_type === 'string' ? data.token_type : 'Bearer',
    scope,
    expires_at: expiresIn !== null ? Date.now() + expiresIn * 1000 : null,
  };
}

async function exchangeProviderCode(
  resolved: ResolvedProvider,
  code: string,
  redirectUri: string,
  verifier: string,
): Promise<OutboundTokenSet> {
  const fields: Record<string, string> = {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  };
  if (resolved.spec.pkce) fields.code_verifier = verifier;
  const { headers, body } = buildTokenRequest(resolved, fields);
  const res = await fetch(resolved.spec.tokenUrl, { method: 'POST', headers, body, redirect: 'manual' });
  if (!res.ok) throw new HttpError(502, 'oauth_exchange_failed', `Provider token exchange failed (${res.status})`);
  const data = await res.json() as Record<string, unknown>;
  return parseTokenResponse(data);
}

async function refreshProviderToken(
  resolved: ResolvedProvider,
  refreshToken: string,
): Promise<OutboundTokenSet> {
  const { headers, body } = buildTokenRequest(resolved, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  const res = await fetch(resolved.spec.tokenUrl, { method: 'POST', headers, body, redirect: 'manual' });
  if (!res.ok) throw new HttpError(502, 'oauth_refresh_failed', `Provider token refresh failed (${res.status})`);
  const data = await res.json() as Record<string, unknown>;
  return parseTokenResponse(data, refreshToken);
}

async function lookupExternalProfile(resolved: ResolvedProvider, accessToken: string): Promise<{ subject: string | null; label: string | null }> {
  if (!resolved.spec.profileUrl) return { subject: null, label: null };
  try {
    const res = await fetch(resolved.spec.profileUrl, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'User-Agent': 'Tendriller-OAuth-Broker/1.0' },
    });
    if (!res.ok) return { subject: null, label: null };
    const profile = await res.json() as Record<string, unknown>;
    const subject = profile.id ?? profile.sub ?? profile.user_id ?? null;
    const label = profile.login ?? profile.email ?? profile.display_name ?? profile.name ?? profile.userPrincipalName ?? null;
    return {
      subject: subject !== null && subject !== undefined ? String(subject).slice(0, 128) : null,
      label: typeof label === 'string' ? label.slice(0, 128) : null,
    };
  } catch {
    return { subject: null, label: null };
  }
}

/** Handle `GET /auth/outbound/callback/:provider`. */
export async function handleOutboundCallback(req: Request, env: Env, url: URL, providerId: string): Promise<Response> {
  if (!env.ACCOUNTS) throw new HttpError(503, 'unavailable', 'Accounts database is not configured');
  const session = await serviceSession(req, env);
  if (!session) throw new HttpError(401, 'unauthorized', 'Sign in to complete this connection');
  const state = url.searchParams.get('state') ?? '';
  const code = url.searchParams.get('code') ?? '';
  const oauthErr = url.searchParams.get('error');
  if (oauthErr) {
    throw new HttpError(400, 'oauth_denied', `Provider authorization declined: ${oauthErr}`);
  }
  if (!state || !code) throw new HttpError(400, 'bad_request', 'Missing OAuth callback code or state');

  const pending = await env.ACCOUNTS.prepare(
    'DELETE FROM outbound_oauth_states WHERE hash = ? AND provider = ? AND account_id = ? AND expires_at > ? RETURNING *',
  ).bind(await sha256Hex(state), providerId, session.accountId, Date.now()).first<OutboundStateRow>();
  if (!pending) throw new HttpError(400, 'invalid_state', 'Connection authorization expired, already used, or started by another account');

  const resolved = await resolveProvider(env, session.accountId, providerId);
  const redirectUri = `${publicBase(env)}/auth/outbound/callback/${encodeURIComponent(providerId)}`;
  const tokens = await exchangeProviderCode(resolved, code, redirectUri, pending.verifier);
  const profile = await lookupExternalProfile(resolved, tokens.access_token);
  const now = Date.now();
  const scopesList = tokens.scope ? tokens.scope.split(/[\s,]+/).filter(Boolean) : JSON.parse(pending.scopes) as string[];

  let wrappedTokens: string | null = null;
  let sealedHandoff: string | null = null;
  let oneTimeConnectionKey: string | null = null;

  if (pending.tier === 'agent-held') {
    if (!pending.agent_wrap_key) throw new HttpError(400, 'invalid_state', 'Missing agent wrapKey for agent-held connection');
    sealedHandoff = await sealAgentTokens(
      pending.agent_wrap_key,
      tokens,
      `${pending.connection_id}:${pending.agent_id ?? ''}:${providerId}`,
    );
  } else {
    oneTimeConnectionKey = generateConnectionKey();
    wrappedTokens = await wrapConnectionTokens(
      oneTimeConnectionKey,
      tokens,
      aadFor(pending.connection_id, session.accountId, pending.custody),
    );
  }

  await env.ACCOUNTS.prepare(`INSERT INTO outbound_connections
    (id, account_id, provider, label, tier, custody, page_id, agent_id, scopes, actions, wrapped_tokens, sealed_handoff, external_subject, external_label, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      pending.connection_id, session.accountId, providerId, pending.label, pending.tier, pending.custody,
      pending.page_id, pending.agent_id, JSON.stringify(scopesList), pending.actions,
      wrappedTokens, sealedHandoff, profile.subject, profile.label, now, now,
    ).run();

  if (pending.page_id) {
    await env.ACCOUNTS.prepare(`INSERT OR REPLACE INTO outbound_page_grants
      (connection_id, page_id, custody, actions, granted_by, granted_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(pending.connection_id, pending.page_id, pending.custody, pending.actions, session.accountId, now).run();
  }

  if (pending.tier === 'agent-held' && pending.agent_id) {
    await notifyAgentHubEvent(env, pending.agent_id, pending.page_id, 'outbound-connection-ready', {
      connection_id: pending.connection_id,
      provider: providerId,
    });
  }

  const responsePayload = {
    connection: {
      id: pending.connection_id,
      provider: providerId,
      label: pending.label,
      tier: pending.tier,
      custody: pending.custody,
      page_id: pending.page_id,
      agent_id: pending.agent_id,
      scopes: scopesList,
      actions: JSON.parse(pending.actions) as string[],
      external_subject: profile.subject,
      external_label: profile.label,
    },
    ...(oneTimeConnectionKey ? { connection_key: oneTimeConnectionKey } : {}),
  };

  if (req.headers.get('Accept')?.includes('application/json')) {
    return json(responsePayload, 201, { 'Cache-Control': 'no-store' });
  }

  // Zero-copy-paste browser handoff for Tier B:
  // 1) If return_to is a page URL, append #tendril-connection=<base64url> (fragments never hit the server).
  // 2) If opened as a popup (window.opener), postMessage strictly to the validated return_to origin.
  // 3) Always keep a manual 1-click Copy fallback box.
  let continueHref = pending.return_to;
  let targetOrigin = new URL(publicBase(env)).origin;
  try {
    const retUrl = new URL(pending.return_to, publicBase(env));
    targetOrigin = retUrl.origin;
    if (oneTimeConnectionKey && (retUrl.origin !== new URL(publicBase(env)).origin || retUrl.pathname !== '/connections')) {
      const fragmentPayload = base64url(new TextEncoder().encode(JSON.stringify(responsePayload)));
      retUrl.hash = `tendril-connection=${fragmentPayload}`;
      continueHref = retUrl.toString();
    }
  } catch { /* keep default continueHref */ }

  const keyBlock = oneTimeConnectionKey
    ? `<div class="card" style="margin-top:1rem"><h2>One-time connection wrap key</h2><p class="muted">Tendriller stores only wrapped ciphertext and never retains this key. Your page can receive it automatically, or copy it now:</p><pre><code id="tendril-kconn">${escapeHtml(oneTimeConnectionKey)}</code></pre><div class="actions tight" style="margin-top:.75rem"><button class="button secondary sm" type="button" id="tendril-copy-kconn">Copy key</button><span class="muted" id="tendril-handoff-status" aria-live="polite"></span></div></div>`
    : `<p class="muted">Your token was sealed directly to your agent’s X25519 wrap key. If <code>tendril agent run</code> is active, it pulls automatically; otherwise run <code>tendril connection pull</code>.</p>`;

  const safeJson = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
  const script = oneTimeConnectionKey
    ? `(function(){var payload=${safeJson(responsePayload)};var origin=${safeJson(targetOrigin)};var btn=document.getElementById('tendril-copy-kconn');var st=document.getElementById('tendril-handoff-status');if(btn){btn.addEventListener('click',function(){navigator.clipboard&&navigator.clipboard.writeText(payload.connection_key).then(function(){btn.textContent='Copied';}).catch(function(){});});}try{if(window.opener&&!window.opener.closed){window.opener.postMessage({type:'tendriller:oauth-connection',connection:payload.connection,connection_key:payload.connection_key},origin);if(st)st.textContent='Delivered to opening page.';}}catch(e){}})();`
    : '';

  return servicePage(
    `${resolved.spec.name} connected`,
    `<section class="card"><span class="eyebrow">External connection ready</span><h1>${escapeHtml(resolved.spec.name)} connected</h1><p class="lead">Mode: <strong>${escapeHtml(pending.tier)}</strong>${pending.tier === 'host-brokered' ? ` · Custody: <strong>${escapeHtml(pending.custody)}</strong>` : ''}</p>${keyBlock}<div class="actions" style="margin-top:1.25rem"><a class="button" href="${escapeHtml(continueHref)}">Continue</a></div></section>`,
    script,
    200,
  );
}

/** Invoke a Tier B wrapped connection using caller-supplied `K_conn` strictly in RAM. */
export async function invokeWrappedConnection(
  env: Env,
  row: OutboundConnectionRow,
  grantedActions: readonly string[],
  kConn: string,
  input: {
    action: string;
    params?: Record<string, string>;
    query?: Record<string, string>;
    body?: unknown;
    method?: string;
    url?: string;
    headers?: Record<string, string>;
  },
): Promise<{ status: number; headers: Record<string, string>; body: unknown }> {
  if (row.revoked_at !== null) throw new HttpError(410, 'connection_revoked', 'This external connection has been revoked');
  if (row.tier !== 'host-brokered' || !row.wrapped_tokens) {
    throw new HttpError(400, 'not_host_brokered', 'Only host-brokered wrapped connections can be invoked through the host proxy');
  }
  await requireHostBrokeredEntitlement(env, row.account_id, row.custody);
  const resolved = await resolveProvider(env, row.account_id, row.provider);
  const aad = aadFor(row.id, row.account_id, row.custody);
  let tokens = await unwrapConnectionTokens(kConn, row.wrapped_tokens, aad);

  // Transparently refresh and atomically re-wrap if access token is expired/near-expiry.
  if (tokens.expires_at && tokens.expires_at <= Date.now() + REFRESH_SKEW_MS && tokens.refresh_token) {
    tokens = await refreshProviderToken(resolved, tokens.refresh_token);
    const rewrapped = await wrapConnectionTokens(kConn, tokens, aad);
    await env.ACCOUNTS.prepare('UPDATE outbound_connections SET wrapped_tokens = ?, updated_at = ? WHERE id = ? AND revoked_at IS NULL')
      .bind(rewrapped, Date.now(), row.id).run();
  }

  const outbound = buildOutboundRequest(resolved.spec, grantedActions, input);
  const upstreamHeaders = new Headers(outbound.headers);
  upstreamHeaders.set('Authorization', `${tokens.token_type || 'Bearer'} ${tokens.access_token}`);

  const upstream = await fetch(outbound.url, {
    method: outbound.method,
    headers: upstreamHeaders,
    redirect: 'manual',
    ...(outbound.body !== undefined ? { body: outbound.body } : {}),
  });

  const contentType = upstream.headers.get('content-type') ?? '';
  let parsedBody: unknown;
  if (contentType.includes('application/json')) {
    parsedBody = await upstream.json().catch(() => null);
  } else {
    const text = await upstream.text();
    parsedBody = text.slice(0, 256 * 1024);
  }
  const safeRespHeaders: Record<string, string> = {};
  for (const name of ['content-type', 'etag', 'location', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'retry-after']) {
    const v = upstream.headers.get(name);
    if (v) safeRespHeaders[name] = v;
  }
  return { status: upstream.status, headers: safeRespHeaders, body: parsedBody };
}

/** Atomically re-wrap a Tier B connection under a new `K_conn` (used on page epoch key rotation). */
export async function rekeyWrappedConnection(
  env: Env,
  row: OutboundConnectionRow,
  oldKey: string,
  newKey: string,
): Promise<void> {
  if (row.revoked_at !== null) throw new HttpError(410, 'connection_revoked', 'This connection has been revoked');
  if (row.tier !== 'host-brokered' || !row.wrapped_tokens) {
    throw new HttpError(400, 'not_host_brokered', 'Only host-brokered wrapped connections support K_conn re-keying');
  }
  const aad = aadFor(row.id, row.account_id, row.custody);
  const tokens = await unwrapConnectionTokens(oldKey, row.wrapped_tokens, aad);
  const rewrapped = await wrapConnectionTokens(newKey, tokens, aad);
  await env.ACCOUNTS.prepare('UPDATE outbound_connections SET wrapped_tokens = ?, updated_at = ? WHERE id = ? AND revoked_at IS NULL')
    .bind(rewrapped, Date.now(), row.id).run();
}

/** Revoke an outbound connection, wiping wrapped ciphertext, sealed handoffs, and page grants. */
export async function revokeOutboundConnection(env: Env, accountId: string, connectionId: string, optionalKey?: string): Promise<void> {
  const row = await env.ACCOUNTS.prepare('SELECT * FROM outbound_connections WHERE id = ? AND account_id = ?')
    .bind(connectionId, accountId).first<OutboundConnectionRow>();
  if (!row) throw new HttpError(404, 'connection_not_found', 'External connection not found');

  // Best-effort upstream revocation if caller provided K_conn and provider has revokeUrl.
  if (optionalKey && row.wrapped_tokens && row.tier === 'host-brokered') {
    try {
      const resolved = await resolveProvider(env, accountId, row.provider);
      if (resolved.spec.revokeUrl) {
        const tokens = await unwrapConnectionTokens(optionalKey, row.wrapped_tokens, aadFor(row.id, row.account_id, row.custody));
        const body = new URLSearchParams({ token: tokens.refresh_token || tokens.access_token, client_id: resolved.clientId });
        if (resolved.clientSecret) body.set('client_secret', resolved.clientSecret);
        await fetch(resolved.spec.revokeUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
        }).then(r => r.body?.cancel()).catch(() => {});
      }
    } catch { /* best effort */ }
  }

  const now = Date.now();
  await env.ACCOUNTS.batch([
    env.ACCOUNTS.prepare('UPDATE outbound_connections SET wrapped_tokens = NULL, sealed_handoff = NULL, webhook_secret_hash = NULL, revoked_at = ?, updated_at = ? WHERE id = ?')
      .bind(now, now, connectionId),
    env.ACCOUNTS.prepare('DELETE FROM outbound_page_grants WHERE connection_id = ?').bind(connectionId),
  ]);
  if (row.agent_id && row.page_id) {
    await notifyAgentHubEvent(env, row.agent_id, row.page_id, 'outbound-connection-revoked', { connection_id: connectionId, provider: row.provider });
  }
}

/** Service-origin API routes: `/api/oauth/providers`, `/api/account/oauth/providers*`, `/api/account/connections*`, `/api/webhooks/connections/*`. */
export async function routeOutboundOAuthApi(req: Request, env: Env, url: URL): Promise<Response | null> {
  const path = url.pathname;
  const m = req.method;

  if (path === '/api/oauth/providers' && (m === 'GET' || m === 'HEAD')) {
    const session = await serviceSession(req, env).catch(() => null);
    let custom: Array<Record<string, unknown>> = [];
    if (session && env.ACCOUNTS) {
      const rows = await env.ACCOUNTS.prepare('SELECT id, slug, name, authorize_url, token_url, revoke_url, default_scopes, allowed_hosts, pkce, created_at FROM oauth_custom_providers WHERE account_id = ? ORDER BY slug ASC')
        .bind(session.accountId).all<CustomProviderRecord>();
      custom = rows.results.map(r => ({
        id: `custom:${r.slug}`,
        name: r.name,
        category: 'custom',
        configured: true,
        pkce: r.pkce === 1,
        supports_agent_held: true,
        supports_host_brokered: true,
        default_scopes: JSON.parse(r.default_scopes),
        allowed_api_hosts: JSON.parse(r.allowed_hosts),
        actions: [],
      }));
    }
    return json({ providers: [...listBuiltinProviderViews(env), ...custom] });
  }

  // Inbound HMAC-verified webhook (zero OAuth token decryption!)
  const webhookMatch = /^\/api\/webhooks\/connections\/(oc_[a-z2-7]{26})$/.exec(path);
  if (webhookMatch && m === 'POST') {
    const connId = webhookMatch[1]!;
    const row = await env.ACCOUNTS.prepare('SELECT * FROM outbound_connections WHERE id = ? AND revoked_at IS NULL')
      .bind(connId).first<OutboundConnectionRow>();
    if (!row || !row.webhook_secret_hash) throw new HttpError(404, 'webhook_not_configured', 'Webhook not configured for this connection');
    const sig = req.headers.get('X-Hub-Signature-256')
      ?? req.headers.get('X-Tendriller-Signature-256')
      ?? req.headers.get('Linear-Signature')
      ?? '';
    const secretHeader = req.headers.get('X-Tendriller-Webhook-Secret');
    const rawBody = await req.arrayBuffer();
    if (rawBody.byteLength > 256 * 1024) throw new HttpError(413, 'payload_too_large', 'Webhook payload too large');

    // Stored webhook_secret_hash is either raw HMAC secret (when using X-Hub-Signature-256) or SHA-256 digest.
    // To avoid plaintext secret storage while supporting standard HMAC headers, we support:
    // - HMAC-SHA256 verified against the stored webhook secret key OR bearer secret hash match.
    let verified = false;
    if (sig && row.webhook_secret_hash.startsWith('hmac:')) {
      const hmacSecret = await unsealHostConfigSecret(env, row.webhook_secret_hash.slice(5), `webhook:${row.id}`);
      verified = await verifyHmacSha256(hmacSecret, rawBody, sig);
    } else if (secretHeader && (await sha256Hex(secretHeader)) === row.webhook_secret_hash) {
      verified = true;
    }
    if (!verified) throw new HttpError(401, 'invalid_signature', 'Webhook signature verification failed');

    const eventKind = req.headers.get('X-GitHub-Event') ?? req.headers.get('X-Tendriller-Event') ?? 'webhook';
    if (row.agent_id && row.page_id) {
      await notifyAgentHubEvent(env, row.agent_id, row.page_id, 'outbound-webhook', {
        connection_id: row.id,
        provider: row.provider,
        event: eventKind,
        received_at: Date.now(),
      });
    }
    return json({ accepted: true, connection_id: row.id, event: eventKind }, 202);
  }

  // Account-authenticated custom BYO OAuth providers
  if (path === '/api/account/oauth/providers' || /^\/api\/account\/oauth\/providers\/([a-z0-9][a-z0-9_-]{1,31})$/.test(path)) {
    const session = await serviceSession(req, env);
    if (!session) throw new HttpError(401, 'unauthorized', 'Sign in first');
    const slugMatch = /^\/api\/account\/oauth\/providers\/([a-z0-9][a-z0-9_-]{1,31})$/.exec(path);
    if (!slugMatch && m === 'GET') {
      const rows = await env.ACCOUNTS.prepare('SELECT id, slug, name, authorize_url, token_url, revoke_url, client_id, default_scopes, allowed_hosts, pkce, created_at FROM oauth_custom_providers WHERE account_id = ? ORDER BY slug ASC')
        .bind(session.accountId).all<CustomProviderRecord>();
      return json({
        providers: rows.results.map(r => ({
          id: `custom:${r.slug}`,
          slug: r.slug,
          name: r.name,
          authorize_url: r.authorize_url,
          token_url: r.token_url,
          revoke_url: r.revoke_url,
          client_id: r.client_id,
          default_scopes: JSON.parse(r.default_scopes),
          allowed_hosts: JSON.parse(r.allowed_hosts),
          pkce: r.pkce === 1,
          created_at: r.created_at,
        })),
      });
    }
    requireSameOrigin(req, env);
    if (!slugMatch && m === 'POST') {
      const b = await readJson(req, 8192);
      if (!isPlainObject(b)) throw new HttpError(400, 'bad_request', 'Expected JSON object');
      const slug = typeof b.slug === 'string' ? b.slug.trim().toLowerCase() : '';
      if (!CUSTOM_SLUG_RE.test(slug)) throw new HttpError(400, 'invalid_slug', 'slug must match ^[a-z0-9][a-z0-9_-]{1,31}$');
      const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim().slice(0, 80) : slug;
      const authorizeUrl = assertSafeExternalUrl(String(b.authorize_url ?? ''), 'authorize_url').toString();
      const tokenUrl = assertSafeExternalUrl(String(b.token_url ?? ''), 'token_url').toString();
      const revokeUrl = typeof b.revoke_url === 'string' && b.revoke_url.trim()
        ? assertSafeExternalUrl(b.revoke_url.trim(), 'revoke_url').toString() : null;
      const clientId = typeof b.client_id === 'string' && b.client_id.trim() ? b.client_id.trim().slice(0, 256) : '';
      if (!clientId) throw new HttpError(400, 'bad_request', 'client_id is required');
      const rawSecret = typeof b.client_secret === 'string' && b.client_secret ? b.client_secret.slice(0, 512) : null;
      const clientSecret = rawSecret ? await sealHostConfigSecret(env, rawSecret, `custom-provider:${session.accountId}:${slug}`) : null;
      const defaultScopes = parseStringList(b.default_scopes, 32, 160);
      const allowedHosts = parseStringList(b.allowed_hosts, 16, 253).map(h => assertSafeExternalHost(h, 'allowed_hosts'));
      if (!allowedHosts.length) throw new HttpError(400, 'bad_request', 'allowed_hosts must contain at least one public HTTPS API host');
      const pkce = b.pkce === false ? 0 : 1;
      const id = `cp_${randomB32(20)}`;
      const now = Date.now();
      await env.ACCOUNTS.prepare(`INSERT INTO oauth_custom_providers
        (id, account_id, slug, name, authorize_url, token_url, revoke_url, client_id, client_secret, default_scopes, allowed_hosts, pkce, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id, slug) DO UPDATE SET
          name=excluded.name, authorize_url=excluded.authorize_url, token_url=excluded.token_url,
          revoke_url=excluded.revoke_url, client_id=excluded.client_id, client_secret=excluded.client_secret,
          default_scopes=excluded.default_scopes, allowed_hosts=excluded.allowed_hosts, pkce=excluded.pkce`)
        .bind(id, session.accountId, slug, name, authorizeUrl, tokenUrl, revokeUrl, clientId, clientSecret, JSON.stringify(defaultScopes), JSON.stringify(allowedHosts), pkce, now).run();
      return json({ id: `custom:${slug}`, slug, name, authorize_url: authorizeUrl, token_url: tokenUrl, allowed_hosts: allowedHosts, pkce: pkce === 1 }, 201);
    }
    if (slugMatch && m === 'DELETE') {
      await env.ACCOUNTS.prepare('DELETE FROM oauth_custom_providers WHERE account_id = ? AND slug = ?')
        .bind(session.accountId, slugMatch[1]).run();
      return new Response(null, { status: 204 });
    }
    throw new HttpError(405, 'method_not_allowed');
  }

  // Account-authenticated outbound connections
  if (path === '/api/account/connections' || /^\/api\/account\/connections\/(oc_[a-z2-7]{26})(\/(revoke|webhook|rekey))?$/.test(path)) {
    const session = await serviceSession(req, env);
    if (!session) throw new HttpError(401, 'unauthorized', 'Sign in first');
    const connMatch = /^\/api\/account\/connections\/(oc_[a-z2-7]{26})(?:\/(revoke|webhook|rekey))?$/.exec(path);

    if (!connMatch && m === 'GET') {
      const rows = await env.ACCOUNTS.prepare('SELECT * FROM outbound_connections WHERE account_id = ? AND revoked_at IS NULL ORDER BY created_at DESC')
        .bind(session.accountId).all<OutboundConnectionRow>();
      const ent = await resolveOAuthEntitlements(env, session.accountId);
      return json({
        entitlements: ent,
        connections: rows.results.map(r => connectionView(r)),
      });
    }
    requireSameOrigin(req, env);
    if (!connMatch && m === 'POST') {
      const b = await readJson(req, 8192);
      if (!isPlainObject(b)) throw new HttpError(400, 'bad_request', 'Expected JSON object');
      return json(await startOutboundConnect(env, session.accountId, b), 201);
    }
    if (connMatch) {
      const [, connId, action] = connMatch;
      if ((action === 'revoke' && m === 'POST') || (!action && m === 'DELETE')) {
        const b = m === 'POST' ? await readJson(req, 4096).catch(() => ({})) : {};
        const key = isPlainObject(b) && typeof b.connection_key === 'string' ? b.connection_key : undefined;
        await revokeOutboundConnection(env, session.accountId, connId!, key);
        return json({ revoked: true, id: connId });
      }
      if (action === 'webhook' && m === 'POST') {
        const row = await env.ACCOUNTS.prepare('SELECT id FROM outbound_connections WHERE id = ? AND account_id = ? AND revoked_at IS NULL')
          .bind(connId, session.accountId).first();
        if (!row) throw new HttpError(404, 'connection_not_found', 'Connection not found');
        const b = await readJson(req, 2048).catch(() => ({}));
        const secret = isPlainObject(b) && typeof b.secret === 'string' && b.secret.length >= 16 ? b.secret.slice(0, 256) : randomToken();
        const mode = isPlainObject(b) && b.mode === 'bearer' ? 'bearer' : 'hmac';
        const stored = mode === 'hmac'
          ? `hmac:${await sealHostConfigSecret(env, secret, `webhook:${connId}`)}`
          : await sha256Hex(secret);
        await env.ACCOUNTS.prepare('UPDATE outbound_connections SET webhook_secret_hash = ?, updated_at = ? WHERE id = ?')
          .bind(stored, Date.now(), connId).run();
        return json({
          webhook_url: `${publicBase(env)}/api/webhooks/connections/${connId}`,
          secret,
          mode,
        });
      }
      if (action === 'rekey' && m === 'POST') {
        const b = await readJson(req, 4096);
        if (!isPlainObject(b) || typeof b.old_key !== 'string' || typeof b.new_key !== 'string') {
          throw new HttpError(400, 'bad_request', 'old_key and new_key are required');
        }
        const row = await env.ACCOUNTS.prepare('SELECT * FROM outbound_connections WHERE id = ? AND account_id = ? AND revoked_at IS NULL')
          .bind(connId, session.accountId).first<OutboundConnectionRow>();
        if (!row) throw new HttpError(404, 'connection_not_found', 'Connection not found');
        await rekeyWrappedConnection(env, row, b.old_key, b.new_key);
        return json({ rekeyed: true, id: connId });
      }
    }
    throw new HttpError(405, 'method_not_allowed');
  }

  return null;
}

/** Agent-authenticated outbound OAuth API routes under `/api/agent/connections*`. */
export async function routeAgentConnectionsApi(req: Request, env: Env, url: URL): Promise<Response | null> {
  const path = url.pathname;
  if (!path.startsWith('/api/agent/connections')) return null;
  const agent: GrantedAgent = await authenticateAgentRequest(env, req);
  if (!agent.account_id) throw new HttpError(403, 'agent_unclaimed', 'Agent must be claimed by an account before creating external connections');
  const m = req.method;

  if (path === '/api/agent/connections' && (m === 'GET' || m === 'HEAD')) {
    const rows = await env.ACCOUNTS.prepare(`SELECT c.* FROM outbound_connections c
      WHERE c.account_id = ? AND c.revoked_at IS NULL
        AND (c.agent_id = ? OR c.page_id IN (SELECT page_id FROM agent_grants WHERE agent_id = ?))
      ORDER BY c.created_at DESC`)
      .bind(agent.account_id, agent.id, agent.id).all<OutboundConnectionRow>();
    return json({
      connections: rows.results.map(r => connectionView(r, { includeSealedHandoff: r.agent_id === agent.id })),
    });
  }

  if (path === '/api/agent/connections/connect' && m === 'POST') {
    const b = await readJson(req, 8192);
    if (!isPlainObject(b)) throw new HttpError(400, 'bad_request', 'Expected JSON object');
    const started = await startOutboundConnect(env, agent.account_id, b, {
      agentId: agent.id,
      agentWrapKey: agent.wrap_key,
    });
    return json(started, 201);
  }

  // Stateless Tier A refresh broker: attaches confidential client_secret, exchanges, re-seals to agent wrapKey, stores nothing.
  if (path === '/api/agent/connections/refresh' && m === 'POST') {
    const b = await readJson(req, 8192);
    if (!isPlainObject(b) || typeof b.provider !== 'string' || typeof b.refresh_token !== 'string' || !b.refresh_token) {
      throw new HttpError(400, 'bad_request', 'provider and refresh_token are required');
    }
    const resolved = await resolveProvider(env, agent.account_id, b.provider.trim().toLowerCase());
    const refreshed = await refreshProviderToken(resolved, b.refresh_token);
    const aad = typeof b.connection_id === 'string' && CONNECTION_ID_RE.test(b.connection_id)
      ? `${b.connection_id}:${agent.id}:${resolved.spec.id}`
      : `refresh:${agent.id}:${resolved.spec.id}`;
    const sealed = await sealAgentTokens(agent.wrap_key, refreshed, aad);
    return json({ sealed_tokens: JSON.parse(sealed), provider: resolved.spec.id }, 200, { 'Cache-Control': 'no-store' });
  }

  const single = /^\/api\/agent\/connections\/(oc_[a-z2-7]{26})(?:\/(ack|invoke|rekey|revoke))?$/.exec(path);
  if (single) {
    const [, connId, sub] = single;
    if (sub === 'ack' && m === 'POST') {
      const res = await env.ACCOUNTS.prepare('UPDATE outbound_connections SET sealed_handoff = NULL, updated_at = ? WHERE id = ? AND agent_id = ? AND account_id = ?')
        .bind(Date.now(), connId, agent.id, agent.account_id).run();
      if (!res.meta?.changes) throw new HttpError(404, 'connection_not_found', 'Connection not found for this agent');
      return json({ acknowledged: true, id: connId });
    }
    if (sub === 'invoke' && m === 'POST') {
      const kConn = req.headers.get('X-Connection-Key') ?? '';
      if (!kConn) throw new HttpError(400, 'connection_key_required', 'Supply X-Connection-Key header');
      const row = await env.ACCOUNTS.prepare(`SELECT c.* FROM outbound_connections c
        WHERE c.id = ? AND c.account_id = ? AND c.revoked_at IS NULL
          AND (c.agent_id = ? OR c.page_id IN (SELECT page_id FROM agent_grants WHERE agent_id = ?))`)
        .bind(connId, agent.account_id, agent.id, agent.id).first<OutboundConnectionRow>();
      if (!row) throw new HttpError(404, 'connection_not_found', 'Connection not accessible to this agent');
      const b = await readJson(req, 64 * 1024);
      if (!isPlainObject(b) || typeof b.action !== 'string') throw new HttpError(400, 'bad_request', 'action is required');
      const result = await invokeWrappedConnection(env, row, JSON.parse(row.actions) as string[], kConn, b as any);
      return json(result, 200, { 'Cache-Control': 'no-store' });
    }
    if (sub === 'rekey' && m === 'POST') {
      const b = await readJson(req, 4096);
      if (!isPlainObject(b) || typeof b.old_key !== 'string' || typeof b.new_key !== 'string') {
        throw new HttpError(400, 'bad_request', 'old_key and new_key are required');
      }
      const row = await env.ACCOUNTS.prepare(`SELECT c.* FROM outbound_connections c
        WHERE c.id = ? AND c.account_id = ? AND c.revoked_at IS NULL
          AND (c.agent_id = ? OR c.page_id IN (SELECT page_id FROM agent_grants WHERE agent_id = ?))`)
        .bind(connId, agent.account_id, agent.id, agent.id).first<OutboundConnectionRow>();
      if (!row) throw new HttpError(404, 'connection_not_found', 'Connection not accessible to this agent');
      await rekeyWrappedConnection(env, row, b.old_key, b.new_key);
      return json({ rekeyed: true, id: connId });
    }
    if ((sub === 'revoke' && m === 'POST') || (!sub && m === 'DELETE')) {
      const row = await env.ACCOUNTS.prepare('SELECT id FROM outbound_connections WHERE id = ? AND account_id = ? AND agent_id = ?')
        .bind(connId, agent.account_id, agent.id).first();
      if (!row) throw new HttpError(404, 'connection_not_found', 'Connection not found for this agent');
      await revokeOutboundConnection(env, agent.account_id, connId!);
      return json({ revoked: true, id: connId });
    }
  }

  throw new HttpError(404, 'not_found', 'Unknown agent connection route');
}

/** Page-local outbound connection routes (`_tendril/connections*`). */
export async function handlePageConnections(t: Tendril, req: Request, sub: string, principal: PagePrincipal): Promise<Response> {
  const m = req.method;
  const ownerAccount = t.db.get<string | null>('owner_account', null);

  if (sub === 'connections' && (m === 'GET' || m === 'HEAD')) {
    if (!principal.accountId) throw new HttpError(403, 'forbidden');
    const grants = await t.env.ACCOUNTS.prepare(`SELECT c.*, g.actions AS grant_actions, g.custody AS grant_custody, g.granted_at
      FROM outbound_page_grants g JOIN outbound_connections c ON c.id = g.connection_id
      WHERE g.page_id = ? AND c.revoked_at IS NULL
      ORDER BY g.granted_at DESC`).bind(t.tid).all<OutboundConnectionRow & { grant_actions: string; grant_custody: OutboundCustody; granted_at: number }>();

    const visible = grants.results.filter(r =>
      r.grant_custody === 'page' || r.account_id === principal.accountId || allows(principal, 'page.owner'),
    );
    return json({
      can_manage: allows(principal, 'page.owner'),
      connections: visible.map(r => ({
        ...connectionView(r),
        custody: r.grant_custody,
        actions: JSON.parse(r.grant_actions) as string[],
        granted_at: r.granted_at,
      })),
    }, 200, { 'Cache-Control': 'no-store' });
  }

  if (sub === 'connections/grant' && m === 'POST') {
    if (!allows(principal, 'page.owner') || !principal.accountId) throw new HttpError(403, 'forbidden');
    const b = await readJson(req, 8192);
    if (!isPlainObject(b) || typeof b.connection_id !== 'string' || !CONNECTION_ID_RE.test(b.connection_id)) {
      throw new HttpError(400, 'bad_request', 'Valid connection_id is required');
    }
    const row = await t.env.ACCOUNTS.prepare('SELECT * FROM outbound_connections WHERE id = ? AND account_id = ? AND revoked_at IS NULL')
      .bind(b.connection_id, principal.accountId).first<OutboundConnectionRow>();
    if (!row) throw new HttpError(404, 'connection_not_found', 'Connection not found on owner account');
    const custody: OutboundCustody = b.custody === 'page' ? 'page' : row.custody;
    if (custody === 'page' && row.tier === 'host-brokered') {
      await requireHostBrokeredEntitlement(t.env, principal.accountId, 'page');
    }
    const allowedByConn = new Set(JSON.parse(row.actions) as string[]);
    const actions = b.actions !== undefined ? parseStringList(b.actions, 64, 128) : [...allowedByConn];
    for (const act of actions) {
      if (!allowedByConn.has(act) && !allowedByConn.has('*')) {
        throw new HttpError(403, 'action_exceeds_connection', `Action "${act}" is not authorized on this connection`);
      }
    }
    await t.env.ACCOUNTS.prepare(`INSERT OR REPLACE INTO outbound_page_grants
      (connection_id, page_id, custody, actions, granted_by, granted_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(row.id, t.tid, custody, JSON.stringify(actions), principal.accountId, Date.now()).run();
    addActivity(t, { kind: 'connection_grant', summary: `Granted ${row.provider} (${row.tier}/${custody}) to this page`, by: `owner:${principal.accountId}` });
    return json({ granted: true, connection_id: row.id, custody, actions }, 201);
  }

  const item = /^connections\/(oc_[a-z2-7]{26})(?:\/(invoke|rekey))?$/.exec(sub);
  if (item) {
    const [, connId, action] = item;
    if (!action && m === 'DELETE') {
      if (!allows(principal, 'page.owner') || !principal.accountId) throw new HttpError(403, 'forbidden');
      await t.env.ACCOUNTS.prepare('DELETE FROM outbound_page_grants WHERE connection_id = ? AND page_id = ?')
        .bind(connId, t.tid).run();
      addActivity(t, { kind: 'connection_revoke', summary: `Removed external connection ${connId} from this page`, by: `owner:${principal.accountId}` });
      return new Response(null, { status: 204 });
    }

    const grant = await t.env.ACCOUNTS.prepare(`SELECT c.*, g.actions AS grant_actions, g.custody AS grant_custody
      FROM outbound_page_grants g JOIN outbound_connections c ON c.id = g.connection_id
      WHERE g.connection_id = ? AND g.page_id = ? AND c.revoked_at IS NULL`)
      .bind(connId, t.tid).first<OutboundConnectionRow & { grant_actions: string; grant_custody: OutboundCustody }>();
    if (!grant) throw new HttpError(404, 'connection_not_found', 'Connection is not granted to this page');

    if (action === 'invoke' && m === 'POST') {
      if (!principal.accountId) throw new HttpError(403, 'forbidden');
      // Personal custody can ONLY be invoked by the connecting account; page custody can be invoked by any admitted page member.
      if (grant.grant_custody === 'personal' && grant.account_id !== principal.accountId) {
        throw new HttpError(403, 'personal_connection_only', 'This personal connection can only be invoked by its owner.');
      }
      const kConn = req.headers.get('X-Connection-Key') ?? '';
      if (!kConn) throw new HttpError(400, 'connection_key_required', 'Supply X-Connection-Key header');
      const b = await readJson(req, 64 * 1024);
      if (!isPlainObject(b) || typeof b.action !== 'string') throw new HttpError(400, 'bad_request', 'action is required');
      const result = await invokeWrappedConnection(t.env, grant, JSON.parse(grant.grant_actions) as string[], kConn, b as any);
      addActivity(t, { kind: 'connection_invoke', summary: `Invoked ${grant.provider}:${b.action} (${result.status})`, by: `${principal.role}:${principal.accountId}` });
      return json(result, 200, { 'Cache-Control': 'no-store' });
    }

    if (action === 'rekey' && m === 'POST') {
      if (!principal.accountId) throw new HttpError(403, 'forbidden');
      let canRekey = grant.account_id === principal.accountId || ownerAccount === principal.accountId;
      if (!canRekey && grant.grant_custody === 'page') {
        // Also allow any current Chronolog administrator on `page`-custody connections (e.g. org-admin rotating epoch keys).
        const state = await readControlState(t);
        if (state) {
          const adminKeys = state.permissions.administrators;
          const attestations = t.db.get<Record<string, { payload: { accountId?: string; publicKey?: string } }>>('group_attestations', {});
          canRekey = Object.values(attestations).some(a =>
            a.payload?.accountId === principal.accountId && a.payload?.publicKey && adminKeys.has(a.payload.publicKey),
          );
        }
      }
      if (!canRekey) throw new HttpError(403, 'forbidden');
      const b = await readJson(req, 4096);
      if (!isPlainObject(b) || typeof b.old_key !== 'string' || typeof b.new_key !== 'string') {
        throw new HttpError(400, 'bad_request', 'old_key and new_key are required');
      }
      await rekeyWrappedConnection(t.env, grant, b.old_key, b.new_key);
      addActivity(t, { kind: 'connection_rekey', summary: `Re-keyed wrapped connection ${grant.provider} (${connId})`, by: `${principal.role}:${principal.accountId}` });
      return json({ rekeyed: true, id: connId });
    }
  }

  throw new HttpError(404, 'not_found');
}

/**
 * Render the account-level External OAuth Connections, BYO Providers, and Verified Org/Team Groups
 * section embedded in `/connections` (Item 9).
 */
export async function renderAccountExternalConnectionsSection(
  env: Env,
  accountId: string,
): Promise<{ html: string; script: string }> {
  if (!env.ACCOUNTS) return { html: '', script: '' };
  const now = Date.now();
  const [conns, groups, customProviders] = await Promise.all([
    env.ACCOUNTS.prepare('SELECT * FROM outbound_connections WHERE account_id = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 50')
      .bind(accountId).all<OutboundConnectionRow>().catch(() => ({ results: [] as OutboundConnectionRow[] })),
    env.ACCOUNTS.prepare('SELECT provider, group_id, display_name, expires_at FROM identity_groups WHERE account_id = ? AND expires_at > ? ORDER BY group_id ASC LIMIT 100')
      .bind(accountId, now).all<{ provider: string; group_id: string; display_name: string | null; expires_at: number }>().catch(() => ({ results: [] })),
    env.ACCOUNTS.prepare('SELECT slug, name, allowed_hosts FROM oauth_custom_providers WHERE account_id = ? ORDER BY slug ASC LIMIT 32')
      .bind(accountId).all<{ slug: string; name: string; allowed_hosts: string }>().catch(() => ({ results: [] })),
  ]);

  const connHtml = conns.results.length
    ? `<ul class="list" id="ext-conn-list">${conns.results.map(c => {
        const scopes = (JSON.parse(c.scopes || '[]') as string[]).slice(0, 6).join(', ');
        const tierLabel = c.tier === 'agent-held' ? 'Zero-trust (agent-held)' : `Wrapped proxy (${c.custody})`;
        const who = c.external_label ? ` · ${escapeHtml(c.external_label)}` : '';
        return `<li class="list-item" data-conn-id="${escapeHtml(c.id)}"><div class="list-item-main"><div class="list-item-title">${escapeHtml(c.label || c.provider)} <span class="badge">${escapeHtml(c.provider)}</span> <span class="badge ok">${escapeHtml(tierLabel)}</span></div><p class="list-item-sub">${scopes ? `Scopes: ${escapeHtml(scopes)}` : 'Default scopes'}${who}</p></div><button class="button sm danger" type="button" data-revoke-conn="${escapeHtml(c.id)}">Revoke</button></li>`;
      }).join('')}</ul>`
    : '<p class="empty">No external OAuth connections yet. Ask your agent in chat to connect GitHub, Google, Linear, Notion, Slack, Spotify, or any custom OAuth 2.1 provider.</p>';

  const groupHtml = groups.results.length
    ? `<ul class="list">${groups.results.map(g =>
        `<li class="list-item"><div class="list-item-main"><div class="list-item-title"><code>${escapeHtml(g.group_id)}</code> <span class="badge">${escapeHtml(g.provider)}</span></div><p class="list-item-sub">${escapeHtml(g.display_name || g.group_id)}</p></div></li>`,
      ).join('')}</ul>`
    : '<p class="empty">No verified organization or team memberships cached yet. Sign in with a Google Workspace account or sync your GitHub orgs & teams below.</p>';

  const builtinViews = listBuiltinProviderViews(env);
  const providerPills = builtinViews.map(p =>
    `<span class="badge${p.configured ? ' ok' : ''}" title="${escapeHtml(p.configured ? `${p.name} ready on this host` : `${p.name} not configured on host — use BYO custom:<slug>`)}">${escapeHtml(p.id)}${p.configured ? ' ✓' : ''}</span>`,
  ).join(' ');

  const customHtml = `<div style="margin-top:1.25rem">
    <h3 style="margin:.25rem 0 .5rem">Built-in provider availability</h3>
    <div style="display:flex;flex-wrap:wrap;gap:.4rem;margin-bottom:.9rem">${providerPills}</div>
    ${customProviders.results.length
      ? `<h3 style="margin:.5rem 0 .5rem">Custom BYO OAuth 2.1 providers</h3><ul class="list" id="byo-provider-list">${customProviders.results.map(p =>
          `<li class="list-item" data-byo-slug="${escapeHtml(p.slug)}"><div class="list-item-main"><div class="list-item-title">${escapeHtml(p.name)} <code>custom:${escapeHtml(p.slug)}</code></div><p class="list-item-sub">Allowed hosts: ${escapeHtml((JSON.parse(p.allowed_hosts || '[]') as string[]).join(', '))}</p></div><button class="button sm danger" type="button" data-delete-byo="${escapeHtml(p.slug)}">Remove</button></li>`,
        ).join('')}</ul>`
      : ''}
    <details style="margin-top:.9rem">
      <summary style="cursor:pointer;font-weight:600">Register a custom OAuth 2.1 provider (BYO)</summary>
      <p class="muted" style="margin:.5rem 0 .75rem">Use your own OAuth app for any provider not enabled on this host. Set its redirect URI to <code>${escapeHtml(publicBase(env))}/auth/outbound/callback/custom%3A&lt;slug&gt;</code>.</p>
      <form id="byo-provider-form" style="display:grid;gap:.6rem;max-width:34rem">
        <label style="display:grid;gap:.2rem"><span class="muted">Slug (lowercase, e.g. <code>my-linear</code>)</span><input name="slug" required pattern="[a-z0-9][a-z0-9_-]{1,31}" placeholder="my-linear"></label>
        <label style="display:grid;gap:.2rem"><span class="muted">Display name</span><input name="name" required placeholder="My Linear"></label>
        <label style="display:grid;gap:.2rem"><span class="muted">Authorize URL (HTTPS)</span><input name="authorize_url" type="url" required placeholder="https://linear.app/oauth/authorize"></label>
        <label style="display:grid;gap:.2rem"><span class="muted">Token URL (HTTPS)</span><input name="token_url" type="url" required placeholder="https://api.linear.app/oauth/token"></label>
        <label style="display:grid;gap:.2rem"><span class="muted">Client ID</span><input name="client_id" required></label>
        <label style="display:grid;gap:.2rem"><span class="muted">Client Secret (optional for PKCE public clients; encrypted at rest)</span><input name="client_secret" type="password" autocomplete="new-password"></label>
        <label style="display:grid;gap:.2rem"><span class="muted">Allowed API hosts (comma-separated HTTPS hostnames)</span><input name="allowed_hosts" required placeholder="api.linear.app"></label>
        <label style="display:grid;gap:.2rem"><span class="muted">Default scopes (comma-separated, optional)</span><input name="default_scopes" placeholder="read,write"></label>
        <div class="actions tight"><button class="button sm" type="submit">Save custom provider</button><span class="muted" id="byo-status" aria-live="polite"></span></div>
      </form>
    </details>
  </div>`;

  const html = `
<section class="card" style="margin-top:1.5rem">
  <span class="eyebrow">External OAuth</span>
  <h2>External app &amp; agent connections</h2>
  <p class="lead">Third-party connections never store plaintext OAuth tokens on Tendriller (X25519 sealed to your agent or AES-256-GCM wrapped under your key).</p>
  ${connHtml}
  ${customHtml}
</section>
<section class="card" style="margin-top:1.5rem">
  <span class="eyebrow">Org &amp; Team Access</span>
  <h2>Verified organizations &amp; teams</h2>
  <p class="lead">Used to admit you seamlessly to team pages configured with GitHub Organization/Team or Google Workspace domain rules.</p>
  ${groupHtml}
  <div class="actions" style="margin-top:1rem">
    <a class="button secondary sm" href="/auth/github?org_sync=1&return_to=%2Fconnections">Sync GitHub Orgs &amp; Teams</a>
  </div>
</section>`;

  const script = `(function(){document.querySelectorAll('[data-revoke-conn]').forEach(function(btn){btn.addEventListener('click',function(){var id=btn.getAttribute('data-revoke-conn');if(!id)return;btn.disabled=true;btn.textContent='Revoking...';fetch('/api/account/connections/'+encodeURIComponent(id)+'/revoke',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:'{}'}).then(function(r){if(!r.ok)throw new Error();var li=btn.closest('[data-conn-id]');if(li)li.remove();}).catch(function(){btn.disabled=false;btn.textContent='Revoke';});});});document.querySelectorAll('[data-delete-byo]').forEach(function(btn){btn.addEventListener('click',function(){var slug=btn.getAttribute('data-delete-byo');if(!slug)return;btn.disabled=true;fetch('/api/account/oauth/providers/'+encodeURIComponent(slug),{method:'DELETE',credentials:'same-origin'}).then(function(r){if(!r.ok)throw new Error();var li=btn.closest('[data-byo-slug]');if(li)li.remove();}).catch(function(){btn.disabled=false;});});});var form=document.getElementById('byo-provider-form');if(form){form.addEventListener('submit',function(e){e.preventDefault();var st=document.getElementById('byo-status');var fd=new FormData(form);var split=function(v){return String(v||'').split(',').map(function(s){return s.trim();}).filter(Boolean);};var body={slug:fd.get('slug'),name:fd.get('name'),authorize_url:fd.get('authorize_url'),token_url:fd.get('token_url'),client_id:fd.get('client_id'),allowed_hosts:split(fd.get('allowed_hosts')),default_scopes:split(fd.get('default_scopes'))};var sec=String(fd.get('client_secret')||'').trim();if(sec)body.client_secret=sec;if(st)st.textContent='Saving...';fetch('/api/account/oauth/providers',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(function(r){return r.json().then(function(d){if(!r.ok)throw new Error((d&&d.error&&d.error.message)||'Save failed');return d;});}).then(function(){if(st)st.textContent='Saved! Reloading...';location.reload();}).catch(function(err){if(st)st.textContent=err.message||'Save failed';});});}})();`;

  return { html, script };
}
