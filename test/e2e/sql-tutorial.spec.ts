// Real tutorial qualification. No specimen UI/domain, injected application
// backend, mocked command, preseeded browser key, or substitute transport.
import { test, expect, type Page } from '@playwright/test';
import { deletePage, openClaimed, signInFixture } from './local-helpers';
import { prepareSqlTutorial } from './sql-tutorial-fixture';

async function stock(page: Page, source: number, destination: number) {
  await expect(page.locator('#stock tr').filter({ has: page.getByRole('link', { name: 'source', exact: true }) })).toHaveText(`source${source}`);
  await expect(page.locator('#stock tr').filter({ has: page.getByRole('link', { name: 'destination', exact: true }) })).toHaveText(`destination${destination}`);
}
async function publishedGraph(page: Page, app: { publication: any; publicationVersion: number }) {
  const hosted = await page.evaluate(() => ({
    version: (window as any).tendril.identity.version,
    publication: (window as any).tendril.identity.publication,
    manifest: (window as any).__TENDRIL__.publication,
  }));
  // Runtime identity addresses the immutable host version; the signed manifest
  // hash is verified independently by the fixture's publication readback.
  expect(hosted.version).toBe(app.publicationVersion);
  expect(hosted.publication).toBe(String(app.publicationVersion));
  expect(hosted.manifest.id).toBe(String(app.publicationVersion));
  expect(hosted.manifest.entry).toBe(app.publication.payload.entry);
  const byPath = (a: { path: string }, b: { path: string }) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  expect(hosted.manifest.assets.sort(byPath)).toEqual(app.publication.payload.files.map((file: any) => ({
    path: file.path, sha256: file.hash, size: file.size, type: file.type,
  })).sort(byPath));
}
// A freshly provisioned native participant opens its own local store at once and replicates the browser's
// history in the background. Until the initializing DDL arrives its `inventory` view has no table to read, which
// the starter reports as an explicit view error (here SQL_PREPARE_FAILED), not an empty or failed result. Poll
// that error as a value so convergence is awaited and a view that never converges still reports its last error.
async function nativeStock(native: { query(name: string, input: null): Promise<{ value: any }> }) {
  try { return (await native.query('inventory', null)).value.stock; }
  catch (error) { return { viewError: (error as Error).message }; }
}
// The page retains each exact intent as a local draft before it asks the owner to store it, so a lost reply or a
// reload between the two leaves the original operation ID and input to retry. Reproduce exactly that state through the
// view store's own draft keys (chronolog:view:<application>:<profile>:<view>:draft:<name>).
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

