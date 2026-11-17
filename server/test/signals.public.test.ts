import { afterEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { createClient } from '../../contract/client.mjs';
import { HOSTED_SIGNAL_LIMITS, connectHostedSignals, createHostedSignals, type HostedSignals } from '../../contract/signals.mjs';
import { sha256Hex } from '../src/ids';
import { PageClient, advance, api, apiJson, create, inDO, req } from './helpers';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
/** The real dedicated protocol, deliberately without automatic transport credit. */
class LiveClient {
  readonly messages: any[] = [];
  readonly waiters: Array<{ pred: (value: any) => boolean; resolve: (value: any) => void }> = [];
  closed: { code: number; reason: string } | null = null;
  constructor(readonly ws: WebSocket) {
    ws.addEventListener('message', event => {
      const value = JSON.parse(event.data as string), index = this.waiters.findIndex(waiter => waiter.pred(value));
      if (index < 0) this.messages.push(value); else this.waiters.splice(index, 1)[0]!.resolve(value);
    });
    ws.addEventListener('close', event => { this.closed = { code: event.code, reason: event.reason }; });
    ws.accept();
  }
  static async connect(pageUrl: string, options: { headers?: Record<string, string> } = {}): Promise<LiveClient> {
    const response = await req(pageUrl + '_tendril/signals/socket', { headers: {
      Upgrade: 'websocket', 'Sec-WebSocket-Protocol': 'tendriller.signals.v1', ...options.headers,
    } });
    if (response.status !== 101 || !response.webSocket) throw new Error(`Live upgrade failed: ${response.status}`);
    const client = new LiveClient(response.webSocket); await client.next('signal_ready'); return client;
  }
  send(value: unknown) { this.ws.send(JSON.stringify(value)); }
  next(match: string | ((value: any) => boolean)): Promise<any> {
    const pred = typeof match === 'string' ? (value: any) => value.t === match : match;
    const index = this.messages.findIndex(pred);
    if (index >= 0) return Promise.resolve(this.messages.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { const index = this.waiters.indexOf(waiter); if (index >= 0) this.waiters.splice(index, 1); reject(new Error('Live reply timed out')); }, 3000);
      const waiter = { pred, resolve: (value: any) => { clearTimeout(timer); resolve(value); } }; this.waiters.push(waiter);
    });
  }
  request(value: Record<string, unknown>) {
    const cid = typeof value.cid === 'string' ? value.cid : crypto.randomUUID();
    this.send({ ...value, cid }); return this.next(reply => reply.cid === cid);
  }
}
function bind(page: LiveClient): HostedSignals {
  const api = createHostedSignals({ connected: () => page.ws.readyState === WebSocket.READY_STATE_OPEN,
    send(message) { page.send(message); return true; },
    onMessage(listener) { const receive = (event: MessageEvent) => listener(JSON.parse(event.data as string)); page.ws.addEventListener('message', receive); return () => page.ws.removeEventListener('message', receive); },
    onDisconnect(listener) { page.ws.addEventListener('close', listener); return () => page.ws.removeEventListener('close', listener); } });
  cleanup.push(() => api.close()); return api;
}
function agentSocket(url: string, protocols: readonly string[]) {
  let ws: WebSocket | undefined, ended = false;
  const target = Object.assign(new EventTarget(), { readyState: 0,
    send(data: string) { ws!.send(data); }, close() { ended = true; ws?.close(); } });
  Object.defineProperty(target, 'readyState', { get: () => ws?.readyState ?? 0 });
  const destination = new URL(url); destination.protocol = 'https:';
  void req(destination.href, { headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': protocols.join(', ') } }).then(response => {
    if (response.status !== 101 || !response.webSocket) throw new Error(`Signal upgrade failed: ${response.status}`);
    ws = response.webSocket;
    ws.addEventListener('message', event => target.dispatchEvent(new MessageEvent('message', { data: event.data })));
    ws.addEventListener('close', () => target.dispatchEvent(new Event('close')));
    ws.accept(); if (ended) ws.close();
  }).catch(() => target.dispatchEvent(new Event('error')));
  return target;
}
const sample = (payload: unknown = { active: true }) => {
  const issuedAtMs = Date.now();
  return { t: 'signal_send', topic: 'typing', payload, issuedAtMs, expiresAtMs: issuedAtMs + 30_000 };
};

