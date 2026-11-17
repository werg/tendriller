import { peerApi, peerJson, ownerPeerApi } from './helpers';
import { expect, it } from 'vitest';
import { advance, api, create, inDO, req } from './helpers';
import { createTestPage } from './public-fixture';
const advertisement = (peerId = 'peer-a') => ({ peerId, storageId: `store:${peerId}`, profiles: ['peer-generation-v1'],
  routes: [{ kind: 'rendezvous', channel: `join:${peerId}` }], coordinatorEligible: true,
  recovery: { generation: 'g1', sequence: 8, root: 'ab'.repeat(32), controlRevision: 0, retainedAt: 100 } });

it('discovers independent peers, coalesces duplicate availability, and expires without host wakeups', async () => {
  const h = await create({ mode: 'dashboard', listener: false, application: { kind: 'peer', id: '01'.repeat(32) } });
  expect(await peerJson(h, 'discovery', 'read')).toEqual({ applicationId: '01'.repeat(32), peers: [] });
  const ad = advertisement();
  const lease = await peerJson(h, 'discovery', 'advertise', { advertisement: ad });
  await advance(h.id, 1000);
  expect(await peerJson(h, 'discovery', 'advertise', { advertisement: ad })).toEqual(lease);
  expect(await peerJson(h, 'discovery', 'read')).toEqual({ applicationId: '01'.repeat(32), peers: [lease] });
  expect(await inDO(h.id, t => ({ log: t.db.one('SELECT COUNT(*) AS n FROM record_log_entries'),
    application: t.db.one('SELECT COUNT(*) AS n FROM application_changes'), sockets: t.ctx.getWebSockets().length,
    keys: Object.keys(t.db.get<any[]>('peer_directory', [])[0]) })))
    .toEqual({ log: { n: 0 }, application: { n: 0 }, sockets: 0, keys: ['advertisement', 'owner', 'principal', 'expiresAt', 'refreshAfter'] });
  await advance(h.id, 120000);
  expect((await peerJson(h, 'discovery', 'read')).peers).toEqual([]);
  expect((await peerJson(h, 'discovery', 'advertise', { advertisement: ad })).expiresAt).toBeGreaterThan(lease.expiresAt);
  expect(await peerJson(h, 'discovery', 'withdraw', { peerId: ad.peerId })).toEqual({ withdrawn: ad.peerId });
  expect((await peerJson(h, 'discovery', 'read')).peers).toEqual([]);
});

it('authenticates availability and scopes active advertisement updates to their participant', async () => {
  const page = await createTestPage({ application: { kind: 'peer', id: '02'.repeat(32) } });
  const participant = await page.participant(), ad = advertisement();
  expect((await participant.peer('discovery', 'advertise', { advertisement: ad })).status).toBe(200);
  expect((await page.ownerPeer('discovery', 'advertise', { advertisement: ad })).status).toBe(409);
  expect((await page.peer('discovery', 'withdraw', { peerId: ad.peerId })).status).toBe(409);
  expect((await participant.peer('discovery', 'withdraw', { peerId: ad.peerId })).status).toBe(200);
  expect((await page.peer('discovery', 'advertise', { advertisement: ad })).status).toBe(200);
});

it('withdraws revoked credentials from discovery and survives Durable Object restart', async () => {
  const page = await createTestPage({ application: { kind: 'peer', id: '03'.repeat(32) } });
  const ad = advertisement();
  const lease = await (await page.peer('discovery', 'advertise', { advertisement: ad })).json();
  await page.restart();
  expect(await (await page.ownerPeer('discovery', 'read')).json()).toEqual({ applicationId: '03'.repeat(32), peers: [lease] });
  const h = await create({ mode: 'dashboard', listener: false, application: { kind: 'peer', id: '04'.repeat(32) } });
  await peerJson(h, 'discovery', 'advertise', { advertisement: ad });
  await inDO(h.id, t => t.db.run('DELETE FROM tokens'));
  expect(await (await ownerPeerApi(h, 'discovery', 'read')).json()).toEqual({ applicationId: '04'.repeat(32), peers: [] });
});

it('bounds directory size and rejects unsigned data-plane fields, anonymous readers, and hosted applications', async () => {
  const h = await create({ mode: 'dashboard', listener: false, application: { kind: 'peer', id: '05'.repeat(32) } });
  expect((await req(`${h.api}/peers/participant`, { method: 'POST', anonymous: true })).status).toBe(401);
  for (let i = 0; i < 8; i++) expect((await peerApi(h, 'discovery', 'advertise', { advertisement: advertisement(`peer-${i}`) })).status).toBe(200);
  expect((await peerApi(h, 'discovery', 'advertise', { advertisement: advertisement('overflow') })).status).toBe(429);
  expect((await peerApi(h, 'discovery', 'advertise', { advertisement: { ...advertisement(), commands: [] } })).status).toBe(400);
  expect((await peerApi(h, 'discovery', 'advertise', { advertisement: advertisement(), ttlMs: 10 })).status).toBe(400);
  const hosted = await create({ mode: 'dashboard', listener: false });
  expect((await api(hosted, 'POST', 'peers/participant', {})).status).toBe(409);
});
