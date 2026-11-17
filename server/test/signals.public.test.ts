import { expect, it } from 'vitest';
import { api, create, inDO, PageClient, req, type Handle } from './helpers';
import { HOSTED_SIGNAL_PROTOCOL, createSignalInput, SIGNAL_LIMITS } from '../../contract/hosted-signals.mjs';
import type { Tendril } from '../src/tendril';

const headers = { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': HOSTED_SIGNAL_PROTOCOL };
async function connect(h: Handle, page = false) {
  const response = page ? await req(`${h.page_url}_tendril/signals/socket`, { headers }) : await api(h, 'GET', 'signals/socket', undefined, headers);
  expect(response.status).toBe(101);
  const ws = response.webSocket!, messages: any[] = [];
  const waits: Array<{ accept: (value: any) => boolean; resolve: (value: any) => void }> = [];
  const read = (accept: (value: any) => boolean) => {
    const index = messages.findIndex(accept);
    if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
    return new Promise<any>((resolve, reject) => {
      const item = { accept, resolve: (value: any) => { clearTimeout(timer); resolve(value); } };
      const timer = setTimeout(() => { const index = waits.indexOf(item); if (index >= 0) waits.splice(index, 1); reject(new Error('No live response')); }, 5000);
      waits.push(item);
    });
  };
  const closed = new Promise<number>(resolve => ws.addEventListener('close', event => resolve(event.code)));
  ws.addEventListener('message', event => {
    const value = JSON.parse(event.data as string), index = waits.findIndex(wait => wait.accept(value));
    if (index >= 0) waits.splice(index, 1)[0].resolve(value); else messages.push(value);
  });
  ws.accept(); const ready = await read(value => value.t === 'signal_ready');
  let sequence = 0;
  return { ws, closed, messages, scope: ready.scope, next: () => read(value => value.t === 'signal'),
    command(message: object) { const cid = String(++sequence); ws.send(JSON.stringify({ ...message, cid })); return read(value => value.cid === cid); } };
}
const retained = (h: Handle) => inDO(h.id, t => ({
  events: t.db.one('SELECT COUNT(*) AS n FROM events'), application: t.db.one('SELECT COUNT(*) AS n FROM application_changes'),
  streams: t.db.one('SELECT COUNT(*) AS n FROM stream_records'), devices: t.db.one('SELECT COUNT(*) AS n FROM devices'),
  activity: t.db.one('SELECT COUNT(*) AS n FROM activity'), rates: t.db.one('SELECT COUNT(*) AS n FROM ws_rate'),
  listening: t.agentSockets().length,
}));

it('ships bidirectional private live sessions with authenticated origins and zero retained application growth', async () => {
  const h = await create({ mode: 'dashboard', listener: false }), before = await retained(h);
  const agent = await connect(h), owner = await connect(h, true);
  try {
    await owner.command({ t: 'signal_subscribe' }); await agent.command({ t: 'signal_subscribe' });
    const sent = await agent.command({ t: 'signal_send', message: createSignalInput('progress', { percent: 42 }) });
    expect((await owner.next()).signal).toEqual(sent.signal);
    expect(sent.signal).toMatchObject({ authorId: 'agent:main', scope: `cf:${h.id}`, sequence: 1 });
    expect(agent.scope).toBe(`cf:${h.id}`);
    const reply = await owner.command({ t: 'signal_send', message: createSignalInput('progress', { percent: 43 }) });
    expect((await agent.next()).signal).toEqual(reply.signal);
    expect(reply.signal.authorId).toMatch(/^account:/); expect(reply.signal.sessionId).not.toBe(sent.signal.sessionId);
    expect(await retained(h)).toEqual(before);
  } finally { agent.ws.close(); owner.ws.close(); }
});

it('reuses an active owner page subscription without entering command delivery or state history', async () => {
  const h = await create({ mode: 'dashboard', listener: false }), page = await PageClient.connect(h.page_url), agent = await connect(h);
  const before = await retained(h);
  try {
    await agent.command({ t: 'signal_subscribe' }); await page.request({ t: 'signal_subscribe' });
    const result = await page.request({ t: 'signal_send', message: createSignalInput('typing', { active: true }) });
    expect(result.t).toBe('ack'); expect(result.error).toBeUndefined();
    expect((await agent.next()).signal).toEqual(result.signal);
    await agent.command({ t: 'signal_send', message: createSignalInput('progress', { percent: 10 }) });
    expect((await page.next('signal')).signal.payload).toEqual({ percent: 10 });
    await page.request({ t: 'signal_unsubscribe' });
    await agent.command({ t: 'signal_send', message: createSignalInput('progress', { percent: 20 }) });
    await page.request({ t: 'signal_unsubscribe' });
    expect(page.messages.filter(message => message.t === 'signal')).toEqual([]);
    expect(await retained(h)).toEqual(before);
  } finally { page.close(); agent.ws.close(); }
});

it('has no replay, sends only to active subscriptions and creates a fresh session on reconnect', async () => {
  const h = await create({ mode: 'dashboard', listener: false }), sender = await connect(h), reader = await connect(h, true);
  let replacement: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    const first = await sender.command({ t: 'signal_send', message: createSignalInput('preview', 'old') });
    await reader.command({ t: 'signal_subscribe' });
    expect(reader.messages.filter(message => message.t === 'signal')).toEqual([]);
    const second = await sender.command({ t: 'signal_send', message: createSignalInput('preview', 'current') });
    expect((await reader.next()).signal).toEqual(second.signal);
    sender.ws.close(); replacement = await connect(h);
    const third = await replacement.command({ t: 'signal_send', message: createSignalInput('preview', 'fresh') });
    expect(third.signal.sessionId).not.toBe(first.signal.sessionId); expect(third.signal.sequence).toBe(1);
    expect((await reader.next()).signal).toEqual(third.signal);
  } finally { sender.ws.close(); reader.ws.close(); replacement?.ws.close(); }
});

