import { expect, it } from 'vitest';
import { advance, api, apiJson, create, inDO, req } from './helpers';
import { createTestPage } from './public-fixture';
const advertisement = (peerId = 'peer-a') => ({ peerId, storageId: `store:${peerId}`, profiles: ['peer-generation-v1'],
  routes: [{ kind: 'rendezvous', channel: `join:${peerId}` }], coordinatorEligible: true,
  recovery: { generation: 'g1', sequence: 8, root: 'ab'.repeat(32), controlRevision: 0, retainedAt: 100 } });

it('discovers independent peers, coalesces duplicate availability, and expires without host wakeups', async () => {
  const h = await create({ mode: 'dashboard', listener: false, application: { kind: 'peer', id: 'directory-app' } });
  expect(await apiJson(h, 'GET', 'peers/directory')).toEqual({ applicationId: 'directory-app', peers: [] });
  const ad = advertisement();
  const lease = await apiJson(h, 'PUT', 'peers/directory', { advertisement: ad });
  await advance(h.id, 1000);
  expect(await apiJson(h, 'PUT', 'peers/directory', { advertisement: ad })).toEqual(lease);
  expect(await apiJson(h, 'GET', 'peers/directory')).toEqual({ applicationId: 'directory-app', peers: [lease] });
  expect(await inDO(h.id, t => ({ log: t.db.one('SELECT COUNT(*) AS n FROM record_log_entries'),
    application: t.db.one('SELECT COUNT(*) AS n FROM application_changes'), sockets: t.ctx.getWebSockets().length,
    keys: Object.keys(t.db.get<any[]>('peer_directory', [])[0]) })))
    .toEqual({ log: { n: 0 }, application: { n: 0 }, sockets: 0, keys: ['advertisement', 'owner', 'principal', 'expiresAt', 'refreshAfter'] });
  await advance(h.id, 120000);
  expect((await apiJson(h, 'GET', 'peers/directory')).peers).toEqual([]);
  expect((await apiJson(h, 'PUT', 'peers/directory', { advertisement: ad })).expiresAt).toBeGreaterThan(lease.expiresAt);
  expect(await apiJson(h, 'DELETE', 'peers/directory', { peerId: ad.peerId })).toEqual({ withdrawn: ad.peerId });
  expect((await apiJson(h, 'GET', 'peers/directory')).peers).toEqual([]);
});

it('authenticates availability and scopes active advertisement updates to their participant', async () => {
  const page = await createTestPage({ application: { kind: 'peer', id: 'private-directory' } });
  const participant = await page.participant(), ad = advertisement();
  expect((await participant.api('PUT', 'peers/directory', { advertisement: ad })).status).toBe(200);
  expect((await page.ownerApi('PUT', 'peers/directory', { advertisement: ad })).status).toBe(409);
  expect((await page.api('DELETE', 'peers/directory', { peerId: ad.peerId })).status).toBe(409);
  expect((await participant.api('DELETE', 'peers/directory', { peerId: ad.peerId })).status).toBe(200);
  expect((await page.api('PUT', 'peers/directory', { advertisement: ad })).status).toBe(200);
});

it('withdraws revoked credentials from discovery and survives Durable Object restart', async () => {
  const page = await createTestPage({ application: { kind: 'peer', id: 'restart-directory' } });
  const ad = advertisement();
  const lease = await (await page.api('PUT', 'peers/directory', { advertisement: ad })).json();
  await page.restart();
  expect(await (await page.ownerApi('GET', 'peers/directory')).json()).toEqual({ applicationId: 'restart-directory', peers: [lease] });
  const h = await create({ mode: 'dashboard', listener: false, application: { kind: 'peer', id: 'revoked-directory' } });
  await apiJson(h, 'PUT', 'peers/directory', { advertisement: ad });
  await inDO(h.id, t => t.db.run('DELETE FROM tokens'));
  expect(await (await req(`${h.page_url}_tendril/peers/directory`)).json()).toEqual({ applicationId: 'revoked-directory', peers: [] });
});

it('bounds directory size and rejects unsigned data-plane fields, anonymous readers, and hosted applications', async () => {
  const h = await create({ mode: 'dashboard', listener: false, application: { kind: 'peer', id: 'bounded-directory' } });
  expect((await req(`${h.api}/peers/directory`, { anonymous: true })).status).toBe(401);
  for (let i = 0; i < 8; i++) expect((await api(h, 'PUT', 'peers/directory', { advertisement: advertisement(`peer-${i}`) })).status).toBe(200);
  expect((await api(h, 'PUT', 'peers/directory', { advertisement: advertisement('overflow') })).status).toBe(429);
  expect((await api(h, 'PUT', 'peers/directory', { advertisement: { ...advertisement(), commands: [] } })).status).toBe(400);
  expect((await api(h, 'PUT', 'peers/directory', { advertisement: advertisement(), ttlMs: 10 })).status).toBe(400);
  const hosted = await create({ mode: 'dashboard', listener: false });
  expect((await api(hosted, 'GET', 'peers/directory')).status).toBe(409);
});