it('delivers real authenticated owner and agent signals with zero application or activity writes', async () => {
  const handle = await create({ mode: 'dashboard', listener: false });
  const page = await LiveClient.connect(handle.page_url); cleanup.push(() => page.ws.close());
  const browser = bind(page), agent = await createClient(handle).connectSignals({ socket: agentSocket }); cleanup.push(() => agent.close());
  const fromOwner = agent.subscribe({ topics: ['typing'] }), fromAgent = browser.subscribe({ mode: 'latest', topics: ['progress'] });
  cleanup.push(async () => { await fromOwner[Symbol.asyncIterator]().return?.(); await fromAgent[Symbol.asyncIterator]().return?.(); });
  // The page request is ordered after the public adapter's subscribe frame.
  await page.request({ t: 'signal_subscribe' });
  await expect.poll(() => inDO(handle.id, t => t.ctx.getWebSockets().filter(ws => ws.deserializeAttachment()?.live?.subscribed).length)).toBe(2);
  const baseline = await inDO(handle.id, t => ({ changes: t.db.one<{ n: number }>('SELECT total_changes() AS n')!.n, wakeListeners: t.agentSockets().length }));
  expect(baseline.wakeListeners).toBe(0);
  const receivedOwner = fromOwner[Symbol.asyncIterator]().next();
  const owner = await browser.send('typing', { authorId: 'payload cannot choose the sender', active: true }, { ttlMs: 30_000 });
  expect((await receivedOwner).value).toEqual(owner);
  expect(owner.authorId).toMatch(/^page:/);
  expect(owner.authorId).not.toBe('payload cannot choose the sender');
  expect(owner.scope).toBe(`hosted:${handle.id}`);
  const firstSession = owner.sessionId;
  const next = await browser.send('typing', false, { ttlMs: 30_000 });
  expect(next.sessionId).toBe(firstSession); expect(next.sequence).toBe(owner.sequence + 1);
  const waiting = fromAgent[Symbol.asyncIterator]().next();
  const sentByAgent = await agent.send('progress', { percent: 10 }, { ttlMs: 30_000 });
  expect((await waiting).value).toEqual(sentByAgent);
  expect(sentByAgent.authorId).toMatch(/^agent:/);
  expect(sentByAgent.sessionId).not.toBe(firstSession);
  const after = await inDO(handle.id, t => ({ changes: t.db.one<{ n: number }>('SELECT total_changes() AS n')!.n, wakeListeners: t.agentSockets().length }));
  expect(after).toEqual(baseline);
});

it('rejects spoofed sender metadata, stale dispatch, large frames and revoked page authority', async () => {
  const handle = await create({ mode: 'dashboard', listener: false });
  const page = await LiveClient.connect(handle.page_url); cleanup.push(() => page.ws.close());
  expect(await page.request({ ...sample(), authorId: 'another-owner', sessionId: 'forged', sequence: 999 })).toMatchObject({ error: 'signal_frame_invalid' });
  expect(await page.request({ ...sample(), issuedAtMs: Date.now() - 2000, expiresAtMs: Date.now() - 1000 })).toMatchObject({ error: 'signal_expired' });
  const accepted = await page.request(sample());
  expect(accepted.signal.sequence).toBe(1);
  const second = await LiveClient.connect(handle.page_url); cleanup.push(() => second.ws.close());
  second.send(sample('x'.repeat(HOSTED_SIGNAL_LIMITS.frameBytes)));
  await expect.poll(() => second.closed?.code).toBe(1009);
  await inDO(handle.id, t => t.db.run('DELETE FROM page_sessions'));
  expect(await page.request(sample())).toMatchObject({ error: 'signal_unauthorized' });
});