it('rejects expired input, forged origin fields and replay cursors without damaging the session', async () => {
  const h = await create({ mode: 'dashboard', listener: false }), sender = await connect(h);
  try {
    expect(await sender.command({ t: 'signal_send', message: createSignalInput('preview', 'stale', { ttlMs: 1 }, Date.now() - 100) })).toMatchObject({ error: 'signal_expired' });
    expect(await sender.command({ t: 'signal_send', message: { ...createSignalInput('preview', 'spoof'), authorId: 'owner' } })).toMatchObject({ error: 'invalid_signal' });
    expect(await sender.command({ t: 'signal_subscribe', after: 0 })).toMatchObject({ error: 'invalid_signal' });
    expect(await sender.command({ t: 'signal_send', message: createSignalInput('preview', 'fresh') })).toMatchObject({ signal: { payload: 'fresh' } });
  } finally { sender.ws.close(); }
});

it('refuses unauthenticated or display live access', async () => {
  const h = await create({ mode: 'dashboard', listener: false });
  expect((await req(`${h.api}/signals/socket`, { headers, anonymous: true })).status).toBe(401);
  const display = await inDO(h.id, async t => t.renderLink(await t.createLink('display', null, null)));
  expect((await req(`${display.url}_tendril/signals/socket`, { headers: { ...headers, Origin: new URL(display.url).origin }, anonymous: true })).status).toBe(403);
  const viewer = await PageClient.connect(display.url);
  try {
    expect(await viewer.request({ t: 'signal_subscribe' })).toMatchObject({ error: 'signal_unauthorized' });
    expect(await viewer.request({ t: 'signal_send', message: createSignalInput('preview', 1) })).toMatchObject({ error: 'signal_unauthorized' });
  } finally { viewer.close(); }
});

it('permits an explicit hosted live route on a peer page without hosted application work or automatic connection', async () => {
  const h = await create({ mode: 'dashboard', listener: false, application: { kind: 'peer', id: 'peer-history' } });
  const before = await retained(h);
  expect(await inDO(h.id, t => t.ctx.getWebSockets().length)).toBe(0);
  expect((await req(`${h.page_url}_tendril/ws`, { headers: { Upgrade: 'websocket' } })).status).toBe(409);
  const agent = await connect(h), owner = await connect(h, true);
  try {
    await owner.command({ t: 'signal_subscribe' }); await agent.command({ t: 'signal_subscribe' });
    const sent = await agent.command({ t: 'signal_send', message: createSignalInput('progress', 'explicit-host-route') });
    expect((await owner.next()).signal).toEqual(sent.signal);
    expect(sent.signal).toMatchObject({ scope: 'peer-history', authorId: 'agent:main' });
    const reply = await owner.command({ t: 'signal_send', message: createSignalInput('attention', 'explicit-reply') });
    expect((await agent.next()).signal).toEqual(reply.signal);
    expect(await retained(h)).toEqual(before);
    expect((await api(h, 'POST', 'application/changes', { operationId: 'not-hosted', program: {} })).status).toBe(409);
    expect(await inDO(h.id, t => t.ctx.getWebSockets().every(ws => ws.deserializeAttachment()?.kind === 'signals'))).toBe(true);
  } finally { agent.ws.close(); owner.ws.close(); }
});

