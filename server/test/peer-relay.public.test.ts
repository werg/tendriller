import { expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { createPeerRelay, PEER_RELAY_LIMITS as LIMITS, PEER_RELAY_PROTOCOL } from '../../contract/peers.mjs';
import { advance, api, create, inDO, req, runAlarm, type Handle } from './helpers';
import { closeRelay } from '../src/peer-relay';
import { createTestPage } from './public-fixture';

const left = 'ab'.repeat(32), right = 'cd'.repeat(32), other = 'ef'.repeat(32);
const headers = { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': PEER_RELAY_PROTOCOL };
const path = (channel: string, peerId = left, remotePeerId = right, lane = 'reliable') =>
  `peers/relay?${new URLSearchParams({ channel, peerId, remotePeerId, lane })}`;
async function open(h: Handle, channel: string, peerId: string, remotePeerId: string, lane: 'reliable' | 'live') {
  const response = await api(h, 'GET', path(channel, peerId, remotePeerId, lane), undefined, headers);
  expect(response.status).toBe(101);
  const socket = response.webSocket!, messages: (string | ArrayBuffer)[] = [];
  socket.binaryType = 'arraybuffer';
  socket.addEventListener('message', event => { messages.push(event.data); });
  const closed = new Promise<number>(resolve => socket.addEventListener('close', event => resolve(event.code)));
  socket.accept(); return { socket, messages, closed };
}
async function pair(h: Handle, channel = 'test') {
  const a = { reliable: await open(h, channel, left, right, 'reliable'), live: await open(h, channel, left, right, 'live') };
  const b = { reliable: await open(h, channel, right, left, 'reliable'), live: await open(h, channel, right, left, 'live') };
  const all = [a.reliable, a.live, b.reliable, b.live];
  await expect.poll(() => all.every(value => value.messages.length === 1)).toBe(true);
  const session = JSON.parse(a.reliable.messages[0] as string).session;
  return { a, b, all, session, close() { for (const value of all) try { value.socket.close(); } catch {} } };
}
function packet(sequence: number, size = 8): ArrayBuffer {
  const bytes = new Uint8Array(4 + size); new DataView(bytes.buffer).setUint32(0, sequence); bytes.fill(0x37, 4); return bytes.buffer;
}

it('forwards opaque binary over isolated reliable and live lanes through real authenticated upgrades', async () => {
  const page = await createTestPage(), guest = await page.participant();
  const relay = (target: typeof page | typeof guest, peerId: string, remotePeerId: string) => createPeerRelay({
    reliable: target.relaySocket('public-relay', peerId, remotePeerId, 'reliable'), live: target.relaySocket('public-relay', peerId, remotePeerId, 'live'),
  }, { peerId, remotePeerId });
  const a = relay(page, left, right), b = relay(guest, right, left), history: ArrayBuffer[] = [], live: ArrayBuffer[] = [];
  b.reliable.addEventListener('message', event => { history.push(event.data); }); b.live.addEventListener('message', event => { live.push(event.data); });
  try {
    const [first, second] = await Promise.all([a.ready, b.ready]); expect(first).toEqual(second);
    const payload = new Uint8Array(16 * 1024).fill(0x31), disposable = new Uint8Array(16_448).fill(0x49);
    a.reliable.send(payload); a.live.send(disposable);
    await expect.poll(() => history.length).toBe(1); await expect.poll(() => live.length).toBe(1);
    expect(new Uint8Array(history[0])).toEqual(payload); expect(new Uint8Array(live[0])).toEqual(disposable);
    await expect.poll(() => a.reliable.bufferedAmount + a.live.bufferedAmount).toBe(0);
    expect(page.hostTraffic.relayUpgrades).toBe(4);
    expect(page.hostTraffic.relaySentBytes).toBeGreaterThan(payload.length + disposable.length);
    expect(page.hostTraffic.relayReceivedBytes).toBeGreaterThan(payload.length + disposable.length);
    expect(page.hostTraffic.rendezvousUpgrades).toBe(0);
    expect(page.hostTraffic.requestBodyBytes).toBe(0);
  } finally { a.close(); b.close(); }
});

it('requires authenticated protocol admission and exact reciprocal peer/lane pairing', async () => {
  const h = await create({ mode: 'dashboard', listener: false });
  expect((await req(`${h.api}/${path('auth')}`, { headers, anonymous: true })).status).toBe(401);
  expect((await api(h, 'GET', path('auth'), undefined, { ...headers, 'Sec-WebSocket-Protocol': 'tendriller.rendezvous.v1' })).status).toBe(400);
  const response = await req(`${h.api}/${path('auth')}`, { anonymous: true,
    headers: { ...headers, 'Sec-WebSocket-Protocol': `${PEER_RELAY_PROTOCOL}, ${h.token}` } });
  expect(response.status).toBe(101); response.webSocket!.accept();
  expect((await api(h, 'GET', path('auth'), undefined, headers)).status).toBe(409);
  expect((await api(h, 'GET', path('auth', other, left, 'live'), undefined, headers)).status).toBe(409);
  expect((await api(h, 'GET', path('auth', right, left, 'wrong'), undefined, headers)).status).toBe(400);
  response.webSocket!.close();
});

it('reserves bounded control credit and rejects reliable overflow without retaining payloads', async () => {
  const h = await create({ mode: 'dashboard', listener: false }), p = await pair(h, 'bound');
  try {
    await inDO(h.id, async t => {
      const sender = t.ctx.getWebSockets('peer-relay').find(ws => { const a = ws.deserializeAttachment(); return a.peerId === left && a.lane === 'reliable'; })!;
      for (let i = 1; i <= LIMITS.pendingPackets; i++) await t.webSocketMessage(sender, packet(i));
      expect(sender.deserializeAttachment().pending.byteLength).toBe(24 * LIMITS.pendingPackets);
      expect(t.db.one("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name IN ('record_log_entries','application_changes','devices')")).toEqual({ n: 0 });
      await t.webSocketMessage(sender, packet(LIMITS.pendingPackets + 1));
    });
    expect(await p.a.reliable.closed).toBe(1008);
    expect(await p.b.live.closed).toBe(1008);
    await expect.poll(() => p.b.reliable.messages.filter(value => value instanceof ArrayBuffer).length).toBe(LIMITS.pendingPackets);
  } finally { p.close(); }
});

it('requires an unpredictable recipient receipt before releasing send credit', async () => {
  const h = await create({ mode: 'dashboard', listener: false }), p = await pair(h, 'receipt');
  try {
    p.a.reliable.socket.send(packet(1));
    await expect.poll(() => p.b.reliable.messages.length).toBe(2);
    const delivered = p.b.reliable.messages[1] as ArrayBuffer;
    expect(delivered.byteLength).toBe(28);
    expect(new Uint8Array(delivered).slice(20)).toEqual(new Uint8Array(8).fill(0x37));
    p.b.reliable.socket.send(JSON.stringify({ t: 'received', session: p.session, sequence: 1, receipt: '00'.repeat(16) }));
    expect(await p.a.reliable.closed).toBe(1008); expect(await p.b.live.closed).toBe(1008);
    expect(p.a.reliable.messages.length).toBe(1);
  } finally { p.close(); }
});

it('drops excess disposable packets without stalling the reliable lane', async () => {
  const h = await create({ mode: 'dashboard', listener: false }), p = await pair(h, 'live');
  try {
    p.a.live.socket.send(packet(1)); p.a.live.socket.send(packet(2)); p.a.reliable.socket.send(packet(1));
    await expect.poll(() => p.a.live.messages.length).toBe(2);
    expect(JSON.parse(p.a.live.messages[1] as string)).toEqual({ t: 'credit', session: p.session, sequence: 2 });
    await expect.poll(() => p.b.reliable.messages.length).toBe(2);
    expect(p.b.live.messages.filter(value => value instanceof ArrayBuffer).length).toBe(1);
  } finally { p.close(); }
});

it('bounds pending sessions per principal and expires unpaired and stalled relay sockets', async () => {
  const h = await create({ mode: 'dashboard', listener: false }), pending = [];
  for (let index = 0; index < LIMITS.sessionsPerPrincipal; index++) pending.push(await open(h, `quota:${index}`, left, right, 'reliable'));
  expect((await api(h, 'GET', path('quota:overflow'), undefined, headers)).status).toBe(429);
  await advance(h.id, LIMITS.pairingMs + 1); await runAlarm(h.id);
  for (const value of pending) expect(await value.closed).toBe(1008);
  const p = await pair(h, 'progress');
  try {
    p.a.reliable.socket.send(packet(1)); await expect.poll(() => p.b.reliable.messages.length).toBe(2);
    await advance(h.id, LIMITS.progressMs + 1); await runAlarm(h.id);
    expect(await p.b.live.closed).toBe(1008);
  } finally { p.close(); }
});

it('fences local revocation on every packet and rechecks account policy in the alarm', async () => {
  const h = await create({ mode: 'dashboard', listener: false }), p = await pair(h, 'revoked');
  await inDO(h.id, t => t.db.run('DELETE FROM tokens'));
  p.a.reliable.socket.send(packet(1)); expect(await p.a.live.closed).toBe(1008);
  expect(p.b.reliable.messages.length).toBe(1); p.close();
  const second = await create({ mode: 'dashboard', listener: false }), q = await pair(second, 'account');
  const account = await inDO(second.id, t => t.db.get('owner_account', ''));
  await env.ACCOUNTS.prepare('UPDATE accounts SET suspended_at=? WHERE id=?').bind(Date.now(), account).run();
  await advance(second.id, LIMITS.authorizationMs + 1);
  await runAlarm(second.id);
  expect(await q.a.reliable.closed).toBe(4003); expect(await q.b.live.closed).toBe(4003); q.close();
  const third = await create({ mode: 'dashboard', listener: false }), r = await pair(third, 'policy-outage');
  await advance(third.id, LIMITS.authorizationMs + 1);
  await inDO(third.id, async t => {
    const original = t.env.ACCOUNTS;
    t.env.ACCOUNTS = { prepare() { throw new Error('Injected account policy outage'); } } as unknown as D1Database;
    try { await t.alarm(); } finally { t.env.ACCOUNTS = original; }
  });
  expect(await r.a.reliable.closed).toBe(4003); expect(await r.b.live.closed).toBe(4003); r.close();
});

it('refreshes admitted idle connections and enforces the absolute relay lifetime', async () => {
  const h = await create({ mode: 'dashboard', listener: false }), p = await pair(h, 'lifetime');
  try {
    await advance(h.id, LIMITS.authorizationMs + 1); await runAlarm(h.id);
    p.a.reliable.socket.send(packet(1)); await expect.poll(() => p.b.reliable.messages.length).toBe(2);
    await advance(h.id, LIMITS.lifetimeMs); await runAlarm(h.id);
    expect(await p.a.reliable.closed).toBe(1008); expect(await p.b.live.closed).toBe(1008);
  } finally { p.close(); }
});

it('rejects oversized and out-of-order packets before forwarding their payloads', async () => {
  for (const invalid of [packet(1, LIMITS.packetBytes + 1), packet(2)]) {
    const h = await create({ mode: 'dashboard', listener: false }), p = await pair(h, 'invalid');
    try {
      p.a.reliable.socket.send(invalid);
      expect(await p.b.reliable.closed).toBe(1008); expect(p.b.reliable.messages.length).toBe(1);
    } finally { p.close(); }
  }
});

it('closes all lanes on disconnect and isolates stale close events from a reused channel', async () => {
  const h = await create({ mode: 'dashboard', listener: false }), p = await pair(h, 'reused');
  let retired!: WebSocket;
  await inDO(h.id, t => { retired = t.ctx.getWebSockets('peer-relay')[0]; });
  p.a.reliable.socket.close(); await Promise.all(p.all.map(value => value.closed));
  const next = await pair(h, 'reused');
  try {
    expect(next.session).not.toBe(p.session);
    await inDO(h.id, t => closeRelay(t, retired));
    next.a.reliable.socket.send(packet(1)); await expect.poll(() => next.b.reliable.messages.length).toBe(2);
  } finally { next.close(); }
});
