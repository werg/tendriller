import { test, expect, type Page, type WebSocketRoute } from '@playwright/test';
import { build } from 'esbuild';
import { MockServer } from './mock-server';

// Exercise the live update state machine in a real DOM without rebuilding shared release assets.
const compiled = await build({ stdin: {
  contents: "export * from './runtime/src/updates.ts';export {mountUtility} from './runtime/src/utility.ts';export {createTransportBinding} from './runtime/src/transport.ts';",
  resolveDir: new URL('../..', import.meta.url).pathname, loader: 'ts',
}, bundle: true,
  format: 'iife', globalName: 'UpdatePolicy', platform: 'browser', write: false });
let mock: MockServer;
test.beforeAll(async () => { mock = new MockServer(); await mock.start(); });
test.afterAll(async () => { await mock.stop(); });

async function setupUpdates(page: Page, html = '<button id="outside">Outside</button>', pinned = false) {
  let stream!: WebSocketRoute;
  await page.clock.install();
  await page.routeWebSocket('**/_tendril/publication-ready', route => {
    stream = route; route.send(JSON.stringify({ type: 'publication', version: 1, current: 1 }));
  });
  await page.goto(mock.origin);
  await page.setContent(html);
  await page.addScriptTag({ content: compiled.outputFiles[0].text });
  await page.evaluate(({ origin, pinned }) => {
    const w = window as any;
    w.reloads = 0; w.notices = [];
    w.cfg = { base: origin + '/t/example/', version: 1, publication: {}, documentPath: 'index.html' };
    w.updates = w.UpdatePolicy.watchPublicationUpdates(w.cfg, { pinned, watch: true, reload: () => w.reloads++ });
    w.updates.onUpdate((notice: unknown) => w.notices.push(notice));
  }, { origin: mock.origin, pinned });
  await expect.poll(() => !!stream).toBe(true);
  return async (current: number) => {
    stream.send(JSON.stringify({ type: 'publication', version: 1, current }));
    await expect.poll(() => page.evaluate(() => (window as any).updates.updateAvailable)).toBe(current !== 1 && current !== 0);
  };
}
const reloads = (page: Page) => page.evaluate(() => (window as any).reloads);

async function mountUtility(page: Page) {
  await page.evaluate(() => {
    const w = window as any, noop = () => () => {};
    w.disposeUtility = w.UpdatePolicy.mountUtility({
      transport: w.UpdatePolicy.createTransportBinding().api,
      identity: { base: w.cfg.base, version: 1, publication: null, managementUrl: w.cfg.base + '_tendril/manage' },
      publication: w.updates,
      installation: { status: () => ({ state: 'unavailable', platform: 'desktop' }), on: noop },
      sensors: { status: () => ({ active: [], pending: [] }), on: noop, stopAll: () => 0 },
    });
  });
}

test('live switches immediately when idle (focus and programmatic values never block, no card flashed)', async ({ page }) => {
  const notice = await setupUpdates(page, '<input id="search" value=""><textarea id="settings">saved</textarea><input id="slider" type="range" value="3">');
  expect(await page.evaluate(() => (window as any).updates.policy)).toBe('live');
  await mountUtility(page);
  await page.evaluate(() => {
    (document.querySelector('#settings') as HTMLTextAreaElement).value = 'loaded from app data';
    (document.querySelector('#slider') as HTMLInputElement).value = '9';
    (document.querySelector('#search') as HTMLInputElement).focus();
  });
  await notice(2);
  await expect.poll(() => reloads(page)).toBe(1);
  expect(await page.locator('tendril-utility').evaluate(host => (host.shadowRoot!.querySelector('[aria-label="Publication update"]') as HTMLElement).hidden)).toBe(true);
});

test('live deterministically shows the update card with zero timer when a typed draft defers navigation, and manual button triggers update()', async ({ page }) => {
  const notice = await setupUpdates(page, '<textarea id="composer"></textarea>');
  await mountUtility(page);
  await page.locator('#composer').pressSequentially('unfinished draft');
  await notice(2);
  // Zero 300ms timer wait: deferred phase is emitted immediately!
  expect(await reloads(page)).toBe(0);
  const card = page.locator('tendril-utility').locator('[aria-label="Publication update"]');
  await expect(card).toBeVisible();
  await expect(card).toContainText('New version published');
  await expect(card).toContainText('Unsaved text draft');

  // Clearing the draft lets live auto-update proceed.
  await page.locator('#composer').fill('');
  await expect.poll(() => reloads(page)).toBe(1);
});

test('a held update surfaces the explicit hold reason immediately, allows clicking Update now, and clears on rollback', async ({ page }) => {
  const notice = await setupUpdates(page, '<button>Outside</button>');
  await mountUtility(page);
  await page.evaluate(() => { (window as any).release = (window as any).updates.hold('Active voice call'); });
  await notice(2);
  const card = page.locator('tendril-utility').locator('[aria-label="Publication update"]');
  await expect(card).toBeVisible();
  await expect(card).toContainText('Active voice call');

  // Rollback withdraws the card cleanly.
  await notice(1);
  await expect(card).toBeHidden();
  await page.evaluate(() => (window as any).release());
  expect(await reloads(page)).toBe(0);

  // Re-hold and click Update now button explicitly.
  await page.evaluate(() => { (window as any).release2 = (window as any).updates.hold('Unsaved form'); });
  await notice(3);
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Update now' }).click();
  expect(await reloads(page)).toBe(1);
});

