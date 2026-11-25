import { peerApi, peerApiJson, peerOwnerApi } from './peer-exchange';
import { expect, it } from 'vitest';
import { evictDurableObject } from 'cloudflare:test';
import { advance, api, create, inDO, req, stub, type Handle } from './helpers';
import { createTestPage } from './public-fixture';
const headers = { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': 'tendriller.discovery.v1' };
const advertisement = (peerId = 'peer-a') => ({ peerId, storageId: `store:${peerId}`, routes: [{ kind: 'rendezvous', channel: `join:${peerId}` }] });
const next = (ws: WebSocket) => new Promise<any>(resolve => ws.addEventListener('message', e => resolve(JSON.parse(e.data as string)), { once: true }));
async function subscribe(h: Handle, peerId: string) {
  const response = await api(h, 'GET', 'peers/discovery/watch?peerId=' + peerId, undefined, headers);
  expect(response.status).toBe(101); const socket = response.webSocket!, ready = next(socket); socket.accept(); expect(await ready).toEqual({ type: 'ready' }); return socket;
}
async function fixtureSocket(socket: ReturnType<Awaited<ReturnType<typeof createTestPage>>['discoverySocket']>) {
  await new Promise<void>((resolve, reject) => { socket.addEventListener('message', () => resolve(), { once: true }); socket.addEventListener('error', reject, { once: true }); }); return socket;
}

it('retains bounded socket presence beyond former leases without timers or duplicate SQL writes', async () => {
  const h = await create({ listener: false });
  expect((await peerApi(h, 'discovery/advertise', { advertisement: advertisement() })).status).toBe(409);
  const socket = await subscribe(h, 'peer-a'), observer = await subscribe(h, 'observer');
  try {
    const beforeAlarm = await inDO(h.id, t => t.ctx.storage.getAlarm());
    const changed = next(observer), value = await peerApiJson(h, 'discovery/advertise', { advertisement: advertisement() });
    expect(value).toEqual({ advertisement: advertisement() }); expect(await changed).toEqual({ type: 'changed' });
    const before = await inDO(h.id, t => t.db.one('SELECT total_changes() AS n'));
    expect(await peerApiJson(h, 'discovery/advertise', { advertisement: advertisement() })).toEqual(value);
    expect(await inDO(h.id, t => t.db.one('SELECT total_changes() AS n'))).toEqual(before);
    await advance(h.id, 3600000);
    expect((await peerApiJson(h, 'discovery/read')).peers).toEqual([value]);
    expect(await inDO(h.id, t => t.ctx.storage.getAlarm())).toEqual(beforeAlarm);
    const removed = next(observer); await peerApiJson(h, 'discovery/withdraw', { peerId: 'peer-a' }); expect(await removed).toEqual({ type: 'changed' });
    expect((await peerApiJson(h, 'discovery/read')).peers).toEqual([]);
  } finally { socket.close(); observer.close(); }
});

it('authenticates native TLS protocols and bounds watch capacity by account across credentials', async () => {
  const h = await create({ listener: false });
  expect((await req(h.api + '/peers/discovery/watch?peerId=a', { headers, anonymous: true })).status).toBe(401);
  const first = await req(h.api + '/peers/discovery/watch?peerId=a', { anonymous: true, headers: { ...headers, 'Sec-WebSocket-Protocol': headers['Sec-WebSocket-Protocol'] + ', ' + h.token } });
  expect(first.status).toBe(101); first.webSocket!.accept(); const sockets = [first.webSocket!];
  try {
    for (let i = 1; i < 8; i++) sockets.push(await subscribe(h, 'peer-' + i));
    expect((await api(h, 'GET', 'peers/discovery/watch?peerId=overflow', undefined, headers)).status).toBe(429);
    const closed = new Promise<number>(resolve => first.webSocket!.addEventListener('close', e => resolve(e.code)));
    first.webSocket!.send('{}'); expect(await closed).toBe(1008);
  } finally { for (const socket of sockets) socket.close(); }
});

it('fences a replaced socket and withdraws on close without deleting the replacement advertisement', async () => {
  const h = await create({ listener: false });
  const old = await subscribe(h, 'peer-a'); await peerApiJson(h, 'discovery/advertise', { advertisement: advertisement() });
  const socket = await subscribe(h, 'peer-a');
  try {
    expect((await peerApiJson(h, 'discovery/read')).peers).toEqual([]);
    await peerApiJson(h, 'discovery/advertise', { advertisement: advertisement() });
    old.close(); expect((await peerApiJson(h, 'discovery/read')).peers).toEqual([{ advertisement: advertisement() }]);
    socket.close();
    // The closing socket is excluded immediately; its delayed close callback only cleans its own row.
    expect((await peerApiJson(h, 'discovery/read')).peers).toEqual([]);
  } finally { old.close(); socket.close(); }
});

it('requires the same participant incarnation and excludes revoked routes on the next read', async () => {
  const page = await createTestPage(), guest = await page.participant();
  const socket = await fixtureSocket(guest.discoverySocket('peer-a'));
  try {
    expect((await guest.api('POST', 'peers/discovery', { action: 'advertise', advertisement: advertisement() })).status).toBe(200);
    expect((await page.ownerApi('POST', 'peers/discovery', { action: 'advertise', advertisement: advertisement() })).status).toBe(409);
    expect((await page.api('POST', 'peers/discovery', { action: 'withdraw', peerId: 'peer-a' })).status).toBe(409);
    expect((await guest.api('POST', 'peers/discovery', { action: 'withdraw', peerId: 'peer-a' })).status).toBe(200);
  } finally { socket.close(); }
  const h = await create({ listener: false });
  const native = await subscribe(h, 'peer-a');
  try {
    expect((await peerApi(h, 'discovery/advertise', { advertisement: advertisement() })).status).toBe(200);
    await inDO(h.id, t => t.db.run('DELETE FROM agent_grants'));
    const directory = await (await peerOwnerApi(h, 'discovery/read')).json() as { peers: unknown[] };
    expect(directory.peers).toEqual([]);
  } finally { native.close(); }
});

it('rejects leases and extra application metadata instead of retaining a polling path', async () => {
  const h = await create({ listener: false }); const socket = await subscribe(h, 'peer-a');
  try {
    expect((await peerApi(h, 'discovery/advertise', { advertisement: advertisement(), ttlMs: 120000 })).status).toBe(400);
    for (const fields of [{ commands: [] }, { applicationData: [] }, { writerEligible: true }])
      expect((await peerApi(h, 'discovery/advertise', { advertisement: { ...advertisement(), ...fields } })).status).toBe(400);
  } finally { socket.close(); }
});


it('restores socket-owned routing hints and notifications after actual object hibernation', async () => {
  const h = await create({ listener: false }), socket = await subscribe(h, 'peer-a'), observer = await subscribe(h, 'observer');
  try {
    const notified = next(observer); await peerApiJson(h, 'discovery/advertise', { advertisement: advertisement() }); await notified;
    await evictDurableObject(stub(h.id));
    expect((await peerApiJson(h, 'discovery/read')).peers).toEqual([{ advertisement: advertisement() }]);
    const withdrawn = next(observer); await peerApiJson(h, 'discovery/withdraw', { peerId: 'peer-a' }); expect(await withdrawn).toEqual({ type: 'changed' });
  } finally { socket.close(); observer.close(); }
});
