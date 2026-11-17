import { expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import type { Tendril } from '../src/tendril';
import { authenticateAgentToken } from '../src/access';
import { changeLifetime, lifetimeChangePending } from '../src/lifetime';
import { handleMembership } from '../src/membership';
import { getRecordLog, provisionRecordLog } from '../src/records';
import { api, apiJson, create, inDO, runAlarm } from './helpers';

const bytes = (value: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(value))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const configuration = {
  executionManifestDigest: bytes(1), schemaAdministratorPublicKey: bytes(2),
  nativeAuthority: { url: 'https://authority.example.test/_chronolog/membership', historyId: 'h_' + 'a'.repeat(32), publicKey: bytes(3) },
};
async function resident() {
  const page = await create({ listener: false, application: { kind: 'peer', id: 'lifetime' } });
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

it('a pending downgrade prevents both new resident resources before the account update completes', async () => {
  const page = await resident();
  await inDO(page.id, async t => {
    const principal = await authenticateAgentToken(t, page.token);
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const restore = interceptAccountWrite(t, async statement => { entered(); await gate; return statement.run(); });
    const changing = changeLifetime(t, 'ad_hoc');
    try {
      await started;
      expect(t.db.get('lifetime', '')).toBe('resident');
      await expect(provisionRecordLog(t)).rejects.toMatchObject({ status: 409, code: 'resident_required' });
      const url = new URL('https://page.example/_tendril/members');
      const req = new Request(url, { method: 'PUT', body: JSON.stringify(configuration) });
      await expect(handleMembership(t, req, url, 'members', principal)).rejects.toMatchObject({ status: 409, code: 'resident_required' });
      expect(t.db.one('SELECT id FROM record_log WHERE id=1')).toBeNull();
      expect(t.db.get('membership_configuration', null)).toBeNull();
    } finally { release(); await changing; restore(); }
    expect(t.db.get('lifetime', '')).toBe('ad_hoc');
    expect(lifetimeChangePending(t)).toBe(false);
  });
  expect(await env.ACCOUNTS.prepare('SELECT lifetime FROM tendrils WHERE id=?').bind(page.id).first('lifetime')).toBe('ad_hoc');
});

it('record provisioning rechecks a downgrade begun while its genesis hash was being prepared', async () => {
  const page = await resident();
  await inDO(page.id, async t => {
    const provisioning = provisionRecordLog(t);
    const changing = changeLifetime(t, 'ad_hoc');
    await expect(provisioning).rejects.toMatchObject({ status: 409, code: 'resident_required' });
    await changing;
    expect(t.db.one('SELECT id FROM record_log WHERE id=1')).toBeNull();
    expect(t.db.get('lifetime', '')).toBe('ad_hoc');
  });
});

it('an already committed record log or membership administrator prevents a downgrade before account I/O', async () => {
  for (const resource of ['records', 'members']) {
    const page = await resident();
    await apiJson(page, resource === 'records' ? 'POST' : 'PUT', resource, resource === 'records' ? {} : configuration);
    const response = await api(page, 'PATCH', '', { lifetime: 'ad_hoc' });
    expect(response.status).toBe(409);
    expect(await env.ACCOUNTS.prepare('SELECT lifetime FROM tendrils WHERE id=?').bind(page.id).first('lifetime')).toBe('resident');
    await inDO(page.id, t => {
      expect(lifetimeChangePending(t)).toBe(false);
      expect(t.db.get('lifetime', '')).toBe('resident');
      if (resource === 'records') expect(getRecordLog(t).head.position).toBe(0);
    });
  }
});

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
      await expect(provisionRecordLog(t)).rejects.toMatchObject({ code: 'resident_required' });
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
