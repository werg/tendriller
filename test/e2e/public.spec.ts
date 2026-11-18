import { expect, test, type Page } from '@playwright/test';
import { setTimeout as delay } from 'node:timers/promises';
import { createClient } from '../../dist/sdk/client.mjs';
import { publishAssetGraph } from './publication-helpers';
import { staging, stagingSession } from './staging-session';

type Handle = { id: string; page_url: string; api: string; token: string; application: { id: string } };
const client = (handle: Handle) => createClient(handle, { applicationId: handle.application.id });
const handles: Handle[] = [];
const createAttempts: number[] = [];
let owner: ReturnType<typeof stagingSession>;

test.beforeAll(() => { owner = stagingSession(); });
test.beforeEach(async ({ context }) => { await owner.signIn(context); });
async function cleanPages() {
  const failed = await Promise.all(handles.map(async handle => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(handle.api, { method: 'DELETE', signal: AbortSignal.timeout(5_000),
          headers: { Authorization: `Bearer ${handle.token}` } });
        if (response.ok || response.status === 404) return null;
      } catch { /* Retry a lost deletion response with the same handle. */ }
      if (attempt < 2) await delay(500);
    }
    return handle;
  }));
  handles.splice(0, handles.length, ...failed.filter((handle): handle is Handle => handle !== null));
}
test.afterEach(async () => {
  await cleanPages();
  expect(handles.map(handle => handle.id), 'staging test pages pending cleanup').toEqual([]);
});
test.afterAll(async () => {
  await cleanPages();
  owner?.close();
  expect(handles.map(handle => handle.id), 'staging test pages pending final cleanup').toEqual([]);
});

async function createPage(name: string): Promise<Handle> {
  // Staging allows five creations per minute per runner IP.
  if (createAttempts.length === 5) {
    const first = createAttempts.shift()!;
    await delay(Math.max(0, first + 61_000 - Date.now()));
  }
  createAttempts.push(Date.now());
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
  await expect(page.getByRole('heading', { name: 'First signed release' })).toBeVisible({ timeout: 25_000 });
  expect(requests).toBeGreaterThan(1);
  expect(await peers.publication()).toEqual(release);

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
  await page.reload();
  await expect(page.getByRole('heading')).toHaveText('First signed release');
  await page.getByRole('link', { name: 'Open latest version' }).click();
  await expect(page.getByRole('heading')).toHaveText('Second signed release');
});

