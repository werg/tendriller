import { beforeAll, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { create, api, inDO, req } from './helpers';
import { peerApiJson } from './peer-exchange';
import { createPeerIdentity, participantGrant, signTransitionRequest, verifyAuthorityBundle, type AuthorityBundle } from '@chronolog/peer-generation/control';
import { authenticateAgentToken, currentPrincipal, freshPrincipal } from '../src/access';
import { PEER_INVITATION_PROTOCOL } from '../../contract/invitations.mjs';
import { SETUP_SCOPES } from '../src/setup-credential';
import { freshAdapters } from '../src/assistant-admission';
import { handleAssistantFrame, callAssistantAdapter } from '../src/assistant-socket';
import { ASSISTANT_SOCKET_TAG } from '../src/assistant-shared';
import { exchangeDiscovery } from '../src/discovery';
import { handleInvitations } from '../src/peer-invitations';
import { handleDevicePairing } from '../src/device-pairing';
import { sha256Hex } from '../src/ids';

const ORIGIN = 'https://tendriller.dev';
let signing: string;
beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  signing = JSON.stringify({ ...await crypto.subtle.exportKey('jwk', pair.privateKey), alg: 'ES256', kid: 'setup-authority-test' });
});

// Construct the exact post-initialization authority boundary independently of
// setup allocation. These checks also cover an already claimed, resident page.
async function fixture() {
  const handle = await create(), grant = crypto.randomUUID(), now = Date.now();
  const account = await inDO(handle.id, t => t.db.get<string>('owner_account', ''));
  await env.ACCOUNTS.prepare(`INSERT INTO integration_oauth_grants(id,account_id,client_id,resource,scope,created_at,expires_at)
    VALUES(?,?,'setup-client',?,'tendrils:create',?,?)`).bind(grant, account, ORIGIN + '/mcp', now, now + 172_800_000).run();
  const commitment = await sha256Hex(handle.token);
  const principal = await inDO(handle.id, async t => {
    t.env.OAUTH_SIGNING_JWK = signing;
    t.env.OAUTH_CONFIG_JSON = JSON.stringify({ resource: ORIGIN + '/mcp', clients: [{ id: 'setup-client', name: 'Setup client',
      redirectUris: ['https://chatgpt.com/connector_platform_oauth_redirect'], scopes: ['tendrils:create'] }] });
    t.db.run("UPDATE tokens SET name='setup' WHERE name='main'");
    t.db.del('agent_binding:main');
    t.db.set('agent_binding:setup', { id: crypto.randomUUID(), scopes: [...SETUP_SCOPES], revision: 1 });
    t.db.set('account_setup', { digest: 'a'.repeat(64), page: handle.id, commitment, account_id: account,
      client_id: 'setup-client', grant_id: grant, service_origin: ORIGIN, expires_at: now + 86_400_000 });
    return authenticateAgentToken(t, handle.token);
  });
  return { handle, grant, account, principal };
}

it('keeps setup authority narrow and refuses rotation of its fixed credential commitment', async () => {
  const f = await fixture();
  expect((await api(f.handle, 'GET', 'self')).status).toBe(200);
  expect((await api(f.handle, 'POST', 'tokens', { name: 'another', scopes: ['host:read'] })).status).toBe(403);
  expect((await api(f.handle, 'PATCH', '', { name: 'Renamed' })).status).toBe(403);
  const rotated = await api(f.handle, 'POST', 'tokens/setup/rotate');
  expect(rotated.status).toBe(403);
  expect(await rotated.json()).toMatchObject({ error: { code: 'setup_credential_fixed' } });
  expect((await api(f.handle, 'GET', 'self')).status).toBe(200);
  expect(await inDO(f.handle.id, t => t.db.one("SELECT hash FROM tokens WHERE name='setup'")))
    .toEqual({ hash: f.principal.credentialHash });
});

