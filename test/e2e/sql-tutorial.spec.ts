// Real tutorial qualification. No specimen UI/domain, injected application
// backend, mocked command, preseeded browser key, or substitute transport.
import { test, expect, type Page } from '@playwright/test';
import { createPage, deletePage, openClaimed, signInFixture } from './local-helpers';
import { prepareSqlTutorial } from './sql-tutorial-fixture';

async function stock(page: Page, source: number, destination: number) {
  await expect(page.locator('#stock-rows tr').filter({ has: page.getByRole('cell', { name: 'source', exact: true }) }))
    .toHaveText(`source${source}`);
  await expect(page.locator('#stock-rows tr').filter({ has: page.getByRole('cell', { name: 'destination', exact: true }) }))
    .toHaveText(`destination${destination}`);
}
async function pendingRecord(page: Page, operationId: string) {
  return page.evaluate(id => {
    for (const raw of Object.values(localStorage)) {
      let record;
      try { record = JSON.parse(raw); } catch { continue; }
      if (record?.reference?.operationId === id && record?.context?.id === id) return record;
    }
    return null;
  }, operationId);
}

test('actual SQL tutorial: signed publication, explicit enrollment, native replication and uncertain reload/inspect', async ({ page, context }, testInfo) => {
  // This scenario has its own fixed overall budget. Existing asymmetric/cold
  // SQL startup tests and their operation deadlines remain unchanged.
  test.setTimeout(180_000);
  const consumer = process.env.E2E_CHRONOLOG_CONSUMER, engine = process.env.E2E_CHRONOLOG_WASM;
  expect(consumer, 'Required combined public SQL consumer; no events-only fallback').toBeTruthy();
  expect(engine, 'Required matching manifest-bound WASM assets').toBeTruthy();
  const handle = await createPage();
  let fixture: Awaited<ReturnType<typeof prepareSqlTutorial>> | undefined;
  try {
    await test.step('build and sign the actual tutorial before claim', async () => {
      fixture = await prepareSqlTutorial(handle, consumer!, engine!);
    });
    const app = fixture!;
    await testInfo.attach('sql-tutorial-public-graph', { contentType: 'application/json', body: Buffer.from(JSON.stringify({
      session: app.sessionProvenance, publication: app.publication,
      limits: ['Synthetic local owner, not live OAuth or Internet NAT.', 'Native supervisor/SQL close is checked; raw workerd TCP close is outside this UI scenario.'],
    }, null, 2)) });
    await signInFixture(context); await openClaimed(page, handle);
    await expect(page.getByRole('heading', { name: 'Shared Inventory (SQL)', exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as any).tendril.identity.publication)).toBe(app.publication.id);
    // No browser identity or grant is fabricated by the test fixture. Exercise
    // the deliberate enrollment action on the signed tutorial itself.
    await expect(page.locator('#session-status')).toHaveText('Connection unavailable', { timeout: 35_000 });
    await page.locator('#create-device').click();
    await expect(page.locator('#device-key')).toHaveValue(/^[a-f0-9]{64}$/, { timeout: 30_000 });
    const browserKey = await page.locator('#device-key').inputValue();
    await expect(page.locator('#result')).toContainText(`npm run enroll -- ${browserKey}`);
    await app.enroll(browserKey); // Actual tutorial administrator signs enrollment.
    let native = await app.start(); // Actual tutorial's resident native owner.
    const nativeKey = native.deviceId;
    expect(nativeKey).not.toBe(browserKey);
    const seed = await native.command('seed', null, { operationId: 'sql-ui-seed' });
    expect((await seed.applied({ signal: AbortSignal.timeout(15_000) })).outcome).toBe('accepted');
    await page.reload();
    await expect(page.locator('#device-key')).toHaveValue(browserKey, { timeout: 35_000 });
    await expect(page.locator('#submit-transfer')).toBeEnabled({ timeout: 35_000 });
    await stock(page, 10, 0);
    await expect(page.locator('#revision-label')).toHaveText(/Generation .+ · seq \d+/);

    await test.step('browser transfer is applied and read by the native participant', async () => {
      await page.locator('#qty').fill('2'); await page.locator('#submit-transfer').click();
      await expect(page.locator('#result')).toContainText('"outcome": "accepted"', { timeout: 15_000 });
      const id = await page.locator('#op-id').inputValue();
      await expect.poll(async () => {
        const snapshot = await native.query('inventory', null);
        return { stock: snapshot.value.stock, receipts: snapshot.value.transfers.filter((receipt: any) => receipt.id === id).length };
      }, { timeout: 5_000 }).toEqual({ stock: [{ id: 'destination', units: 2 }, { id: 'source', units: 8 }], receipts: 1 });
      await stock(page, 8, 2);
    });
    await test.step('native transfer reaches the real browser Worker and live view', async () => {
      const before = await native.query('inventory', null);
      const operation = await native.command('transfer', { transferId: 'sql-ui-native-return', from: 'destination', to: 'source',
        units: 1, expectedSource: 2, expectedDestination: 8 }, { operationId: 'sql-ui-native-return', basedOn: before.revision });
      expect((await operation.applied({ signal: AbortSignal.timeout(15_000) })).outcome).toBe('accepted');
      await stock(page, 9, 1);
    });
    let uncertainId = '';
    await test.step('cancel only the applied waiter; preserve exact intent through reload', async () => {
      // Same controlled failure as the first-app qualifier. The command still
      // runs over the real owner/peer connection; only its page waiter aborts.
      await page.evaluate(() => {
        const timeout = AbortSignal.timeout.bind(AbortSignal);
        AbortSignal.timeout = ms => ms === 15_000 ? AbortSignal.abort(Error('SQL_UI_APPLIED_WAITER_CANCELLED')) : timeout(ms);
      });
      await page.locator('#qty').fill('1'); await page.locator('#submit-transfer').click();
      await expect(page.locator('#result')).toContainText('SQL_UI_APPLIED_WAITER_CANCELLED', { timeout: 15_000 });
      uncertainId = await page.locator('#op-id').inputValue();
      const retained = await pendingRecord(page, uncertainId);
      expect(retained).not.toBeNull();
      expect(retained.context.command).toBe('transfer');
      expect(retained.context.input).toEqual({ transferId: uncertainId, from: 'source', to: 'destination', units: 1,
        expectedSource: 9, expectedDestination: 1 });
      expect(retained.reference.author).toBe(browserKey);
      expect(retained.context.basedOn.point.sequence).toEqual(expect.any(Number));
      await expect(page.locator('#submit-transfer')).toBeDisabled();
      await page.reload(); // Restore original AbortSignal and the same view/device.
      await expect(page.locator('#device-key')).toHaveValue(browserKey, { timeout: 35_000 });
      await expect(page.locator('#op-id')).toHaveValue(uncertainId);
      await expect(page.locator('#retry-op')).toBeEnabled({ timeout: 35_000 });
      expect(await pendingRecord(page, uncertainId)).toEqual(retained);
      await expect(page.locator('#submit-transfer')).toBeDisabled();
      await expect(page.locator('#qty')).toBeDisabled();
      await page.locator('#retry-op').click();
      await expect(page.locator('#result')).toContainText('"outcome": "accepted"', { timeout: 15_000 });
      await expect(page.locator('#submit-transfer')).toBeEnabled();
      expect(await pendingRecord(page, uncertainId)).toBeNull();
      // The inspector reads the real saved operation, separately from retry.
      await page.locator('#inspect-op').click();
      await expect(page.locator('#result')).toContainText('"reviewed": null');
      const inspected = JSON.parse(await page.locator('#result').innerText());
      expect(inspected.state.operationId).toBe(uncertainId);
      expect(inspected.state.status).toBe('applied');
      expect(inspected.state.outcome).toBe('accepted');
    });
    await test.step('device-only CLI handoff replays SQL history, receipts, events and the uncertain attempt', async () => {
      await stock(page, 8, 2);
      await expect.poll(async () => {
        const { value } = await native.query('inventory', null);
        return { receipts: value.transfers.length, uncertain: value.transfers.filter((row: any) => row.id === uncertainId).length,
          events: value.activity.filter((event: any) => event.topic === 'inventory.transferred').length };
      }, { timeout: 5_000 }).toEqual({ receipts: 3, uncertain: 1, events: 3 });
      await page.reload();
      await expect(page.locator('#submit-transfer')).toBeEnabled({ timeout: 35_000 });
      await expect(page.locator('#device-key')).toHaveValue(browserKey);
      await stock(page, 8, 2);
      expect(await page.evaluate(() => (window as any).tendril.identity.publication)).toBe(app.publication.id);
      await page.locator('#close').click(); await expect(page.locator('#session-status')).toContainText('Detached.');
      // Capture the original browser-authored signed attempt on the native
      // participant before it moves. Reconcile that exact author/ID after replay.
      const beforeMove = await native.query('inventory', null);
      const originalAttempt = await native.operations.inspect(uncertainId, { author: browserKey });
      expect(originalAttempt?.state).toMatchObject({ operationId: uncertainId, status: 'applied', outcome: 'accepted' });
      expect(originalAttempt?.attempt).toBeTruthy();
      await page.close(); await app.stop();
      const handoff = await app.moveCheckpoint(); // Actual dist/tools CLI, ephemeral env secret.
      expect(handoff).toEqual({ exported: { retiredSource: true, deviceId: nativeKey, hasSqlDatabase: false },
        restored: { materialization: 'rebuild-on-open', deviceId: nativeKey }, sourceRetired: true });
      expect(await app.movedMaterializationExists()).toBe(false);
      // Root handle/descriptor/schema stay in place. Only the restored device
      // journal is under profiles/moved; there is no copied derived SQL file.
      native = await app.start('moved');
      expect(native.deviceId).toBe(nativeKey);
      const replayed = await native.query('inventory', null);
      expect(await app.movedMaterializationExists()).toBe(true);
      expect(replayed.value).toEqual(beforeMove.value);
      expect(replayed.value.stock).toEqual([{ id: 'destination', units: 2 }, { id: 'source', units: 8 }]);
      expect(replayed.value.transfers).toHaveLength(3);
      expect(replayed.value.transfers.filter((row: any) => row.id === uncertainId)).toHaveLength(1);
      expect(replayed.value.activity.filter((event: any) => event.topic === 'inventory.transferred')).toHaveLength(3);
      const reconciled = await native.operations.inspect(uncertainId, { author: browserKey });
      expect(reconciled?.attempt).toEqual(originalAttempt.attempt);
      expect(reconciled?.state).toMatchObject({ operationId: uncertainId, status: 'applied', outcome: 'accepted' });
    });
  } finally {
    // Browser attachments retire before native supervisor/database cleanup.
    if (!page.isClosed()) await page.close();
    try { await fixture?.cleanup(); } finally { await deletePage(handle); }
  }
});
