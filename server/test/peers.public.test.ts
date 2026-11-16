import { expect, it } from 'vitest';
import { api, apiJson, create, inDO, req, type Handle } from './helpers';
import { createPeerConnection, encodePeerFrame, PEER_LIMITS } from '../../contract/peers.mjs';
import { closePeer } from '../src/peers';

async function open(h: Handle, channel: string, peerId: string, page = false) {
  const path = `peers/socket?${new URLSearchParams({ channel, peerId })}`;
  const headers = { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': 'tendriller.peer.v1' };
  const response = page ? await req(`${h.page_url}_tendril/${path}`, { headers }) : await api(h, 'GET', path, undefined, headers);
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  const connection = createPeerConnection(socket, { route: 'relay', relayHandshake: true });
  const closed = new Promise<{ code: number; reason: string }>(resolve => socket.addEventListener('close', event => resolve({ code: event.code, reason: event.reason })));
  socket.accept();
  return { socket, connection, closed };
}

it('exposes authorized bootstrap and forwards bounded opaque domains independently of retained authority', async () => {
  const h = await create({ mode: 'dashboard', listener: false, application: { kind: 'peer', id: 'peer-history' } });
  const hints = { version: 1, endpoints: [{ route: 'direct', url: 'wss://resident.example/peer' }] };
  expect(await apiJson(h, 'PUT', 'peers/bootstrap', hints)).toEqual(hints);
  expect(await apiJson(h, 'GET', 'peers/bootstrap')).toEqual(hints);
  expect((await req(`${h.api}/peers/bootstrap`, { anonymous: true })).status).toBe(401);
  expect((await api(h, 'PUT', 'peers/bootstrap', { version: 1, endpoints: [{ route: 'direct', url: 'ws://insecure.example/' }] })).status).toBe(400);
  const agent = await open(h, 'one', 'agent'), page = await open(h, 'one', 'browser', true);
  await Promise.all([agent.connection.ready, page.connection.ready]);
  const reader = page.connection.frames[Symbol.asyncIterator](), responseReader = agent.connection.frames[Symbol.asyncIterator]();
  const payload = new Uint8Array([0, 255, 73]);
  await agent.connection.send({ domain: 'records', payload });
  expect((await reader.next()).value).toEqual({ domain: 'records', payload });
  await page.connection.send({ domain: 'signals', payload });
  expect((await responseReader.next()).value).toEqual({ domain: 'signals', payload });
  expect(agent.connection.stats.sentBytes).toBe(6);
  expect(page.connection.stats.receivedBytes).toBe(6);
  expect(await inDO(h.id, t => ({ log: t.db.one('SELECT COUNT(*) AS n FROM record_log_entries'),
    application: t.db.one('SELECT COUNT(*) AS n FROM application_changes'), oldEvents: t.db.one('SELECT COUNT(*) AS n FROM events') })))
    .toEqual({ log: { n: 0 }, application: { n: 0 }, oldEvents: { n: 0 } });
  agent.connection.close(); page.connection.close(); await reader.return?.(); await responseReader.return?.();
});

it('isolates two-endpoint sessions and closes the remaining peer on disconnect', async () => {
  const h = await create({ mode: 'dashboard', listener: false });
  const first = await open(h, 'channel', 'first');
  const headers = { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': 'tendriller.peer.v1' };
  expect((await api(h, 'GET', 'peers/socket?channel=channel&peerId=first', undefined, headers)).status).toBe(409);
  const second = await open(h, 'channel', 'second');
  await Promise.all([first.connection.ready, second.connection.ready]);
  expect((await api(h, 'GET', 'peers/socket?channel=channel&peerId=third', undefined, headers)).status).toBe(409);
  first.connection.close();
  expect((await second.closed).code).toBe(1013);
});

it('rejects oversized or malformed relay messages without retaining application records', async () => {
  for (const invalid of [new Uint8Array(PEER_LIMITS.signalBytes + 4), 'null']) {
    const h = await create({ mode: 'dashboard', listener: false });
    const first = await open(h, 'bounded', 'first'), second = await open(h, 'bounded', 'second');
    await Promise.all([first.connection.ready, second.connection.ready]);
    if (invalid instanceof Uint8Array) invalid.set([0x54, 1, 1]);
    first.socket.send(invalid);
    expect((await first.closed).code).toBe(invalid instanceof Uint8Array ? 1009 : 1008);
    second.connection.close();
    expect(await inDO(h.id, t => t.db.one('SELECT COUNT(*) AS n FROM record_log_entries'))).toEqual({ n: 0 });
  }
});

it('rechecks the recipient host credential before forwarding and never treats relay access as a database grant', async () => {
  const h = await create({ mode: 'dashboard', listener: false, application: { kind: 'peer', id: 'private-group' } });
  const agent = await open(h, 'access', 'agent'), page = await open(h, 'access', 'page', true);
  await Promise.all([agent.connection.ready, page.connection.ready]);
  await inDO(h.id, t => { t.db.run('DELETE FROM tokens'); });
  page.socket.send(encodePeerFrame({ domain: 'records', payload: new Uint8Array([1]) }));
  expect((await agent.closed).code).toBe(4003);
  expect(agent.connection.stats.receivedBytes).toBe(0);
  page.connection.close();
});


it('preserves sender order when the first frame waits for account authorization', async () => {
  const h = await create({ mode: 'dashboard', listener: false });
  const first = await open(h, 'ordered', 'first'), second = await open(h, 'ordered', 'second');
  await Promise.all([first.connection.ready, second.connection.ready]);
  await inDO(h.id, async t => {
    const sender = t.ctx.getWebSockets('peer').find(ws => ws.deserializeAttachment().peerId === 'first')!;
    const original = t.env.ACCOUNTS;
    let release!: () => void, entered!: () => void, reads = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    t.env.ACCOUNTS = { prepare(sql: string) {
      const statement = original.prepare(sql);
      return { bind(...args: unknown[]) {
        const bound = statement.bind(...args);
        return { async first() {
          const result = await bound.first();
          if (++reads === 1) { entered(); await gate; }
          return result;
        } };
      } };
    } } as D1Database;
    try {
      const one = t.webSocketMessage(sender, encodePeerFrame({ domain: 'records', payload: new Uint8Array([1]) }).slice().buffer);
      await started;
      const two = t.webSocketMessage(sender, encodePeerFrame({ domain: 'records', payload: new Uint8Array([2]) }).slice().buffer);
      await new Promise(resolve => setTimeout(resolve, 20));
      release(); await Promise.all([one, two]);
    } finally { release(); t.env.ACCOUNTS = original; }
  });
  const reader = second.connection.frames[Symbol.asyncIterator]();
  expect((await reader.next()).value?.payload).toEqual(new Uint8Array([1]));
  expect((await reader.next()).value?.payload).toEqual(new Uint8Array([2]));
  first.connection.close(); second.connection.close(); await reader.return?.();
});

it('ignores delayed traffic and close events from a retired pair after channel reuse', async () => {
  const h = await create({ mode: 'dashboard', listener: false });
  const oldFirst = await open(h, 'reused', 'first'), oldSecond = await open(h, 'reused', 'second');
  await Promise.all([oldFirst.connection.ready, oldSecond.connection.ready]);
  let retired!: WebSocket;
  await inDO(h.id, t => { retired = t.ctx.getWebSockets('peer').find(ws => ws.deserializeAttachment().peerId === 'first')!; });
  oldFirst.connection.close();
  await Promise.all([oldFirst.closed, oldSecond.closed]);
  const first = await open(h, 'reused', 'first'), second = await open(h, 'reused', 'second');
  await Promise.all([first.connection.ready, second.connection.ready]);
  await inDO(h.id, async t => {
    await t.webSocketMessage(retired, encodePeerFrame({ domain: 'records', payload: new Uint8Array([9]) }).slice().buffer);
    closePeer(t, retired);
  });
  await first.connection.send({ domain: 'records', payload: new Uint8Array([1]) });
  const reader = second.connection.frames[Symbol.asyncIterator]();
  expect((await reader.next()).value?.payload).toEqual(new Uint8Array([1]));
  expect(first.connection.stats.receivedBytes).toBe(0);
  first.connection.close(); second.connection.close(); await reader.return?.();
});

it('bounds queued authorization work and forwards no queued frames after overflow closes the sender', async () => {
  const h = await create({ mode: 'dashboard', listener: false });
  const first = await open(h, 'pending-bound', 'first'), second = await open(h, 'pending-bound', 'second');
  await Promise.all([first.connection.ready, second.connection.ready]);
  await inDO(h.id, async t => {
    const sender = t.ctx.getWebSockets('peer').find(ws => ws.deserializeAttachment().peerId === 'first')!;
    const frame = encodePeerFrame({ domain: 'records', payload: new Uint8Array([1]) }).slice().buffer;
    await Promise.all(Array.from({ length: 129 }, () => t.webSocketMessage(sender, frame)));
  });
  expect((await first.closed).code).toBe(1008);
  expect(second.connection.stats.receivedBytes).toBe(0);
  second.connection.close();
});
