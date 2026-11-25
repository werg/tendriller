import { expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { evictDurableObject } from 'cloudflare:test';
import type { Tendril } from '../src/tendril';
import { changeLifetime, lifetimeChangePending } from '../src/lifetime';
import { advance, api, apiJson, create, inDO, runAlarm, signInAsOwner, stub } from './helpers';
import { AD_HOC_IDLE, HOUR } from '../src/limits';

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

it('does not delete an expired ad-hoc page while its resident upgrade is unresolved', async () => {
  const page = await create({ listener: false });
  await inDO(page.id, async t => {
    const restore = interceptAccountWrite(t, async statement => {
      await statement.run();
      throw new Error('Lost resident upgrade response');
    });
    try {
      await expect(changeLifetime(t, 'resident')).rejects.toMatchObject({ code: 'lifetime_pending' });
      t.skew += AD_HOC_IDLE + 60_000;
      await t.alarm();
      expect(t.exists()).toBe(true);
      expect(lifetimeChangePending(t)).toBe(true);
      expect(await t.ctx.storage.getAlarm()).toBeGreaterThan(Date.now());
    } finally { restore(); }
  });
  await runAlarm(page.id);
  expect((await apiJson(page, 'GET', '')).lifetime).toBe('resident');
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
  let beforeCommit = await inDO(page.id, t => t.now());
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
        beforeCommit = t.now();
      }
      finally { restore(); }
    });
    // An automatic cleanup alarm can already own the first recovery attempt.
    // Drive its persisted retry instead of treating an absent manual alarm as
    // evidence that the interrupted lifetime change has finished.
    await vi.waitFor(async () => {
      await runAlarm(page.id);
      expect(await inDO(page.id, t => lifetimeChangePending(t))).toBe(false);
    }, { timeout: 5000, interval: 25 });
  } else await apiJson(page, 'PATCH', '', { lifetime: 'ad_hoc' });
  await inDO(page.id, t => {
    expect(t.exists()).toBe(true);
    expect(t.db.get('lifetime', '')).toBe('ad_hoc');
    const last = t.db.get<number>('last_access', 0);
    expect(last).toBeGreaterThanOrEqual(beforeCommit);
    expect(t.expiresAt()).toBe(last + AD_HOC_IDLE);
    expect(lifetimeChangePending(t)).toBe(false);
  });
});

it('skips unused inactivity state when a released resident page becomes ad-hoc', async () => {
  const page = await resident();
  await apiJson(page, 'POST', 'release', {});
  const previous = await inDO(page.id, t => ({ last: t.db.get('last_access', 0), expires: t.expiresAt() }));
  await advance(page.id, HOUR);
  await apiJson(page, 'PATCH', '', { lifetime: 'ad_hoc' });
  await inDO(page.id, t => {
    expect(t.db.get('owner_account', null)).toBeNull();
    expect(t.db.get('lifetime', '')).toBe('ad_hoc');
    expect(t.db.get('last_access', 0)).toBe(previous.last);
    expect(t.expiresAt()).toBe(previous.expires);
  });
});

it('retains a late first claim for a full idle window without a subsequent page load', async () => {
  const email = `late-claim-${crypto.randomUUID()}@example.test`, account = crypto.randomUUID();
  const page = await create({ claim: false, listener: false, owner: email });
  const originalExpiry = await inDO(page.id, t => t.expiresAt()!);
  await env.ACCOUNTS.prepare('INSERT INTO accounts(id,created_at,email) VALUES(?,?,?)').bind(account, Date.now(), email).run();
  await advance(page.id, 20 * HOUR);
  expect((await apiJson(page, 'GET', '')).expires_at).toBe(originalExpiry);
  await advance(page.id, 3 * HOUR);
  const beforeClaim = await inDO(page.id, t => t.now());
  // Redeem the sign-in code, but deliberately never request the page itself.
  // An interrupted redirect must not leave its new owner with the old expiry.
  await signInAsOwner(page, account, email);
  const saved = await inDO(page.id, t => {
    const last = t.db.get('last_access', 0), expires = t.expiresAt();
    expect(t.db.get('owner_account', '')).toBe(account);
    expect(last).toBeGreaterThanOrEqual(beforeClaim);
    expect(expires).toBe(last + AD_HOC_IDLE);
    expect(expires!).toBeGreaterThanOrEqual(beforeClaim + AD_HOC_IDLE);
    return { last, expires, skew: t.skew };
  });
  await evictDurableObject(stub(page.id));
  await inDO(page.id, t => {
    t.skew = saved.skew;
    expect(t.db.get('last_access', 0)).toBe(saved.last);
    expect(t.expiresAt()).toBe(saved.expires);
  });
  await advance(page.id, 2 * HOUR);
  expect(await runAlarm(page.id)).toBe(true);
  await inDO(page.id, t => {
    expect(t.now()).toBeGreaterThan(originalExpiry);
    expect(t.exists()).toBe(true);
    expect(t.db.get('owner_account', '')).toBe(account);
    expect(t.db.get('last_access', 0)).toBe(saved.last);
    expect(t.expiresAt()).toBe(saved.expires);
  });
});
