import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

test('documented multi-control wiring releases all eligible actions without data rerender or lost editor state', { timeout: 30000 }, async t => {
  const guide = await readFile(new URL('../../../docs/APP_PATTERNS.md', import.meta.url), 'utf8');
  const example = guide.match(/```js\n(\/\/ submission-controls-example\n[\s\S]*?)\n```/)[1];
  const bundle = await build({ stdin: { contents: example, resolveDir: fileURLToPath(new URL('../../../docs/tutorial/', import.meta.url)) },
    bundle: true, write: false, format: 'iife', globalName: 'Example' });
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined });
  t.after(() => browser.close());
  for (const width of [1200, 320]) {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    await page.setContent(`<main id="app"><section id="detail" data-selected="record-1">
      <input id="draft" value="Retained draft"><button id="detail-save" data-write-action="submit">Save detail</button></section>
      <button id="card-save" data-write-action="submit">Save card</button>
      <button id="invalid" data-write-action="submit" data-domain-blocked="true">Invalid card</button>
      <button id="retry" data-write-action="retry">Retry original</button>
      <button id="reapply" data-write-action="reapply">Review reapplication</button>
      <p data-submission-status role="status"></p></main>`);
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.evaluate(() => {
      const controls = Example.createWriteControls(document.querySelector('#app'));
      window.controls = controls; window.reads = 0;
      const { submission } = controls;
      window.currentRead = () => { window.reads++; submission.read({ revision: { generation: 'g' } }); };
      submission.update({ attached: true });
      submission.application({ phase: 'ready', database: 'ready', generation: 'g' });
      submission.participation({ phase: 'following' }); currentRead();
    });
    await page.locator('#draft').focus();
    const enabled = async id => page.locator('#' + id).isEnabled();
    assert.equal(await enabled('detail-save'), true); assert.equal(await enabled('card-save'), true);
    assert.equal(await enabled('invalid'), false);
    await page.evaluate(() => {
      const { submission, sync } = controls;
      window.release = submission.begin();
      submission.update({ pending: { id: 'accepted' }, selected: 'accepted' });
      const added = document.createElement('button'); added.id = 'new-card'; added.dataset.writeAction = 'submit';
      document.querySelector('#app').append(added); sync();
      submission.update({ pending: null, observed: { status: 'applied', outcome: 'accepted' } });
      currentRead(); // Refresh finishes while the handler still owns working.
    });
    for (const id of ['detail-save', 'card-save', 'new-card']) assert.equal(await enabled(id), false);
    const reads = await page.evaluate(() => window.reads);
    await page.evaluate(() => release());
    for (const id of ['detail-save', 'card-save', 'new-card']) {
      assert.equal(await enabled(id), true); assert.equal(await page.locator('#' + id).getAttribute('aria-busy'), 'false');
    }
    assert.equal(await page.evaluate(() => window.reads), reads, 'release needs no data event or extra query');
    assert.equal(await page.locator('#draft').inputValue(), 'Retained draft');
    assert.equal(await page.locator('#draft').evaluate(element => document.activeElement === element), true);
    assert.equal(await page.locator('#detail').getAttribute('data-selected'), 'record-1');
    // Failed refresh and uncertain operations remain blocked after their own release.
    await page.evaluate(() => { const done = controls.submission.begin(); controls.submission.update({ coherent: false }); done(); });
    assert.equal(await enabled('card-save'), false);
    await page.evaluate(() => {
      currentRead(); const done = controls.submission.begin();
      controls.submission.update({ pending: { id: 'uncertain' }, selected: 'uncertain', observed: { status: 'saved' } }); done();
    });
    assert.equal(await enabled('detail-save'), false); assert.equal(await enabled('retry'), true);
    await page.evaluate(() => controls.submission.update({ observed: { status: 'needsReapply' } }));
    assert.equal(await enabled('retry'), false); assert.equal(await enabled('reapply'), true);
    await page.evaluate(() => controls.submission.participation({ phase: 'recovering' }));
    assert.equal(await enabled('reapply'), false); assert.equal(await enabled('card-save'), false);
    await page.evaluate(() => {
      controls.submission.update({ pending: null }); controls.submission.participation({ phase: 'following' });
    });
    assert.equal(await enabled('card-save'), false, 'reconnect still requires a coherent current read');
    await page.evaluate(() => { currentRead(); const done = controls.submission.begin(); try { throw Error('Validation failed before dispatch'); } catch {} finally { done(); } });
    assert.equal(await enabled('card-save'), true); assert.equal(await enabled('invalid'), false);
    assert.equal(await page.locator('#draft').inputValue(), 'Retained draft');
    await page.close();
  }
});
