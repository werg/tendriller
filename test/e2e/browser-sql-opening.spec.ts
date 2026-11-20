// Local deterministic coverage of the live staging SQL fixture. Supply the
// matching SQL-enabled E2E_CHRONOLOG_CONSUMER and E2E_CHRONOLOG_WASM artifacts.
import { test, expect } from '@playwright/test';
import { setTimeout as delay } from 'node:timers/promises';
import { agent, claim, client, createPage, deletePage, localPageUrl, openClaimed,
  signInFixture, OTHER_TOKEN } from './local-helpers';
import { openBrowserSqlSpecimen } from './staging-browser-sql';

for (const slowPeer of ['none', 'owner', 'guest'] as const) {
  const isPrivate = slowPeer !== 'none';
  test(`SQL opening: ${isPrivate ? `private correction with delayed ${slowPeer}` : 'checklist and reopen'}`, async ({ page, context, browser }) => {
    const consumer = process.env.E2E_CHRONOLOG_CONSUMER, engineDirectory = process.env.E2E_CHRONOLOG_WASM;
    expect(consumer, 'Supply the matching combined SQL session consumer').toBeTruthy();
    expect(engineDirectory, 'Supply its verified browser engine').toBeTruthy();
    const handle = await createPage(), guest = await browser.newContext({ ignoreHTTPSErrors: true });
    let delayedReads = 0;
    try {
      if (slowPeer !== 'none') await (slowPeer === 'owner' ? context : guest).route('**/_tendril/peers/participant', async route => {
        const body = route.request().postDataJSON();
        if (body?.facet !== 'publication' || body?.action !== 'definition') return route.continue();
        const response = await route.fetch();
        delayedReads++;
        // Beyond the unchanged physical transport's 10s opening deadline,
        // within the fixture's existing 25s session-preparation deadline.
        await delay(12_000);
        await route.fulfill({ response });
      });
      await signInFixture(context); await claim(context, handle); await openClaimed(page, handle);
      const invitation = await agent(handle, '/links', 'POST', { role: 'guest' });
      expect(invitation.status).toBe(201);
      await signInFixture(guest, OTHER_TOKEN);
      const second = await guest.newPage(), guestHandle = { ...handle, page_url: invitation.data.url };
      await second.goto(localPageUrl(guestHandle));
      await second.getByRole('button', { name: 'Request access' }).click();
      const management = await context.newPage();
      try {
        await management.goto(new URL('_tendril/manage', localPageUrl(handle)).href);
        await management.getByRole('button', { name: 'Approve', exact: true }).click();
        await expect(management.getByRole('status')).toHaveText('Guest access approved.');
      } finally { await management.close(); }
      // The local fixture helper retains port 8790 across auth redemption.
      await claim(guest, guestHandle); await second.goto(localPageUrl(guestHandle));
      await expect(second.getByRole('heading')).toHaveText(/is getting ready/);
      const fixture = await openBrowserSqlSpecimen({ consumer: consumer!, engineDirectory: engineDirectory!,
        peers: client(handle).peers, pageUrl: localPageUrl(handle), applicationId: handle.application.id,
        pages: [page, second], isPrivate, guestAccount: 'e2e-other' });
      expect(delayedReads).toBe(isPrivate ? 1 : 0);
      if (isPrivate) {
        for (const answer of ['First answer', 'Corrected answer']) {
          await page.getByRole('textbox', { name: 'Your answer' }).fill(answer);
          await page.getByRole('button', { name: 'Save answer' }).click();
          await expect(page.locator('#status')).toHaveText(/Applied here|Shared with another device/);
          await expect(second.getByText(`Current answer: ${answer}`, { exact: true })).toBeVisible();
        }
        await expect(second.getByRole('textbox', { name: 'Your answer' })).toHaveCount(0);
      } else {
        await page.getByLabel('Task title').fill('Retained SQL task');
        await page.getByRole('button', { name: 'Add task' }).click();
        await expect(second.getByText('Retained SQL task · Open', { exact: true })).toBeVisible();
        await second.getByRole('button', { name: 'Claim task' }).click();
        await expect(page.getByText('Retained SQL task · Claimed by a teammate', { exact: true })).toBeVisible();
        await guest.setOffline(true);
        const reopened = await fixture.reopenFirst();
        await expect(reopened.getByText('Retained SQL task · Claimed by a teammate', { exact: true })).toBeVisible();
      }
    } finally { await guest.close(); await deletePage(handle); }
  });
}
