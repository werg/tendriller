import { expect, it } from 'vitest';
import { api, create, inDO, PageClient, req, type Handle } from './helpers';
import { HOSTED_SIGNAL_PROTOCOL, createSignalInput, SIGNAL_LIMITS } from '../../contract/hosted-signals.mjs';

const headers = { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': HOSTED_SIGNAL_PROTOCOL };
async function connect(h: Handle, page = false, url = h.page_url) {
  const response = page ? await req(`${url}_tendril/signals/socket`, { headers: { ...headers, Origin: new URL(url).origin } })
    : await api(h, 'GET', 'signals/socket', undefined, headers);
  expect(response.status).toBe(101);
  const ws = response.webSocket!, messages: any[] = [], waits: Array<{ accept: (value: any) => boolean; resolve: (value: any) => void }> = [];
  const read = (accept: (value: any) => boolean) => {
    const index = messages.findIndex(accept);
    if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
    return new Promise<any>(resolve => waits.push({ accept, resolve }));
  };
  const closed = new Promise<number>(resolve => ws.addEventListener('close', event => resolve(event.code)));
  ws.addEventListener('message', event => {
    const value = JSON.parse(event.data as string), index = waits.findIndex(wait => wait.accept(value));
    if (index >= 0) waits.splice(index, 1)[0].resolve(value); else messages.push(value);
  });
  ws.accept(); await read(value => value.t === 'signal_ready');
  let sequence = 0;
  return { ws, closed, messages, next: () => read(value => value.t === 'signal'),
    command(message: object) { const cid = String(++sequence); ws.send(JSON.stringify({ ...message, cid })); return read(value => value.cid === cid); } };
}

it('uses the same authenticated live port for agents and existing page sockets with no retained application work', async () => {
  const h = await create({ mode: 'dashboard', listener: false }), agent = await connect(h), page = await PageClient.connect(h.page_url);
  page.send({ t: 'signal_subscribe', cid: 'listen' }); await page.next(value => value.cid === 'listen');
  await agent.command({ t: 'signal_subscribe' });
  const before = await inDO(h.id, t => ({ events: t.db.one('SELECT COUNT(*) AS n FROM events'), changes: t.db.one('SELECT COUNT(*) AS n FROM application_changes'), streams: t.db.one('SELECT COUNT(*) AS n FROM stream_records') }));
  const sent = await agent.command({ t: 'signal_send', message: createSignalInput('progress', { completed: 3 }) });
  const received = await page.next(value => value.t === 'signal');
  expect(received.signal).toEqual(sent.signal);
  expect(sent.signal).toMatchObject({ scope: `cf:${h.id}`, authorId: 'agent:main', sequence: 1, payload: { completed: 3 } });
  page.send({ t: 'signal_send', cid: 'typing', message: createSignalInput('typing', { active: true }) });
  const reply = await page.next(value => value.cid === 'typing');
  expect((await agent.next()).signal).toEqual(reply.signal);
  expect(reply.signal.authorId).toMatch(/^page:/);
  expect(await inDO(h.id, t => ({ events: t.db.one('SELECT COUNT(*) AS n FROM events'), changes: t.db.one('SELECT COUNT(*) AS n FROM application_changes'), streams: t.db.one('SELECT COUNT(*) AS n FROM stream_records') }))).toEqual(before);
  agent.ws.close(); page.close();
});

it('does not replay on a new subscription and creates a fresh sender session on reconnect', async () => {
  const h = await create({ mode: 'dashboard', listener: false }), sender = await connect(h), reader = await connect(h, true);
  const first = await sender.command({ t: 'signal_send', message: createSignalInput('preview', 'old') });
  await reader.command({ t: 'signal_subscribe' });
  expect(reader.messages.filter(message => message.t === 'signal')).toEqual([]);
  const second = await sender.command({ t: 'signal_send', message: createSignalInput('preview', 'current') });
  expect((await reader.next()).signal).toEqual(second.signal);
  sender.ws.close(); const replacement = await connect(h);
  const third = await replacement.command({ t: 'signal_send', message: createSignalInput('preview', 'fresh') });
  expect(third.signal.sessionId).not.toBe(first.signal.sessionId); expect(third.signal.sequence).toBe(1);
  expect((await reader.next()).signal).toEqual(third.signal);
  reader.ws.close(); replacement.ws.close();
});

it('rejects expired messages, forged sender context, and replay cursors', async () => {
  const h = await create({ mode: 'dashboard', listener: false }), sender = await connect(h);
  expect(await sender.command({ t: 'signal_send', message: createSignalInput('preview', 'stale', { ttlMs: 1 }, Date.now() - 100) })).toMatchObject({ error: 'signal_expired' });
  expect(await sender.command({ t: 'signal_send', message: { ...createSignalInput('preview', 'spoof'), authorId: 'owner' } })).toMatchObject({ error: 'invalid_signal' });
  expect(await sender.command({ t: 'signal_subscribe', after: 0 })).toMatchObject({ error: 'invalid_signal' });
  sender.ws.close();
});

it('rechecks sender and recipient credentials and makes display links receive-only', async () => {
  const h = await create({ mode: 'dashboard', listener: false }), agent = await connect(h), page = await connect(h, true);
  const display = await inDO(h.id, async t => t.renderLink(await t.createLink('display', null, null)));
  const viewer = await connect(h, true, display.url);
  await viewer.command({ t: 'signal_subscribe' }); await agent.command({ t: 'signal_subscribe' });
  expect(await viewer.command({ t: 'signal_send', message: createSignalInput('typing', true) })).toMatchObject({ error: 'forbidden' });
  await inDO(h.id, t => t.db.run('DELETE FROM tokens'));
  expect(await agent.command({ t: 'signal_send', message: createSignalInput('typing', true) })).toMatchObject({ error: 'forbidden' });
  const sent = await page.command({ t: 'signal_send', message: createSignalInput('typing', true) });
  expect((await viewer.next()).signal).toEqual(sent.signal);
  expect(await agent.closed).toBe(4003);
  viewer.ws.close(); page.ws.close();
});

it('authenticates native socket headers and refuses hosted signals on peer pages', async () => {
  const h = await create({ mode: 'dashboard', listener: false });
  const native = await req(`${h.api}/signals/socket`, { anonymous: true, headers: { ...headers, 'Sec-WebSocket-Protocol': `${HOSTED_SIGNAL_PROTOCOL}, ${h.token}` } });
  expect(native.status).toBe(101); native.webSocket!.accept(); native.webSocket!.close();
  expect((await req(`${h.api}/signals/socket`, { anonymous: true, headers })).status).toBe(401);
  const peer = await create({ mode: 'dashboard', listener: false, application: { kind: 'peer', id: 'peer-history' } });
  expect((await api(peer, 'GET', 'signals/socket', undefined, headers)).status).toBe(409);
  expect(await inDO(peer.id, t => t.ctx.getWebSockets().length)).toBe(0);
});

it('bounds frames and pending authorization before creating a sender backlog', async () => {
  const h = await create({ mode: 'dashboard', listener: false }), first = await connect(h);
  first.ws.send('x'.repeat(SIGNAL_LIMITS.bytes + 1)); expect(await first.closed).toBe(1009);
  const second = await connect(h);
  await inDO(h.id, async t => {
    const ws = t.ctx.getWebSockets('signals').find(socket => socket.readyState === WebSocket.READY_STATE_OPEN)!;
    await Promise.all(Array.from({ length: SIGNAL_LIMITS.pending + 1 }, (_, i) => t.webSocketMessage(ws,
      JSON.stringify({ t: 'signal_send', cid: String(i), message: createSignalInput('sample', i, {}, t.now()) }))));
  });
  expect(await second.closed).toBe(1013);
});
