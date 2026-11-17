import { peerApi, peerApiJson, peerOwnerApi, participantMessage, participantPayload } from './peer-exchange';
import { expect, it } from 'vitest';
import { createPeerInvitationListener, PEER_INVITATION_LIMITS as LIMITS, PEER_INVITATION_PROTOCOL } from '../../contract/peers.mjs';
import { api, create, inDO, req } from './helpers';
import { createTestPage } from './public-fixture';
import { authenticateAgentToken } from '../src/access';
import { sendPeerInvitation } from '../src/peer-invitations';

const headers = { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': PEER_INVITATION_PROTOCOL };

it('accepts a late join through a hibernatable listener with no expiry timer or idle host requests', async () => {
  const page = await createTestPage({ application: { id: '0b4bafac142b1f628224036aeb8ef8ef2781259163d7f4ef6e8320527bde1116' } });
  const listener = createPeerInvitationListener(page.ownerInvitationSocket('coordinator'), 'coordinator');
  try {
    await listener.ready;
    const idle = page.hostTraffic;
    await page.advance(10 * 60_000);
    expect(page.hostTraffic).toEqual(idle);
    const guest = await page.participant(), invitation = { peerId: 'coordinator', channel: 'late-channel', requesterPeerId: 'new-peer' };
    expect((await guest.exchange('ephemeral/invite', invitation)).status).toBe(200);
    const reader = listener.invitations[Symbol.asyncIterator]();
    expect((await reader.next()).value).toEqual({ channel: 'late-channel', requesterPeerId: 'new-peer' });
    expect((await guest.exchange('ephemeral/invite', invitation)).status).toBe(200);
    expect(listener.stats.receivedInvitations).toBe(1);
    expect(page.hostTraffic.httpRequests - idle.httpRequests).toBe(2);
    expect(page.hostTraffic.invitationUpgrades).toBe(1);
    expect(page.hostTraffic.rendezvousUpgrades).toBe(0);
    expect((await guest.exchange('ephemeral/invite', { ...invitation, command: { sql: 'not a host command' } })).status).toBe(400);
    listener.close(); expect((await reader.next()).done).toBe(true);
  } finally { listener.close(); }
});

it('bounds pending invitation work, coalesces exact retries and refuses an application-data frame', async () => {
  const h = await create({ application: { id: 'e13fc055bc3be9dffef39adc2d65236ae392e355b46a5b20b627e0c2c708800a' }, listener: false, mode: 'dashboard' });
  const before = await inDO(h.id, async t => ({ alarm: await t.ctx.storage.getAlarm(), records: t.db.one("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name='record_log_entries'"),
    application: t.db.one("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name='application_changes'"), devices: t.db.one("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name='devices'") }));
  const response = await api(h, 'GET', 'peers/invitations?peerId=target', undefined, headers);
  expect(response.status).toBe(101);
  const socket = response.webSocket!, closed = new Promise<number>(resolve => socket.addEventListener('close', event => resolve(event.code)));
  socket.accept();
  const invite = (index: number) => peerApi(h, 'ephemeral/invite', { peerId: 'target', channel: `join-${index}`, requesterPeerId: 'source' });
  for (let i = 0; i < LIMITS.pending; i++) expect((await invite(i)).status).toBe(200);
  expect((await invite(LIMITS.pending)).status).toBe(429);
  expect((await invite(0)).status).toBe(200);
  socket.send(JSON.stringify({ t: 'received', channel: 'join-0', requesterPeerId: 'source' }));
  await expect.poll(() => inDO(h.id, t => t.ctx.getWebSockets('peer-invitations')[0].deserializeAttachment().pending.length), { timeout: 10_000 })
    .toBe(LIMITS.pending - 1);
  expect((await invite(LIMITS.pending)).status).toBe(200);
  expect(await inDO(h.id, async t => ({ alarm: await t.ctx.storage.getAlarm(), records: t.db.one("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name='record_log_entries'"),
    application: t.db.one("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name='application_changes'"), devices: t.db.one("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name='devices'") }))).toEqual(before);
  socket.send(JSON.stringify({ t: 'command', program: 'application data' }));
  expect(await closed).toBe(1008);
});

it('authenticates native invitation listeners through private subprotocol headers and fences revoked recipients', async () => {
  const h = await create({ application: { id: '0f0657524ee8db10c0da9c20b3eaa55f0ee95486eddd6bb15675292c11974946' }, listener: false, mode: 'dashboard' });
  expect((await req(`${h.api}/peers/invitations?peerId=target`, { headers, anonymous: true })).status).toBe(401);
  const response = await req(`${h.api}/peers/invitations?peerId=target`, { anonymous: true,
    headers: { ...headers, 'Sec-WebSocket-Protocol': `${PEER_INVITATION_PROTOCOL}, ${h.token}` } });
  expect(response.status).toBe(101);
  const socket = response.webSocket!, closed = new Promise<number>(resolve => socket.addEventListener('close', event => resolve(event.code)));
  socket.accept();
  await inDO(h.id, t => t.db.run('DELETE FROM tokens'));
  const attempted = await peerOwnerApi(h, 'ephemeral/invite', { peerId: 'target', channel: 'after-revocation', requesterPeerId: 'owner' });
  expect(attempted.status).toBe(404); expect(await closed).toBe(4003);
});

it('rechecks the sender after asynchronous recipient authorization before delivering an invitation', async () => {
  const h = await create({ application: { id: '02e6f58e00e0a74baa20e1ef12424acb40747cc17a3a94d036e0ca9d62da6b67' }, listener: false, mode: 'dashboard' });
  const response = await req(`${h.page_url}_tendril/peers/invitations?peerId=target`, { headers });
  const socket = response.webSocket!, listener = createPeerInvitationListener(socket, 'target'); socket.accept(); await listener.ready;
  try {
    await inDO(h.id, async t => {
      const principal = await authenticateAgentToken(t, h.token), original = t.env.ACCOUNTS;
      let changed = false;
      t.env.ACCOUNTS = { prepare(sql: string) {
        const statement = original.prepare(sql);
        if (!sql.includes('FROM accounts WHERE id')) return statement;
        return { bind(...args: unknown[]) { const bound = statement.bind(...args); return { async first() {
          const result = await bound.first(); changed = true; t.db.run('DELETE FROM tokens'); return result;
        } }; } };
      } } as D1Database;
      try {
        const url = new URL(`${h.api}/peers/invitations`), request = new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ peerId: 'target', channel: 'revoked-during-check', requesterPeerId: 'source' }) });
        await expect(sendPeerInvitation(t, principal, { peerId: 'target', channel: 'revoked-during-check', requesterPeerId: 'source' })).rejects.toMatchObject({ status: 403 }); expect(changed).toBe(true);
      } finally { t.env.ACCOUNTS = original; }
    });
    expect(listener.stats.receivedInvitations).toBe(0);
  } finally { listener.close(); }
});

it('limits invitation rate independently of consumed queue slots and resets only on a new request', async () => {
  const page = await createTestPage({ application: { id: 'a60604c22fb668458cf73b412976303903225f49e57f425145e72ff8cdba9d68' } });
  const listener = createPeerInvitationListener(page.ownerInvitationSocket('target'), 'target');
  await listener.ready;
  const reader = listener.invitations[Symbol.asyncIterator]();
  const invite = (channel: string) => page.exchange('ephemeral/invite', { peerId: 'target', channel, requesterPeerId: 'source' });
  try {
    for (let i = 0; i < LIMITS.invitationsPerMinute; i++) {
      expect((await invite(`connection-${i}`)).status).toBe(200);
      expect((await reader.next()).value?.channel).toBe(`connection-${i}`);
    }
    expect((await invite('too-many')).status).toBe(429);
    const before = page.hostTraffic; await page.advance(60_000); expect(page.hostTraffic).toEqual(before);
    expect((await invite('next-window')).status).toBe(200);
    expect((await reader.next()).value?.channel).toBe('next-window');
  } finally { listener.close(); }
}, 20_000);