it('authenticates native clients through subprotocol headers without an agent wake listener', async () => {
  const h = await create({ mode: 'dashboard', listener: false });
  const native = await req(`${h.api}/signals/socket`, { anonymous: true, headers: { ...headers, 'Sec-WebSocket-Protocol': `${HOSTED_SIGNAL_PROTOCOL}, ${h.token}` } });
  expect(native.status).toBe(101); native.webSocket!.accept();
  expect(await inDO(h.id, t => t.agentSockets().length)).toBe(0);
  native.webSocket!.close();
});

it('rechecks established senders and recipients after token revocation', async () => {
  const h = await create({ mode: 'dashboard', listener: false }), agent = await connect(h), owner = await connect(h, true);
  try {
    await agent.command({ t: 'signal_subscribe' }); await owner.command({ t: 'signal_subscribe' });
    await inDO(h.id, t => t.db.run('DELETE FROM tokens'));
    expect(await agent.command({ t: 'signal_send', message: createSignalInput('progress', 1) })).toMatchObject({ error: 'signal_unauthorized' });
    await owner.command({ t: 'signal_send', message: createSignalInput('progress', 2) });
    await agent.command({ t: 'signal_unsubscribe' });
    expect(agent.messages.filter(message => message.t === 'signal')).toEqual([]);
    expect(owner.messages.filter(message => message.t === 'signal')).toEqual([]);
  } finally { agent.ws.close(); owner.ws.close(); }
});

it('drops excess live authorization work and leaves the shared durable page socket usable', async () => {
  const h = await create({ mode: 'dashboard', listener: false }), page = await PageClient.connect(h.page_url);
  try {
    await inDO(h.id, async t => {
      const ws = t.connectedSockets().find(value => value.att.deviceId === page.deviceId)!.ws;
      await Promise.all(Array.from({ length: SIGNAL_LIMITS.pendingSends + 1 }, (_, i) => t.webSocketMessage(ws,
        JSON.stringify({ t: 'signal_send', cid: `pressure-${i}`, message: createSignalInput('sample', i, {}, t.now()) }))));
    });
    const replies = await Promise.all(Array.from({ length: SIGNAL_LIMITS.pendingSends + 1 }, (_, i) => page.next(message => message.cid === `pressure-${i}`)));
    expect(replies.filter(message => message.error === 'signal_backpressure').length).toBe(SIGNAL_LIMITS.pendingSends);
    expect(replies.filter(message => message.signal).length).toBe(1);
    expect(page.closed).toBeNull();
    expect(await page.request({ t: 'state', expected_generations: {}, ops: [{ op: 'set', path: ['stillConnected'], value: true }] })).not.toHaveProperty('error');
    expect((await page.request({ t: 'state_snapshot' })).state.stillConnected).toBe(true);
    expect(await page.request({ t: 'signal_send', message: createSignalInput('sample', 'fresh') })).toMatchObject({ signal: { payload: 'fresh' } });
  } finally { page.close(); }
});

it('drops a congested live delivery without closing the receiving page socket', async () => {
  const h = await create({ mode: 'dashboard', listener: false }), sender = await connect(h), page = await PageClient.connect(h.page_url);
  try {
    await page.request({ t: 'signal_subscribe' });
    await inDO(h.id, t => {
      const ws = t.connectedSockets().find(value => value.att.deviceId === page.deviceId)!.ws;
      Object.defineProperty(ws, 'bufferedAmount', { configurable: true, value: SIGNAL_LIMITS.pendingBytes });
    });
    expect(await sender.command({ t: 'signal_send', message: createSignalInput('sample', 'congested') })).toHaveProperty('signal');
    await inDO(h.id, t => {
      const ws = t.connectedSockets().find(value => value.att.deviceId === page.deviceId)!.ws;
      expect(ws.readyState).toBe(WebSocket.READY_STATE_OPEN);
      Object.defineProperty(ws, 'bufferedAmount', { configurable: true, value: 0 });
    });
    const fresh = await sender.command({ t: 'signal_send', message: createSignalInput('sample', 'fresh') });
    expect((await page.next('signal')).signal).toEqual(fresh.signal);
    expect((await page.request({ t: 'state_snapshot' })).state).toEqual({});
  } finally { sender.ws.close(); page.close(); }
});

