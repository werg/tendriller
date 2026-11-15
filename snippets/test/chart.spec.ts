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
      () => chart.update([], { emaAlpha: 0 }),
      () => chart.update([], { emaAlpha: 1.1 }),
      () => chart.update([], { yScale: 'log2' }),
      () => chart.update([], { xDomain: [2, 1] }),
      () => chart.update([], { xDomain: [0, Infinity] }),
      () => chart.update([], { xDomain: Array(2) }),
      () => chart.update([], { crosshair: 'yes' }),
      () => chart.update([], { onCursor: true }),
      () => chart.setCursor(NaN),
      () => w.tendrilSnippets.chart.mount('#app', { maxPoints: Infinity }),
      () => w.tendrilSnippets.chart.mount('#app', { emaAlpha: -1 }),
    ]) { try { action(); } catch (error: any) { errors.push(error.message); } }
    w.chart = chart;
    return errors;
  });
  expect(errors).toHaveLength(15);
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

test('EMA retains raw values, restarts at gaps and recomputes over the bounded window', async ({ page }) => {
  await load(page, 'chart');
  const result = await page.evaluate(() => {
    const w = window as any;
    w.chart = w.tendrilSnippets.chart.mount('#app', { emaAlpha: 0.5, maxPoints: 5 });
    return w.chart.update([{ id: 'run', points: [
      { x: 5, y: 4 }, { x: 3, y: null }, { x: 2, y: 0 }, { x: 4, y: 8 }, { x: 1, y: 10 },
    ] }]);
  });
  expect(result).toEqual({ series: 1, samples: 4, min: 0, max: 10 });
  await expect(page.locator('path.tc-raw')).toHaveCount(1);
  await expect(page.locator('path.tc-raw')).toHaveCSS('opacity', '0.25');
  expect((await page.locator('path.tc-series').getAttribute('d'))!.match(/M/g)).toHaveLength(2);
  await page.getByText('View sample values').click();
  const cells = () => page.locator('tbody tr').evaluateAll(rows => rows.map(row => [...row.querySelectorAll('td')].map(td => td.textContent)));
  await expect.poll(cells).toEqual([
    ['run', '1', '10', '10'], ['run', '2', '0', '5'], ['run', '3', '—', '—'], ['run', '4', '8', '8'], ['run', '5', '4', '6'],
  ]);
  await page.evaluate(() => (window as any).chart.append('run', { x: 6, y: 2 }));
  // x=1 was evicted; x=2 now seeds the EMA, rather than retaining hidden state.
  expect((await cells())[0]).toEqual(['run', '2', '0', '0']);
  expect((await cells()).at(-1)).toEqual(['run', '6', '2', '4']);
  await page.evaluate(() => (window as any).chart.update([{ id: 'run', points: [{ x: 1, y: 10 }, { x: 2, y: 0 }] }], { emaAlpha: null }));
  await expect(page.locator('path.tc-raw')).toHaveCount(0);
  await expect(page.locator('thead th')).toHaveCount(3);
});

test('log scales preserve raw nonpositive values as gaps and handle extreme positive ranges', async ({ page }) => {
  await load(page, 'chart');
  const result = await page.evaluate(() => {
    const w = window as any;
    w.chart = w.tendrilSnippets.chart.mount('#app', { yScale: 'log' });
    return w.chart.update([{ id: 'value', points: [
      { x: 1, y: 1 }, { x: 2, y: 0 }, { x: 3, y: 100 }, { x: 4, y: -3 },
      { x: 5, y: Number.MIN_VALUE }, { x: 6, y: Number.MAX_VALUE },
    ] }]);
  });
  expect(result).toEqual({ series: 1, samples: 6, min: -3, max: Number.MAX_VALUE });
  expect((await page.locator('path.tc-series').getAttribute('d'))!.match(/M/g)).toHaveLength(3);
  await page.getByText('View sample values').click();
  await expect(page.locator('tbody tr').nth(1)).toHaveText('value20 (not shown on log scale)');
  await expect(page.locator('tbody tr').nth(3)).toHaveText('value4-3 (not shown on log scale)');
  for (const value of [Number.MIN_VALUE, Number.MAX_VALUE]) {
    await page.evaluate(value => (window as any).chart.update([{ id: 'value', points: [{ x: 1, y: value }, { x: 2, y: value }] }], { emaAlpha: 0.5 }), value);
    expect(await page.locator('[data-tendril-chart] > svg').evaluate(node => node.outerHTML)).not.toMatch(/NaN|Infinity|∞/);
    expect(await page.locator('tbody tr').last().locator('td').last().textContent()).toBe(value.toExponential(3));
  }
  await page.evaluate(() => (window as any).chart.update([{ id: 'value', points: [{ x: 1, y: 0 }, { x: 2, y: -1 }] }]));
  await expect(page.locator('[data-tendril-chart] > svg')).toContainText('Waiting for positive samples');
  await expect(page.locator('path.tc-series')).toHaveAttribute('d', '');
});

