import { expect, it } from 'vitest';
import { evictDurableObject } from 'cloudflare:test';
import { advance, agentPrincipal, apiJson, create, inDO, stub } from './helpers';
import { ACCESS_WRITE_INTERVAL, DAY, HOUR } from '../src/limits';

it('avoids per-request expiry writes for resident and unclaimed pages while retaining ad-hoc expiry', async () => {
  for (const mode of ['resident', 'unclaimed', 'ad_hoc'] as const) {
    const page = await create({ claim: mode !== 'unclaimed', listener: false });
    if (mode === 'resident') await apiJson(page, 'PATCH', '', { lifetime: 'resident' });
    const result = await inDO(page.id, async t => {
      const original = t.db.run.bind(t.db);
      let accessWrites = 0;
      t.db.run = (query, ...values) => {
        if (values[0] === 'last_access') accessWrites++;
        original(query, ...values);
      };
      const initialExpiry = t.expiresAt();
      try {
        for (let i = 0; i < 20; i++) {
          t.skew += 1_000;
          const response = await t.fetch(new Request('https://tendril.internal/agent', {
            headers: { 'x-tendril-agent': page.agent.id, 'x-tendril-agent-scopes': agentPrincipal(t, page).scopes.join(' '), 'x-tendril-rest': '' },
          }));
          expect(response.status).toBe(200);
        }
        return { accessWrites, initialExpiry, expiry: t.expiresAt(), now: t.now() };
      } finally { t.db.run = original; }
    });
    expect(result.accessWrites).toBeLessThanOrEqual(mode === 'ad_hoc' ? 1 : 0);
    if (mode === 'resident') expect(result.expiry).toBeNull();
    else if (mode === 'unclaimed') expect(result.expiry).toBe(result.initialExpiry);
    else {
      expect(result.expiry).toBeGreaterThanOrEqual(result.initialExpiry!);
      expect(result.expiry!).toBeGreaterThan(result.now + DAY - 2_000);
      expect(result.expiry!).toBeLessThanOrEqual(result.now + DAY + ACCESS_WRITE_INTERVAL);
    }
  }
});

it('keeps the full inactivity window after bucketed activity and actual eviction', async () => {
  const page = await create({ listener: false });
  await advance(page.id, ACCESS_WRITE_INTERVAL + 1000);
  await apiJson(page, 'GET', '');
  const saved = await inDO(page.id, t => ({ now: t.now(), expires: t.expiresAt()!, skew: t.skew }));
  expect(saved.expires).toBeGreaterThanOrEqual(saved.now + DAY - 1000);
  expect(saved.expires).toBeLessThanOrEqual(saved.now + DAY + ACCESS_WRITE_INTERVAL);
  await evictDurableObject(stub(page.id));
  await inDO(page.id, t => {
    t.skew = saved.skew;
    expect(t.expiresAt()).toBe(saved.expires);
  });
  await advance(page.id, ACCESS_WRITE_INTERVAL + 1000);
  await apiJson(page, 'GET', '');
  expect(await inDO(page.id, t => t.expiresAt())).toBeGreaterThan(saved.expires);
});

it('does not spend activity writes or extend retention for unknown or ungranted agents', async () => {
  const page = await create({ listener: false });
  await advance(page.id, 2 * ACCESS_WRITE_INTERVAL);
  await inDO(page.id, async t => {
    const before = t.db.get('last_access', 0), expires = t.expiresAt();
    for (const [agent, status] of [['', 401], ['invalid-agent', 401], ['ag_' + 'z'.repeat(26), 404]] as const) {
      const response = await t.fetch(new Request('https://tendril.internal/agent', {
        headers: { 'x-tendril-agent': agent, 'x-tendril-agent-scopes': 'host:read', 'x-tendril-rest': '' },
      }));
      expect(response.status).toBe(status);
    }
    expect(t.db.get('last_access', 0)).toBe(before);
    expect(t.expiresAt()).toBe(expires);
  });
});

it('deletes an expired page without first pruning and reconciling its doomed records', async () => {
  const page = await create({ claim: false, listener: false });
  await advance(page.id, DAY + 1);
  await inDO(page.id, async t => {
    let cleanups = 0;
    const original = t.cleanup;
    t.cleanup = async () => { cleanups++; };
    try { await t.alarm(); }
    finally { t.cleanup = original; }
    expect(cleanups).toBe(0);
    expect(t.exists()).toBe(false);
  });
});

it('invalidates cached link and storage totals on mutation and rollback', async () => {
  const page = await create({ listener: false });
  await inDO(page.id, async t => {
    const initial = t.storageUsed(), main = t.mainPageUrl();
    const hash = '23'.repeat(32);
    expect(() => t.transaction(() => {
      t.db.run("INSERT INTO stored_files(hash,size,created_at,status) VALUES(?,7,?,'ready')", hash, t.now());
      t.db.run("UPDATE links SET key = 'temporary-main-key' WHERE id = 'l_main'");
      expect(t.storageUsed()).toBe(initial + 7);
      expect(t.mainPageUrl()).not.toBe(main);
      throw new Error('roll back cached observations');
    })).toThrow('roll back cached observations');
    expect(t.storageUsed()).toBe(initial);
    expect(t.mainPageUrl()).toBe(main);
    const link = await t.createLink('guest', 'short', 1, true);
    expect(await t.linkForKey(link.key)).toMatchObject({ id: link.id });
    t.skew += 2000;
    expect(await t.linkForKey(link.key)).toBeNull();
    t.db.run('DELETE FROM links WHERE id=?', link.id);
    expect(await t.linkForKey(link.key)).toBeNull();
  });
});

it('scans retained publication references once when looking for orphan content', async () => {
  const page = await create({ listener: false });
  const measured = await inDO(page.id, async t => {
    const count = 1_024, old = t.now() - 2 * HOUR;
    t.transaction(() => {
      for (let index = 0; index < count; index++) {
        const hash = index.toString(16).padStart(64, '0');
        t.db.run("INSERT INTO stored_files(hash,size,created_at,risk_score,status) VALUES(?,1,?,0,'ready')", hash, old);
        t.db.run('INSERT INTO version_files(version,path,hash,type,size) VALUES(?,?,?,?,1)',
          1 + Math.floor(index / 64), `file-${index % 64}.txt`, hash, 'text/plain');
      }
    });
    const before = t.ctx.storage.sql.exec(`SELECT s.hash FROM stored_files s
      WHERE s.created_at < ? AND NOT EXISTS (SELECT 1 FROM version_files v WHERE v.hash=s.hash)`, t.now() - HOUR);
    expect(before.toArray()).toEqual([]);
    const baselineRows = before.rowsRead;
    const original = t.db.all.bind(t.db);
    let rowsRead = 0;
    t.db.all = ((query: string, ...values: (string | number | null | ArrayBuffer)[]) => {
      if (!query.startsWith('SELECT s.hash FROM stored_files s')) return original(query, ...values);
      const cursor = t.ctx.storage.sql.exec(query, ...values), rows = cursor.toArray();
      rowsRead += cursor.rowsRead;
      return rows;
    }) as typeof t.db.all;
    try { await t.pruneOrphanFiles(t.now()); }
    finally { t.db.all = original; }
    expect(t.db.one<{ n: number }>('SELECT COUNT(*) AS n FROM stored_files')!.n).toBe(count);
    return { count, baselineRows, rowsRead };
  });
  expect(measured.rowsRead).toBeLessThanOrEqual(measured.count * 3);
  expect(measured.rowsRead).toBeLessThan(measured.baselineRows / 100);
  console.info('Publication cleanup SQL rows', measured);
});
