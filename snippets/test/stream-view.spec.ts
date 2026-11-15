import { test, expect } from '@playwright/test';
import { load } from './helpers';

test('stream checkpoints restore the materialized view and cursor together after reload', async ({ page }) => {
  await load(page, 'stream-view');
  await page.evaluate(() => {
    const checkpoint = (window as any).tendrilSnippets.streamView.checkpoint('measurements', { pageId: 'page-a', key: 'chart-v1' });
    checkpoint.save({ cursor: 2, state: { records: [{ seq: 1, value: 3 }, { seq: 2, value: 4 }], historyIncomplete: true } });
  });
  await page.reload();
  await page.addScriptTag({ url: '/stream-view.js' });
  const restored = await page.evaluate(() => {
    const checkpoint = (window as any).tendrilSnippets.streamView.checkpoint('measurements', { pageId: 'page-a', key: 'chart-v1' });
    const saved = checkpoint.load();
    document.querySelector('#app')!.textContent = saved.state.records.map((record: any) => record.value).join(', ');
    // The caller restores its view before choosing a subscription cursor.
    return { after: saved.cursor, records: saved.state.records, historyIncomplete: saved.state.historyIncomplete };
  });
  expect(restored).toEqual({ after: 2, records: [{ seq: 1, value: 3 }, { seq: 2, value: 4 }], historyIncomplete: true });
  await expect(page.locator('#app')).toHaveText('3, 4');
});

test('stream checkpoints isolate pages, streams and application schema versions', async ({ page }) => {
  await load(page, 'stream-view');
  const result = await page.evaluate(() => {
    const helper = (window as any).tendrilSnippets.streamView;
    (window as any).__TENDRIL__ = { id: 'page-a' };
    const a = helper.checkpoint('measurements', { key: 'chart-v1' });
    a.save({ cursor: 10, state: { count: 4 } });
    const other = [
      helper.checkpoint('measurements', { key: 'chart-v1', pageId: 'page-b' }).load(),
      helper.checkpoint('another', { key: 'chart-v1' }).load(),
      helper.checkpoint('measurements', { key: 'chart-v2' }).load(),
    ];
    const first = a.load(); first.state.count = 99;
    const original = a.load(); a.clear();
    return { other, original, cleared: a.load() };
  });
  expect(result).toEqual({ other: [null, null, null], original: { cursor: 10, state: { count: 4 } }, cleared: null });
});

test('corrupt checkpoints and invalid scope fail visibly without silently resetting the cursor', async ({ page }) => {
  await load(page, 'stream-view');
  const failures = await page.evaluate(() => {
    const checkpoint = (window as any).tendrilSnippets.streamView.checkpoint('measurements', { pageId: 'page-a', key: 'chart-v1' });
    checkpoint.save({ cursor: 4, state: { rows: [] } });
    const key = Object.keys(localStorage).find(key => key.startsWith('tendril:stream-view:'))!;
    const good = localStorage.getItem(key)!;
    const outcomes = [];
    for (const raw of ['{bad json', JSON.stringify({ ...JSON.parse(good), stream: 'other' }), JSON.stringify({ ...JSON.parse(good), cursor: -1 }),
      JSON.stringify({ ...JSON.parse(good), version: 2 }), JSON.stringify({ ...JSON.parse(good), state: undefined })]) {
      localStorage.setItem(key, raw);
      try { checkpoint.load(); outcomes.push('accepted'); } catch (error: any) { outcomes.push(error.code); }
      if (localStorage.getItem(key) !== raw) throw new Error('load must not rewrite the saved checkpoint');
    }
    return outcomes;
  });
  expect(failures).toEqual(Array(5).fill('invalid_checkpoint'));
});

test('invalid state, oversized entries and quota failures preserve the old cursor and state', async ({ page }) => {
  await load(page, 'stream-view');
  const result = await page.evaluate(() => {
    const helper = (window as any).tendrilSnippets.streamView;
    const options = { pageId: 'page-a', key: 'chart-v1', maxBytes: 256 };
    const checkpoint = helper.checkpoint('measurements', options);
    const original = { cursor: 2, state: { rows: [3, 4] } }; checkpoint.save(original);
    const cycle: any = {}; cycle.self = cycle;
    const failures = [];
    const hiddenJSON = Object.defineProperty({ rows: [5, 6] }, 'toJSON', { value: () => ({ rows: [] }) });
    for (const state of [undefined, NaN, { skipped: undefined }, new Map(), cycle, [, 1], { get value() { return 1; } }, hiddenJSON]) {
      try { checkpoint.save({ cursor: 3, state }); failures.push('accepted'); } catch (error: any) { failures.push(error.code); }
    }
    try { checkpoint.save({ cursor: 3 }); } catch (error: any) { failures.push(error.code); }
    try { checkpoint.save({ cursor: 3, state: 'x'.repeat(300) }); } catch (error: any) { failures.push(error.code); }
    const failing = helper.checkpoint('measurements', { ...options, storage: {
      getItem: (key: string) => localStorage.getItem(key),
      setItem() { throw new DOMException('Quota exceeded', 'QuotaExceededError'); },
    } });
    try { failing.save({ cursor: 3, state: { rows: [4, 5] } }); } catch (error: any) { failures.push(error.code); }
    return { failures, saved: checkpoint.load() };
  });
  expect(result.failures).toEqual([...Array(9).fill('invalid_checkpoint'), 'checkpoint_too_large', 'storage_unavailable']);
  expect(result.saved).toEqual({ cursor: 2, state: { rows: [3, 4] } });
});

test('render batching retains every model update and supports flush and cancellation', async ({ page }) => {
  await load(page, 'stream-view');
  const beforeFrame = await page.evaluate(() => {
    const w = window as any;
    w.model = []; w.renders = [];
    w.paint = w.tendrilSnippets.streamView.batch(() => w.renders.push(w.model.length));
    for (let i = 0; i < 500; i++) { w.model.push(i); w.paint.schedule(); }
    return w.renders;
  });
  expect(beforeFrame).toEqual([]);
  await expect.poll(() => page.evaluate(() => (window as any).renders)).toEqual([500]);
  await page.evaluate(() => {
    const w = window as any;
    w.model.push(500); w.paint.schedule(); w.paint.flush(); w.paint.flush();
    w.model.push(501); w.paint.schedule(); w.paint.cancel();
  });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(await page.evaluate(() => (window as any).renders)).toEqual([500, 501]);
  await page.evaluate(() => (window as any).paint.schedule());
  await expect.poll(() => page.evaluate(() => (window as any).renders)).toEqual([500, 501, 502]);
});