test('crosshair uses exact common-x values and a persistent keyboard inspector', async ({ page }) => {
  await load(page, 'chart');
  await page.evaluate(() => {
    const w = window as any; w.cursors = [];
    w.chart = w.tendrilSnippets.chart.mount('#app', { title: 'Comparison', crosshair: true, xDomain: [0, 3], onCursor: (x: number | null) => w.cursors.push(x) });
    w.chart.update([
      { id: 'a', points: [{ x: 0, y: 10 }, { x: 2, y: 20 }, { x: 2, y: 21 }] },
      { id: 'b', points: [{ x: 1, y: 5 }, { x: 2, y: null }] },
    ]);
  });
  const slider = page.getByRole('slider', { name: 'Comparison: inspect X samples' });
  await slider.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.tc-legend')).toHaveText('a: —b: 5');
  await expect(slider).toHaveAttribute('aria-valuetext', /X: 1.*a: —; b: 5/);
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.tc-legend')).toHaveText('a: 21b: —');
  await page.evaluate(() => (window as any).chart.append('a', { x: 3, y: 22 }));
  await expect(slider).toBeFocused();
  await expect(page.locator('.tc-legend')).toHaveText('a: 21b: —');
  await page.evaluate(() => (window as any).chart.setCursor(1.5));
  await expect(page.locator('.tc-legend')).toHaveText('a: —b: —');
  expect(await page.evaluate(() => (window as any).cursors)).toEqual([0, 1, 2]);
  await page.keyboard.press('Escape');
  await expect(page.locator('.tc-crosshair')).toHaveCount(0);
  const point = await page.locator('[data-tendril-chart] > svg').evaluate(node => {
    const svg = node as SVGSVGElement, p = new DOMPoint(76 + (svg.viewBox.baseVal.width - 96) / 3, 100).matrixTransform(svg.getScreenCTM()!);
    return { x: p.x, y: p.y };
  });
  await page.mouse.move(point.x, point.y);
  await expect(page.locator('.tc-legend')).toHaveText('a: —b: 5');
  await expect(page.locator('[data-cursor-series]')).toHaveCount(1);
});

