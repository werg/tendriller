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
  expect(await ready).toEqual({ type: 'setup', version: 1, mcp: { connected: false, grants: [], updatedAt: 0 } });
  expect(await inDO(h.id, async t => ({ alarm: await t.ctx.storage.getAlarm(), rows: t.db.one('SELECT COUNT(*) AS n FROM sqlite_schema') }))).toEqual(before);
  const changed = next(socket);
  await inDO(h.id, t => {
    const now = t.now();
    t.transaction(() => {
      t.db.run(
        'INSERT INTO mcp_connections(grant_id,handle,bio,public_key,wrapped_keys,label,capabilities,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
        'grant-1', 'chatgpt', '', 'a'.repeat(64), new Uint8Array([1]).buffer, 'Notes', '{}', now, now,
      );
      notifySetupChanged(t);
    });
  });
  expect((await changed).mcp).toMatchObject({ connected: true, grants: ['grant-1'] });
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
    const now = t.now();
    try {
      t.transaction(() => {
        t.db.run(
          'INSERT INTO mcp_connections(grant_id,handle,bio,public_key,wrapped_keys,label,capabilities,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
          'grant-rb', 'chatgpt', '', 'b'.repeat(64), new Uint8Array([1]).buffer, 'Notes', '{}', now, now,
        );
        notifySetupChanged(t);
        throw Error('rollback');
      });
    } catch {}
    expect(t.db.all('SELECT grant_id FROM mcp_connections')).toEqual([]);
  });
  const closed = new Promise<number>(resolve => socket.addEventListener('close', e => resolve(e.code)));
  await inDO(h.id, t => { t.db.run('DELETE FROM agent_grants'); notifySetupChanged(t); });
  expect(await closed).toBe(4003);
});