it('a slow live transport has a strict receipt-credit bound and cannot accumulate unbounded frames', async () => {
  const handle = await create({ mode: 'dashboard', listener: false });
  const writer = await LiveClient.connect(handle.page_url), reader = await LiveClient.connect(handle.page_url);
  cleanup.push(() => writer.ws.close()); cleanup.push(() => reader.ws.close());
  const sender = bind(writer);
  const subscribed = await reader.request({ t: 'signal_subscribe' });
  reader.send({ t: 'signal_credit', through: subscribed.delivery });
  for (let index = 0; index <= HOSTED_SIGNAL_LIMITS.inFlightFrames; index++) {
    if (index === HOSTED_SIGNAL_LIMITS.sendsPerSecond) await advance(handle.id, 1000);
    expect((await sender.send('typing', index, { ttlMs: 30_000 })).sequence).toBe(index + 1);
  }
  await expect.poll(() => reader.closed?.code).toBe(1013);
  expect(reader.messages.filter(value => value.t === 'signal')).toHaveLength(HOSTED_SIGNAL_LIMITS.inFlightFrames);
}, 30_000);

it('bounds unread dispatch replies even when a raw sender never subscribes or returns credit', async () => {
  const handle = await create({ mode: 'dashboard', listener: false });
  const writer = await LiveClient.connect(handle.page_url); cleanup.push(() => writer.ws.close());
  for (let index = 0; index < HOSTED_SIGNAL_LIMITS.inFlightFrames; index++) {
    if (index === HOSTED_SIGNAL_LIMITS.sendsPerSecond) await advance(handle.id, 1000);
    expect(await writer.request(sample(index))).toMatchObject({ delivery: index + 1, signal: { sequence: index + 1 } });
  }
  expect(await inDO(handle.id, t => {
    const socket = t.ctx.getWebSockets('signals')[0]!;
    return socket.deserializeAttachment().live.pending.length;
  })).toBe(HOSTED_SIGNAL_LIMITS.inFlightFrames);
  writer.send({ ...sample('reader stopped'), cid: 'over-credit-window' });
  await expect.poll(() => writer.closed?.code).toBe(1013);
  expect(writer.messages.some(value => value.cid === 'over-credit-window')).toBe(false);
}, 30_000);

it('reopening starts a fresh live session with no replay of disconnected signals', async () => {
  const handle = await create({ mode: 'dashboard', listener: false });
  const writer = await LiveClient.connect(handle.page_url), first = await LiveClient.connect(handle.page_url);
  cleanup.push(() => writer.ws.close()); cleanup.push(() => first.ws.close());
  await first.request({ t: 'signal_subscribe' });
  const previous = await writer.request(sample('before disconnect'));
  expect((await first.next('signal')).signal.payload).toBe('before disconnect');
  first.ws.close();
  await writer.request(sample('while disconnected'));
  const fresh = await LiveClient.connect(handle.page_url); cleanup.push(() => fresh.ws.close());
  await fresh.request({ t: 'signal_subscribe' });
  await writer.request(sample('after reconnect'));
  expect((await fresh.next('signal')).signal.payload).toBe('after reconnect');
  expect(fresh.messages.some(value => value.t === 'signal')).toBe(false);
  const reply = await fresh.request(sample('fresh sender'));
  expect(reply.signal.sessionId).not.toBe(previous.signal.sessionId); expect(reply.signal.sequence).toBe(1);
});

it('does not disclose later payloads to a reader whose credential was revoked', async () => {
  const handle = await create({ mode: 'dashboard', listener: false });
  const owner = await LiveClient.connect(handle.page_url); cleanup.push(() => owner.ws.close());
  const agent = await createClient(handle).connectSignals({ socket: agentSocket }); cleanup.push(() => agent.close());
  const iterator = agent.subscribe()[Symbol.asyncIterator]();
  await expect.poll(() => inDO(handle.id, t => t.ctx.getWebSockets('signals').filter(ws => ws.deserializeAttachment()?.live?.subscribed).length)).toBe(1);
  const rejected = expect(iterator.next()).rejects.toMatchObject({ code: 'signal_disconnected' });
  await inDO(handle.id, t => t.db.run('DELETE FROM tokens'));
  expect((await owner.request(sample('must remain private'))).signal.sequence).toBe(1);
  await rejected;
});

