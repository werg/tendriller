import { expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { agentReq, BASE, create, inDO, req } from './helpers';
import { generateWrapKeyPair } from '../src/mcp-crypto';
import { generateConnectionKey } from '../src/oauth-outbound/crypto';
import { unsealAgentTokens, consumeConnectionCallbackFragment } from '../../contract/connections.mjs';
import { sha256Hex } from '../src/ids';
import { applyPlanToAccount } from '../src/billing/entitlements';
import { route } from '../src/router';
import { mcpConnectExternalProvider, mcpInvokeExternalConnection, mcpListExternalConnections } from '../src/oauth-outbound/routes';

async function importX25519Priv(raw32: Uint8Array): Promise<CryptoKey> {
  const prefix = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20]);
  const pkcs8 = new Uint8Array(prefix.length + 32);
  pkcs8.set(prefix, 0);
  pkcs8.set(raw32, prefix.length);
  return crypto.subtle.importKey('pkcs8', pkcs8, { name: 'X25519' }, false, ['deriveBits']);
}

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
  return Array.from(sig, b => b.toString(16).padStart(2, '0')).join('');
}

async function signInGuestOnPage(pageUrl: string, pageId: string, linkId: string, email: string): Promise<{ accountId: string; cookie: string }> {
  const accountId = crypto.randomUUID();
  const now = Date.now();
  await env.ACCOUNTS!.prepare('INSERT INTO accounts (id, created_at, email) VALUES (?, ?, ?)').bind(accountId, now, email).run();
  const rawToken = `guest-${crypto.randomUUID()}`;
  const hash = await sha256Hex(rawToken);
  await inDO(pageId, t => {
    t.db.run('INSERT OR REPLACE INTO guest_accounts (account_id, link_id, approved, created_at) VALUES (?, ?, 1, ?)', accountId, linkId, now);
    t.db.run('INSERT INTO page_sessions (hash, account_id, role, expires_at) VALUES (?, ?, ?, ?)', hash, accountId, 'guest', now + 86_400_000);
  });
  return { accountId, cookie: `__Host-tendril=${rawToken}` };
}

