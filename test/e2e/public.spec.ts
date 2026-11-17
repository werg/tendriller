import { expect, test, type Page } from '@playwright/test';
import { createClient } from '../../dist/sdk/client.mjs';
import { publishAssetGraph } from './publication-helpers';

type Handle = { id: string; page_url: string; api: string; token: string; application: { id: string } };
const base = process.env.E2E_SERVICE_BASE, owner = process.env.E2E_OWNER_EMAIL;
if (!base || !owner || new URL(base).protocol !== 'https:') {
  throw new Error('Set E2E_SERVICE_BASE and E2E_OWNER_EMAIL for a staging owner account');
}

async function makePage(page: Page, name: string): Promise<Handle> {
  const response = await fetch(`${base}/api/tendrils`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, owner }) });
  expect(response.status, await response.clone().text()).toBe(201);
  const handle = await response.json() as Handle;
  // The supplied staging account must actually claim this invitation before configuring authority.
  await page.goto(handle.page_url);
  await page.waitForURL(url => url.origin === new URL(handle.page_url).origin);
  await publishAssetGraph(createClient(handle, { applicationId: handle.application.id }).peers, {
    'index.html': { type: 'text/html', body: `<!doctype html><html><head><title>${name}</title></head><body><h1>${name}</h1></body></html>` },
  });
  await page.goto(handle.page_url);
  return handle;
}

test('signed pages isolate storage and sessions and reject sibling participant mutations', async ({ page, context }) => {
  const handles: Handle[] = [];
  try {
    const first = await makePage(page, `Isolation A ${Date.now()}`); handles.push(first);
    await expect(page.locator('body')).toContainText('Isolation A');
    await page.evaluate(() => localStorage.setItem('isolation-proof', 'from-a'));
    const other = await context.newPage();
    const second = await makePage(other, `Isolation B ${Date.now()}`); handles.push(second);
    expect(new URL(first.page_url).origin).not.toBe(new URL(second.page_url).origin);
    await expect(other.locator('body')).toContainText('Isolation B');
    expect(await other.evaluate(() => localStorage.getItem('isolation-proof'))).toBeNull();

    await page.evaluate(domain => { document.cookie = `__Host-tendril=forged; Domain=${domain}; Path=/; Secure`; },
      new URL(first.page_url).hostname.split('.').slice(1).join('.'));
    await other.reload();
    await expect(other.locator('body')).toContainText('Isolation B');

    const endpoint = `${second.page_url}_tendril/peers/participant`;
    const blocked = page.waitForResponse(response => response.url() === endpoint && response.request().method() === 'POST');
    await page.evaluate(async ({ endpoint, applicationId }) => {
      await fetch(endpoint, { method: 'POST', credentials: 'include', mode: 'no-cors', body: JSON.stringify({
        protocol: 'chronolog-participant-v1', applicationId, requestId: 'sibling-origin', facet: 'publication', action: 'read', payload: {},
      }) }).catch(() => {});
    }, { endpoint, applicationId: second.application.id });
    expect((await blocked).status()).toBe(403);
  } finally {
    await Promise.allSettled(handles.map(handle => fetch(handle.api, { method: 'DELETE', headers: { Authorization: `Bearer ${handle.token}` } })));
  }
});
