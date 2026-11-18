import { env } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { Admission } from '../src/admission';
import type { Env } from '../src/env';

const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
const id = (n: number) => `aaaaaaaaa${alphabet[Math.floor(n / 1024)]}${alphabet[Math.floor(n / 32) % 32]}${alphabet[n % 32]}`;
const request = (action: string, n: number) => new Request(`https://admission.internal/${action}`, {
  method: 'POST', headers: { 'x-tendril-id': id(n) },
});
const stub = () => (env as Env).ADMISSION!.get((env as Env).ADMISSION!.idFromName(`cost-${crypto.randomUUID()}`));
afterEach(() => vi.restoreAllMocks());

it('reuses exact admission aggregates instead of rescanning the retained ledger for each creation', async () => {
  const measured = await runInDurableObject(stub(), (_instance, ctx) => {
    const now = Date.now();
    for (let n = 0; n < 1000; n++) ctx.storage.sql.exec('INSERT INTO creations(id,ts,released) VALUES(?,?,?)', id(n), now - 7_200_000, n % 2);
    const counts = { queries: 0, rowsRead: 0 };
    const exec = ctx.storage.sql.exec.bind(ctx.storage.sql);
    const sql = new Proxy(ctx.storage.sql, { get(target, key) {
      if (key !== 'exec') return Reflect.get(target, key, target);
      return (query: string, ...bindings: (string | number)[]) => {
        const cursor = exec(query, ...bindings);
        if (!query.startsWith('SELECT COUNT(*)')) return cursor;
        return new Proxy(cursor, { get(value, field) {
          if (field === 'one') return () => {
            const result = value.one(); counts.queries++; counts.rowsRead += value.rowsRead; return result;
          };
          return Reflect.get(value, field, value);
        } });
      };
    } });
    const admission = new Admission(ctx,
      { ...env, PUBLIC_CREATIONS_PER_HOUR: '1000', PUBLIC_UNCLAIMED_CAP: '1000' } as Env);
    vi.spyOn(ctx.storage.sql, 'exec').mockImplementation(sql.exec);
    expect(admission.fetch(request('reserve', 1000)).status).toBe(200);
    const cold = { ...counts };
    counts.queries = counts.rowsRead = 0;
    for (let n = 1001; n < 1021; n++) expect(admission.fetch(request('reserve', n)).status).toBe(200);
    return { cold, warm: { ...counts }, live: ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM creations WHERE released=0').one().n };
  });
  expect(measured.cold.queries).toBe(2);
  expect(measured.cold.rowsRead).toBeGreaterThanOrEqual(1000);
  expect(measured.warm).toEqual({ queries: 0, rowsRead: 0 });
  expect(measured.live).toBe(521);
  console.info('Admission aggregate SQL rows', measured);
});

it('keeps release, reopen, cancel and retries exact without writing repeated releases', async () => {
  await runInDurableObject(stub(), (_instance, ctx) => {
    let releaseWrites = 0;
    const exec = ctx.storage.sql.exec.bind(ctx.storage.sql);
    const sql = new Proxy(ctx.storage.sql, { get(target, key) {
      if (key !== 'exec') return Reflect.get(target, key, target);
      return (query: string, ...bindings: (string | number)[]) => {
        const cursor = exec(query, ...bindings);
        if (!query.startsWith('UPDATE creations SET released = 1')) return cursor;
        return new Proxy(cursor, { get(value, field) {
          if (field === 'toArray') return () => {
            const result = value.toArray(); releaseWrites += value.rowsWritten; return result;
          };
          return Reflect.get(value, field, value);
        } });
      };
    } });
    const admission = new Admission(ctx,
      { ...env, PUBLIC_CREATIONS_PER_HOUR: '3', PUBLIC_UNCLAIMED_CAP: '2' } as Env);
    vi.spyOn(ctx.storage.sql, 'exec').mockImplementation(sql.exec);
    const call = (action: string, n: number) => admission.fetch(request(action, n)).status;
    expect(call('reserve', 1)).toBe(200); expect(call('reserve', 2)).toBe(200);
    expect(call('reserve', 1)).toBe(200); expect(call('reserve', 3)).toBe(503);
    expect(call('release', 1)).toBe(200);
    const firstWrite = releaseWrites;
    expect(firstWrite).toBeGreaterThan(0);
    expect(call('release', 1)).toBe(200); expect(releaseWrites).toBe(firstWrite);
    expect(call('reopen', 1)).toBe(200); expect(call('reopen', 1)).toBe(200);
    expect(call('reserve', 3)).toBe(503);
    expect(call('release', 1)).toBe(200); expect(call('reserve', 3)).toBe(200);
    expect(call('reopen', 1)).toBe(503);
    expect(call('release', 2)).toBe(200); expect(call('reserve', 4)).toBe(503);
    expect(call('cancel', 3)).toBe(200); expect(call('cancel', 3)).toBe(200);
    expect(call('reserve', 4)).toBe(200);
    expect(ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM creations WHERE released=0').one().n).toBe(1);
  });
});

it('prunes only newly eligible timestamp ranges while catching late releases and clock reversals', async () => {
  const measured = await runInDurableObject(stub(), (_instance, ctx) => {
    const start = Date.now(), day = 86_400_000, clock = vi.spyOn(Date, 'now').mockReturnValue(start);
    for (let n = 0; n < 1000; n++) ctx.storage.sql.exec('INSERT INTO creations(id,ts,released) VALUES(?,?,0)', id(n), start - 4 * day);
    ctx.storage.sql.exec('INSERT INTO creations(id,ts,released) VALUES(?,?,1)', id(1000), start - 3 * day);
    const exec = ctx.storage.sql.exec.bind(ctx.storage.sql);
    let sweepRows = 0;
    const sql = vi.spyOn(ctx.storage.sql, 'exec').mockImplementation((query, ...bindings) => {
      const cursor = exec(query, ...bindings);
      if (query.startsWith('DELETE FROM creations WHERE released')) sweepRows += cursor.rowsRead;
      return cursor;
    });
    try {
      const admission = new Admission(ctx, { ...env, PUBLIC_CREATIONS_PER_HOUR: '1000', PUBLIC_UNCLAIMED_CAP: '2000' } as Env);
      const call = (action: string, n: number) => admission.fetch(request(action, n)).status;
      const present = (n: number) => ctx.storage.sql.exec('SELECT id FROM creations WHERE id=?', id(n)).toArray().length > 0;
      expect(call('reserve', 1001)).toBe(200); expect(present(1000)).toBe(false);
      const cold = sweepRows; sweepRows = 0;
      let baseline = 0;
      for (let n = 1002; n < 1022; n++) {
        clock.mockReturnValue(start + (n - 1001) * 1000);
        // The old predicate deletes nothing in this retained-live fixture, so
        // measuring it does not change the subsequent admission state.
        const prior = exec('DELETE FROM creations WHERE released = 1 AND ts < ?', Date.now() - 2 * day);
        baseline += prior.rowsRead;
        expect(call('reserve', n)).toBe(200);
      }
      const warm = sweepRows;
      expect(call('release', 0)).toBe(200); expect(call('reserve', 1022)).toBe(200); expect(present(0)).toBe(false);
      clock.mockReturnValue(start - 2 * day);
      expect(call('release', 1)).toBe(200); expect(call('reserve', 1023)).toBe(200); expect(present(1)).toBe(true);
      clock.mockReturnValue(start);
      expect(call('reserve', 1024)).toBe(200); expect(present(1)).toBe(false); expect(present(2)).toBe(true);
      return { cold, warm, baseline };
    } finally { sql.mockRestore(); clock.mockRestore(); }
  });
  expect(measured.cold).toBeGreaterThanOrEqual(1000);
  // SQLite counts the boundary index seek even when its range is empty.
  expect(measured.warm).toBe(20);
  expect(measured.baseline).toBeGreaterThanOrEqual(20_000);
  expect(measured.warm).toBeLessThan(measured.baseline / 100);
  console.info('Admission retention sweep SQL rows', measured);
});

it('rebuilds the rolling count at the exact hourly boundary and after the clock moves backwards', async () => {
  await runInDurableObject(stub(), (_instance, ctx) => {
    const start = Date.now(), clock = vi.spyOn(Date, 'now').mockReturnValue(start);
    try {
      const admission = new Admission(ctx, { ...env, PUBLIC_CREATIONS_PER_HOUR: '2', PUBLIC_UNCLAIMED_CAP: '10' } as Env);
      const call = (n: number) => admission.fetch(request('reserve', n)).status;
      expect(call(1)).toBe(200); expect(call(2)).toBe(200); expect(call(3)).toBe(503);
      clock.mockReturnValue(start + 3_600_000 - 1); expect(call(3)).toBe(503);
      clock.mockReturnValue(start + 3_600_000); expect(call(3)).toBe(200);
      clock.mockReturnValue(start + 3_600_000 - 1); expect(call(4)).toBe(503);
      clock.mockReturnValue(start + 3_600_000); expect(call(4)).toBe(200);
    } finally { clock.mockRestore(); }
  });
});

it('changes cached counts only after a successful durable mutation', async () => {
  await runInDurableObject(stub(), (_instance, ctx) => {
    let failInsert = true, failRelease = true;
    const exec = ctx.storage.sql.exec.bind(ctx.storage.sql);
    const sql = new Proxy(ctx.storage.sql, { get(target, key) {
      if (key !== 'exec') return Reflect.get(target, key, target);
      return (query: string, ...bindings: (string | number)[]) => {
        if (failInsert && query.startsWith('INSERT OR IGNORE')) { failInsert = false; throw new Error('injected insert failure'); }
        if (failRelease && query.startsWith('UPDATE creations SET released = 1')) { failRelease = false; throw new Error('injected release failure'); }
        return exec(query, ...bindings);
      };
    } });
    const admission = new Admission(ctx,
      { ...env, PUBLIC_CREATIONS_PER_HOUR: '2', PUBLIC_UNCLAIMED_CAP: '1' } as Env);
    vi.spyOn(ctx.storage.sql, 'exec').mockImplementation(sql.exec);
    expect(() => admission.fetch(request('reserve', 1))).toThrow('injected insert failure');
    expect(admission.fetch(request('reserve', 1)).status).toBe(200);
    expect(() => admission.fetch(request('release', 1))).toThrow('injected release failure');
    expect(admission.fetch(request('reserve', 2)).status).toBe(503);
    expect(admission.fetch(request('release', 1)).status).toBe(200);
    expect(admission.fetch(request('reserve', 2)).status).toBe(200);
    expect(admission.fetch(request('reserve', 3)).status).toBe(503);
  });
});

it('reconstructs admission authority from SQLite after actual object eviction', async () => {
  const admission = stub();
  for (let n = 0; n < 100; n++) {
    const response = await admission.fetch(request('reserve', n));
    expect(response.status).toBe(200); await response.text();
  }
  await evictDurableObject(admission);
  expect((await admission.fetch(request('reserve', 100))).status).toBe(503);
  expect((await admission.fetch(request('release', 0))).status).toBe(200);
  expect((await admission.fetch(request('reserve', 100))).status).toBe(503);
  expect((await admission.fetch(request('cancel', 1))).status).toBe(200);
  expect((await admission.fetch(request('reserve', 100))).status).toBe(200);
});