test('signed page origins isolate storage and reject sibling participant requests', async ({ page, context }) => {
  const a = await createPage('Origin one'), b = await createPage('Origin two');
  const other = await context.newPage();
  await openHoldingPage(page, a);
  await openHoldingPage(other, b);
  await publish(client(a).peers, 'Origin one');
  await publish(client(b).peers, 'Origin two');
  await expect(page.getByRole('heading', { name: 'Origin one', exact: true })).toBeVisible({ timeout: 25_000 });
  await expect(other.getByRole('heading', { name: 'Origin two', exact: true })).toBeVisible({ timeout: 25_000 });
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

test('Chronolog SQL peers share guarded changes, recover and reopen through the live host', async ({ page }) => {
  const consumer = process.env.E2E_CHRONOLOG_CONSUMER;
  test.skip(!consumer, 'Install an exact --sql-native Chronolog archive and set E2E_CHRONOLOG_CONSUMER');
  const { runStagingSql } = await import('./staging-sql');
  const handle = await createPage('Chronolog shared task board');
  await openHoldingPage(page, handle);
  await runStagingSql({ consumer: consumer!, handle, page, peers: client(handle).peers });
});

test('field inspection keeps a photo and notes through offline reload and reconnect', async ({ page, context }) => {
  const { readFile } = await import('node:fs/promises');
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => {
    if (new URL(response.url()).pathname.endsWith('/inspection.mjs') && !response.ok()) errors.push(`Inspection module HTTP ${response.status()}`);
  });
  const handle = await createPage('Field inspection');
  await openHoldingPage(page, handle);
  await publishAssetGraph(client(handle).peers, {
    'index.html': { type: 'text/html', body: await readFile('test/e2e/specimens/inspection.html', 'utf8') },
    'inspection.mjs': { type: 'text/javascript', body: await readFile('test/e2e/specimens/inspection.mjs', 'utf8') },
  });
  await expect(page.getByRole('heading', { name: 'Field inspection', exact: true })).toBeVisible({ timeout: 25_000 });
  await expect(page.locator('main')).toHaveAttribute('data-ready', 'true', { timeout: 10_000 }).catch(error => {
    throw new Error(`Inspection UI failed to start: ${errors.join('; ') || 'no browser error recorded'}`, { cause: error });
  });
  const status = page.locator('#result');
  await page.getByRole('button', { name: 'Keep this page available offline' }).click();
  await expect(status).toHaveText('This page is available offline.', { timeout: 25_000 });
  await context.setOffline(true);
  try {
    await page.getByLabel('Inspection notes').fill('Left hinge needs inspection');
    await page.getByLabel('Evidence photo').setInputFiles({ name: 'hinge.png', mimeType: 'image/png',
      buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=', 'base64') });
    await page.getByRole('button', { name: 'Save draft on this device' }).click();
    await expect(status).toHaveText('Draft saved on this device.');
    await page.reload();
    await expect(page.getByLabel('Inspection notes')).toHaveValue('Left hinge needs inspection');
    await expect(page.getByRole('img', { name: 'Inspection evidence' })).toBeVisible();
    await expect.poll(() => page.locator('#preview').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
    await expect(status).toHaveText('Restored your local draft.');
  } finally {
    await context.setOffline(false);
  }
  await page.reload();
  await expect(page.getByLabel('Inspection notes')).toHaveValue('Left hinge needs inspection');
  await page.getByLabel('Evidence photo').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Not a photo') });
  await page.getByRole('button', { name: 'Save draft on this device' }).click();
  await expect(status).toHaveText('Choose a PNG or JPEG under 512 KB.');
  await page.reload();
  await expect(page.getByLabel('Inspection notes')).toHaveValue('Left hinge needs inspection');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export saved draft' }).click();
  const exported = await (await download).path();
  expect(exported).toBeTruthy();
  await page.getByRole('button', { name: 'Discard local draft' }).click();
  await page.reload();
  await expect(page.getByLabel('Inspection notes')).toBeEmpty();
  await expect(page.getByRole('img', { name: 'Inspection evidence' })).toBeHidden();
  await page.getByLabel('Restore exported draft').setInputFiles(exported!);
  await expect(status).toHaveText('Exported draft restored on this device.');
  await expect(page.getByLabel('Inspection notes')).toHaveValue('Left hinge needs inspection');
  await expect.poll(() => page.locator('#preview').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  await context.grantPermissions(['camera'], { origin: new URL(handle.page_url).origin });
  await page.getByRole('button', { name: 'Take evidence photo' }).click();
  await expect(status).toHaveText('Photo captured. Save the draft to keep it on this device.').catch(async error => {
    throw new Error(`Virtual camera failed: ${await status.getAttribute('data-camera-error') || 'no error recorded'}`, { cause: error });
  });
  expect(await page.locator('#preview').getAttribute('src')).toMatch(/^data:image\/jpeg/);
  await expect.poll(() => page.evaluate(() => (window as any).tendril.sensors.status().active)).not.toContain('camera');
  await page.getByRole('button', { name: 'Save draft on this device' }).click();
  await expect(status).toHaveText('Draft saved on this device.');
  await page.reload();
  expect(await page.locator('#preview').getAttribute('src')).toMatch(/^data:image\/jpeg/);
  await page.getByRole('button', { name: 'Discard local draft' }).click();
});

test('private intake permits a correction and rejects a stale or unauthorized edit', async ({ page, browser }) => {
  const consumer = process.env.E2E_CHRONOLOG_CONSUMER;
  test.skip(!consumer, 'Install an exact --sql-native Chronolog archive and set E2E_CHRONOLOG_CONSUMER');
  const { runStagingSql } = await import('./staging-sql');
  const handle = await createPage('Private intake');
  await openHoldingPage(page, handle);
  const outsider = stagingSession();
  const context = await browser.newContext();
  try {
    await outsider.signIn(context);
    const response = await context.request.get(handle.page_url);
    expect(response.status()).toBe(403);
  } finally {
    await context.close();
    outsider.close();
  }
  await runStagingSql({ consumer: consumer!, handle, page, peers: client(handle).peers, privateIntake: true });
});

for (const isPrivate of [false, true]) {
  test(`real Chromium SQL: ${isPrivate ? 'private intake correction' : 'shared checklist and reopen'}`, async ({ page, browser }) => {
    const consumer = process.env.E2E_CHRONOLOG_CONSUMER, engineDirectory = process.env.E2E_CHRONOLOG_WASM;
    test.skip(!consumer || !engineDirectory, 'Requires the combined SQL archive and a verified browser engine');
    const { openBrowserSqlSpecimen } = await import('./staging-browser-sql');
    const handle = await createPage(isPrivate ? 'Browser intake' : 'Browser checklist');
    const secondContext = await browser.newContext();
    const guest = stagingSession();
    try {
      await guest.signIn(secondContext);
      const second = await secondContext.newPage();
      await openHoldingPage(page, handle);
      const invitation = await fetch(`${handle.api}/links`, { method: 'POST',
        headers: { Authorization: `Bearer ${handle.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'guest', label: 'Acceptance guest' }) });
      expect(invitation.status).toBe(201);
      const { url: guestUrl } = await invitation.json();
      await second.goto(guestUrl);
      await test.step('Guest requests access', async () => {
        await second.getByRole('button', { name: 'Request access' }).click();
        await expect(second.locator('#claim-status')).toBeVisible();
      });
      const management = await page.context().newPage();
      try {
        await management.goto(new URL('_tendril/manage', handle.page_url).href);
        await expect(management.getByRole('heading', { name: 'Guest requests' })).toBeVisible();
        await expect(management.getByText(guest.email, { exact: true })).toBeVisible();
        await management.getByRole('button', { name: 'Approve', exact: true }).click();
        await expect(management.getByRole('status')).toHaveText('Guest access approved.');
      } finally { await management.close(); }
      await expect(second.getByRole('heading')).toHaveText(/is getting ready/, { timeout: 20_000 });
      const fixture = await test.step('Publish and open browser SQL peers', () => openBrowserSqlSpecimen({ consumer: consumer!, engineDirectory: engineDirectory!,
        peers: client(handle).peers, pageUrl: handle.page_url, applicationId: handle.application.id,
        pages: [page, second], isPrivate, guestAccount: guest.id }));
      if (isPrivate) {
        await page.getByRole('textbox', { name: 'Your answer' }).fill('First answer');
        await page.getByRole('button', { name: 'Save answer' }).click();
        await expect(second.getByText('Current answer: First answer')).toBeVisible();
        await expect(second.getByRole('textbox', { name: 'Your answer' })).toHaveCount(0);
        await page.getByRole('textbox', { name: 'Your answer' }).fill('Corrected answer');
        await page.getByRole('button', { name: 'Save answer' }).click();
        await expect(second.getByText('Current answer: Corrected answer')).toBeVisible();
      } else {
        await page.getByLabel('Task title').fill('Check the spare tire');
        await page.getByRole('button', { name: 'Add task' }).click();
        await expect(second.getByText('Check the spare tire · Open')).toBeVisible();
        await second.getByRole('button', { name: 'Claim task' }).click();
        await expect(page.getByText('Check the spare tire · Claimed by a teammate')).toBeVisible();
        await expect(page.getByRole('button', { name: 'Claim task' })).toBeDisabled();
        await second.getByRole('button', { name: 'Complete task' }).click();
        await expect(page.getByText('Check the spare tire · Done')).toBeVisible();
        await fixture.reopenFirst();
        await expect(page.getByText('Check the spare tire · Done')).toBeVisible();
      }
    } finally {
      await secondContext.close();
      guest.close();
    }
  });
}
