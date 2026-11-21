import { test, expect, type Page } from '@playwright/test';
import { build } from 'esbuild';

// Real browser URL resolution and navigation, using the policy/kernel source.
// Every request is intercepted; no account, service or persistent profile exists.
const compiled = await build({ entryPoints: [new URL('../src/kernel.ts', import.meta.url).pathname],
  bundle: true, format: 'iife', globalName: 'NavigationKernel', platform: 'browser', write: false });
const origin = 'https://navigation.test', base = origin + '/page/';
async function fixture(page: Page) {
  let selected = 1;
  const requests: string[] = [];
  await page.addInitScript({ content: compiled.outputFiles[0].text + `
    document.addEventListener('DOMContentLoaded', () => {
      window.tendril = NavigationKernel.startRuntime(window.__TENDRIL__);
      for (const link of document.querySelectorAll('[data-document-link]'))
        link.href = window.tendril.documentUrl(link.getAttribute('href'));
    });` });
  await page.route(origin + '/**', async route => {
    const url = new URL(route.request().url()); requests.push(url.pathname);
    const match = /^\/page\/(?:_publications\/([1-9][0-9]*)\/)?(.*)$/.exec(url.pathname);
    if (!match) return route.fulfill({ status: 404, body: 'not found' });
    const version = match[1] ? Number(match[1]) : selected, documentPath = match[2] || 'index.html';
    if (documentPath.endsWith('asset.js')) return route.fulfill({ contentType: 'text/javascript', body: 'window.assetVersion=' + version });
    const publicationBase = base + '_publications/' + version + '/', directory = documentPath.slice(0, documentPath.lastIndexOf('/') + 1);
    const cfg = { id: 'navigation', base, version, documentPath, application: { id: 'a'.repeat(64) },
      features: { speech: null, shared_by: 'Fixture' }, publication: { id: String(version), base: publicationBase, entry: 'index.html',
        runtime: { version: 'fixture', base: origin + '/_tendril/runtime/' + 'a'.repeat(64) + '/' },
        assets: ['index.html', 'other.html', 'notes/index.html', 'notes/other.html'].map(path => ({ path, type: 'text/html', sha256: 'a'.repeat(64) })) } };
    await route.fulfill({ contentType: 'text/html', body: `<!doctype html><base href="${publicationBase + directory}">
      <script>window.__TENDRIL__=${JSON.stringify(cfg)}</script><script src="./asset.js"></script>
      <h1>${documentPath} version ${version}</h1><a id="plain" href="other.html">Signed document</a>
      <a id="plain-fragment" href="#section">Signed fragment</a>
      <a id="live" data-document-link href="other.html">Document context</a>
      <a id="fragment" data-document-link href="#section">Current section</a><h2 id="section">Section</h2>` });
  });
  return { requests, select(version: number) { selected = version; } };
}

// A URL can commit before the destination's DOMContentLoaded fixture runs.
// Wait for the new document and its runtime, rather than reading the old/empty realm.
async function followDocument(page: Page, selector: string, url: string) {
  await Promise.all([
    page.waitForURL(url, { waitUntil: 'load' }),
    page.locator(selector).click(),
  ]);
  await page.waitForFunction(() => Boolean(window.tendril?.publication));
}

test('plain relative document and fragment links intentionally resolve inside the signed graph', async ({ page }) => {
  await fixture(page); await page.goto(base);
  expect(await page.evaluate(() => window.tendril.publication.pinned)).toBe(false);
  await followDocument(page, '#plain', base + '_publications/1/other.html');
  expect(page.url()).toBe(base + '_publications/1/other.html');
  expect(await page.evaluate(() => window.tendril.publication.pinned)).toBe(true);
  await page.goto(base); await followDocument(page, '#plain-fragment', base + '_publications/1/#section');
  expect(page.url()).toBe(base + '_publications/1/#section');
  expect(await page.evaluate(() => window.tendril.publication.pinned)).toBe(true);
});

test('documentUrl opts into latest document navigation while current assets stay immutable', async ({ page }) => {
  const f = await fixture(page); await page.goto(base);
  expect(await page.evaluate(() => (window as any).assetVersion)).toBe(1);
  expect(await page.locator('#plain').getAttribute('href')).toBe('other.html');
  expect(await page.locator('#live').getAttribute('href')).toBe(base + 'other.html');
  f.select(2);
  expect(await page.evaluate(() => (window as any).assetVersion)).toBe(1);
  await followDocument(page, '#live', base + 'other.html'); expect(page.url()).toBe(base + 'other.html');
  expect(await page.evaluate(() => ({ version: window.tendril.version, pinned: window.tendril.publication.pinned, asset: (window as any).assetVersion })))
    .toEqual({ version: 2, pinned: false, asset: 2 });
  expect(f.requests).toContain('/page/_publications/1/asset.js'); expect(f.requests).toContain('/page/_publications/2/asset.js');
});

test('documentUrl fragments remain in the current live document, without a reload', async ({ page }) => {
  const f = await fixture(page); await page.goto(base + 'notes/index.html?review=1');
  await page.evaluate(() => (window as any).marker = 'same document'); const before = f.requests.length;
  await followDocument(page, '#fragment', base + 'notes/index.html?review=1#section');
  expect(page.url()).toBe(base + 'notes/index.html?review=1#section'); expect(f.requests).toHaveLength(before);
  expect(await page.evaluate(() => (window as any).marker)).toBe('same document');
  expect(await page.evaluate(() => window.tendril.documentUrl('other.html?mode=review#detail'))).toBe(base + 'notes/other.html?mode=review#detail');
});

test('documentUrl preserves explicit pins and rejects references escaping the selected context', async ({ page }) => {
  const f = await fixture(page); f.select(2); await page.goto(base + '_publications/1/notes/index.html');
  await followDocument(page, '#live', base + '_publications/1/notes/other.html'); expect(page.url()).toBe(base + '_publications/1/notes/other.html');
  expect(await page.evaluate(() => ({ version: window.tendril.version, pinned: window.tendril.publication.pinned }))).toEqual({ version: 1, pinned: true });
  expect(await page.evaluate(() => ['/page/other.html', 'https://elsewhere.test/', 'javascript:alert(1)', 'https://user:password@navigation.test/page/'].map(reference => {
    try { window.tendril.documentUrl(reference); return false; } catch { return true; }
  }))).toEqual([true, true, true, true]);
});
