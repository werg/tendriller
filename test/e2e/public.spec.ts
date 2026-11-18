import { expect, test, type Page } from '@playwright/test';
import { createClient } from '../../dist/sdk/client.mjs';
import { publishAssetGraph } from './publication-helpers';
import { staging, stagingSession } from './staging-session';

type Handle = { id: string; page_url: string; api: string; token: string; application: { id: string } };
const client = (handle: Handle) => createClient(handle, { applicationId: handle.application.id });
const handles: Handle[] = [];
let owner: ReturnType<typeof stagingSession>;

test.beforeAll(() => { owner = stagingSession(); });
test.beforeEach(async ({ context }) => { await owner.signIn(context); });
test.afterEach(async () => {
  const failed = [];
  for (const handle of handles) {
    const response = await fetch(handle.api, { method: 'DELETE', headers: { Authorization: `Bearer ${handle.token}` } });
    if (!response.ok && response.status !== 404) failed.push(handle);
  }
  handles.splice(0, handles.length, ...failed);
  expect(failed.map(handle => handle.id), 'staging test pages pending cleanup').toEqual([]);
});
test.afterAll(() => { owner?.close(); });

async function createPage(name: string): Promise<Handle> {
  const response = await fetch(`${staging}/api/tendrils`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, owner: owner.email }) });
  expect(response.status, `Page creation returned HTTP ${response.status}`).toBe(201);
  const handle = await response.json() as Handle;
  handles.push(handle);
  expect(new URL(handle.api).origin).toBe(staging);
  return handle;
}

async function openHoldingPage(page: Page, handle: Handle) {
  await page.goto(handle.page_url);
  await expect(page.getByRole('heading')).toHaveText(/is getting ready/);
  expect(new URL(page.url()).origin).toBe(new URL(handle.page_url).origin);
}

function publish(peers: ReturnType<typeof client>['peers'], name: string) {
  return publishAssetGraph(peers, {
    'index.html': { type: 'text/html', body: `<!doctype html><html lang="en"><meta charset="utf-8"><title>Staging test</title><main><h1>${name}</h1></main></html>` },
  });
}

test('owner claim, retry after a failed readiness request, signed publication, reload and live invitations', async ({ page, browser }) => {
  const handle = await createPage('First publication');
  const anonymous = await browser.newContext();
  try {
    const response = await anonymous.request.get(handle.page_url, { maxRedirects: 0 });
    expect(response.status()).toBe(302);
    expect(new URL(response.headers().location, handle.page_url).origin).toBe(staging);
  } finally {
    await anonymous.close();
  }

  let requests = 0;
  await page.route('**/_tendril/publication-ready', route => {
    requests++;
    return requests === 1 ? route.fulfill({ status: 503 }) : route.continue();
  });
  await openHoldingPage(page, handle);
  await expect(page.getByRole('status')).toContainText('Retrying automatically');
  const peers = client(handle).peers;
  const release = await publish(peers, 'First signed release');
  await expect(page.getByRole('heading', { name: 'First signed release' })).toBeVisible();
  expect(requests).toBeGreaterThan(1);
  expect((await peers.publication())?.publication.id).toBe(release.publication.id);

  const listener = peers.listenInvitations('agent-staging-validation');
  try {
    await listener.ready;
    await page.evaluate(async () => {
      const peers = (window as any).tendril.host.peers;
      const browserListener = peers.listenInvitations('browser-staging-validation');
      (window as any).browserInvitation = browserListener.invitations[Symbol.asyncIterator]().next();
      await browserListener.ready;
      await peers.invite('agent-staging-validation', { channel: 'from-browser', requesterPeerId: 'browser-staging-validation' });
    });
    const incoming = await listener.invitations[Symbol.asyncIterator]().next();
    expect(incoming.value).toMatchObject({ channel: 'from-browser', requesterPeerId: 'browser-staging-validation' });
    await peers.invite('browser-staging-validation', { channel: 'from-agent', requesterPeerId: 'agent-staging-validation' });
    expect(await page.evaluate(async () => (await (window as any).browserInvitation).value))
      .toMatchObject({ channel: 'from-agent', requesterPeerId: 'agent-staging-validation' });
  } finally {
    listener.close();
  }

  await publish(peers, 'Second signed release');
  await expect(page.getByRole('heading')).toHaveText('First signed release');
  await page.reload();
  await expect(page.getByRole('heading')).toHaveText('Second signed release');
});

test('signed page origins isolate storage and reject sibling participant requests', async ({ page, context }) => {
  const a = await createPage('Origin one'), b = await createPage('Origin two');
  const other = await context.newPage();
  await openHoldingPage(page, a);
  await openHoldingPage(other, b);
  await publish(client(a).peers, 'Origin one');
  await publish(client(b).peers, 'Origin two');
  await expect(page.getByRole('heading', { name: 'Origin one', exact: true })).toBeVisible();
  await expect(other.getByRole('heading', { name: 'Origin two', exact: true })).toBeVisible();
  expect(new URL(page.url()).origin).not.toBe(new URL(other.url()).origin);
  await page.evaluate(() => localStorage.setItem('isolation-proof', 'from-a'));
  expect(await other.evaluate(() => localStorage.getItem('isolation-proof'))).toBeNull();

  const endpoint = `${b.page_url}_tendril/peers/participant`;
  const blocked = page.waitForResponse(response => response.url() === endpoint && response.request().method() === 'POST');
  await page.evaluate(async ({ endpoint, applicationId }) => {
    await fetch(endpoint, { method: 'POST', credentials: 'include', mode: 'no-cors', body: JSON.stringify({
      protocol: 'chronolog-participant-v1', applicationId, requestId: 'sibling-origin', facet: 'publication', action: 'read', payload: {},
    }) }).catch(() => {});
  }, { endpoint, applicationId: b.application.id });
  expect((await blocked).status()).toBe(403);
});
