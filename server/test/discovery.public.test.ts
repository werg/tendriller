import { peerApi, peerApiJson, peerOwnerApi, participantMessage, participantPayload } from './peer-exchange';
import { expect, it } from 'vitest';
import { advance, api, apiJson, create, inDO, req } from './helpers';
import { createTestPage } from './public-fixture';
const advertisement = (peerId = 'peer-a') => ({ peerId, storageId: `store:${peerId}`, profiles: ['peer-generation-v1'],
  routes: [{ kind: 'rendezvous', channel: `join:${peerId}` }], coordinatorEligible: true,
  recovery: { generation: 'g1', sequence: 8, root: 'ab'.repeat(32), controlRevision: 0, retainedAt: 100 } });

it('discovers independent peers, coalesces duplicate availability, and expires without host wakeups', async () => {
  const h = await create({ mode: 'dashboard', listener: false, application: { id: 'e17410f37bea544015af1bb0ed29baef7a9cc99617ca3d4fb8bfca77189f32e7' } });
  expect(await peerApiJson(h, 'discovery/read')).toEqual({ applicationId: 'e17410f37bea544015af1bb0ed29baef7a9cc99617ca3d4fb8bfca77189f32e7', peers: [] });
  const ad = advertisement();
  const lease = await peerApiJson(h, 'discovery/advertise', { advertisement: ad });
  await advance(h.id, 1000);
  expect(await peerApiJson(h, 'discovery/advertise', { advertisement: ad })).toEqual(lease);
  expect(await peerApiJson(h, 'discovery/read')).toEqual({ applicationId: 'e17410f37bea544015af1bb0ed29baef7a9cc99617ca3d4fb8bfca77189f32e7', peers: [lease] });
  expect(await inDO(h.id, t => ({ log: t.db.one("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name='record_log_entries'"),
    application: t.db.one("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name='application_changes'"), sockets: t.ctx.getWebSockets().length,
    keys: Object.keys(t.db.get<any[]>('peer_directory', [])[0]) })))
    .toEqual({ log: { n: 0 }, application: { n: 0 }, sockets: 0, keys: ['advertisement', 'owner', 'principal', 'expiresAt', 'refreshAfter'] });
  await advance(h.id, 120000);
  expect((await peerApiJson(h, 'discovery/read')).peers).toEqual([]);
  expect((await peerApiJson(h, 'discovery/advertise', { advertisement: ad })).expiresAt).toBeGreaterThan(lease.expiresAt);
  expect(await peerApiJson(h, 'discovery/withdraw', { peerId: ad.peerId })).toEqual({ withdrawn: ad.peerId });
  expect((await peerApiJson(h, 'discovery/read')).peers).toEqual([]);
});

it('authenticates availability and scopes active advertisement updates to their participant', async () => {
  const page = await createTestPage({ application: { id: 'bd3be84677635bddf1a39e3f6d2fe8862c21efaeee688c35a7b6cc6d0ae59415' } });
  const participant = await page.participant(), ad = advertisement();
  expect((await participant.exchange('discovery/advertise', { advertisement: ad })).status).toBe(200);
  expect((await page.ownerExchange('discovery/advertise', { advertisement: ad })).status).toBe(409);
  expect((await page.exchange('discovery/withdraw', { peerId: ad.peerId })).status).toBe(409);
  expect((await participant.exchange('discovery/withdraw', { peerId: ad.peerId })).status).toBe(200);
  expect((await page.exchange('discovery/advertise', { advertisement: ad })).status).toBe(200);
});

it('withdraws revoked credentials from discovery and survives Durable Object restart', async () => {
  const page = await createTestPage({ application: { id: 'be538046a573830719749c78aca639af0cc53dd2fe41383f6d5a4668e1c7994c' } });
  const ad = advertisement();
  const lease = await (await page.exchange('discovery/advertise', { advertisement: ad })).json();
  await page.restart();
  expect(await (await page.ownerExchange('discovery/read')).json()).toEqual({ applicationId: 'be538046a573830719749c78aca639af0cc53dd2fe41383f6d5a4668e1c7994c', peers: [lease] });
  const h = await create({ mode: 'dashboard', listener: false, application: { id: '70b342eb4017a99a5e12f7b4cb5248ce45775765f520f1f3fef112e96f9b5f33' } });
  await peerApiJson(h, 'discovery/advertise', { advertisement: ad });
  await inDO(h.id, t => t.db.run('DELETE FROM tokens'));
  expect(await (await peerOwnerApi(h, 'discovery/read')).json()).toEqual({ applicationId: '70b342eb4017a99a5e12f7b4cb5248ce45775765f520f1f3fef112e96f9b5f33', peers: [] });
});

it('bounds directory size and rejects unsigned data-plane fields, anonymous readers, and unconfigured applications', async () => {
  const h = await create({ mode: 'dashboard', listener: false, application: { id: '30a54be9f9164e2efb2d815abce5d81744fed1f6497e7fdff295614508c89a33' } });
  expect((await req(`${h.api}/peers/participant`, { anonymous: true })).status).toBe(401);
  for (let i = 0; i < 8; i++) expect((await peerApi(h, 'discovery/advertise', { advertisement: advertisement(`peer-${i}`) })).status).toBe(200);
  expect((await peerApi(h, 'discovery/advertise', { advertisement: advertisement('overflow') })).status).toBe(429);
  expect((await peerApi(h, 'discovery/advertise', { advertisement: { ...advertisement(), commands: [] } })).status).toBe(400);
  expect((await peerApi(h, 'discovery/advertise', { advertisement: advertisement(), ttlMs: 10 })).status).toBe(400);
  const hosted = await create({ mode: 'dashboard', listener: false });
  expect((await peerApi(hosted, 'discovery/read')).status).toBe(200);
});
