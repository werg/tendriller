import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { chromium } from '@playwright/test';

const root = new URL('../../../', import.meta.url);
const files = new Map([
  ['/ui/showcase.html', 'docs/tutorial/ui/showcase.html'],
  ['/ui/showcase.mjs', 'docs/tutorial/ui/showcase.mjs'],
  ['/ui/patterns.mjs', 'docs/tutorial/ui/patterns.mjs'],
  ['/connect-view.mjs', 'docs/tutorial/connect-view.mjs'],
]);

// Real Chromium, fresh contexts, synthetic domain data. No connection,
// persistence, native participant, mobile hardware or agent-acceptance claim.
test('domain patterns support search, deep links, keyboard, review, undo and honest states', { timeout:60000 }, async t => {
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://fixture').pathname;
    if (!files.has(path)) { response.writeHead(404); response.end(); return; }
    response.setHeader('Content-Type', path.endsWith('.mjs') ? 'text/javascript' : 'text/html');
    response.end(await readFile(new URL(files.get(path), root)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const browser = await chromium.launch({ headless:true, executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined });
  t.after(() => browser.close());
  const base = 'http://127.0.0.1:' + server.address().port + '/ui/showcase.html';
  const screenshot = async (page, name) => {
    if (!process.env.UPDATE_PATTERN_SCREENSHOTS) return;
    await mkdir(new URL('docs/assets/', root), { recursive:true });
    await page.screenshot({ path:new URL('docs/assets/app-patterns-' + name + '.png', root).pathname, fullPage:true });
  };
  for (const [name, viewport] of [
    ['desktop', { width:1200, height:1100 }], ['phone', { width:390, height:844 }],
  ]) {
    await t.test(name, async () => {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage(), errors = [];
      page.setDefaultTimeout(5000);
      page.on('pageerror', error => errors.push(error.message));
      try {
        await page.goto(base);
        const search = page.getByLabel('Search episodes');
        await search.fill('calendar');
        assert.equal(await page.locator('.tp-items a').count(), 1);
        assert.match(page.url(), /item-search=calendar/);
        await search.fill('not present');
        assert.equal(await page.getByText('No matching records', { exact:true }).isVisible(), true);
        await page.getByRole('button', { name:'Clear filters' }).click();
        await page.getByLabel('Status', { exact:true }).selectOption('reviewed');
        assert.equal(await page.locator('.tp-items a').count(), 1);
        await page.getByLabel('Status', { exact:true }).selectOption('');
        const episode = page.getByRole('link', { name:'The missing delivery', exact:false });
        await episode.focus(); await page.keyboard.press('Enter');
        await page.waitForURL(/item=episode-17/);
        assert.equal(await page.getByRole('heading', { name:'The missing delivery', exact:true }).isVisible(), true);
        assert.equal(await page.locator('details.context').evaluate(element => element.open), false);
        assert.equal(await page.getByRole('link', { name:'Customer support training run' }).isVisible(), true);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        assert.equal(await page.locator('h2').evaluate(element => document.activeElement === element), true);
        // Browser history must restore focus in both directions, including
        // detail -> list on the narrow layout where the list was hidden.
        await page.goBack();
        await page.waitForFunction(() => document.querySelector('.tp-workspace').dataset.selected === 'false');
        assert.equal(await episode.isVisible(), true);
        assert.equal(await episode.evaluate(element => document.activeElement === element), true);
        await page.goForward();
        await page.waitForFunction(() => document.querySelector('.tp-workspace').dataset.selected === 'true');
        assert.equal(await page.locator('h2').evaluate(element => document.activeElement === element), true);
        const editor = page.getByLabel('Reviewer summary');
        const original = await editor.inputValue();
        const revised = 'Verified the order and prepared a carrier message for review.';
        const summary = page.locator('.episode-summary');
        assert.equal(await summary.textContent(), original);
        await editor.fill(revised);
        await page.getByRole('button', { name:'Review changes', exact:true }).click();
        assert.equal(await page.getByRole('group', { name:'Review changes' }).isVisible(), true);
        assert.equal(await page.locator('.tp-compare del').textContent(), original);
        await screenshot(page, name);
        await page.getByRole('button', { name:'Save reviewed change' }).click();
        assert.equal(await page.getByText('Change saved.', { exact:true }).isVisible(), true);
        assert.equal(await summary.textContent(), revised);
        assert.equal(await page.getByRole('button', { name:'Undo saved change' }).isEnabled(), true);
        await page.getByRole('button', { name:'Undo saved change' }).click();
        assert.equal(await editor.inputValue(), original);
        assert.equal(await summary.textContent(), original);
        // Reopening a detail uses the edited record, while the live editor above
        // retained its own undo state rather than being remounted after save.
        await editor.fill(revised);
        await page.getByRole('button', { name:'Review changes', exact:true }).click();
        await page.getByRole('button', { name:'Save reviewed change' }).click();
        await page.getByRole('button', { name:'Back to list' }).click();
        assert.equal(new URL(page.url()).searchParams.has('item'), false);
        await page.goBack();
        assert.equal(await page.getByRole('heading', { name:'The missing delivery', exact:true }).isVisible(), true);
        assert.equal(await summary.textContent(), revised);
        assert.equal(await editor.inputValue(), revised);
        await page.reload();
        assert.equal(await page.getByRole('heading', { name:'The missing delivery', exact:true }).isVisible(), true);
        // Unknown deep links offer recovery rather than an empty inspector.
        await page.goto(base + '?item=missing');
        assert.equal(await page.getByRole('heading', { name:'Record unavailable' }).isVisible(), true);
        await page.getByRole('button', { name:'Back to list' }).click();
        assert.equal(await search.isVisible(), true);
        await page.goto(base + '?states=1');
        assert.equal(await page.getByText('Setting up this browser…', { exact:true }).isVisible(), true);
        assert.equal(await page.locator('#connection-card').getByRole('button').count(), 0);
        assert.equal(await page.getByRole('alert').getByText('Episodes could not be loaded').isVisible(), true);
        assert.equal(await page.locator('[aria-busy=true]').count(), 1);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        if (name === 'desktop') await screenshot(page, 'states');
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    });
  }
  await t.test('coherent list updates retain owned focus without moving unrelated focus', async () => {
    const page = await browser.newPage(); page.setDefaultTimeout(5000);
    try {
      await page.goto(base + '?states=1');
      await page.evaluate(async () => {
        const { mountListDetail } = await import('./patterns.mjs');
        const root = document.querySelector('#workspace'); root.replaceChildren();
        window.records = [{id:'first',title:'First record'}, {id:'second',title:'Second record'}];
        window.collection = mountListDetail(root, {
          records:window.records, renderDetail(record, container) {
            const input = document.createElement('textarea'); input.setAttribute('aria-label', 'Detail notes'); container.append(input);
          },
        });
        const outside = document.createElement('button'); outside.id = 'outside'; outside.textContent = 'Other action';
        document.querySelector('main').append(outside);
      });
      const second = page.getByRole('link', { name:'Second record', exact:true });
      await second.focus();
      await page.evaluate(() => window.collection.setRecords(window.records));
      assert.equal(await second.evaluate(element => document.activeElement === element), true);
      await page.evaluate(() => window.collection.setRecords(window.records.map(record => ({...record}))));
      assert.equal(await second.evaluate(element => document.activeElement === element), true);
      await page.getByRole('button', { name:'Other action' }).focus();
      await page.evaluate(() => window.collection.setRecords(window.records));
      assert.equal(await page.locator('#outside').evaluate(element => document.activeElement === element), true);
      await second.click(); await page.getByLabel('Detail notes').focus();
      await page.evaluate(() => window.collection.setRecords(window.records.map(record => ({...record}))));
      assert.equal(await page.getByRole('heading', { name:'Second record' }).evaluate(element => document.activeElement === element), true);
      await page.getByRole('button', { name:'Other action' }).focus();
      await page.evaluate(() => {
        const url = new URL(location.href); url.searchParams.set('unrelated', 'changed'); history.pushState(null, '', url);
      });
      await page.goBack();
      assert.equal(await page.locator('#outside').evaluate(element => document.activeElement === element), true);
      await page.goBack();
      await page.waitForFunction(() => document.querySelector('.tp-workspace').dataset.selected === 'false');
      assert.equal(await second.evaluate(element => document.activeElement === element), true);
      await page.evaluate(() => window.collection.setRecords(window.records.filter(record => record.id !== 'second')));
      assert.equal(await page.getByLabel('Search records').evaluate(element => document.activeElement === element), true);
    } finally { await page.close(); }
  });

  await t.test('uncertain mutations stay locked and authored text stays text', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(base);
      await page.evaluate(async () => {
        const { mountInlineReview, mountComparison } = await import('./patterns.mjs');
        document.querySelector('#workspace').replaceChildren();
        window.saves = 0;
        window.editor = mountInlineReview(document.querySelector('#workspace'), {
          label:'Uncertain draft', value:'original', async onSave() { window.saves++; throw Error('reply lost'); },
        });
        mountComparison(document.querySelector('#workspace'), {
          label:'Literal input', before:'<img src=x onerror=alert(1)>', after:'<script>throw 1</script>',
        });
      });
      const input = page.getByLabel('Uncertain draft');
      await input.fill('updated'); await page.getByRole('button', { name:'Review changes', exact:true }).click();
      await page.getByRole('button', { name:'Save reviewed change' }).click();
      assert.equal(await input.isDisabled(), true);
      assert.equal(await page.getByRole('button', { name:'Save reviewed change' }).isDisabled(), true);
      assert.equal(await page.evaluate(() => window.saves), 1);
      assert.equal(await page.locator('.tp-compare img,.tp-compare script').count(), 0);
      await page.evaluate(() => window.editor.reconcile('confirmed authoritative value'));
      assert.equal(await input.isEnabled(), true);
      assert.equal(await input.inputValue(), 'confirmed authoritative value');
    } finally { await page.close(); }
  });

  for (const [name, viewport] of [
    ['desktop', { width:1200, height:1100 }], ['phone', { width:390, height:844 }],
  ]) {
    await t.test(name + ' immutable snapshots preserve edits, confirmations and owned focus', async () => {
      const context = await browser.newContext({ viewport }), page = await context.newPage(), errors = [];
      page.setDefaultTimeout(5000); page.on('pageerror', error => errors.push(error.message));
      try {
        await page.goto(base + '?states=1&item=first&unrelated=kept');
        await page.evaluate(async () => {
          const { mountListDetail, mountInlineReview } = await import('./patterns.mjs');
          const root = document.querySelector('#workspace'); root.replaceChildren(); root.className = '';
          window.records = [
            { id:'first', title:'A very long record heading that must wrap while Back to list remains legible on a narrow phone screen',
              summary:'original', subtitle:'Initial metadata' },
            { id:'second', title:'Second record', summary:'another', subtitle:'Other metadata' },
          ];
          window.mounts = []; window.disposals = []; window.calls = [];
          window.collection = mountListDetail(root, {
            records:window.records,
            renderDetail(record, container) {
              window.mounts.push(record.id);
              const summary = document.createElement('p'), metadata = document.createElement('p');
              summary.className = 'live-summary'; metadata.className = 'live-metadata';
              summary.textContent = record.summary; metadata.textContent = record.subtitle;
              container.append(summary, metadata);
              const dispatch = change => {
                // The application, not the renderer, retains this exact guard/ID.
                window.calls.push({ ...change, operationId:'operation-' + (window.calls.length + 1) });
                return new Promise((resolve, reject) => { window.pending = { resolve, reject }; });
              };
              const editor = mountInlineReview(container, {
                label:'Live summary', value:record.summary, onSave:dispatch, onUndo:dispatch,
              });
              window.editor = editor;
              return {
                update(next) {
                  record = next; summary.textContent = next.summary; metadata.textContent = next.subtitle;
                  editor.observe(next.summary);
                },
                close() { window.disposals.push(record.id); editor.close(); },
              };
            },
          });
          window.snapshot = updates => {
            window.records = window.records.map(record => ({ ...record, ...(record.id === 'first' ? updates : {}) }));
            window.collection.setRecords(window.records);
          };
        });
        const input = page.getByLabel('Live summary');
        const review = page.getByRole('button', { name:'Review changes', exact:true });
        const save = page.getByRole('button', { name:'Save reviewed change' });
        const undo = page.getByRole('button', { name:'Undo saved change' });
        const discard = page.getByRole('button', { name:'Discard draft' });
        const back = page.getByRole('button', { name:'Back to list' });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        assert.equal(await back.evaluate(button => {
          const range = document.createRange(); range.selectNodeContents(button);
          return new Set([...range.getClientRects()].map(rect => rect.top)).size;
        }), 1, 'Back text stays on one visual line beside a long title');
        await input.fill('my draft');
        await input.evaluate(field => field.setSelectionRange(2, 5));
        await page.evaluate(() => window.snapshot({ subtitle:'Fresh metadata' }));
        assert.equal(await input.inputValue(), 'my draft');
        assert.equal(await input.evaluate(field => document.activeElement === field), true);
        assert.deepEqual(await input.evaluate(field => [field.selectionStart, field.selectionEnd]), [2, 5]);
        assert.equal(await page.locator('.live-metadata').textContent(), 'Fresh metadata');
        await review.click();
        await page.evaluate(() => window.snapshot({ subtitle:'Another coherent snapshot' }));
        assert.equal(await page.locator('.tp-compare ins').textContent(), 'my draft');

        // The accepted value reaches the live query before the callback resolves.
        await save.click();
        await page.evaluate(() => window.snapshot({ summary:'my draft' }));
        assert.equal(await input.isDisabled(), true);
        assert.deepEqual(await page.evaluate(() => window.calls), [
          { before:'original', after:'my draft', operationId:'operation-1' },
        ]);
        await page.evaluate(() => window.pending.resolve({ confirmed:true, value:'my draft' }));
        await page.getByText('Change saved.', { exact:true }).waitFor();
        assert.equal(await undo.isEnabled(), true);
        await page.evaluate(() => window.snapshot({ subtitle:'After confirmation' }));
        assert.equal(await page.getByText('Change saved.', { exact:true }).isVisible(), true);
        assert.equal(await undo.isEnabled(), true);
        assert.deepEqual(await page.evaluate(() => window.mounts), ['first']);
        assert.deepEqual(await page.evaluate(() => window.disposals), []);

        // Undo keeps the confirmed old value, and its later query snapshot agrees.
        await undo.click();
        await page.evaluate(() => window.pending.resolve({ confirmed:true, value:'original' }));
        await page.getByText('Saved change undone.', { exact:true }).waitFor();
        await page.evaluate(() => window.snapshot({ summary:'original' }));
        assert.equal(await input.inputValue(), 'original');

        // Also cover a save confirmation arriving before its query snapshot.
        await input.fill('second edit'); await review.click(); await save.click();
        await page.evaluate(() => window.pending.resolve({ confirmed:true, value:'second edit' }));
        await page.getByText('Change saved.', { exact:true }).waitFor();
        assert.equal(await undo.isEnabled(), true);
        await page.evaluate(() => window.snapshot({ summary:'second edit' }));
        assert.equal(await input.inputValue(), 'second edit');
        assert.equal(await page.getByText('Change saved.', { exact:true }).isVisible(), true);
        assert.equal(await undo.isEnabled(), true);

        // Remote changes never silently rebase a dirty/reviewed draft.
        await input.fill('next local draft'); await review.click();
        await page.evaluate(() => window.snapshot({ summary:'remote edit' }));
        assert.equal(await input.inputValue(), 'next local draft');
        assert.equal(await page.locator('.live-summary').textContent(), 'remote edit');
        assert.equal(await save.isVisible(), false);
        assert.equal(await undo.isDisabled(), true);
        assert.equal(await page.getByText('The saved value changed. Review your draft against the latest value or discard it.', { exact:true }).isVisible(), true);
        await review.click();
        assert.equal(await page.locator('.tp-compare del').textContent(), 'remote edit');
        assert.equal(await page.locator('.tp-compare ins').textContent(), 'next local draft');
        assert.equal(await page.evaluate(() => window.calls.length), 3);
        await discard.click();
        assert.equal(await input.inputValue(), 'remote edit');

        // A foreign value can follow our accepted write before its callback.
        await input.fill('accepted local edit'); await review.click(); await save.click();
        await page.evaluate(() => window.snapshot({ summary:'later remote edit' }));
        assert.deepEqual(await page.evaluate(() => window.calls.at(-1)), {
          before:'remote edit', after:'accepted local edit', operationId:'operation-4',
        });
        await page.evaluate(() => window.pending.resolve({ confirmed:true, value:'accepted local edit' }));
        await page.getByText('Change saved.', { exact:true }).waitFor();
        assert.equal(await input.inputValue(), 'accepted local edit');
        assert.equal(await undo.isDisabled(), true);
        assert.equal(await page.locator('.live-summary').textContent(), 'later remote edit');
        await discard.click();
        assert.equal(await input.inputValue(), 'later remote edit');

        // Matching data is not proof that an uncertain operation was accepted.
        await input.fill('uncertain draft'); await review.click(); await save.click();
        await page.evaluate(() => window.snapshot({ summary:'uncertain draft' }));
        await page.evaluate(() => window.pending.reject(Error('reply lost')));
        await page.getByText('Change not confirmed. Inspect the original operation before continuing.', { exact:true }).waitFor();
        await page.evaluate(() => window.snapshot({ summary:'uncertain draft' }));
        assert.equal(await input.isDisabled(), true);
        assert.equal(await review.isDisabled(), true);
        assert.equal(await page.evaluate(() => window.calls.length), 5);
        await page.evaluate(() => window.editor.reconcile('uncertain draft'));
        assert.equal(await input.isEnabled(), true);

        // Actual navigation/removal disposes once; repeated close is harmless.
        await back.click();
        assert.deepEqual(await page.evaluate(() => window.disposals), ['first']);
        assert.equal(new URL(page.url()).searchParams.get('unrelated'), 'kept');
        await page.getByRole('link', { name:'Second record', exact:false }).click();
        await page.evaluate(() => {
          window.records = window.records.filter(record => record.id !== 'second');
          window.collection.setRecords(window.records);
          window.collection.setRecords(window.records.map(record => ({ ...record })));
        });
        assert.equal(await page.getByRole('heading', { name:'Record unavailable' }).isVisible(), true);
        assert.equal(await page.getByText('This record is no longer in the current view. Return to the list.', { exact:true }).count(), 1);
        await page.evaluate(() => { window.collection.close(); window.collection.close(); });
        assert.deepEqual(await page.evaluate(() => window.disposals), ['first', 'second']);
        assert.deepEqual(await page.evaluate(() => window.mounts), ['first', 'second']);
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    });

    await t.test(name + ' equal-valued snapshots during save and undo retain concurrent observations', async () => {
      const context = await browser.newContext({ viewport }), page = await context.newPage(), errors = [];
      page.setDefaultTimeout(5000); page.on('pageerror', error => errors.push(error.message));
      try {
        await page.goto(base);
        await page.evaluate(async () => {
          const { mountInlineReview } = await import('./patterns.mjs');
          const root = document.querySelector('#workspace'); root.replaceChildren();
          window.calls = [];
          const dispatch = change => {
            window.calls.push(change);
            return new Promise(resolve => { window.confirm = resolve; });
          };
          window.editor = mountInlineReview(root, {
            label:'Concurrent summary', value:'original', onSave:dispatch, onUndo:dispatch,
          });
        });
        const input = page.getByLabel('Concurrent summary');
        const review = page.getByRole('button', { name:'Review changes', exact:true });
        const save = page.getByRole('button', { name:'Save reviewed change' });
        const undo = page.getByRole('button', { name:'Undo saved change' });
        const discard = page.getByRole('button', { name:'Discard draft' });
        const conflict = page.getByText('The saved value changed. Review your draft against the latest value or discard it.', { exact:true });

        // A coalesced query can observe a concurrent restoration of the old
        // value without ever observing our accepted intermediate write.
        await input.fill('saved edit'); await review.click(); await save.click();
        await page.evaluate(() => window.editor.observe('original'));
        assert.equal(await input.isDisabled(), true);
        await page.evaluate(() => window.confirm({ confirmed:true, value:'saved edit' }));
        await page.getByText('Change saved.', { exact:true }).waitFor();
        assert.equal(await input.inputValue(), 'saved edit');
        assert.equal(await conflict.isVisible(), true);
        assert.equal(await undo.isDisabled(), true, 'Undo must not be offered against the restored stored value.');
        await discard.click();
        assert.equal(await input.inputValue(), 'original');
        assert.equal(await conflict.isVisible(), false);

        // With no observation during confirmation, retain the original behavior.
        // Idle repetitions of that confirmed value must also remain harmless.
        await input.fill('saved edit'); await review.click(); await save.click();
        await page.evaluate(() => window.confirm({ confirmed:true, value:'saved edit' }));
        await page.getByText('Change saved.', { exact:true }).waitFor();
        await page.evaluate(() => { window.editor.observe('saved edit'); window.editor.observe('saved edit'); });
        assert.equal(await input.inputValue(), 'saved edit');
        assert.equal(await conflict.isVisible(), false);
        assert.equal(await undo.isEnabled(), true);

        // The same rule applies to Undo: a concurrent restoration of the saved
        // edit must survive an older confirmation of the undo operation.
        await undo.click();
        await page.evaluate(() => window.editor.observe('saved edit'));
        await page.evaluate(() => window.confirm({ confirmed:true, value:'original' }));
        await page.getByText('Saved change undone.', { exact:true }).waitFor();
        assert.equal(await input.inputValue(), 'original');
        assert.equal(await conflict.isVisible(), true);
        assert.equal(await undo.isVisible(), false);
        await discard.click();
        assert.equal(await input.inputValue(), 'saved edit');
        assert.equal(await conflict.isVisible(), false);
        assert.deepEqual(await page.evaluate(() => window.calls), [
          { before:'original', after:'saved edit' },
          { before:'original', after:'saved edit' },
          { before:'saved edit', after:'original' },
        ]);
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    });
  }
});