test('pinned pages never auto-reload and immediately surface phase: pinned', async ({ page }) => {
  const notice = await setupUpdates(page, '<button>Outside</button>', true);
  await mountUtility(page);
  await notice(2);
  await page.clock.runFor(10_000);
  expect(await reloads(page)).toBe(0);
  expect(await page.evaluate(() => (window as any).updates.phase)).toBe('pinned');
  const card = page.locator('tendril-utility').locator('[aria-label="Publication update"]');
  await expect(card).toBeVisible();
});

test('multiple holds are independent, and manual update overrides them', async ({ page }) => {
  const notice = await setupUpdates(page, '<textarea>saved</textarea>');
  await page.evaluate(() => { const w = window as any; w.a = w.updates.hold('A'); w.b = w.updates.hold('B'); });
  await notice(2);
  await page.evaluate(() => (window as any).a());
  expect(await reloads(page)).toBe(0);
  await page.evaluate(() => (window as any).updates.update());
  expect(await reloads(page)).toBe(1);
});

test('close fences deferred edits, timer ticks, held releases and manual update', async ({ page }) => {
  const notice = await setupUpdates(page);
  await page.evaluate(() => (window as any).release = (window as any).updates.hold());
  await notice(2);
  await page.evaluate(() => {
    const w = window as any; document.dispatchEvent(new Event('change')); w.updates.close(); w.updates.close();
    w.release(); w.updates.update(); document.dispatchEvent(new Event('focusout')); document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('pageshow'));
  });
  await page.clock.runFor(10_000);
  expect(await reloads(page)).toBe(0);
  expect(await page.evaluate(() => (window as any).updates.updateAvailable)).toBe(false);
});

test('pin detection matches only a valid immutable route relative to this page base', async ({ page }) => {
  await page.goto(mock.origin); await page.addScriptTag({ content: compiled.outputFiles[0].text });
  const result = await page.evaluate(origin => {
    const w = window as any, cfg = { base: origin + '/page/', publication: {} };
    return ['_publications/1/', '_publications/23/docs/help.html', 'docs/_publications/help.html', '_publications/0/', '_publications/01/', '_publications/not-a-version/', '_publications/9007199254740992/'].map(path => w.UpdatePolicy.explicitlyPinned(cfg, origin + '/page/' + path))
      .concat(w.UpdatePolicy.explicitlyPinned(cfg, origin + '/other/_publications/1/'));
  }, mock.origin);
  expect(result).toEqual([true, true, false, false, false, false, false, false]);
});

test('live protects active typing inside a same-origin srcdoc iframe (nested contenteditable)', async ({ page }) => {
  const notice = await setupUpdates(page, '<iframe id="frame"></iframe><button id="outside">Outside</button>');
  await page.evaluate(() => {
    const f = document.querySelector('#frame') as HTMLIFrameElement;
    f.srcdoc = '<!doctype html><html><body><div id="rich" contenteditable="true"><p><span id="inner">hello</span></p></div></body></html>';
  });
  const frame = page.frameLocator('#frame');
  await expect(frame.locator('#inner')).toBeVisible();
  await frame.locator('#inner').click();
  await page.keyboard.type(' world');
  await notice(2);
  await page.clock.runFor(5000);
  expect(await reloads(page)).toBe(0);

  await page.locator('#outside').click();
  await expect.poll(() => reloads(page)).toBe(1);
});

test('live defers reload during active IME composition and active pointer gestures, then switches once finished', async ({ page }) => {
  const notice = await setupUpdates(page, '<div id="canvas" style="width:120px;height:120px"></div><input id="ime" />');
  await page.evaluate(() => {
    document.querySelector('#ime')!.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
  });
  await notice(2);
  await page.clock.runFor(5000);
  expect(await reloads(page)).toBe(0);

  await page.mouse.move(40, 40);
  await page.mouse.down();
  await page.evaluate(() => {
    document.querySelector('#ime')!.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
  });
  await page.clock.runFor(500);
  expect(await reloads(page)).toBe(0);

  await page.mouse.up();
  await expect.poll(() => reloads(page)).toBe(1);
});

test('live protects a user-selected file input until cleared', async ({ page }) => {
  const notice = await setupUpdates(page, '<input id="upload" type="file">');
  await page.locator('#upload').setInputFiles({ name: 'photo.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  await notice(2);
  await page.clock.runFor(5000);
  expect(await reloads(page)).toBe(0);

  await page.locator('#upload').setInputFiles([]);
  await expect.poll(() => reloads(page)).toBe(1);
});

test('onBeforeReload flushes async drafts and transitions applying -> deferred when vetoed', async ({ page }) => {
  const notice = await setupUpdates(page, '<button id="outside">Outside</button>');
  await mountUtility(page);
  await page.evaluate(() => {
    const w = window as any;
    w.flushed = 0;
    w.allowReload = false;
    w.updates.onBeforeReload(async () => {
      w.flushed += 1;
      await Promise.resolve();
      return w.allowReload;
    });
  });
  await notice(2);
  await expect.poll(() => page.evaluate(() => (window as any).flushed)).toBe(1);
  expect(await reloads(page)).toBe(0);
  expect(await page.evaluate(() => (window as any).updates.phase)).toBe('deferred');
  const card = page.locator('tendril-utility').locator('[aria-label="Publication update"]');
  await expect(card).toBeVisible();

  await page.evaluate(() => {
    const w = window as any;
    w.allowReload = true;
    const release = w.updates.hold('flush');
    release();
  });
  await expect.poll(() => reloads(page)).toBe(1);
  expect(await page.evaluate(() => (window as any).flushed)).toBe(2);
});
