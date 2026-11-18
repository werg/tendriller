import { expect, it } from 'vitest';
import { apiJson, create, inDO } from './helpers';
import { DAY, HOUR } from '../src/limits';

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
            headers: { Authorization: `Bearer ${page.token}`, 'x-tendril-rest': '' },
          }));
          expect(response.status).toBe(200);
        }
        return { accessWrites, initialExpiry, expiry: t.expiresAt(), now: t.now() };
      } finally { t.db.run = original; }
    });
    expect(result.accessWrites).toBe(mode === 'ad_hoc' ? 20 : 0);
    if (mode === 'resident') expect(result.expiry).toBeNull();
    else if (mode === 'unclaimed') expect(result.expiry).toBe(result.initialExpiry);
    else {
      expect(result.expiry).toBeGreaterThan(result.initialExpiry!);
      expect(result.expiry!).toBeGreaterThan(result.now + DAY - 2_000);
    }
  }
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