test('shared domains align peer cursors without callback loops and clip extreme offscreen segments', async ({ page }) => {
  await load(page, 'chart');
  await page.evaluate(() => {
    const w = window as any; w.charts = []; w.cursorCalls = [];
    for (let index = 0; index < 2; index++) {
      const panel = document.createElement('div'); panel.style.width = '480px'; document.querySelector('#app')!.append(panel);
      w.charts.push(w.tendrilSnippets.chart.mount(panel, { title: 'Panel ' + index, xDomain: [0, 20], crosshair: true,
        onCursor: (x: number | null) => { w.cursorCalls.push({ index, x }); for (const chart of w.charts) chart.setCursor(x); } }));
    }
    w.charts[0].update([{ id: 'a', points: [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 20 }] }]);
    w.charts[1].update([{ id: 'b', points: [{ x: 10, y: 100 }, { x: 15, y: 150 }] }]);
  });
  await page.getByRole('slider', { name: 'Panel 0: inspect X samples' }).focus();
  await page.keyboard.press('ArrowRight');
  const lines = page.locator('.tc-crosshair');
  await expect(lines).toHaveCount(2);
  expect(await lines.nth(0).getAttribute('x1')).toBe(await lines.nth(1).getAttribute('x1'));
  await expect(page.locator('.tc-legend').nth(0)).toHaveText('a: 10');
  await expect(page.locator('.tc-legend').nth(1)).toHaveText('b: 100');
  expect(await page.evaluate(() => (window as any).cursorCalls)).toEqual([{ index: 0, x: 0 }, { index: 0, x: 10 }]);
  await page.evaluate(() => (window as any).charts[0].update([{ id: 'a', points: [
    { x: -Number.MAX_VALUE, y: 0 }, { x: Number.MAX_VALUE, y: 1 },
  ] }], { xDomain: [-1, 1] }));
  await expect(page.locator('path.tc-series').first()).toHaveAttribute('d', 'M76.00,115.00 L460.00,115.00');
  expect(await page.locator('[data-tendril-chart] > svg').first().evaluate(node => node.outerHTML)).not.toMatch(/NaN|Infinity/);
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
  await page.route('**/dashboard/_tendril/snippets/*.js', async route => {
    const file = new URL(route.request().url()).pathname.split('/').pop()!;
    if (!['chart.js', 'stream-view.js'].includes(file)) return route.abort();
    await route.fulfill({ body: readFileSync(fileURLToPath(new URL('../' + file, import.meta.url))), contentType: 'text/javascript' });
  });
  await page.addInitScript(() => {
    const w = window as any;
    w.tendril = { connected: true, on() {}, streams: {
      async list() { return { streams: ['machine.utilization', 'training.metrics', 'training.logs'].map(name => ({ name, durability: 'durable' })) }; },
      subscribe(name: string, receive: (record: any) => void) {
        if (name === 'machine.utilization') receive({ type: 'host', ts: Date.now(), received_at: Date.now(), data: {
          source: 'gpu-box', host: 'GPU host', metrics: { cpu_percent: 12, memory_used_bytes: null, memory_total_bytes: 16 * 2 ** 30 },
          gpu_status: 'available', gpus: [{ index: 0, utilization_percent: null, memory_used_bytes: null, memory_total_bytes: null, temperature_c: 55,
            unavailable: { utilization_percent: 'not_supported', memory_used_bytes: 'not_available', memory_total_bytes: 'not_available' } }],
        } });
        if (name === 'training.metrics') for (const source of ['sensor A', 'sensor B']) for (let step = 0; step < 5; step++)
          receive({ type: 'metric', ts: step, data: { source, run: 0, step, loss: 5 - step } });
        if (name === 'training.logs') receive({ type: 'log', ts: 4, data: { source: 'training-logs', run: 0, line: 'Epoch complete' } });
        return () => {};
      },
    } };
  });
  await page.goto('/dashboard/');
  await expect(page.locator('path.tc-series')).toHaveCount(2);
  await expect(page.locator('#chart-summary')).toHaveText('10 samples across 2 source/run series');
  await expect(page.locator('.tc-legend')).toContainText('sensor A / 0');
  await expect(page.locator('.tc-legend')).toContainText('sensor B / 0');
  await expect(page.locator('#machines .stats')).toContainText('— / 16 GiB');
  await expect(page.locator('#machines .gpu').first()).toHaveText('GPU 0 · —% · — / — GiB · 55 °C');
  await expect(page.locator('#machines .gpu.muted')).toContainText('utilization: not supported; used memory: not available (N/A); total memory: not available (N/A)');
  await page.getByText('View sample values').click();
  await expect(page.locator('tbody tr')).toHaveCount(10);
  await page.selectOption('#run', JSON.stringify(['sensor A', '0']));
  await expect(page.locator('path.tc-series')).toHaveCount(1);
  // Metrics and logs have different adapter source ids; match their explicit run.
  await expect(page.locator('#logs')).toContainText('Epoch complete');
});
