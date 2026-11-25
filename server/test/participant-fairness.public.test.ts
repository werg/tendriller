import { expect, it } from 'vitest';
import { api, apiJson, create, inDO, req, ownerHeaders, type Handle } from './helpers';
import { peerApi, peerApiJson, peerOwnerApi } from './peer-exchange';
import { PEER_DIRECTORY_LIMITS, PEER_INVITATION_LIMITS, PEER_INVITATION_PROTOCOL, PEER_RELAY_LIMITS, PEER_RELAY_PROTOCOL } from '../../contract/peers.mjs';
import { authenticateAgentToken, type PagePrincipal } from '../src/access';
import { handlePeerParticipant } from '../src/peer-participant';
import { authorityRecord } from '../../contract/authority.mjs';
import { encodeRecord } from '@chronolog/authority';

async function agent(handle: Handle, name: string, scopes = ['host:read', 'participants:connect']): Promise<Handle> {
  const value = await apiJson(handle, 'POST', 'tokens', { name, scopes });
  return { ...handle, token: value.token };
}
const advertisement = (peerId: string) => ({ peerId, storageId: `store:${peerId}`, routes: [{ kind: 'rendezvous', channel: `join:${peerId}` }] });

it('named agent bindings and the human owner share discovery capacity while revocation stays narrow', async () => {
  const handle = await create(), one = await agent(handle, 'one'), two = await agent(handle, 'two'), three = await agent(handle, 'three');
  const headers = { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': 'tendriller.discovery.v1' }, sockets: WebSocket[] = [];
  const watch = async (h: Handle, id: string) => {
    const response = await api(h, 'GET', 'peers/discovery/watch?peerId=' + id, undefined, headers);
    if (response.status === 101) { response.webSocket!.accept(); sockets.push(response.webSocket!); }
    return response;
  };
  try {
    for (let i = 0; i < PEER_DIRECTORY_LIMITS.peersPerPrincipal; i++) {
      expect((await watch(i % 2 ? one : two, `shared-${i}`)).status).toBe(101);
      expect((await peerApi(i % 2 ? one : two, 'discovery/advertise', { advertisement: advertisement(`shared-${i}`) })).status).toBe(200);
    }
    expect((await watch(three, 'additional-token')).status).toBe(429);
    expect((await req(handle.page_url + '_tendril/peers/discovery/watch?peerId=same-human',
      { headers: { ...ownerHeaders(handle.page_url), ...headers } })).status).toBe(429);
    expect((await peerApi(one, 'discovery/withdraw', { peerId: 'shared-0' })).status).toBe(409);
    expect((await api(handle, 'DELETE', 'tokens/one')).ok).toBe(true);
    const remaining = (await peerApiJson(two, 'discovery/read')).peers;
    expect(remaining).toHaveLength(PEER_DIRECTORY_LIMITS.peersPerPrincipal / 2);
    expect(remaining.every((row: any) => Number(row.advertisement.peerId.split('-')[1]) % 2 === 0)).toBe(true);
    expect((await watch(three, 'new-after-revoke')).status).toBe(101);
    expect((await peerApi(three, 'discovery/advertise', { advertisement: advertisement('new-after-revoke') })).status).toBe(200);
  } finally { for (const socket of sockets) socket.close(); }
});

it('listener and relay quotas cannot be multiplied by additive credentials or credential rotation', async () => {
  const handle = await create(), one = await agent(handle, 'one'), two = await agent(handle, 'two'), three = await agent(handle, 'three');
  const sockets: WebSocket[] = [], invitationHeaders = { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': PEER_INVITATION_PROTOCOL };
  const relayHeaders = { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': PEER_RELAY_PROTOCOL };
  const relay = (index: number) => `peers/relay?${new URLSearchParams({ channel: `fair-${index}`, peerId: 'ab'.repeat(32), remotePeerId: 'cd'.repeat(32), lane: 'reliable' })}`;
  try {
    for (let i = 0; i < PEER_INVITATION_LIMITS.listenersPerPrincipal; i++) {
      const response = await api(i % 2 ? one : two, 'GET', `peers/invitations?peerId=listener-${i}`, undefined, invitationHeaders);
      expect(response.status).toBe(101); response.webSocket!.accept(); sockets.push(response.webSocket!);
    }
    expect((await api(three, 'GET', 'peers/invitations?peerId=listener-overflow', undefined, invitationHeaders)).status).toBe(429);
    for (let i = 0; i < PEER_RELAY_LIMITS.sessionsPerPrincipal; i++) {
      const response = await api(i % 2 ? one : two, 'GET', relay(i), undefined, relayHeaders);
      expect(response.status).toBe(101); response.webSocket!.accept(); sockets.push(response.webSocket!);
    }
    expect((await api(three, 'GET', relay(99), undefined, relayHeaders)).status).toBe(429);
    await api(handle, 'DELETE', 'tokens/one');
    const replacement = await api(three, 'GET', 'peers/invitations?peerId=after-revocation', undefined, invitationHeaders);
    expect(replacement.status).toBe(101); replacement.webSocket!.accept(); sockets.push(replacement.webSocket!);
    const nextRelay = await api(three, 'GET', relay(100), undefined, relayHeaders);
    expect(nextRelay.status).toBe(101); nextRelay.webSocket!.accept(); sockets.push(nextRelay.webSocket!);
    const retained = await inDO(handle.id, t => t.ctx.getWebSockets().filter(ws => ws.readyState === WebSocket.READY_STATE_OPEN)
      .map(ws => ws.deserializeAttachment()).filter(row => ['peer-relay', 'peer-invitations'].includes(row?.kind)));
    expect(retained.some(row => row.principal.name === 'one')).toBe(false);
    expect(retained.filter(row => row.principal.name === 'two')).toHaveLength(8);
    const rotated = await apiJson(handle, 'POST', 'tokens/two/rotate', {});
    const rotatedListener = await api({ ...two, token: rotated.token }, 'GET', 'peers/invitations?peerId=rotated', undefined, invitationHeaders);
    expect(rotatedListener.status).toBe(101); rotatedListener.webSocket!.accept(); sockets.push(rotatedListener.webSocket!);
  } finally { for (const socket of sockets) try { socket.close(); } catch {} }
});

it('a saturated account retains no more than half the participant request slots', async () => {
  const handle = await create(), first = await agent(handle, 'first'), second = await agent(handle, 'second'), third = await agent(handle, 'third');
  await inDO(handle.id, async t => {
    const a = await authenticateAgentToken(t, first.token), b = await authenticateAgentToken(t, second.token), c = await authenticateAgentToken(t, third.token);
    const message = authorityRecord(encodeRecord({})), complete: (() => void)[] = [];
    const held = () => new Request('https://participant.invalid/', { method: 'POST', body: new ReadableStream<Uint8Array>({ start(controller) {
      complete.push(() => { controller.enqueue(new TextEncoder().encode(JSON.stringify(message))); controller.close(); });
    } }) });
    const pending = [handlePeerParticipant(t, held(), a), handlePeerParticipant(t, held(), b)];
    try {
      await expect(handlePeerParticipant(t, new Request('https://participant.invalid/', { method: 'POST', body: JSON.stringify(message) }), c))
        .rejects.toMatchObject({ status: 429, code: 'participant_busy' });
      const account = crypto.randomUUID(), sessionHash = crypto.randomUUID(), link = await t.createLink('guest', 'independent account', null);
      await t.env.ACCOUNTS.prepare('INSERT INTO accounts(id,created_at,email) VALUES(?,?,?)').bind(account, Date.now(), account + '@example.test').run();
      t.db.run('INSERT INTO guest_accounts(account_id,link_id,approved,created_at) VALUES(?,?,1,?)', account, link.id, t.now());
      t.db.run('INSERT INTO page_sessions(hash,account_id,role,expires_at) VALUES(?,?,?,?)', sessionHash, account, 'guest', t.now() + 86400_000);
      const guest: PagePrincipal = { kind: 'page', role: 'guest', name: account, accountId: account, linkId: link.id, sessionHash };
      await expect(handlePeerParticipant(t, new Request('https://participant.invalid/', { method: 'POST', body: JSON.stringify(message) }), guest)).rejects.toMatchObject({ status: 400, code: 'participant_fields_invalid' });
    } finally { for (const finish of complete) finish(); await Promise.allSettled(pending); }
    await expect(handlePeerParticipant(t, new Request('https://participant.invalid/', { method: 'POST', body: JSON.stringify(message) }), c)).rejects.toMatchObject({ status: 400, code: 'participant_fields_invalid' });
  });
});

it('host metadata credentials cannot open discovery, invitation or relay participation', async () => {
  const handle = await create(), observer = await agent(handle, 'metadata-only', ['host:read']);
  expect((await peerApi(observer, 'discovery/read')).status).toBe(403);
  expect((await api(observer, 'GET', 'peers/invitations?peerId=forbidden', undefined,
    { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': PEER_INVITATION_PROTOCOL })).status).toBe(403);
  expect((await api(observer, 'GET', 'peers/bootstrap')).status).toBe(403);
  expect((await api(observer, 'GET', '')).status).toBe(200);
});
