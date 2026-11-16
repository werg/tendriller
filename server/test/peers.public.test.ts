import { expect, it } from 'vitest';
import { api, apiJson, create, inDO, req, type Handle } from './helpers';
import { createPeerConnection, encodePeerFrame, PEER_LIMITS } from '../../contract/peers.mjs';

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
