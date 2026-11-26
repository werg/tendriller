// Real tutorial qualification. No specimen UI/domain, injected application
// backend, mocked command, preseeded browser key, or substitute transport.
import { test, expect, type Page } from '@playwright/test';
import { deletePage, openClaimed, signInFixture } from './local-helpers';
import { prepareSqlTutorial } from './sql-tutorial-fixture';

async function stock(page: Page, source: number, destination: number) {
  await expect(page.locator('#stock tr').filter({ has: page.getByRole('link', { name: 'source', exact: true }) })).toHaveText(`source${source}`, { timeout: 30_000 });
  await expect(page.locator('#stock tr').filter({ has: page.getByRole('link', { name: 'destination', exact: true }) })).toHaveText(`destination${destination}`, { timeout: 30_000 });
}
async function publishedGraph(page: Page, app: { publication: any; publicationVersion: number }) {
  const hosted = await page.evaluate(() => ({
    version: (window as any).tendril.identity.version,
    publication: (window as any).tendril.identity.publication,
    manifest: (window as any).__TENDRIL__.publication,
  }));
  expect(hosted.version).toBe(app.publicationVersion);
  expect(hosted.publication).toBe(String(app.publicationVersion));
  expect(hosted.manifest.id).toBe(String(app.publicationVersion));
  expect(hosted.manifest.entry).toBe('index.html');
}
async function nativeStock(native: { query(name: string, input: null): Promise<{ value: any }> }) {
  try { return (await native.query('inventory', null)).value.stock; }
  catch (error) { return { viewError: (error as Error).message }; }
}
async function retainUncertainIntent(page: Page, intent: Record<string, unknown>) {
  await page.evaluate(({ intent }) => {
    const draft = Object.keys(localStorage).find(key => /^chronolog:view:.+:draft:/.test(key));
    if (!draft) throw new Error('The page has not retained any local draft yet');
    const prefix = draft.slice(0, draft.indexOf(':draft:') + ':draft:'.length);
    const read = (name: string) => { try { return JSON.parse(localStorage.getItem(prefix + name) ?? 'null'); } catch { return null; } };
    localStorage.setItem(prefix + 'intents', JSON.stringify({ ...(read('intents') ?? {}), [intent.operationId as string]: intent }));
    localStorage.setItem(prefix + 'selected-operation', JSON.stringify(intent.operationId));
  }, { intent });
}
async function proposalOf(page: Page) {
  const text = await page.locator('#result').innerText();
  return /^Proposal ([a-f0-9]{64})$/m.exec(text)?.[1];
}