it('lists the expanded built-in provider catalog and supports BYO custom OAuth 2.1 providers with SSRF guards', async () => {
  const h = await create({ name: 'Integrations' });
  const pubRes = await req('/api/oauth/providers', { anonymous: true });
  expect(pubRes.status).toBe(200);
  const { providers } = await pubRes.json() as { providers: Array<{ id: string }> };
  const ids = providers.map(p => p.id);
  for (const expected of ['github', 'google', 'linear', 'notion', 'slack', 'figma', 'airtable', 'discord', 'microsoft', 'dropbox', 'todoist', 'spotify', 'strava', 'fitbit', 'oura']) {
    expect(ids).toContain(expected);
  }

  const headers = { Cookie: h.session!, 'Content-Type': 'application/json', Origin: BASE };
  // Reject non-HTTPS or private/loopback URLs
  const badUrl = await req('/api/account/oauth/providers', {
    method: 'POST', anonymous: true, headers,
    body: JSON.stringify({
      slug: 'bad-local', name: 'Bad', authorize_url: 'http://127.0.0.1/auth', token_url: 'https://169.254.169.254/token',
      client_id: 'cid', allowed_hosts: ['127.0.0.1'],
    }),
  });
  expect(badUrl.status).toBe(400);

  // Register a valid BYO custom provider
  const good = await req('/api/account/oauth/providers', {
    method: 'POST', anonymous: true, headers,
    body: JSON.stringify({
      slug: 'nextcloud', name: 'My Nextcloud',
      authorize_url: 'https://cloud.example.org/apps/oauth2/authorize',
      token_url: 'https://cloud.example.org/apps/oauth2/api/v1/token',
      client_id: 'nc_client_1', client_secret: 'nc_secret_1',
      default_scopes: ['files:read'], allowed_hosts: ['cloud.example.org'],
    }),
  });
  expect(good.status).toBe(201);
  const withCustom = await (await req('/api/oauth/providers', { anonymous: true, headers: { Cookie: h.session! } })).json() as { providers: Array<{ id: string }> };
  expect(withCustom.providers.some(p => p.id === 'custom:nextcloud')).toBe(true);

  const del = await req('/api/account/oauth/providers/nextcloud', { method: 'DELETE', anonymous: true, headers: { Cookie: h.session!, Origin: BASE } });
  expect(del.status).toBe(204);

  // Verify built-in GitHub reuses `/auth/callback/github` when no separate outbound override is configured,
  // completes end-to-end through `/auth/callback/github` via `out_` state demuxing, and Google sends
  // `include_granted_scopes=true` requesting only the exact incremental scopes asked for.
  const loginEnv = {
    ...env,
    GITHUB_CLIENT_ID: 'gh_login_id',
    GITHUB_CLIENT_SECRET: 'gh_login_sec',
    GOOGLE_CLIENT_ID: 'g_login_id',
    GOOGLE_CLIENT_SECRET: 'g_login_sec',
  };
  const ghStart = await route(new Request(`${BASE}/api/account/connections`, {
    method: 'POST', headers,
    body: JSON.stringify({ provider: 'github', tier: 'agent-held', agent_id: h.agent.id, scopes: ['read:user'] }),
  }), loginEnv);
  expect(ghStart.status).toBe(201);
  const ghBody = await ghStart.json() as { authorize_url: string; state: string; connection_id: string };
  expect(ghBody.state.startsWith('out_')).toBe(true);
  const ghAuthUrl = new URL(ghBody.authorize_url);
  expect(ghAuthUrl.searchParams.get('redirect_uri')).toBe(`${BASE}/auth/callback/github`);

  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const u = String(input);
    if (u === 'https://github.com/login/oauth/access_token') {
      const bodyStr = String(init?.body ?? '');
      expect(bodyStr).toContain(encodeURIComponent(`${BASE}/auth/callback/github`));
      return Response.json({ access_token: 'gho_reused_cb', token_type: 'bearer', scope: 'read:user' });
    }
    if (u === 'https://api.github.com/user') {
      return Response.json({ id: 777, login: 'octocat' });
    }
    throw new Error(`Unexpected fetch: ${u}`);
  });
  try {
    const ghCb = await route(new Request(`${BASE}/auth/callback/github?code=ghcode&state=${encodeURIComponent(ghBody.state)}`, {
      headers: { Cookie: h.session!, Accept: 'application/json' },
    }), loginEnv);
    expect(ghCb.status).toBe(201);
    const completed = await ghCb.json() as { connection: { id: string; provider: string; external_label: string } };
    expect(completed.connection.id).toBe(ghBody.connection_id);
    expect(completed.connection.external_label).toBe('octocat');
  } finally {
    fetchMock.mockRestore();
  }

  const gStart = await route(new Request(`${BASE}/api/account/connections`, {
    method: 'POST', headers,
    body: JSON.stringify({ provider: 'google', tier: 'agent-held', agent_id: h.agent.id, scopes: ['https://www.googleapis.com/auth/tasks.readonly'] }),
  }), loginEnv);
  expect(gStart.status).toBe(201);
  const gAuthUrl = new URL(((await gStart.json()) as { authorize_url: string }).authorize_url);
  expect(gAuthUrl.searchParams.get('redirect_uri')).toBe(`${BASE}/auth/callback/google`);
  expect(gAuthUrl.searchParams.get('include_granted_scopes')).toBe('true');
  expect(gAuthUrl.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/tasks.readonly');
});