it('isolates thrown live sends from a shared socket and retires only a failed dedicated connection', async () => {
  const h = await create({ mode: 'dashboard', listener: false }), sender = await connect(h), dedicated = await connect(h);
  const page = await PageClient.connect(h.page_url);
  try {
    await dedicated.command({ t: 'signal_subscribe' }); await page.request({ t: 'signal_subscribe' });
    await inDO(h.id, t => {
      for (const ws of t.ctx.getWebSockets().filter(socket => socket.deserializeAttachment()?.live?.subscribed)) {
        const original = ws.send;
        ws.send = function (message) {
          if (typeof message === 'string' && JSON.parse(message).t === 'signal') {
            ws.send = original; throw new Error('Injected live transport send failure');
          }
          original.call(ws, message);
        };
      }
    });
    expect(await sender.command({ t: 'signal_send', message: createSignalInput('sample', 'lost-live-attempt') })).toHaveProperty('signal');
    expect(await dedicated.closed).toBe(1011); expect(page.closed).toBeNull();
    expect(await page.request({ t: 'state', expected_generations: {}, ops: [{ op: 'set', path: ['liveFailureIsolated'], value: true }] })).not.toHaveProperty('error');
    expect((await page.request({ t: 'state_snapshot' })).state.liveFailureIsolated).toBe(true);
    const fresh = await sender.command({ t: 'signal_send', message: createSignalInput('sample', 'fresh') });
    expect((await page.next('signal')).signal).toEqual(fresh.signal);
  } finally { sender.ws.close(); dedicated.ws.close(); page.close(); }
});

it('rejects oversized dedicated frames as protocol violations', async () => {
  const h = await create({ mode: 'dashboard', listener: false }), sender = await connect(h);
  sender.ws.send('x'.repeat(SIGNAL_LIMITS.frameBytes + 1)); expect(await sender.closed).toBe(1009);
});

async function duringRecipientAccountRead(t: Tendril, mutate: () => void | Promise<void>, run: () => Promise<void>) {
  const original = t.env.ACCOUNTS;
  let changed = false;
  t.env.ACCOUNTS = { prepare(sql: string) {
    const statement = original.prepare(sql);
    if (!sql.includes('FROM accounts WHERE id')) return statement;
    return { bind(...args: unknown[]) {
      const bound = statement.bind(...args);
      return { async first() { const result = await bound.first(); if (!changed) { changed = true; await mutate(); } return result; } };
    } };
  } } as D1Database;
  try { await run(); expect(changed).toBe(true); } finally { t.env.ACCOUNTS = original; }
}

for (const change of ['sender revoked', 'recipient revoked', 'unsubscribe', 'expiry'] as const) {
  it(`rechecks ${change} after asynchronous recipient authorization before sending bytes`, async () => {
    const h = await create({ mode: 'dashboard', listener: false }), agent = await connect(h), owner = await connect(h, true);
    try {
      await owner.command({ t: 'signal_subscribe' });
      await inDO(h.id, async t => {
        const sockets = t.ctx.getWebSockets('signals');
        const sender = sockets.find(ws => ws.deserializeAttachment()?.principal?.kind === 'agent')!;
        const reader = sockets.find(ws => ws.deserializeAttachment()?.principal?.kind === 'page')!;
        await duringRecipientAccountRead(t, async () => {
          if (change === 'sender revoked') t.db.run('DELETE FROM tokens');
          if (change === 'recipient revoked') t.db.run('DELETE FROM page_sessions');
          if (change === 'unsubscribe') await t.webSocketMessage(reader, JSON.stringify({ t: 'signal_unsubscribe', cid: 'during-read' }));
          if (change === 'expiry') t.skew += 6000;
        }, () => t.webSocketMessage(sender, JSON.stringify({ t: 'signal_send', cid: 'yielded', message: createSignalInput('preview', 'must not escape', {}, t.now()) })));
      });
      await owner.command({ t: 'signal_unsubscribe' });
      expect(owner.messages.filter(message => message.t === 'signal')).toEqual([]);
    } finally { agent.ws.close(); owner.ws.close(); }
  });
}
