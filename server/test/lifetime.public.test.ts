import { expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import type { Tendril } from '../src/tendril';
import { authenticateAgentToken } from '../src/access';
import { changeLifetime, lifetimeChangePending } from '../src/lifetime';
import { advance, api, apiJson, create, inDO, runAlarm } from './helpers';
import { AD_HOC_IDLE } from '../src/limits';

async function resident() {
  const page = await create({ listener: false, application: { id: '45'.repeat(32) } });
  await apiJson(page, 'PATCH', '', { lifetime: 'resident' });
  return page;
}
function interceptAccountWrite(t: Tendril, run: (statement: D1PreparedStatement) => Promise<D1Result>): () => void {
  const original = t.env.ACCOUNTS;
  t.env.ACCOUNTS = { prepare(sql: string) {
    const statement = original.prepare(sql);
    if (!sql.startsWith('UPDATE tendrils SET lifetime')) return statement;
    return { bind(...args: unknown[]) { const bound = statement.bind(...args); return { run: () => run(bound) }; } };
  } } as D1Database;
  return () => { t.env.ACCOUNTS = original; };
}

it('recovers a failed or lost account update response through an alarm or a request after real restart', async () => {
  for (const afterCommit of [false, true]) {
    const page = await resident();
    await inDO(page.id, async t => {
      const restore = interceptAccountWrite(t, async statement => {
        if (afterCommit) await statement.run();
        throw new Error(afterCommit ? 'Response lost after account commit' : 'Account storage unavailable');
      });
      try { await expect(changeLifetime(t, 'ad_hoc')).rejects.toMatchObject({ status: 503, code: 'lifetime_pending' }); }
      finally { restore(); }
      expect(lifetimeChangePending(t)).toBe(true);
      expect(t.db.get('lifetime', '')).toBe('resident');
    });
    expect(await env.ACCOUNTS.prepare('SELECT lifetime FROM tendrils WHERE id=?').bind(page.id).first('lifetime')).toBe(afterCommit ? 'ad_hoc' : 'resident');
    if (afterCommit) {
      await inDO(page.id, t => { t.ctx.abort('Interrupted lifetime transition test'); }).catch(() => {});
      expect((await apiJson(page, 'GET', '')).lifetime).toBe('ad_hoc');
    } else await runAlarm(page.id);
    await inDO(page.id, t => {
      expect(lifetimeChangePending(t)).toBe(false);
      expect(t.db.get('lifetime', '')).toBe('ad_hoc');
    });
    expect(await env.ACCOUNTS.prepare('SELECT lifetime FROM tendrils WHERE id=?').bind(page.id).first('lifetime')).toBe('ad_hoc');
  }
});

it('releases a definitively rejected resident quota reservation so a later reviewed retry can succeed', async () => {
  const page = await create({ listener: false });
  await inDO(page.id, async t => {
    const restore = interceptAccountWrite(t, async () => { throw new Error('account_residents_full'); });
    try { await expect(changeLifetime(t, 'resident')).rejects.toMatchObject({ status: 429, code: 'quota' }); }
    finally { restore(); }
    expect(lifetimeChangePending(t)).toBe(false);
    expect(t.db.get('lifetime', '')).toBe('ad_hoc');
    await changeLifetime(t, 'resident');
    expect(t.db.get('lifetime', '')).toBe('resident');
    expect(lifetimeChangePending(t)).toBe(false);
  });
});

it('continues alarm work and schedules bounded retries while account recovery stays unavailable', async () => {
  const page = await resident();
  await inDO(page.id, async t => {
    const restore = interceptAccountWrite(t, async () => { throw new Error('Account storage unavailable'); });
    const originalCleanup = t.cleanup.bind(t);
    let cleanups = 0;
    t.cleanup = async () => { cleanups++; t.db.set('next_cleanup', t.now() + 86_400_000); };
    try {
      await expect(changeLifetime(t, 'ad_hoc')).rejects.toMatchObject({ code: 'lifetime_pending' });
      t.db.set('next_cleanup', 0);
      await t.alarm();
      expect(cleanups).toBe(1);
      expect(lifetimeChangePending(t)).toBe(true);
      const alarm = await t.ctx.storage.getAlarm();
      expect(alarm).not.toBeNull();
      expect(alarm!).toBeGreaterThan(Date.now());
      expect(alarm!).toBeLessThanOrEqual(Date.now() + 5000);
    } finally { t.cleanup = originalCleanup; restore(); }
  });
  await runAlarm(page.id);
  expect(await inDO(page.id, t => lifetimeChangePending(t))).toBe(false);
});

it.each([false, true])('starts a full inactivity window when an old resident page becomes ad-hoc (recovery=%s)', async interrupted => {
  const page = await resident();
  await advance(page.id, 2 * AD_HOC_IDLE);
  if (interrupted) {
    await inDO(page.id, async t => {
      const restore = interceptAccountWrite(t, async statement => {
        await statement.run();
        throw new Error('Lost downgrade response');
      });
      try {
        await expect(changeLifetime(t, 'ad_hoc')).rejects.toMatchObject({ code: 'lifetime_pending' });
        // Advance before restoring account access: an already-due cleanup alarm
        // may otherwise complete the recovery before a separate advance() call.
        t.skew += 60_000;
      }
      finally { restore(); }
    });
    await runAlarm(page.id);
  } else await apiJson(page, 'PATCH', '', { lifetime: 'ad_hoc' });
  await inDO(page.id, t => {
    expect(t.exists()).toBe(true);
    expect(t.db.get('lifetime', '')).toBe('ad_hoc');
    expect(t.expiresAt()!).toBeGreaterThan(t.now() + AD_HOC_IDLE - 2_000);
    expect(lifetimeChangePending(t)).toBe(false);
  });
});
