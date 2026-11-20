import { expect, it } from 'vitest';
import { api, create, inDO, req } from './helpers';
import { notifySetupChanged } from '../src/setup-watch';
import { SETUP_WATCH_PROTOCOL } from '../../contract/setup.mjs';
const headers = { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': SETUP_WATCH_PROTOCOL };
const next = (socket: WebSocket) => new Promise<any>(resolve => socket.addEventListener('message', e => resolve(JSON.parse(e.data as string)), { once: true }));

it('retains a receive-only setup subscription through hibernation without an idle timer or queued payloads', async () => {
  const h = await create({ listener: false });
  const before = await inDO(h.id, async t => ({ alarm: await t.ctx.storage.getAlarm(), rows: t.db.one('SELECT COUNT(*) AS n FROM sqlite_schema') }));
  const response = await api(h, 'GET', 'setup/watch', undefined, headers); expect(response.status).toBe(101);
  const socket = response.webSocket!; const ready = next(socket); socket.accept();
  expect(await ready).toEqual({ type: 'setup', version: 1, assistant: { proposalId: null, approved: false, revision: null } });
  expect(await inDO(h.id, async t => ({ alarm: await t.ctx.storage.getAlarm(), rows: t.db.one('SELECT COUNT(*) AS n FROM sqlite_schema') }))).toEqual(before);
  const changed = next(socket);
  await inDO(h.id, t => {
    t.transaction(() => { t.db.set('assistant_proposal', { id: 'a'.repeat(64) }); notifySetupChanged(t); });
  });
  expect((await changed).assistant).toEqual({ proposalId: 'a'.repeat(64), approved: false, revision: null });
  const closed = new Promise<number>(resolve => socket.addEventListener('close', e => resolve(e.code)));
  socket.send('{}'); expect(await closed).toBe(1008);
});

it('requires scoped native authentication, keeps private tokens out of URLs, and bounds listener count', async () => {
  const h = await create({ listener: false });
  expect((await req(h.api + '/setup/watch', { headers, anonymous: true })).status).toBe(401);
  const response = await req(h.api + '/setup/watch', { anonymous: true,
    headers: { ...headers, 'Sec-WebSocket-Protocol': `${SETUP_WATCH_PROTOCOL}, ${h.token}` } });
  expect(response.status).toBe(101); const a = response.webSocket!; a.accept();
  const second = await api(h, 'GET', 'setup/watch', undefined, headers); expect(second.status).toBe(101); second.webSocket!.accept();
  expect((await api(h, 'GET', 'setup/watch', undefined, headers)).status).toBe(429);
  a.close(); second.webSocket!.close();
});

it('publishes no notification for rolled-back writes and fences revoked credentials on the next change', async () => {
  const h = await create({ listener: false });
  const response = await api(h, 'GET', 'setup/watch', undefined, headers), socket = response.webSocket!;
  const ready = next(socket); socket.accept(); await ready;
  await inDO(h.id, t => {
    try { t.transaction(() => { t.db.set('assistant_proposal', { id: 'b'.repeat(64) }); notifySetupChanged(t); throw Error('rollback'); }); } catch {}
    expect(t.db.get('assistant_proposal', null)).toBe(null);
  });
  const closed = new Promise<number>(resolve => socket.addEventListener('close', e => resolve(e.code)));
  await inDO(h.id, t => { t.db.run('DELETE FROM tokens'); notifySetupChanged(t); });
  expect(await closed).toBe(4003);
});