// The workspace starter's inventory template: its own createPage, init (host preparation), build, deploy and
// agent page module, signed by the workspace's one agent key. Browser-first: the owner's first authorized browser
// initializes local identity, keys and authority; the native participant is optional and explicitly provisioned.
test('actual SQL inventory page: signed publication, browser-first initialization, explicit native provisioning, replication and exact retained retry', async ({ page, context }, testInfo) => {
  // This scenario has its own fixed overall budget. Existing asymmetric/cold
  // SQL startup tests and their operation deadlines remain unchanged.
  test.setTimeout(240_000);
  const consumer = process.env.E2E_CHRONOLOG_CONSUMER, engine = process.env.E2E_CHRONOLOG_WASM;
  expect(consumer, 'Required combined public SQL consumer; no events-only fallback').toBeTruthy();
  expect(engine, 'Required matching manifest-bound WASM assets').toBeTruthy();
  let fixture: Awaited<ReturnType<typeof prepareSqlTutorial>> | undefined;
  try {
    await test.step('create, prepare, build and sign the inventory page before claim', async () => {
      fixture = await prepareSqlTutorial(consumer!, engine!);
    });
    const app = fixture!, handle = app.handle;
    await testInfo.attach('sql-tutorial-public-graph', { contentType: 'application/json', body: Buffer.from(JSON.stringify({
      session: app.sessionProvenance, publication: app.publication, hostVersion: app.publicationVersion,
      limits: ['Synthetic local owner, not live OAuth or Internet NAT.', 'Native supervisor/SQL close is checked; raw workerd TCP close is outside this UI scenario.'],
    }, null, 2)) });
    await signInFixture(context); await openClaimed(page, handle);
    await expect(page.getByRole('heading', { name: 'Shared inventory', exact: true })).toBeVisible();
    await publishedGraph(page, app);
    // The first authorized browser creates its own local device, authority and keys: no identity, key or grant is
    // fabricated by the fixture and no native participant exists yet.
    await expect(page.locator('#initialize')).toBeEnabled({ timeout: 60_000 });
    const browserKey = await page.locator('#public-key').inputValue();
    expect(browserKey).toMatch(/^[a-f0-9]{64}$/);
    expect(app.nativePublicKey).not.toBe(browserKey);
    await expect(page.locator('#summary')).not.toContainText('Loading');
    // Schema and rows are an ordinary authorized DDL/DML transaction, stored and materialized locally.
    await page.locator('#initialize').click();
    await expect(page.locator('#result')).toContainText('Stored locally: true', { timeout: 30_000 });
    await expect(page.locator('#result')).toContainText('Materialized locally: accepted', { timeout: 30_000 });
    await stock(page, 10, 0);
    await expect(page.locator('#summary')).toContainText('2 bins · 10 total units');
    await expect(page.locator('#summary')).toHaveText(/local snapshot [a-f0-9]{12} \(revisable\)/);

    await test.step('explicit native provisioning: account-bound proof, recipient-bound request and wrapped keys', async () => {
      await page.locator('#provisioning > summary').click();
      await page.getByText('Prove an optional native/external device key').click();
      await page.getByLabel('Public signing key from that retained device').fill(app.nativePublicKey);
      await page.getByRole('button', { name: 'Create account-bound challenge for this key' }).click();
      const out = page.locator('[data-provisioning="out"]'), incoming = page.locator('[data-provisioning="in"]'), status = page.locator('[data-provisioning="status"]');
      await expect(out).toHaveValue(/"challenge"/);
      const challenge = JSON.parse(await out.inputValue());
      expect(challenge.publicKey).toBe(app.nativePublicKey);
      await incoming.fill(JSON.stringify(await app.signEnrollment(challenge)));
      await page.getByRole('button', { name: 'Record external signed enrollment proof from incoming field' }).click();
      await expect(status).toContainText('External key proof recorded');
      await incoming.fill(JSON.stringify(await app.provisioningRequest()));
      await page.locator('[data-provisioning="writer"]').check();
      await page.locator('[data-provisioning="review"]').click();
      await expect(status).toContainText(`Review recipient fingerprint: ${app.nativePublicKey}`);
      await page.locator('[data-provisioning="grant"]').click();
      await expect(status).toContainText('Recipient-bound encrypted key package created');
      expect(JSON.stringify(await out.inputValue())).not.toContain('privateKey');
      await app.importProvisioning(JSON.parse(await out.inputValue()));
    });
    await test.step('explicit SQL grant for the native key through the starter\'s ordinary permission transaction', async () => {
      // Key provisioning and the crypto writer grant authorize no SQL; without this the native transfer is rejected
      // with policy:inventory:update. The browser's root principal grants units updates and receipt inserts.
      const previous = await proposalOf(page);
      await page.locator('#sql-grantee').fill(app.nativePublicKey);
      await page.locator('#sql-grant').click();
      await expect.poll(() => proposalOf(page), { timeout: 30_000 }).not.toBe(previous);
      await expect(page.locator('#result')).toContainText('Stored locally: true', { timeout: 30_000 });
      await expect(page.locator('#result')).toContainText('Materialized locally: accepted', { timeout: 30_000 });
    });
    let native = await app.start(); // The page's optional owner from pages/stock/agent.mjs, opened from cached keys.
    expect(native.identity.publicKey).toBe(app.nativePublicKey);
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
      // Ordinary local Save never waits on an uncertain operation; only that intent's retry is offered.
      await expect(page.getByRole('button', { name: 'Store transfer locally' })).toBeEnabled();
      await page.locator('#retry').click();
      await expect(page.locator('#result')).toContainText(`Operation ${uncertainId}`, { timeout: 30_000 });
      await expect(page.locator('#result')).toContainText('Materialized locally: accepted', { timeout: 30_000 });
      const proposal = await proposalOf(page);
      expect(proposal).toMatch(/^[a-f0-9]{64}$/);
      await expect.poll(async () => (await native.query('inventory', null)).value.transfers.filter((row: any) => row.id === 'sql-ui-uncertain-receipt').length, { timeout: 15_000 }).toBe(1);
      // The inspector reads the real stored operation separately from retry and never resubmits it.
      await page.locator('#inspect').click();
      await expect(page.locator('#result')).toContainText(`Operation ${uncertainId}`);
      expect(await proposalOf(page)).toBe(proposal);
      await stock(page, 8, 2);
    });
    await test.step('discarded SQL materialization is rebuilt from the retained history and receipts', async () => {
      await expect.poll(async () => {
        const { value } = await native.query('inventory', null);
        return { receipts: value.transfers.length, uncertain: value.transfers.filter((row: any) => row.id === 'sql-ui-uncertain-receipt').length };
      }, { timeout: 15_000 }).toEqual({ receipts: 3, uncertain: 1 });
      await page.reload();
      await expect(page.locator('#initialize')).toBeEnabled({ timeout: 60_000 });
      await expect(page.locator('#public-key')).toHaveValue(browserKey);
      await stock(page, 8, 2);
      await publishedGraph(page, app);
      const beforeMove = await native.query('inventory', null);
      await page.close(); await app.stop();
      expect(await app.discardMaterialization()).toEqual({ sourceSetAside: true, deviceKept: true });
      expect(await app.materializationExists()).toBe(false);
      // Page records, authority, the device journal and the shared signer stay in place; there is no derived SQL
      // file until the owner reopens and rebuilds it from the retained signed operations.
      native = await app.start();
      expect(native.identity.publicKey).toBe(app.nativePublicKey);
      const replayed = await native.query('inventory', null);
      expect(await app.materializationExists()).toBe(true);
      expect(replayed.value).toEqual(beforeMove.value);
      expect(replayed.value.stock).toEqual([{ id: 'destination', units: 2 }, { id: 'source', units: 8 }]);
      expect(replayed.value.transfers).toHaveLength(3);
      expect(replayed.value.transfers.filter((row: any) => row.id === 'sql-ui-uncertain-receipt')).toHaveLength(1);
    });
  } finally {
    // Browser attachments retire before native supervisor/database cleanup.
    if (!page.isClosed()) await page.close();
    try { await fixture?.cleanup(); } finally { if (fixture) await deletePage(fixture.handle); }
  }
});
