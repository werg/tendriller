import { expect, it } from 'vitest';
import { PEER_RELAY_PROTOCOL } from '../../contract/relay.mjs';
import { advance, api, create, inDO } from './helpers';
import { DAY } from '../src/limits';

it('leaves failed maintenance to the alarm retry and reconciles pending deadlines after recovery', async () => {
  const page = await create({ listener: false });
  const query = new URLSearchParams({ channel: 'alarm-recovery', peerId: 'ab'.repeat(32), remotePeerId: 'cd'.repeat(32), lane: 'reliable' });
  const response = await api(page, 'GET', `peers/relay?${query}`, undefined,
    { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': PEER_RELAY_PROTOCOL });
  expect(response.status).toBe(101);
  const socket = response.webSocket!; socket.accept();
  try {
    await inDO(page.id, async t => {
      const due = t.now() - 1000;
      t.db.set('next_cleanup', due);
      // Direct handler invocation below simulates the runtime consuming its alarm.
      await t.ctx.storage.deleteAlarm();
      const writes: number[] = [];
      const setAlarm = t.ctx.storage.setAlarm.bind(t.ctx.storage), reconcile = t.reconcileStorage;
      t.ctx.storage.setAlarm = async (at, options) => { writes.push(Number(at)); await setAlarm(at, options); };
      t.reconcileStorage = async () => {
        // Requests may schedule work while maintenance has yielded. The handler
        // must release suppression after failure and reconcile it on recovery.
        await Promise.resolve();
        t.scheduleAlarm();
        throw new Error('Injected reconciliation outage');
      };
      try {
        await expect(t.alarm()).rejects.toThrow('Injected reconciliation outage');
        expect(t.db.get('next_cleanup', 0)).toBe(due);
        expect(writes).toEqual([]);
        expect(await t.ctx.storage.getAlarm()).toBeNull();
        t.reconcileStorage = reconcile;
        await t.alarm();
        expect(t.db.get('next_cleanup', 0)).toBeGreaterThan(t.now());
        const pending = t.ctx.getWebSockets('peer-relay')[0].deserializeAttachment().expiresAt - t.skew;
        expect(writes).toEqual([pending]);
        expect(await t.ctx.storage.getAlarm()).toBe(pending);
      } finally { t.ctx.storage.setAlarm = setAlarm; t.reconcileStorage = reconcile; }
    });
  } finally { socket.close(); }
});

it.each(['account deletion', 'admission release'] as const)('does not suppress alarm retry if %s fails during destruction', async failure => {
  const page = await create({ listener: false, claim: false });
  await advance(page.id, DAY + 1);
  await inDO(page.id, async t => {
    await t.ctx.storage.deleteAlarm();
    const accounts = t.env.ACCOUNTS, admission = t.env.ADMISSION;
    const setAlarm = t.ctx.storage.setAlarm.bind(t.ctx.storage), deleteAlarm = t.ctx.storage.deleteAlarm.bind(t.ctx.storage);
    let writes = 0, deletes = 0;
    t.ctx.storage.setAlarm = async (at, options) => { writes++; await setAlarm(at, options); };
    t.ctx.storage.deleteAlarm = async options => { deletes++; await deleteAlarm(options); };
    if (failure === 'account deletion') t.env.ACCOUNTS = {
      prepare(query: string) {
        if (query === 'DELETE FROM tendrils WHERE id = ?') throw new Error('Injected account deletion outage');
        return accounts.prepare(query);
      },
    } as D1Database;
    else t.env.ADMISSION = new Proxy(admission, { get(target, key) {
      if (key === 'get') return () => ({ fetch: async () => { throw new Error('Injected admission release outage'); } });
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    try {
      await expect(t.alarm()).rejects.toThrow(`Injected ${failure} outage`);
      expect(writes).toBe(0); expect(deletes).toBe(0);
      expect(t.exists()).toBe(true);
      t.env.ACCOUNTS = accounts; t.env.ADMISSION = admission;
      await t.alarm();
      expect(t.exists()).toBe(false);
      expect(writes).toBe(0); expect(deletes).toBe(1);
      expect(await t.ctx.storage.getAlarm()).toBeNull();
    } finally {
      t.env.ACCOUNTS = accounts; t.env.ADMISSION = admission;
      t.ctx.storage.setAlarm = setAlarm; t.ctx.storage.deleteAlarm = deleteAlarm;
    }
  });
});

it('observes retained alarm state after final deadline persistence fails', async () => {
  const page = await create({ listener: false });
  await inDO(page.id, async t => {
    // A pending retry exposes the original alarm timestamp. Retain the real
    // stored timestamp here while directly invoking the failed handler.
    const retained = await t.ctx.storage.getAlarm();
    expect(retained).not.toBeNull();
    t.db.set('next_cleanup', t.now() + 2 * DAY);
    const setAlarm = t.ctx.storage.setAlarm.bind(t.ctx.storage), getAlarm = t.ctx.storage.getAlarm.bind(t.ctx.storage);
    const waitUntil = t.ctx.waitUntil.bind(t.ctx), pending: Promise<unknown>[] = [];
    let writes = 0, reads = 0;
    t.ctx.storage.setAlarm = async (at, options) => {
      writes++;
      if (writes === 1) throw new Error('Injected alarm write outage');
      await setAlarm(at, options);
    };
    t.ctx.storage.getAlarm = async options => { reads++; return getAlarm(options); };
    t.ctx.waitUntil = work => { pending.push(work); waitUntil(work); };
    try {
      await expect(t.alarm()).rejects.toThrow('Injected alarm write outage');
      t.scheduleAlarm();
      await Promise.all(pending);
      expect(reads).toBe(1);
      expect(writes).toBe(1);
      expect(await getAlarm()).toBe(retained);
      await t.alarm();
      expect(writes).toBe(2);
      expect(await getAlarm()).toBe(t.expiresAt()! - t.skew);
    } finally {
      t.ctx.storage.setAlarm = setAlarm; t.ctx.storage.getAlarm = getAlarm; t.ctx.waitUntil = waitUntil;
    }
  });
});