it('Tier A (agent-held): X25519-seals tokens to agent wrapKey with zero plaintext in D1, wipes on ack, and supports stateless refresh', async () => {
  const wrapPair = await generateWrapKeyPair();
  const h = await create({ name: 'Zero-trust sync', agentKeys: { wrapKey: wrapPair.publicKeyHex } });
  const headers = { Cookie: h.session!, 'Content-Type': 'application/json', Origin: BASE };

  // Register a custom provider so the test needs zero host client secrets
  expect((await req('/api/account/oauth/providers', {
    method: 'POST', anonymous: true, headers,
    body: JSON.stringify({
      slug: 'acme', name: 'Acme API',
      authorize_url: 'https://acme.example.org/oauth/authorize',
      token_url: 'https://acme.example.org/oauth/token',
      client_id: 'acme_cid', client_secret: 'acme_secret',
      allowed_hosts: ['api.acme.example.org'],
    }),
  })).status).toBe(201);

  // Agent initiates Tier A connection
  const startRes = await agentReq(h.token, 'POST', '/api/agent/connections/connect', {
    provider: 'custom:acme',
    tier: 'agent-held',
    scopes: ['items:read'],
    page_id: h.id,
  });
  expect(startRes.status).toBe(201);
  const started = await startRes.json() as { connection_id: string; state: string; authorize_url: string; tier: string };
  expect(started.tier).toBe('agent-held');
  expect(started.authorize_url).toContain('code_challenge=');

  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    if (url === 'https://acme.example.org/oauth/token') {
      return Response.json({
        access_token: 'SECRET_TIER_A_ACCESS',
        refresh_token: 'SECRET_TIER_A_REFRESH',
        expires_in: 3600,
        scope: 'items:read',
      });
    }
    throw new Error(`Unexpected external fetch: ${url}`);
  });
  try {
    const cbRes = await req(`/auth/outbound/callback/custom%3Aacme?code=code123&state=${encodeURIComponent(started.state)}`, {
      anonymous: true,
      headers: { Cookie: h.session!, Accept: 'application/json' },
    });
    expect(cbRes.status).toBe(201);
    const cbBody = await cbRes.json() as { connection: { id: string }; connection_key?: string };
    expect(cbBody.connection.id).toBe(started.connection_id);
    expect(cbBody.connection_key).toBeUndefined();

    // Verify D1 stores ZERO plaintext tokens
    const dbRow = await env.ACCOUNTS!.prepare('SELECT wrapped_tokens, sealed_handoff FROM outbound_connections WHERE id = ?')
      .bind(started.connection_id).first<{ wrapped_tokens: string | null; sealed_handoff: string | null }>();
    expect(dbRow?.wrapped_tokens).toBeNull();
    expect(dbRow?.sealed_handoff).toBeTruthy();
    expect(dbRow?.sealed_handoff).not.toContain('SECRET_TIER_A_ACCESS');
    expect(dbRow?.sealed_handoff).not.toContain('SECRET_TIER_A_REFRESH');

    // Agent fetches & unseals with its private X25519 wrapKey
    const listRes = await agentReq(h.token, 'GET', '/api/agent/connections');
    expect(listRes.status).toBe(200);
    const { connections } = await listRes.json() as { connections: Array<{ id: string; sealed_handoff?: any }> };
    const found = connections.find(c => c.id === started.connection_id);
    expect(found?.sealed_handoff).toBeTruthy();

    const privKey = await importX25519Priv(wrapPair.privateKeyBytes);
    const unsealed = await unsealAgentTokens(privKey, wrapPair.publicKeyHex, found!.sealed_handoff, `${started.connection_id}:${h.agent.id}:custom:acme`);
    expect(unsealed.access_token).toBe('SECRET_TIER_A_ACCESS');
    expect(unsealed.refresh_token).toBe('SECRET_TIER_A_REFRESH');

    // Agent acks pickup -> host wipes sealed_handoff immediately
    const ackRes = await agentReq(h.token, 'POST', `/api/agent/connections/${started.connection_id}/ack`, {});
    expect(ackRes.status).toBe(200);
    const afterAck = await env.ACCOUNTS!.prepare('SELECT sealed_handoff FROM outbound_connections WHERE id = ?')
      .bind(started.connection_id).first<{ sealed_handoff: string | null }>();
    expect(afterAck?.sealed_handoff).toBeNull();

    // Stateless confidential refresh broker re-seals rotated tokens and stores nothing
    const refreshRes = await agentReq(h.token, 'POST', '/api/agent/connections/refresh', {
      provider: 'custom:acme',
      connection_id: started.connection_id,
      refresh_token: 'SECRET_TIER_A_REFRESH',
    });
    expect(refreshRes.status).toBe(200);
    const { sealed_tokens } = await refreshRes.json() as { sealed_tokens: any };
    const refreshed = await unsealAgentTokens(privKey, wrapPair.publicKeyHex, sealed_tokens, `${started.connection_id}:${h.agent.id}:custom:acme`);
    expect(refreshed.access_token).toBe('SECRET_TIER_A_ACCESS');
  } finally {
    fetchMock.mockRestore();
  }
});

