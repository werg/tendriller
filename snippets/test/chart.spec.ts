import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { load } from './helpers';

test('chart retains bounded sorted samples, shows gaps and does not coerce data', async ({ page }) => {
  await load(page, 'chart');
  const result = await page.evaluate(() => {
    const w = window as any;
    delete w.tendril; // A chart needs neither the runtime nor a network request.
    w.chart = w.tendrilSnippets.chart.mount('#app', { title: 'Sensors', xLabel: 'Time', yLabel: '°C', maxPoints: 5 });
    return w.chart.update([{ id: 'room', label: 'Room', points: [
      { x: -1, y: 100 }, { x: 3, y: null }, { x: 1, y: 10 }, { x: 2, y: 12 },
      { x: 4, y: 14 }, { x: 5, y: '16' }, { x: '6', y: 18 }, { x: Infinity, y: 20 },
    ] }]);
  });
  expect(result).toEqual({ series: 1, samples: 3, min: 10, max: 14 });
  const path = await page.locator('path.tc-series').getAttribute('d');
  expect(path!.match(/M/g)).toHaveLength(2);
  expect(path!.match(/L/g)).toHaveLength(1);
  await expect(page.getByRole('img', { name: /Sensors: 3 samples/ })).toBeVisible();
  await page.getByText('View sample values').click();
  await expect(page.locator('tbody tr')).toHaveCount(5);
  await expect(page.locator('tbody tr').nth(2)).toHaveText('Room3—');
  await expect(page.locator('tbody tr').nth(4)).toHaveText('Room5—');

  const appended = await page.evaluate(() => (window as any).chart.append('room', [{ x: 6, y: 20 }, { x: 0, y: 500 }]));
  expect(appended).toEqual({ series: 1, samples: 3, min: 12, max: 20 });
  await expect(page.locator('tbody tr').first()).toHaveText('Room212');
  await expect(page.locator('tbody tr').last()).toHaveText('Room620');
});

test('chart keeps keyboard focus across updates and limits table size independently', async ({ page }) => {
  await load(page, 'chart');
  await page.evaluate(() => {
    const w = window as any;
    w.chart = w.tendrilSnippets.chart.mount('#app', { maxPoints: 1000 });
    w.chart.update(['first', 'second'].map(id => ({ id, points: Array.from({ length: 1000 }, (_, x) => ({ x, y: x / 10 })) })));
  });
  const toggle = page.getByText('View sample values');
  await toggle.focus(); await page.keyboard.press('Enter');
  await expect(page.locator('tbody tr')).toHaveCount(100);
  await page.evaluate(() => (window as any).chart.append('first', { x: 1001, y: 5 }));
  await expect(toggle).toBeFocused();
  await expect(page.locator('details')).toHaveAttribute('open', '');
  await expect(page.locator('tbody tr')).toHaveCount(100);
  await expect(page.locator('tbody tr').last()).toHaveText('first1,0015');
  await page.keyboard.press('Enter');
  await expect(page.locator('details')).not.toHaveAttribute('open', '');
});