it('reserves the fixed setup name before ordinary delegation can mint an unusable token', async () => {
  const handle = await create();
  const response = await api(handle, 'POST', 'tokens', { name: 'setup', scopes: ['host:read'] });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { code: 'reserved_agent_name' } });
  expect(await inDO(handle.id, t => t.db.one("SELECT hash FROM tokens WHERE name='setup'"))).toBeNull();
});

it('continues a claimed app through reviewed delegation after setup expiry without changing signed authority', async () => {
  const f = await fixture(), device = await createPeerIdentity();
  const authority = await peerApiJson<AuthorityBundle>(f.handle, 'control/configure', {
    historyId: 'retained-setup-application', executionManifestDigest: '12'.repeat(32),
    definition: { id: 'retained-setup', version: '1', schema: null, commands: [], queries: [] },
    schemaAdministrator: device.publicKey, epoch: 0, keyDigest: '56'.repeat(32),
    members: [{ grant: participantGrant(device.publicKey, { administrator: true, publisher: true }) }],
  });
  const descriptor = authority.descriptor.payload;
  const request = await signTransitionRequest({ applicationId: descriptor.applicationId, profile: descriptor.profile, policy: descriptor.policy,
    transitionId: 'retained-setup-genesis', expectedGeneration: null, requester: device.publicKey, coordinator: device.publicKey,
    controlRevision: 0, reason: 'create', base: null }, device);
  const generation = await peerApiJson(f.handle, 'control/select', { request });
  const before = await peerApiJson<AuthorityBundle>(f.handle, 'control/read');
  await inDO(f.handle.id, t => t.db.set('account_setup', { ...t.db.get<object>('account_setup', {}), expires_at: Date.now() - 1 }));
  expect((await api(f.handle, 'GET', 'self')).status).toBe(401);
  const form = new URLSearchParams({ action: 'delegate-agent', name: 'retained-native' });
  for (const scope of SETUP_SCOPES) form.append('scopes', scope);
  const review = await req(f.handle.page_url + '_tendril/manage', { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() });
  expect(review.status).toBe(200);
  const code = new RegExp(f.handle.id + '-[0-9]{6}').exec(await review.text())![0];
  const response = await req('/api/adopt', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, expectedMode: 'delegate', applicationId: f.handle.application.id }) });
  expect(response.status).toBe(200);
  const delegated = await response.json() as typeof f.handle;
  expect(delegated.id).toBe(f.handle.id);
  expect(delegated.token).not.toBe(f.handle.token);
  expect((await api(delegated, 'GET', 'self')).status).toBe(200);
  expect((await api(delegated, 'POST', 'tokens', { name: 'unauthorized', scopes: ['host:read'] })).status).toBe(403);
  expect(await peerApiJson(delegated, 'control/select', { request })).toEqual(generation);
  const after = await peerApiJson<AuthorityBundle>(delegated, 'control/read');
  expect(after).toEqual(before);
  expect((await verifyAuthorityBundle(after, authority.descriptor)).current?.id).toBe(generation.id);
  expect((await api(f.handle, 'GET', 'self')).status).toBe(401);
});

it('fails closed for missing, widened or changed setup bindings instead of granting historical unrestricted access', async () => {
  const f = await fixture(), original = f.principal.binding!;
  for (const binding of [null, { ...original, scopes: [...SETUP_SCOPES, 'agents:delegate'] },
    { ...original, scopes: SETUP_SCOPES.slice(1) }, { ...original, revision: 2 }]) {
    await inDO(f.handle.id, t => {
      if (binding) t.db.set('agent_binding:setup', binding); else t.db.del('agent_binding:setup');
    });
    const response = await api(f.handle, 'GET', 'self');
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: 'setup_binding_inactive' } });
    expect(await inDO(f.handle.id, t => currentPrincipal(t, f.principal))).toBeNull();
  }
});