it('Tier B (host-brokered wrapped proxy): enforces K_conn wrapping, auto-refresh, SSRF, personal vs page custody, atomic rekey, and HMAC webhooks', async () => {
  const h = await create({ name: 'Team dashboard' });
  const acctHeaders = { Cookie: h.session!, 'Content-Type': 'application/json', Origin: BASE };

  expect((await req('/api/account/oauth/providers', {
    method: 'POST', anonymous: true, headers: acctHeaders,
    body: JSON.stringify({
      slug: 'tracker', name: 'Tracker',
      authorize_url: 'https://tracker.example.org/auth',
      token_url: 'https://tracker.example.org/token',
      client_id: 'tr_cid', client_secret: 'tr_sec',
      allowed_hosts: ['api.tracker.example.org'],
    }),
  })).status).toBe(201);

  // Verify real Free -> Pro -> Team billing gates via unified `billing/entitlements.ts`
  expect((await req('/api/account/connections', {
    method: 'POST', anonymous: true, headers: acctHeaders,
    body: JSON.stringify({ provider: 'custom:tracker', tier: 'host-brokered', custody: 'personal', actions: ['http:request'] }),
  })).status).toBe(402);

  await applyPlanToAccount(env, h.account!, 'pro');
  expect((await req('/api/account/connections', {
    method: 'POST', anonymous: true, headers: acctHeaders,
    body: JSON.stringify({ provider: 'custom:tracker', tier: 'host-brokered', custody: 'page', page_id: h.id, actions: ['http:request'] }),
  })).status).toBe(402);

  await applyPlanToAccount(env, h.account!, 'team');

  // Create a shared team (`custody: "page"`) Tier B connection
  const startTeam = await (await req('/api/account/connections', {
    method: 'POST', anonymous: true, headers: acctHeaders,
    body: JSON.stringify({
      provider: 'custom:tracker',
      tier: 'host-brokered',
      custody: 'page',
      page_id: h.id,
      actions: ['http:request'],
    }),
  })).json() as { connection_id: string; state: string };

  let tokenExchangeCount = 0;
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === 'https://tracker.example.org/token') {
      tokenExchangeCount++;
      if (tokenExchangeCount === 1) {
        // Issue an already-expired access token to verify transparent refresh + atomic re-wrap!
        return Response.json({ access_token: 'EXPIRED_TOKEN', refresh_token: 'REFRESH_1', expires_in: -10 });
      }
      return Response.json({ access_token: 'FRESH_TOKEN_2', refresh_token: 'REFRESH_2', expires_in: 3600 });
    }
    if (url === 'https://api.tracker.example.org/v1/items') {
      expect(init?.redirect).toBe('manual');
      const auth = new Headers(init?.headers).get('Authorization');
      return Response.json({ ok: true, auth });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });

  try {
    const cbRes = await req(`/auth/outbound/callback/custom%3Atracker?code=abc&state=${encodeURIComponent(startTeam.state)}`, {
      anonymous: true,
      headers: { Cookie: h.session!, Accept: 'application/json' },
    });
    expect(cbRes.status).toBe(201);
    const { connection_key: kConn1 } = await cbRes.json() as { connection_key: string };
    expect(kConn1).toBeTruthy();

    // Verify D1 holds only ciphertext (zero plaintext tokens)
    const row = await env.ACCOUNTS!.prepare('SELECT wrapped_tokens FROM outbound_connections WHERE id = ?')
      .bind(startTeam.connection_id).first<{ wrapped_tokens: string }>();
    expect(row?.wrapped_tokens).toContain('A256GCM');
    expect(row?.wrapped_tokens).not.toContain('EXPIRED_TOKEN');
    expect(row?.wrapped_tokens).not.toContain('REFRESH_1');

    // Wrong K_conn is rejected (403)
    const wrongKeyRes = await req(`${h.page_url}_tendril/connections/${startTeam.connection_id}/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Connection-Key': generateConnectionKey() },
      body: JSON.stringify({ action: 'http:request', method: 'GET', url: 'https://api.tracker.example.org/v1/items' }),
    });
    expect(wrongKeyRes.status).toBe(403);

    // Off-allowlist SSRF host is rejected (403)
    const ssrfRes = await req(`${h.page_url}_tendril/connections/${startTeam.connection_id}/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Connection-Key': kConn1 },
      body: JSON.stringify({ action: 'http:request', method: 'GET', url: 'https://evil.example.net/steal' }),
    });
    expect(ssrfRes.status).toBe(403);

    // Valid invoke transparently refreshes expired token, atomically re-wraps, and returns upstream JSON
    const okRes = await req(`${h.page_url}_tendril/connections/${startTeam.connection_id}/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Connection-Key': kConn1 },
      body: JSON.stringify({ action: 'http:request', method: 'GET', url: 'https://api.tracker.example.org/v1/items' }),
    });
    expect(okRes.status).toBe(200);
    const invoked = await okRes.json() as { status: number; body: { ok: boolean; auth: string } };
    expect(invoked.status).toBe(200);
    expect(invoked.body).toEqual({ ok: true, auth: 'Bearer FRESH_TOKEN_2' });
    expect(tokenExchangeCount).toBe(2);

    // Admitted guest CAN invoke a shared team (`custody: "page"`) connection
    const guestLink = await (await req(`${h.page_url}_tendril/links`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'guest' }),
    })).json() as { id: string; url: string };
    const guest = await signInGuestOnPage(guestLink.url, h.id, guestLink.id, 'teammate@example.org');
    const guestTeamInvoke = await req(`${guestLink.url}_tendril/connections/${startTeam.connection_id}/invoke`, {
      method: 'POST', anonymous: true,
      headers: { Cookie: guest.cookie, Origin: new URL(guestLink.url).origin, 'Content-Type': 'application/json', 'X-Connection-Key': kConn1 },
      body: JSON.stringify({ action: 'http:request', method: 'GET', url: 'https://api.tracker.example.org/v1/items' }),
    });
    expect(guestTeamInvoke.status).toBe(200);

    // Atomic rekey invalidates old K_conn and succeeds with new K_conn
    const kConn2 = generateConnectionKey();
    const rekeyRes = await req(`${h.page_url}_tendril/connections/${startTeam.connection_id}/rekey`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ old_key: kConn1, new_key: kConn2 }),
    });
    expect(rekeyRes.status).toBe(200);
    expect((await req(`${h.page_url}_tendril/connections/${startTeam.connection_id}/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Connection-Key': kConn1 },
      body: JSON.stringify({ action: 'http:request', method: 'GET', url: 'https://api.tracker.example.org/v1/items' }),
    })).status).toBe(403);
    expect((await req(`${h.page_url}_tendril/connections/${startTeam.connection_id}/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Connection-Key': kConn2 },
      body: JSON.stringify({ action: 'http:request', method: 'GET', url: 'https://api.tracker.example.org/v1/items' }),
    })).status).toBe(200);

    // Personal custody connection CANNOT be invoked by a guest even if they somehow obtained K_conn
    const startPersonal = await (await req('/api/account/connections', {
      method: 'POST', anonymous: true, headers: acctHeaders,
      body: JSON.stringify({ provider: 'custom:tracker', tier: 'host-brokered', custody: 'personal', page_id: h.id, actions: ['http:request'] }),
    })).json() as { connection_id: string; state: string };
    const cbPersonal = await (await req(`/auth/outbound/callback/custom%3Atracker?code=p1&state=${encodeURIComponent(startPersonal.state)}`, {
      anonymous: true, headers: { Cookie: h.session!, Accept: 'application/json' },
    })).json() as { connection_key: string };
    const guestPersonalRes = await req(`${guestLink.url}_tendril/connections/${startPersonal.connection_id}/invoke`, {
      method: 'POST', anonymous: true,
      headers: { Cookie: guest.cookie, Origin: new URL(guestLink.url).origin, 'Content-Type': 'application/json', 'X-Connection-Key': cbPersonal.connection_key },
      body: JSON.stringify({ action: 'http:request', method: 'GET', url: 'https://api.tracker.example.org/v1/items' }),
    });
    expect(guestPersonalRes.status).toBe(403);

    // Inbound HMAC webhook verifies without decrypting OAuth tokens, and its secret is encrypted at rest in D1
    const whSetup = await (await req(`/api/account/connections/${startTeam.connection_id}/webhook`, {
      method: 'POST', anonymous: true, headers: acctHeaders, body: JSON.stringify({ mode: 'hmac' }),
    })).json() as { webhook_url: string; secret: string };
    const storedSecretRow = await env.ACCOUNTS!.prepare('SELECT webhook_secret_hash FROM outbound_connections WHERE id = ?')
      .bind(startTeam.connection_id).first<{ webhook_secret_hash: string }>();
    expect(storedSecretRow?.webhook_secret_hash).not.toContain(whSetup.secret);
    const storedCustomRow = await env.ACCOUNTS!.prepare('SELECT client_secret FROM oauth_custom_providers WHERE slug = ?')
      .bind('tracker').first<{ client_secret: string }>();
    expect(storedCustomRow?.client_secret).not.toBe('tr_sec');
    expect(storedCustomRow?.client_secret).toMatch(/^enc:v1:/);
    const whBody = JSON.stringify({ event: 'issue.created', id: 42 });
    const goodSig = `sha256=${await hmacHex(whSetup.secret, whBody)}`;
    expect((await req(whSetup.webhook_url, {
      method: 'POST', anonymous: true, headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': 'sha256=' + '0'.repeat(64) }, body: whBody,
    })).status).toBe(401);
    expect((await req(whSetup.webhook_url, {
      method: 'POST', anonymous: true, headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': goodSig, 'X-GitHub-Event': 'issues' }, body: whBody,
    })).status).toBe(202);

    // Agent-side rekey (`POST /api/agent/connections/:id/rekey`) supports headless org offboarding
    const kConn3 = generateConnectionKey();
    const agentRekey = await agentReq(h.token, 'POST', `/api/agent/connections/${startTeam.connection_id}/rekey`, {
      old_key: kConn2,
      new_key: kConn3,
    });
    expect(agentRekey.status).toBe(200);
    expect((await req(`${h.page_url}_tendril/connections/${startTeam.connection_id}/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Connection-Key': kConn3 },
      body: JSON.stringify({ action: 'http:request', method: 'GET', url: 'https://api.tracker.example.org/v1/items' }),
    })).status).toBe(200);

    // HTML callback delivers zero-copy-paste fragment handoff to page return_to + Copy button, and /connections lists it
    const startHtml = await (await req('/api/account/connections', {
      method: 'POST', anonymous: true, headers: acctHeaders,
      body: JSON.stringify({ provider: 'custom:tracker', tier: 'host-brokered', custody: 'personal', return_to: h.page_url, actions: ['http:request'] }),
    })).json() as { state: string };
    const htmlCb = await req(`/auth/outbound/callback/custom%3Atracker?code=html1&state=${encodeURIComponent(startHtml.state)}`, {
      anonymous: true, headers: { Cookie: h.session!, Accept: 'text/html' },
    });
    expect(htmlCb.status).toBe(200);
    const htmlText = await htmlCb.text();
    expect(htmlText).toContain('tendril-copy-kconn');
    const fragMatch = /#tendril-connection=([A-Za-z0-9_-]+)/.exec(htmlText);
    expect(fragMatch).toBeTruthy();
    const parsedHandoff = consumeConnectionCallbackFragment({ hash: `#tendril-connection=${fragMatch![1]}`, pathname: '/', search: '' }, null as any);
    expect(parsedHandoff?.connection_key).toBeTruthy();
    expect(parsedHandoff?.connection.provider).toBe('custom:tracker');

    const dashRes = await req('/connections', { anonymous: true, headers: { Cookie: h.session! } });
    expect(dashRes.status).toBe(200);
    const dashHtml = await dashRes.text();
    expect(dashHtml).toContain('External app &amp; agent connections');
    expect(dashHtml).toContain('Sync GitHub Orgs &amp; Teams');
    expect(dashHtml).toContain('Register a custom OAuth 2.1 provider (BYO)');
    expect(dashHtml).toContain('custom:tracker');
  } finally {
    fetchMock.mockRestore();
  }
});