test('actual SQL inventory page: signed publication, browser-first initialization, automatic agent admission, replication and exact retained retry', async ({ page, context }, testInfo) => {
  test.setTimeout(240_000);
  const consumer = process.env.E2E_CHRONOLOG_CONSUMER;
  let fixture: Awaited<ReturnType<typeof prepareSqlTutorial>> | undefined;
  try {
    await test.step('create, prepare, build and sign the inventory page before claim', async () => {
      fixture = await prepareSqlTutorial(consumer);
    });
    const app = fixture!, handle = app.handle;
    await testInfo.attach('sql-tutorial-public-graph', { contentType: 'application/json', body: Buffer.from(JSON.stringify({
      session: app.sessionProvenance, publication: app.publication, hostVersion: app.publicationVersion,
      limits: ['Synthetic local owner, not live OAuth or Internet NAT.'],
    }, null, 2)) });
    await signInFixture(context); await openClaimed(page, handle);
    await expect(page.getByRole('heading', { name: 'Shared inventory', exact: true })).toBeVisible();
    await publishedGraph(page, app);
    await expect(page.locator('#initialize')).toBeEnabled({ timeout: 60_000 });
    const browserKey = await page.locator('#public-key').inputValue();
    expect(browserKey).toMatch(/^[a-f0-9]{64}$/);
    expect(app.nativePublicKey).not.toBe(browserKey);
    await expect(page.locator('#summary')).not.toContainText('Loading', { timeout: 30_000 });

    await page.locator('#initialize').click();
    await expect(page.locator('#result')).toContainText('Stored locally: true', { timeout: 30_000 });
    await expect(page.locator('#result')).toContainText('Materialized locally: accepted', { timeout: 30_000 });
    await stock(page, 10, 0);
    await expect(page.locator('#summary')).toContainText('2 bins · 10 total units');
    await expect(page.locator('#summary')).toHaveText(/local snapshot [a-f0-9]{12} \(revisable\)/);

    await test.step('explicit SQL grant for the native key through the starter\'s ordinary permission transaction', async () => {
      const previous = await proposalOf(page);
      await page.locator('#sql-grantee').fill(app.nativePublicKey);
      await page.locator('#sql-grant').click();
      await expect.poll(() => proposalOf(page), { timeout: 30_000 }).not.toBe(previous);
      await expect(page.locator('#result')).toContainText('Stored locally: true', { timeout: 30_000 });
      await expect(page.locator('#result')).toContainText('Materialized locally: accepted', { timeout: 30_000 });
    });
    let native = await app.start();
    expect(native.identity.publicKey).toBe(app.nativePublicKey);
    await test.step('the online browser admits the agent from its signed grant and wraps the page keys (nothing copied)', async () => {
      await expect.poll(() => native.status.canAuthor, { timeout: 60_000 }).toBe(true);
      const key = app.nativePublicKey;
      await expect(page.locator('#devices .admission-members')).toContainText(`agent · key ${key.slice(0, 8)}…${key.slice(-4)}`, { timeout: 30_000 });
    });
    await expect.poll(() => nativeStock(native), { timeout: 30_000 })
      .toEqual([{ id: 'destination', units: 0 }, { id: 'source', units: 10 }]);

    await test.step('browser transfer is stored locally and read by the native participant', async () => {
      await page.locator('#from').fill('source'); await page.locator('#to').fill('destination'); await page.locator('#units').fill('2');
      await page.locator('#review-balances').click();
      await page.getByRole('button', { name: 'Store transfer locally' }).click();
      await expect(page.locator('#result')).toContainText('Materialized locally: accepted', { timeout: 30_000 });
      await expect.poll(async () => {
        const snapshot = await native.query('inventory', null);
        return { stock: snapshot.value.stock, receipts: snapshot.value.transfers.length };
      }, { timeout: 15_000 }).toEqual({ stock: [{ id: 'destination', units: 2 }, { id: 'source', units: 8 }], receipts: 1 });
      await stock(page, 8, 2);
    });
    await test.step('native transfer reaches the real browser Worker and live view', async () => {
      const operation = await native.command('transfer', { transferId: 'sql-ui-native-return', from: 'destination', to: 'source',
        units: 1, expectedSource: 2, expectedDestination: 8 }, { operationId: 'sql-ui-native-return' });
      expect((await operation.materialized({ signal: AbortSignal.timeout(15_000) })).outcome).toBe('accepted');
      await stock(page, 9, 1);
    });
    const uncertainId = 'sql-ui-uncertain';
    await test.step('an exact retained intent survives reload and retries under its original identity', async () => {
      await retainUncertainIntent(page, { operationId: uncertainId, command: 'transfer', input: { transferId: 'sql-ui-uncertain-receipt',
        from: 'source', to: 'destination', units: 1, expectedSource: 9, expectedDestination: 1 } });
      await page.reload();
      await expect(page.locator('#public-key')).toHaveValue(browserKey, { timeout: 60_000 });
      await expect(page.locator('#op-id')).toHaveValue(uncertainId);
      await expect(page.locator('#retry')).toBeEnabled({ timeout: 60_000 });
      await expect(page.getByRole('button', { name: 'Store transfer locally' })).toBeEnabled();
      await page.locator('#retry').click();
      await expect(page.locator('#result')).toContainText(`Operation ${uncertainId}`, { timeout: 30_000 });
      await expect(page.locator('#result')).toContainText('Materialized locally: accepted', { timeout: 30_000 });
      const proposal = await proposalOf(page);
      expect(proposal).toMatch(/^[a-f0-9]{64}$/);
      await expect.poll(async () => (await native.query('inventory', null)).value.transfers.filter((row: any) => row.id === 'sql-ui-uncertain-receipt').length, { timeout: 15_000 }).toBe(1);
      await page.locator('#inspect').click();
      await expect(page.locator('#result')).toContainText(`Operation ${uncertainId}`);
      expect(await proposalOf(page)).toBe(proposal);
      await stock(page, 8, 2);
    });
    await test.step('reopened native SQLite-CAS device reproduces exact state and receipts', async () => {
      await expect.poll(async () => {
        const { value } = await native.query('inventory', null);
        return { receipts: value.transfers.length, uncertain: value.transfers.filter((row: any) => row.id === 'sql-ui-uncertain-receipt').length };
      }, { timeout: 15_000 }).toEqual({ receipts: 3, uncertain: 1 });
      await page.reload();
      await expect(page.locator('#initialize')).toBeEnabled({ timeout: 60_000 });
      await expect(page.locator('#public-key')).toHaveValue(browserKey);
      await stock(page, 8, 2);
      await publishedGraph(page, app);
      const beforeReopen = await native.query('inventory', null);
      await page.close(); await app.stop();
      expect(await app.deviceExists()).toBe(true);
      native = await app.start();
      expect(native.identity.publicKey).toBe(app.nativePublicKey);
      const replayed = await native.query('inventory', null);
      expect(replayed.value).toEqual(beforeReopen.value);
      expect(replayed.value.stock).toEqual([{ id: 'destination', units: 2 }, { id: 'source', units: 8 }]);
      expect(replayed.value.transfers).toHaveLength(3);
      expect(replayed.value.transfers.filter((row: any) => row.id === 'sql-ui-uncertain-receipt')).toHaveLength(1);
    });
  } finally {
    if (!page.isClosed()) await page.close();
    try { await fixture?.cleanup(); } finally { if (fixture) await deletePage(fixture.handle); }
  }
});
