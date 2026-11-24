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
        await editor.fill('Verified the order and prepared a carrier message for review.');
        await page.getByRole('button', { name:'Review changes', exact:true }).click();
        assert.equal(await page.getByRole('group', { name:'Review changes' }).isVisible(), true);
        assert.equal(await page.locator('.tp-compare del').textContent(), original);
        await screenshot(page, name);
        await page.getByRole('button', { name:'Save reviewed change' }).click();
        assert.equal(await page.getByText('Change saved.', { exact:true }).isVisible(), true);
        await page.getByRole('button', { name:'Undo saved change' }).click();
        assert.equal(await editor.inputValue(), original);
        await page.getByRole('button', { name:'Back to list' }).click();
        assert.equal(new URL(page.url()).searchParams.has('item'), false);
        await page.goBack();
        assert.equal(await page.getByRole('heading', { name:'The missing delivery', exact:true }).isVisible(), true);
        await page.reload();
        assert.equal(await page.getByRole('heading', { name:'The missing delivery', exact:true }).isVisible(), true);
        // Unknown deep links offer recovery rather than an empty inspector.
        await page.goto(base + '?item=missing');
        assert.equal(await page.getByRole('heading', { name:'Record unavailable' }).isVisible(), true);
        await page.getByRole('button', { name:'Back to list' }).click();
        assert.equal(await search.isVisible(), true);
        await page.goto(base + '?states=1');
        assert.equal(await page.getByRole('button', { name:'Approve this browser' }).count(), 1);
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
});