it('Tier B agent auto-handoff and Hosted MCP tools invoke external connections with zero browser UI and zero plaintext keys at rest', async () => {
  const agentWrap = await generateWrapKeyPair();
  const h = await create({ name: 'Headless Integrations', agentKeys: { wrapKey: agentWrap.publicKeyHex } });
  await applyPlanToAccount(env, h.account!, 'pro');
  const acctHeaders = { Cookie: h.session!, 'Content-Type': 'application/json', Origin: BASE };

  expect((await req('/api/account/oauth/providers', {
    method: 'POST', anonymous: true, headers: acctHeaders,
    body: JSON.stringify({
      slug: 'calapi', name: 'CalAPI',
      authorize_url: 'https://cal.example.org/auth',
      token_url: 'https://cal.example.org/token',
      client_id: 'cal_cid', client_secret: 'cal_sec',
      allowed_hosts: ['api.cal.example.org'],
    }),
  })).status).toBe(201);

  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const u = String(input);
    if (u === 'https://cal.example.org/token') {
      return Response.json({ access_token: 'CAL_SECRET_ACCESS', refresh_token: 'CAL_REFRESH', expires_in: 3600 });
    }
    if (u === 'https://api.cal.example.org/events') {
      return Response.json({ items: [{ title: 'Standup' }], auth: new Headers(init?.headers).get('Authorization') });
    }
    throw new Error(`Unexpected fetch: ${u}`);
  });

  try {
    // 1. Workspace agent initiates Tier B -> callback X25519-seals K_conn to agent wrapKey -> agent unseals, acks, invokes!
    const agStart = await (await agentReq(h.token, 'POST', '/api/agent/connections/connect', {
      provider: 'custom:calapi', tier: 'host-brokered', custody: 'personal', actions: ['http:request'],
    })).json() as { connection_id: string; state: string };
    const agCb = await req(`/auth/outbound/callback/custom%3Acalapi?code=ag1&state=${encodeURIComponent(agStart.state)}`, {
      anonymous: true, headers: { Cookie: h.session!, Accept: 'application/json' },
    });
    expect(agCb.status).toBe(201);

    const agList = await (await agentReq(h.token, 'GET', '/api/agent/connections')).json() as {
      connections: Array<{ id: string; tier: string; sealed_handoff?: any }>;
    };
    const agConn = agList.connections.find(c => c.id === agStart.connection_id);
    expect(agConn?.tier).toBe('host-brokered');
    expect(agConn?.sealed_handoff).toBeTruthy();
    const agPriv = await importX25519Priv(agentWrap.privateKeyBytes);
    const unsealedAg = await unsealAgentTokens(agPriv, agentWrap.publicKeyHex, agConn!.sealed_handoff, `${agStart.connection_id}:${h.agent.id}:custom:calapi`) as unknown as { connection_key: string };
    expect(unsealedAg.connection_key).toBeTruthy();

    expect((await agentReq(h.token, 'POST', `/api/agent/connections/${agStart.connection_id}/ack`, {})).status).toBe(200);
    const agInvoke = await agentReq(h.token, 'POST', `/api/agent/connections/${agStart.connection_id}/invoke`, {
      action: 'http:request', method: 'GET', url: 'https://api.cal.example.org/events',
    }, { 'X-Connection-Key': unsealedAg.connection_key });
    expect(agInvoke.status).toBe(200);
    expect(((await agInvoke.json()) as { body: { auth: string } }).body.auth).toBe('Bearer CAL_SECRET_ACCESS');

    // 2. Hosted MCP initiates Tier B -> K_conn sealed to MCP grant's wrap_public_key -> invokes with zero UI / zero local agent!
    const mcpWrap = await generateWrapKeyPair();
    const mcpGrantId = 'grant_mcp_test_1';
    const mcpStarted = await mcpConnectExternalProvider(env, h.account!, mcpGrantId, mcpWrap.publicKeyHex, {
      provider: 'custom:calapi', actions: ['http:request'],
    });
    const mcpCb = await req(`/auth/outbound/callback/custom%3Acalapi?code=mcp1&state=${encodeURIComponent(mcpStarted.state)}`, {
      anonymous: true, headers: { Cookie: h.session!, Accept: 'application/json' },
    });
    expect(mcpCb.status).toBe(201);
    const { connection_key: rawMcpKConn } = await mcpCb.json() as { connection_key: string };

    // Verify D1 stores ZERO plaintext K_conn or OAuth access token
    const d1Row = await env.ACCOUNTS!.prepare('SELECT wrapped_tokens, sealed_handoff FROM outbound_connections WHERE id = ?')
      .bind(mcpStarted.connection_id).first<{ wrapped_tokens: string; sealed_handoff: string }>();
    expect(d1Row?.wrapped_tokens).not.toContain('CAL_SECRET_ACCESS');
    expect(d1Row?.sealed_handoff).not.toContain(rawMcpKConn);

    const listed = await mcpListExternalConnections(env, h.account!);
    expect(listed.connections.find(c => c.id === mcpStarted.connection_id)?.mcp_callable).toBe(true);

    // Invoke via Hosted MCP with the matching grant's RAM wrapPrivateKey
    const mcpResult = await mcpInvokeExternalConnection(env, h.account!, mcpGrantId, mcpWrap.publicKeyHex, mcpWrap.privateKeyBytes, {
      connection_id: mcpStarted.connection_id, action: 'http:request', method: 'GET', url: 'https://api.cal.example.org/events',
    });
    expect(mcpResult.status).toBe(200);
    expect((mcpResult.body as { items: Array<{ title: string }> }).items[0]?.title).toBe('Standup');

    // A different MCP grant CANNOT unseal K_conn
    const otherWrap = await generateWrapKeyPair();
    await expect(mcpInvokeExternalConnection(env, h.account!, 'grant_other', otherWrap.publicKeyHex, otherWrap.privateKeyBytes, {
      connection_id: mcpStarted.connection_id, action: 'http:request', method: 'GET', url: 'https://api.cal.example.org/events',
    })).rejects.toMatchObject({ status: 403 });
  } finally {
    fetchMock.mockRestore();
  }
});