it('uses page read/write permissions for guests and displays and keeps producer credentials separate', async () => {
  const handle = await create({ mode: 'dashboard', listener: false });
  const owner = await LiveClient.connect(handle.page_url); cleanup.push(() => owner.ws.close());
  const management = await PageClient.connect(handle.page_url); cleanup.push(() => management.ws.close());
  const display = (await management.request({ t: 'links', create: { role: 'display' } })).created;
  const screen = await LiveClient.connect(display.url, { headers: { Cookie: '', Origin: new URL(display.url).origin } });
  cleanup.push(() => screen.ws.close());
  expect(await screen.request({ t: 'signal_subscribe' })).not.toHaveProperty('error');
  expect(await screen.request(sample())).toMatchObject({ error: 'signal_unauthorized' });
  const link = await apiJson(handle, 'POST', 'links', { role: 'guest' });
  const guestId = crypto.randomUUID(), token = crypto.randomUUID(), hash = await sha256Hex(token);
  await env.ACCOUNTS.prepare('INSERT INTO accounts(id,email,created_at) VALUES(?,?,?)').bind(guestId, `${guestId}@example.com`, Date.now()).run();
  await inDO(handle.id, t => {
    t.db.run('INSERT INTO guest_accounts(account_id,link_id,approved,created_at) VALUES(?,?,1,?)', guestId, link.id, t.now());
    t.db.run("INSERT INTO page_sessions(hash,account_id,role,expires_at) VALUES(?,?,'guest',?)", hash, guestId, t.now() + 86_400_000);
  });
  const guest = await LiveClient.connect(link.url, { headers: { Cookie: `__Host-tendril=${token}`, Origin: new URL(link.url).origin } });
  cleanup.push(() => guest.ws.close());
  const guestSignal = await guest.request(sample('approved guest message'));
  expect(guestSignal.signal.authorId).toBe(`page:${guestId}`);
  expect((await screen.next('signal')).signal).toEqual(guestSignal.signal);
  await apiJson(handle, 'POST', 'streams', { name: 'samples', durability: 'ephemeral' }, 201);
  const producer = await apiJson(handle, 'POST', 'producers', { name: 'sampler', streams: ['samples'] }, 201);
  const upgrade = await req(handle.api + '/signals/socket', { headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `tendriller.signals.v1, ${producer.token}` } });
  expect(upgrade.status).toBe(401);
  await env.ACCOUNTS.prepare("UPDATE service_state SET mode='read_only' WHERE id=1").run();
  try {
    expect(await owner.request({ t: 'signal_subscribe' })).not.toHaveProperty('error');
    expect(await owner.request(sample())).toMatchObject({ error: 'read_only' });
  } finally { await env.ACCOUNTS.prepare("UPDATE service_state SET mode='open' WHERE id=1").run(); }
});

it('provides an explicit hosted live choice independently of peer durable history', async () => {
  const handle = await create({ mode: 'dashboard', listener: false });
  const agent = await createClient(handle).connectSignals({ socket: agentSocket }); cleanup.push(() => agent.close());
  const page = await connectHostedSignals({ api: handle.page_url + '_tendril', socket: agentSocket }); cleanup.push(() => page.close());
  expect(page.connected).toBe(true);
  const iterator = page.subscribe()[Symbol.asyncIterator](); cleanup.push(() => iterator.return?.().then(() => {}));
  await expect.poll(() => inDO(handle.id, t => t.ctx.getWebSockets('signals').filter(ws => ws.deserializeAttachment()?.live?.subscribed).length)).toBe(1);
  const sent = await agent.send('preview', 'fresh traffic');
  expect((await iterator.next()).value).toEqual(sent);
  expect(await inDO(handle.id, t => t.db.one<{ n: number }>('SELECT COUNT(*) AS n FROM devices')!.n)).toBe(0);
  const peer = await create({ mode: 'dashboard', listener: false, application: { kind: 'peer', id: 'peer-history' } });
  const retained = () => inDO(peer.id, t => ({ events: t.db.one('SELECT COUNT(*) AS n FROM events'),
    changes: t.db.one('SELECT COUNT(*) AS n FROM application_changes'), devices: t.db.one('SELECT COUNT(*) AS n FROM devices') }));
  const before = await retained();
  const publisher = await createClient(peer).connectSignals({ socket: agentSocket }); cleanup.push(() => publisher.close());
  const receiver = await connectHostedSignals({ api: peer.page_url + '_tendril', socket: agentSocket }); cleanup.push(() => receiver.close());
  const incoming = receiver.subscribe()[Symbol.asyncIterator](); cleanup.push(() => incoming.return?.().then(() => {}));
  await expect.poll(() => inDO(peer.id, t => t.ctx.getWebSockets('signals').filter(ws => ws.deserializeAttachment()?.live?.subscribed).length)).toBe(1);
  const explicit = await publisher.send('progress', 'explicit hosted transport');
  expect((await incoming.next()).value).toEqual(explicit);
  expect(explicit.scope).toBe(`hosted:${peer.id}`);
  expect(await retained()).toEqual(before);
  expect((await req(peer.page_url + '_tendril/ws', { headers: { Upgrade: 'websocket' } })).status).toBe(409);
  expect((await api(peer, 'POST', 'application/changes', { operationId: 'not-hosted', program: {} })).status).toBe(409);
  expect(await inDO(peer.id, t => t.ctx.getWebSockets().every(ws => ws.deserializeAttachment()?.kind === 'signals'))).toBe(true);
});

