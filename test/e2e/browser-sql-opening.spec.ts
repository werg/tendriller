// Local deterministic coverage of the live staging SQL fixture over Chronolog v2 (`chronolog/sql` + `sqlite-cas.wasm`).
import { test, expect, type Page } from '@playwright/test';
import { setTimeout as delay } from 'node:timers/promises';
import { agent, claim, client, createPage, deletePage, localPageUrl, openClaimed,
  signInFixture, OTHER_TOKEN } from './local-helpers';
import { openBrowserSqlSpecimen } from './staging-browser-sql';

async function expectAppliedAndReplicated(source: Page, target: Page, text: string) {
  try {
    await expect(source.locator('#status')).toHaveText(/Applied here|Shared with another device/, { timeout: 15_000 });
    await expect(target.getByText(text, { exact: true })).toBeVisible();
  } catch (error) {
    const inspect = (page: Page) => page.evaluate(() => (window as any).inspectAcceptanceState?.()).catch(() => null);
    const [sender, receiver] = await Promise.all([inspect(source), inspect(target)]);
    throw new Error(`SQL applied/replicated observation failed: ${JSON.stringify({ sender, receiver })}`, { cause: error });
  }
}

for (const slowPeer of ['none', 'owner', 'guest', 'cold-sql'] as const) {
  const isPrivate = slowPeer === 'owner' || slowPeer === 'guest';
  test(`SQL opening: ${isPrivate ? `private correction with delayed ${slowPeer}` : `checklist and reopen (${slowPeer})`}`, async ({ page, context, browser }) => {
    const consumer = process.env.E2E_CHRONOLOG_CONSUMER;
    const handle = await createPage(), guest = await browser.newContext({ ignoreHTTPSErrors: true });
    let delayedReads = 0, delayedSqlLoads = 0, delayedSqlElapsedMs = 0;
    try {
      if (slowPeer === 'cold-sql') await context.route('**/*.wasm', async route => {
        const requestedAt = Date.now(), response = await route.fetch();
        const body = await response.body(), headers = { ...response.headers() };
        delete headers['content-encoding']; delete headers['content-length'];
        if (delayedSqlLoads === 0) {
          delayedSqlLoads++;
          while (Date.now() < requestedAt + 21_000) await delay(Math.max(1, requestedAt + 21_000 - Date.now()));
          delayedSqlElapsedMs = Date.now() - requestedAt;
        }
        await route.fulfill({ status: response.status(), headers, body });
      });
      if (isPrivate || slowPeer === 'cold-sql') await (slowPeer === 'guest' ? guest : context).route('**/_tendril/application', async route => {
        if (route.request().method() !== 'GET' || route.request().headers()['x-sql-fixture-read'] !== 'application') return route.continue();
        const response = await route.fetch();
        delayedReads++;
        await delay(slowPeer === 'cold-sql' ? 6_000 : 12_000);
        await route.fulfill({ response });
      });
      await signInFixture(context); await claim(context, handle); await openClaimed(page, handle);
      const invitation = await agent(handle, '/links', 'POST', { role: 'guest' });
      expect(invitation.status).toBe(201);
      await signInFixture(guest, OTHER_TOKEN);
      const second = await guest.newPage(), guestHandle = { ...handle, page_url: invitation.data.url };
      await claim(guest, guestHandle); await second.goto(localPageUrl(guestHandle));
      await expect(second.getByRole('heading')).toHaveText(/is getting ready/);
      const fixture = await openBrowserSqlSpecimen({
        consumer,
        peers: client(handle).peers, pageUrl: localPageUrl(handle), applicationId: handle.application.id,
        pages: [page, second], isPrivate, guestAccount: 'e2e-other',
      });
      expect(delayedReads).toBe(slowPeer === 'none' ? 0 : 1);
      const startup = await page.evaluate(() => (window as any).inspectAcceptanceState?.());
      console.info('SQL_FIXTURE_STARTUP', JSON.stringify(startup));
      expect(startup.viewReads, 'One coherent initial read, with no post-Ready duplicate').toBe(1);
      const guestState = await second.evaluate(() => (window as any).inspectAcceptanceState?.());
      expect(guestState.viewReads).toBeGreaterThanOrEqual(1);
      expect(guestState.duplicateViewReads, 'No redundant reread of a displayed revision').toBe(0);
      if (isPrivate) {
        for (const answer of ['First answer', 'Corrected answer']) {
          await page.getByRole('textbox', { name: 'Your answer' }).fill(answer);
          await page.getByRole('button', { name: 'Save answer' }).click();
          await expectAppliedAndReplicated(page, second, `Current answer: ${answer}`);
        }
        await expect(second.getByRole('textbox', { name: 'Your answer' })).toHaveCount(0);
      } else {
        await page.getByLabel('Task title').fill('Retained SQL task');
        await page.getByRole('button', { name: 'Add task' }).click();
        await expectAppliedAndReplicated(page, second, 'Retained SQL task · Open');
        await second.getByRole('button', { name: 'Claim task' }).click();
        await expectAppliedAndReplicated(second, page, 'Retained SQL task · Claimed by a teammate');
        await guest.setOffline(true);
        await context.unroute('**/*.wasm');
        const reopened = await fixture.reopenFirst();
        await expect(reopened.getByText('Retained SQL task · Claimed by a teammate', { exact: true })).toBeVisible();
        expect(delayedSqlLoads).toBe(slowPeer === 'cold-sql' ? 1 : 0);
        if (slowPeer === 'cold-sql') expect(delayedSqlElapsedMs).toBeGreaterThanOrEqual(21_000);
      }
    } finally { await guest.close(); await deletePage(handle); }
  });
}