it('expires retained principals on claimed pages and rechecks grant revocation before using cached peer authority', async () => {
  const expired = await fixture();
  await inDO(expired.handle.id, t => { t.skew += 86_400_001; });
  expect(await inDO(expired.handle.id, t => currentPrincipal(t, expired.principal))).toBeNull();
  expect((await api(expired.handle, 'GET', 'self')).status).toBe(401);
  const revoked = await fixture();
  expect(await inDO(revoked.handle.id, t => freshPrincipal(t, revoked.principal))).toMatchObject({ name: 'setup' });
  await env.ACCOUNTS.prepare('UPDATE integration_oauth_grants SET revoked_at=? WHERE id=?').bind(Date.now(), revoked.grant).run();
  expect(await inDO(revoked.handle.id, t => freshPrincipal(t, revoked.principal))).toBeNull();
  expect((await api(revoked.handle, 'GET', 'self')).status).toBe(401);
  await inDO(revoked.handle.id, async t => {
    await expect(exchangeDiscovery(t, revoked.principal, 'read', {})).rejects.toMatchObject({ code: 'forbidden' });
    const request = new Request('https://tendril.internal/agent?peerId=retained-peer', {
      headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': PEER_INVITATION_PROTOCOL },
    });
    await expect(handleInvitations(t, request, new URL(request.url), revoked.principal)).rejects.toMatchObject({ code: 'forbidden' });
    const pairingRequest = new Request('https://tendril.internal/agent');
    await expect(handleDevicePairing(t, pairingRequest, new URL(pairingRequest.url), revoked.principal))
      .rejects.toMatchObject({ code: 'pairing_account_revoked' });
  });
});

it('rejects ready setup credentials after grant expiry, account suspension or configured scope removal', async () => {
  for (const reason of ['grant_expired', 'suspended', 'scope_removed'] as const) {
    const f = await fixture();
    if (reason === 'grant_expired') await env.ACCOUNTS.prepare('UPDATE integration_oauth_grants SET expires_at=0 WHERE id=?').bind(f.grant).run();
    else if (reason === 'suspended') await env.ACCOUNTS.prepare('UPDATE accounts SET suspended_at=? WHERE id=?').bind(Date.now(), f.account).run();
    else await inDO(f.handle.id, t => {
      const config = JSON.parse(t.env.OAUTH_CONFIG_JSON!); config.clients[0].scopes = []; t.env.OAUTH_CONFIG_JSON = JSON.stringify(config);
    });
    expect(await inDO(f.handle.id, t => freshPrincipal(t, f.principal))).toBeNull();
    expect((await api(f.handle, 'GET', 'self')).status).toBe(reason === 'suspended' ? 403 : 401);
  }
});

it('revokes existing assistant adapter ingress and dispatch when its setup grant ends', async () => {
  const f = await fixture(), adapterHash = 'd'.repeat(64), version = crypto.randomUUID();
  await inDO(f.handle.id, t => {
    t.db.set('assistant_connection', { id: version, owner: f.account, applicationId: f.handle.application.id, label: 'Prepared app',
      queries: [{ name: 'notes', description: 'Notes' }], commands: [], events: [], version, inboxVersion: version });
    t.db.set('assistant_adapters', { agent: f.principal, hashes: [adapterHash] });
  });
  expect(await inDO(f.handle.id, t => freshAdapters(t))).toEqual([adapterHash]);
  await env.ACCOUNTS.prepare('UPDATE integration_oauth_grants SET revoked_at=? WHERE id=?').bind(Date.now(), f.grant).run();
  await inDO(f.handle.id, async t => {
    expect(await freshAdapters(t)).toEqual([]);
    let closed = 0, sent = 0;
    const socket = { readyState: WebSocket.READY_STATE_OPEN,
      deserializeAttachment: () => ({ tag: ASSISTANT_SOCKET_TAG, adapterHash, deviceId: 'b'.repeat(64), connectionEpoch: 1 }),
      close: (code: number) => { closed = code; }, send: () => { sent++; } } as unknown as WebSocket;
    await handleAssistantFrame(t, socket, JSON.stringify({ type: 'result', id: crypto.randomUUID(), value: 'cached' }));
    expect(closed).toBe(4003);
    await expect(callAssistantAdapter(t, socket, {}, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'application_participant_offline' });
    expect(sent).toBe(0);
  });
});