it('rejects live use on the durable socket and keeps durable work available after live overload', async () => {
  const handle = await create({ mode: 'dashboard', listener: false });
  const page = await PageClient.connect(handle.page_url); cleanup.push(() => page.ws.close());
  expect(await page.request(sample())).toMatchObject({ t: 'error', code: 'signal_connection_required' });
  const live = await LiveClient.connect(handle.page_url); cleanup.push(() => live.ws.close());
  await inDO(handle.id, async t => {
    const socket = t.ctx.getWebSockets('signals')[0]!;
    await Promise.all(Array.from({ length: HOSTED_SIGNAL_LIMITS.pendingRequests + 1 }, (_, index) =>
      t.webSocketMessage(socket, JSON.stringify({ ...sample(index), cid: String(index) }))));
  });
  await expect.poll(() => live.closed?.code).toBe(1013);
  expect(page.closed).toBeNull();
  const written = await page.request({ t: 'state', expected_generations: {}, ops: [{ op: 'set', path: ['liveFailureIsolated'], value: true }] });
  expect(written.error).toBeUndefined();
  expect((await page.request({ t: 'state_snapshot' })).state.liveFailureIsolated).toBe(true);
});

it('bounds pending authorization independently of the ordinary page queue', async () => {
  const handle = await create({ mode: 'dashboard', listener: false });
  const page = await LiveClient.connect(handle.page_url); cleanup.push(() => page.ws.close());
  await inDO(handle.id, async t => {
    const socket = t.ctx.getWebSockets('signals')[0]!;
    await Promise.all(Array.from({ length: HOSTED_SIGNAL_LIMITS.pendingRequests + 1 }, (_, index) =>
      t.webSocketMessage(socket, JSON.stringify({ ...sample(index), cid: String(index) }))));
  });
  await expect.poll(() => page.closed?.code).toBe(1013);
});

it('expires the original caller window when asynchronous authorization consumes its remaining lifetime', async () => {
  const handle = await create({ mode: 'dashboard', listener: false });
  const owner = await LiveClient.connect(handle.page_url); cleanup.push(() => owner.ws.close());
  const message = { ...sample(), cid: 'original-expiry' };
  await inDO(handle.id, async t => {
    const original = t.env.ACCOUNTS, skew = t.skew;
    let observed = false;
    t.env.ACCOUNTS = { prepare(sql: string) {
      const statement = original.prepare(sql);
      if (!sql.includes('SELECT mode FROM service_state')) return statement;
      return { async first() { const result = await statement.first(); observed = true; t.skew += 30_001; return result; } };
    } } as D1Database;
    try {
      const socket = t.ctx.getWebSockets('signals')[0]!;
      await t.webSocketMessage(socket, JSON.stringify(message));
      expect(observed).toBe(true);
    } finally { t.env.ACCOUNTS = original; t.skew = skew; }
  });
  expect(await owner.next(value => value.cid === message.cid)).toMatchObject({ error: 'signal_expired' });
  expect((await owner.request(sample())).signal.sequence).toBe(1);
});