test('chart renders empty, constant and extreme numeric ranges with safe labels', async ({ page }) => {
  await load(page, 'chart');
  await page.setViewportSize({ width: 360, height: 800 });
  const empty = await page.evaluate(() => {
    const w = window as any;
    w.chart = w.tendrilSnippets.chart.mount('#app', { title: '<img src=x onerror="window.injected=1">', xLabel: 'Step' });
    return w.chart.update([{ id: 'sensor', label: '<script>bad()</script>', points: [{ x: 1, y: false }, { x: 2, y: NaN }] }]);
  });
  expect(empty.samples).toBe(0);
  await expect(page.locator('.tc-summary')).toHaveText('Waiting for numeric samples.');
  await expect(page.locator('#app img, #app script')).toHaveCount(0);
  await expect(page.locator('.tc-legend')).toContainText('<script>bad()</script>');
  await page.evaluate(() => (window as any).chart.update([{ id: 'sensor', points: [{ x: 1, y: 2 }, { x: 2, y: 2 }] }]));
  const constant = await page.locator('path.tc-series').getAttribute('d');
  expect(constant).toBe('M76.00,115.00 L340.00,115.00');
  await page.evaluate(() => (window as any).chart.update([{ id: 'sensor', points: [
    { x: -Number.MAX_VALUE, y: -Number.MAX_VALUE }, { x: Number.MAX_VALUE, y: Number.MAX_VALUE },
  ] }]));
  const svg = await page.locator('[data-tendril-chart] > svg').evaluate(node => node.outerHTML);
  expect(svg).not.toMatch(/NaN|Infinity/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
});

test('chart rejects invalid updates without losing the current view and releases its mount', async ({ page }) => {
  await load(page, 'chart');
  const errors = await page.evaluate(() => {
    const w = window as any, chart = w.tendrilSnippets.chart.mount('#app');
    chart.update([{ id: 'one', points: [{ x: 1, y: 3 }] }]);
    const errors: string[] = [];
    for (const action of [
      () => chart.update([{ id: 'one', points: [] }, { id: 'one', points: [] }]),
      () => chart.update(Array.from({ length: 25 }, (_, i) => ({ id: String(i), points: [] }))),
      () => chart.append('missing', { x: 1, y: 2 }),
      () => chart.update([{ id: 'one', points: [] }], { xFormat: 'bad' }),
      () => w.tendrilSnippets.chart.mount('#app', { maxPoints: Infinity }),
    ]) { try { action(); } catch (error: any) { errors.push(error.message); } }
    w.chart = chart;
    return errors;
  });
  expect(errors).toHaveLength(5);
  await expect(page.getByRole('img')).toHaveAttribute('aria-label', /1 samples.*min 3/);
  await expect(page.locator('[data-tendril-chart]')).toHaveCount(1);
  await page.evaluate(() => { (window as any).chart.destroy(); (window as any).chart.destroy(); window.dispatchEvent(new Event('resize')); });
  await expect(page.locator('[data-tendril-chart]')).toHaveCount(0);
});

test('chart falls back to numeric labels when a formatter cannot handle finite samples', async ({ page }) => {
  await load(page, 'chart');
  const result = await page.evaluate(() => {
    const w = window as any;
    w.chart = w.tendrilSnippets.chart.mount('#app', {
      title: 'Clock readings', xLabel: 'Time', xFormat: (value: number) => new Date(value).toISOString(),
      yFormat: () => { throw new Error('Formatter is unavailable'); },
    });
    // These are finite numbers but outside JavaScript Date's valid range.
    w.chart.update([{ id: 'clock', points: [{ x: 1e20, y: 5 }] }]);
    return w.chart.append('clock', { x: 2e20, y: 6 });
  });
  expect(result).toEqual({ series: 1, samples: 2, min: 5, max: 6 });
  await expect(page.getByRole('img')).toHaveAttribute('aria-label', /2 samples.*min 5.*max 6/);
  await expect(page.locator('.tc-legend')).toHaveText('clock: 6');
  await page.getByText('View sample values').click();
  await expect(page.locator('tbody tr')).toHaveCount(2);
  await expect(page.locator('tbody tr').first()).toHaveText('clock1.000e+205');
  await expect(page.locator('tbody tr').last()).toHaveText('clock2.000e+206');
});

test('training dashboard uses the served chart snippet for distinct source/run series', async ({ page }) => {
  const root = new URL('../../examples/training-dashboard/', import.meta.url);
  await page.route('**/dashboard/**', async route => {
    const name = new URL(route.request().url()).pathname.slice('/dashboard/'.length);
    if (name.startsWith('_tendril/')) return route.continue();
    const file = name || 'index.html';
    if (!['index.html', 'app.js', 'model.mjs'].includes(file)) return route.abort();
    await route.fulfill({ body: readFileSync(fileURLToPath(new URL(file, root))), contentType: file.endsWith('.html') ? 'text/html' : 'text/javascript' });
  });
  await page.route('**/dashboard/_tendril/snippets/chart.js', route => route.fulfill({
    body: readFileSync(fileURLToPath(new URL('../chart.js', import.meta.url))), contentType: 'text/javascript',
  }));
  await page.addInitScript(() => {
    const w = window as any;
    w.tendril = { connected: true, on() {}, streams: {
      async list() { return { streams: ['machine.utilization', 'training.metrics', 'training.logs'].map(name => ({ name, durability: 'durable' })) }; },
      subscribe(name: string, receive: (record: any) => void) {
        if (name === 'training.metrics') for (const source of ['sensor A', 'sensor B']) for (let step = 0; step < 5; step++)
          receive({ type: 'metric', ts: step, data: { source, run: 'demo', step, loss: 5 - step } });
        return () => {};
      },
    } };
  });
  await page.goto('/dashboard/');
  await expect(page.locator('path.tc-series')).toHaveCount(2);
  await expect(page.locator('#chart-summary')).toHaveText('10 samples across 2 source/run series');
  await expect(page.locator('.tc-legend')).toContainText('sensor A / demo');
  await expect(page.locator('.tc-legend')).toContainText('sensor B / demo');
  await page.getByText('View sample values').click();
  await expect(page.locator('tbody tr')).toHaveCount(10);
  await page.selectOption('#run', JSON.stringify(['sensor A', 'demo']));
  await expect(page.locator('path.tc-series')).toHaveCount(1);
});
