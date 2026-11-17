import { expect, it } from 'vitest';
import { advance, api, apiJson, create, inDO, req, runAlarm, type Handle } from './helpers';
import { createPeerRendezvous, PEER_RENDEZVOUS_LIMITS as LIMITS, PEER_RENDEZVOUS_PROTOCOL } from '../../contract/peers.mjs';
import { closePeer } from '../src/peers';
import { createTestPage } from './public-fixture';

const headers = { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': PEER_RENDEZVOUS_PROTOCOL };
const offer = { type: 'offer' as const, sdp: 'v=0\r\no=offer\r\n' };
const answer = { type: 'answer' as const, sdp: 'v=0\r\no=answer\r\n' };

it('exposes real authenticated rendezvous and observed host traffic to independent public consumers', async () => {
  const page = await createTestPage({ application: { id: '26717ae4369d005dc210693d1d9256de56b5689078ed07922317ea56020a6486' } });
  const guest = await page.participant();
  expect(page.hostTraffic).toEqual({ httpRequests: 0, requestBodyBytes: 0, rendezvousUpgrades: 0, rendezvousSentBytes: 0, rendezvousReceivedBytes: 0,
    invitationUpgrades: 0, invitationSentBytes: 0, invitationReceivedBytes: 0, relayUpgrades: 0, relaySentBytes: 0, relayReceivedBytes: 0 });
  const bootstrap = { version: 2, endpoints: [] };
  expect((await page.ownerApi('PUT', 'peers/bootstrap', bootstrap)).status).toBe(200);
  const a = createPeerRendezvous(page.rendezvousSocket('public-pair', 'agent'));
  const b = createPeerRendezvous(guest.rendezvousSocket('public-pair', 'guest'));
  try {
    const [ready] = await Promise.all([a.ready, b.ready]);
    const offerer = ready.role === 'offerer' ? a : b, answerer = offerer === a ? b : a;
    const first = offerer.messages[Symbol.asyncIterator](), second = answerer.messages[Symbol.asyncIterator]();
    await offerer.send(offer); expect((await second.next()).value).toEqual(offer);
    await answerer.send(answer); expect((await first.next()).value).toEqual(answer);
    expect((await first.next()).done).toBe(true); expect((await second.next()).done).toBe(true);
    const traffic = page.hostTraffic;
    expect(traffic.httpRequests).toBe(3);
    expect(traffic.requestBodyBytes).toBe(new TextEncoder().encode(JSON.stringify(bootstrap)).byteLength);
    expect(traffic.rendezvousUpgrades).toBe(2);
    expect(traffic.rendezvousSentBytes).toBe(a.stats.sentBytes + b.stats.sentBytes);
    expect(traffic.rendezvousReceivedBytes).toBe(a.stats.receivedBytes + b.stats.receivedBytes);
    expect(traffic.rendezvousReceivedBytes).toBeGreaterThan(traffic.rendezvousSentBytes);
  } finally { a.close(); b.close(); }
});
async function open(h: Handle, channel: string, peerId: string, page = false) {
  const path = `peers/rendezvous?${new URLSearchParams({ channel, peerId })}`;
  const response = page ? await req(`${h.page_url}_tendril/${path}`, { headers }) : await api(h, 'GET', path, undefined, headers);
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  const connection = createPeerRendezvous(socket);
  const closed = new Promise<{ code: number; reason: string }>(resolve => socket.addEventListener('close', event => resolve({ code: event.code, reason: event.reason })));
  socket.accept();
  return { socket, connection, closed };
}

it('introduces authorized peers, exchanges exactly two descriptions, and retires the host sockets', async () => {
  const h = await create({ mode: 'dashboard', listener: false, application: { id: 'e914219948c672f1d1e1260b4752e95e67396b08c94126c0213ff195eb932532' } });
  const hints = { version: 2, endpoints: [{ url: 'https://resident.example/introduce' }] };
  expect(await apiJson(h, 'PUT', 'peers/bootstrap', hints)).toEqual(hints);
  expect(await apiJson(h, 'GET', 'peers/bootstrap')).toEqual(hints);
  expect((await req(`${h.api}/peers/bootstrap`, { anonymous: true })).status).toBe(401);
  expect((await api(h, 'PUT', 'peers/bootstrap', { version: 2, endpoints: [{ url: 'http://insecure.example/' }] })).status).toBe(400);
  const html = await (await req(h.page_url)).text();
  expect(JSON.parse(/window\.__TENDRIL__=(.*?);<\/script>/.exec(html)![1]).peerBootstrap).toEqual(hints);
  const agent = await open(h, 'one', 'agent'), page = await open(h, 'one', 'browser', true);
  const [a, b] = await Promise.all([agent.connection.ready, page.connection.ready]);
  expect(a.role).toBe('offerer'); expect(b).toEqual({ session: a.session, role: 'answerer' });
  const pageReader = page.connection.messages[Symbol.asyncIterator](), agentReader = agent.connection.messages[Symbol.asyncIterator]();
  await agent.connection.send(offer); expect((await pageReader.next()).value).toEqual(offer);
  await page.connection.send(answer); expect((await agentReader.next()).value).toEqual(answer);
  expect((await pageReader.next()).done).toBe(true); expect((await agentReader.next()).done).toBe(true);
  expect((await agent.closed).code).toBe(1000); expect((await page.closed).code).toBe(1000);
  expect(agent.connection.stats.sentDescriptions + page.connection.stats.sentDescriptions).toBe(2);
  expect(await inDO(h.id, t => ({ log: t.db.one("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name='record_log_entries'"),
    application: t.db.one("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name='application_changes'"), oldEvents: t.db.one("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name='events'"),
    devices: t.db.one("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name='devices'") })))
    .toEqual({ log: { n: 0 }, application: { n: 0 }, oldEvents: { n: 0 }, devices: { n: 0 } });
});

it('requires the dedicated relay route and protocol for binary peer transport', async () => {
  const h = await create({ mode: 'dashboard', listener: false });
  expect((await api(h, 'GET', 'peers/socket?channel=x&peerId=y', undefined,
    { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': 'tendriller.peer.v1' })).status).toBe(404);
  expect((await api(h, 'GET', 'peers/rendezvous?channel=x&peerId=y', undefined,
    { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': 'tendriller.peer.v1' })).status).toBe(400);
});

it('serves current resident introductions in peer HTML without exposing them to display links', async () => {
  const h = await create({ mode: 'dashboard', listener: false, application: { id: 'b38af2e285ec262a9cfb515291202bac44f6e637403aab77104c5dfac219c722' } });

  const hints = { version: 2, endpoints: [{ url: 'https://resident.example/introduce' }] };
  await apiJson(h, 'PUT', 'peers/bootstrap', hints);
  const response = await req(h.page_url);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  const config = (html: string) => JSON.parse(/window\.__TENDRIL__=(.*?);<\/script>/.exec(html)![1]);
  expect(config(await response.text()).peerBootstrap).toEqual(hints);
  const next = { version: 2, endpoints: [{ url: 'https://replacement.example/introduce' }] };
  await apiJson(h, 'PUT', 'peers/bootstrap', next);
  expect(config(await (await req(h.page_url)).text()).peerBootstrap).toEqual(next);
  const display = await inDO(h.id, async t => t.renderLink(await t.createLink('display', null, null)));
  expect(config(await (await req(display.url, { anonymous: true })).text()).peerBootstrap).toBeUndefined();
  expect((await req(display.url + '_tendril/peers/bootstrap', { anonymous: true })).status).toBe(403);
  expect(await inDO(h.id, t => ({ sockets: t.ctx.getWebSockets().length, devices: t.db.one("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name='devices'") })))
    .toEqual({ sockets: 0, devices: { n: 0 } });
});

it('does not register hosted application devices or sockets for a peer page', async () => {
  const h = await create({ mode: 'dashboard', listener: false, application: { id: '640f9dd29023c050bdf38a63589f9f26c63a61f91d58afb59f12f96d12756e84' } });
  const response = await req(`${h.page_url}_tendril/ws`, { headers: { Upgrade: 'websocket' } });
  expect(response.status).toBe(404);
  expect(await inDO(h.id, t => ({ devices: t.db.one("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name='devices'"), sockets: t.ctx.getWebSockets().length })))
    .toEqual({ devices: { n: 0 }, sockets: 0 });
});

it('isolates pairs and closes an incomplete rendezvous when either participant leaves', async () => {
  const h = await create({ mode: 'dashboard', listener: false });
  const first = await open(h, 'channel', 'first');
  expect((await api(h, 'GET', 'peers/rendezvous?channel=channel&peerId=first', undefined, headers)).status).toBe(409);
  const second = await open(h, 'channel', 'second');
  await Promise.all([first.connection.ready, second.connection.ready]);
  expect((await api(h, 'GET', 'peers/rendezvous?channel=channel&peerId=third', undefined, headers)).status).toBe(409);
  first.connection.close(); expect((await second.closed).code).toBe(1013);
});

it('rejects binary frames, oversized SDP and foreign sessions without retaining payloads', async () => {
  const bad = [new Uint8Array([0x54, 1, 0, 1]), 'null', 'x'.repeat(LIMITS.messageBytes + 1),
    JSON.stringify({ t: 'description', session: 'retired', description: offer })];
  for (const invalid of bad) {
    const h = await create({ mode: 'dashboard', listener: false });
    const first = await open(h, 'bounded', 'first'), second = await open(h, 'bounded', 'second');
    await Promise.all([first.connection.ready, second.connection.ready]);
    first.socket.send(invalid);
    expect((await first.closed).code).toBe(invalid instanceof Uint8Array || invalid.length > LIMITS.messageBytes ? 1009 : 1008);
    expect(second.connection.stats.receivedDescriptions).toBe(0);
    second.connection.close();
    expect(await inDO(h.id, t => t.db.one("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name='record_log_entries'"))).toEqual({ n: 0 });
  }
});

it('refuses role confusion, premature answers and repeated descriptions', async () => {
  for (const attempt of ['role', 'premature', 'repeat']) {
    const h = await create({ mode: 'dashboard', listener: false });
    const first = await open(h, 'roles', 'first'), second = await open(h, 'roles', 'second');
    const [a] = await Promise.all([first.connection.ready, second.connection.ready]);
    if (attempt === 'repeat') {
      await first.connection.send(offer);
      expect((await second.connection.messages[Symbol.asyncIterator]().next()).value).toEqual(offer);
    }
    const sender = attempt === 'premature' ? second : first;
    sender.socket.send(JSON.stringify({ t: 'description', session: a.session, description: attempt === 'repeat' ? offer : answer }));
    expect((await sender.closed).code).toBe(1008);
    first.connection.close(); second.connection.close();
  }
});

it('rechecks the recipient host credential before forwarding an introduction', async () => {
  const h = await create({ mode: 'dashboard', listener: false, application: { id: '5e877599b096097b35ad02ff3f399ef0fa00c01d7205c07126d441eb1bd0626f' } });
  const page = await open(h, 'access', 'page', true), agent = await open(h, 'access', 'agent');
  await Promise.all([agent.connection.ready, page.connection.ready]);
  await inDO(h.id, t => { t.db.run('DELETE FROM tokens'); });
  await page.connection.send(offer);
  expect((await agent.closed).code).toBe(4003);
  expect(agent.connection.stats.receivedDescriptions).toBe(0);
  page.connection.close();
});

it('expires stalled sessions through the Durable Object alarm without client heartbeats', async () => {
  const h = await create({ mode: 'dashboard', listener: false });
  const first = await open(h, 'expires', 'first');
  await advance(h.id, LIMITS.lifetimeMs + 1); await runAlarm(h.id);
  expect((await first.closed).code).toBe(1008);
  await expect(first.connection.ready).rejects.toMatchObject({ code: 'rendezvous_closed' });
  const replacement = await open(h, 'expires', 'first'); replacement.connection.close();
});

it('ignores delayed messages and close events from a retired pair after channel reuse', async () => {
  const h = await create({ mode: 'dashboard', listener: false });
  const oldFirst = await open(h, 'reused', 'first'), oldSecond = await open(h, 'reused', 'second');
  const [old] = await Promise.all([oldFirst.connection.ready, oldSecond.connection.ready]);
  let retired!: WebSocket;
  await inDO(h.id, t => { retired = t.ctx.getWebSockets('rendezvous').find(ws => ws.deserializeAttachment().peerId === 'first')!; });
  oldFirst.connection.close(); await Promise.all([oldFirst.closed, oldSecond.closed]);
  const first = await open(h, 'reused', 'first'), second = await open(h, 'reused', 'second');
  const [current] = await Promise.all([first.connection.ready, second.connection.ready]);
  expect(current.session).not.toBe(old.session);
  await inDO(h.id, async t => {
    await t.webSocketMessage(retired, JSON.stringify({ t: 'description', session: old.session, description: offer }));
    closePeer(t, retired);
  });
  await first.connection.send(offer);
  expect((await second.connection.messages[Symbol.asyncIterator]().next()).value).toEqual(offer);
  expect(first.connection.stats.receivedDescriptions).toBe(0);
  first.connection.close(); second.connection.close();
});

it('bounds authorization work and forwards no pending description after a repeated send', async () => {
  const h = await create({ mode: 'dashboard', listener: false });
  const first = await open(h, 'pending', 'first'), second = await open(h, 'pending', 'second');
  const [a] = await Promise.all([first.connection.ready, second.connection.ready]);
  await inDO(h.id, async t => {
    const sender = t.ctx.getWebSockets('rendezvous').find(ws => ws.deserializeAttachment().peerId === 'first')!;
    const frame = JSON.stringify({ t: 'description', session: a.session, description: offer });
    await Promise.all([t.webSocketMessage(sender, frame), t.webSocketMessage(sender, frame)]);
  });
  expect((await first.closed).code).toBe(1008);
  expect(second.connection.stats.receivedDescriptions).toBe(0);
  second.connection.close();
});

it('retires both endpoints when asynchronous host authorization fails', async () => {
  const h = await create({ mode: 'dashboard', listener: false });
  const first = await open(h, 'failed-auth', 'first'), second = await open(h, 'failed-auth', 'second');
  const [a] = await Promise.all([first.connection.ready, second.connection.ready]);
  await inDO(h.id, async t => {
    const original = t.env.ACCOUNTS;
    const sender = t.ctx.getWebSockets('rendezvous').find(ws => ws.deserializeAttachment().peerId === 'first')!;
    t.env.ACCOUNTS = { prepare() { throw new Error('Injected account storage failure'); } } as unknown as D1Database;
    try { await t.webSocketMessage(sender, JSON.stringify({ t: 'description', session: a.session, description: offer })); }
    finally { t.env.ACCOUNTS = original; }
  });
  expect((await first.closed).code).toBe(1011);
  expect((await second.closed).code).toBe(1013);
  expect(second.connection.stats.receivedDescriptions).toBe(0);
});
