import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

// The documented multi-control wiring runs against the starter's actual submission state: eligibility follows
// the local signer and storage, never peers, a successful read or finality, and an uncertain operation blocks only
// its own retry/inspect controls, not independent saves.
test('documented multi-control wiring releases all eligible actions without data rerender or lost editor state', { timeout: 30000 }, async t => {
  const guide = await readFile(new URL('../../../docs/APP_PATTERNS.md', import.meta.url), 'utf8');
  const example = guide.match(/```js\n(\/\/ submission-controls-example\n[\s\S]*?)\n```/)[1];
  const bundle = await build({ stdin: { contents: example, resolveDir: fileURLToPath(new URL('../../../docs/tutorial/templates/notes/', import.meta.url)) },
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
      <p data-submission-status role="status"></p></main>`);
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.evaluate(() => {
      const controls = Example.createWriteControls(document.querySelector('#app'));
      window.controls = controls;
      // Attached with a granted signer and open storage: no peer, successful read or finalizer is part of eligibility.
      controls.submission.update({ attached: true });
      controls.submission.application({ canAuthor: true, phase: 'ready' });
    });
    await page.locator('#draft').focus();
    const enabled = async id => page.locator('#' + id).isEnabled();
    assert.equal(await enabled('detail-save'), true); assert.equal(await enabled('card-save'), true);
    assert.equal(await enabled('invalid'), false); assert.equal(await enabled('retry'), false);
    assert.match(await page.locator('[data-submission-status]').textContent(), /Save is available, including offline/);
    await page.evaluate(() => {
      const { submission, sync } = controls;
      window.release = submission.begin();
      submission.update({ pending: { operationId: 'accepted' }, selected: 'accepted' });
      const added = document.createElement('button'); added.id = 'new-card'; added.dataset.writeAction = 'submit';
      document.querySelector('#app').append(added); sync();
      submission.update({ pending: null, observed: { stored: true, materialized: { outcome: 'accepted' } } });
    });
    for (const id of ['detail-save', 'card-save', 'new-card']) assert.equal(await enabled(id), false);
    await page.evaluate(() => release());
    for (const id of ['detail-save', 'card-save', 'new-card']) {
      assert.equal(await enabled(id), true); assert.equal(await page.locator('#' + id).getAttribute('aria-busy'), 'false');
    }
    assert.equal(await page.locator('#draft').inputValue(), 'Retained draft');
    assert.equal(await page.locator('#draft').evaluate(element => document.activeElement === element), true);
    assert.equal(await page.locator('#detail').getAttribute('data-selected'), 'record-1');
    // A missing key or closed storage blocks every local write and says why; the editor stays usable.
    await page.evaluate(() => controls.submission.application({ canAuthor: false, phase: 'ready' }));
    for (const id of ['detail-save', 'card-save', 'new-card', 'retry']) assert.equal(await enabled(id), false);
    assert.match(await page.locator('[data-submission-status]').textContent(), /waiting to be admitted/);
    await page.evaluate(() => controls.submission.application({ canAuthor: true, phase: 'closed' }));
    assert.equal(await enabled('card-save'), false);
    assert.match(await page.locator('[data-submission-status]').textContent(), /Local storage is unavailable/);
    await page.evaluate(() => controls.submission.application({ canAuthor: true, phase: 'ready' }));
    // An uncertain stored operation exposes its exact retry without blocking independent saves.
    await page.evaluate(() => controls.submission.update({ pending: { operationId: 'uncertain' }, selected: 'uncertain' }));
    assert.equal(await enabled('retry'), true); assert.equal(await enabled('card-save'), true);
    // Verified exclusion keeps the original inspectable but never offers a silent retimestamped retry.
    await page.evaluate(() => controls.submission.update({ observed: { stored: true, excluded: true } }));
    assert.equal(await enabled('retry'), false);
    await page.evaluate(() => controls.submission.update({ pending: null, selected: '', observed: null }));
    // A validation failure before dispatch releases its lock and leaves a domain-invalid control blocked.
    await page.evaluate(() => { const done = controls.submission.begin(); try { throw Error('Validation failed before dispatch'); } catch {} finally { done(); } });
    assert.equal(await enabled('card-save'), true); assert.equal(await enabled('invalid'), false);
    assert.equal(await page.locator('#draft').inputValue(), 'Retained draft');
    await page.close();
  }
});
