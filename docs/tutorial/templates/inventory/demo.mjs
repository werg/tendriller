// Run on this page's fresh development application while npm run agent is running:
//   npm run demo -- <slug>
// This changes real retained state. It is safe to retry with the saved identities.
import assert from 'node:assert/strict';
import { attachPage } from '@tendriller/tools/workspace';
import { workspace, slugOf } from '../../shared/local.mjs';

const slug = slugOf(import.meta.url), selected = await workspace();
const context = await selected.pageContext(slug), readPrivate = context.readPrivate, savePrivate = context.savePrivate;
// Detach and attach again through the running agent program; the page owner never closes.
const openSession = ({ signal }) => attachPage(selected, slug, { signal });

const timeout = () => AbortSignal.timeout(30_000);
const balances = snapshot => Object.fromEntries(snapshot.value.stock.map(row => [row.id, row.units]));
let owned, session;
async function closeOwned() {
  await owned?.detach();
  owned = session = undefined;
}
try {
  owned = await openSession({ signal: timeout() }); session = owned.session;
  const seed = await session.command('seed', null, { operationId: 'inventory-demo-seed-v1' });
  assert.equal((await seed.applied({ signal: timeout() })).outcome, 'accepted');

  let transfer = await readPrivate('demo-transfer.json', true);
  if (!transfer) {
    const observed = await session.query('inventory', null);
    const stock = balances(observed);
    assert.deepEqual(stock, { destination: 0, source: 10 }, 'Use a fresh development application for this demonstration.');
    transfer = await savePrivate('demo-transfer.json', {
      input: { transferId: 'demo-transfer-3', from: 'source', to: 'destination', units: 3,
        expectedSource: stock.source, expectedDestination: stock.destination },
      options: { operationId: 'inventory-demo-transfer-v1', basedOn: observed.revision },
    });
  }
  const accepted = await (await session.command('transfer', transfer.input, transfer.options)).applied({ signal: timeout() });
  assert.equal(accepted.outcome, 'accepted');
  const afterAccepted = await session.query('inventory', null);
  assert.deepEqual(balances(afterAccepted), { destination: 3, source: 7 });
  assert.equal(afterAccepted.value.transfers.length, 1);
  assert.equal(afterAccepted.value.activity.filter(event => event.topic === 'inventory.transferred').length, 1);

  let invalid = await readPrivate('demo-rejection.json', true);
  if (!invalid) invalid = await savePrivate('demo-rejection.json', {
    input: { transferId: 'demo-too-many', from: 'source', to: 'destination', units: 8,
      expectedSource: 7, expectedDestination: 3 },
    options: { operationId: 'inventory-demo-rejected-v1', basedOn: afterAccepted.revision },
  });
  const rejected = await (await session.command('transfer', invalid.input, invalid.options)).applied({ signal: timeout() });
  assert.equal(rejected.outcome, 'rejected');
  assert.equal(rejected.rejectionCode, 'assert:insufficient_stock');
  const afterRejected = await session.query('inventory', null);
  assert.deepEqual(afterRejected.value, afterAccepted.value, 'Rejected transfer must leave both balances, receipts and effective events unchanged.');

  const deviceId = session.deviceId;
  await closeOwned();
  owned = await openSession({ signal: timeout() }); session = owned.session;
  assert.equal(session.deviceId, deviceId, 'Reattaching must retain the signer.');
  assert.deepEqual(balances(await session.query('inventory', null)), { destination: 3, source: 7 });
  assert.equal((await session.operations.get(transfer.options.operationId)).outcome, 'accepted');
  assert.equal((await session.operations.get(invalid.options.operationId)).outcome, 'rejected');
  await closeOwned();
  console.log(JSON.stringify({ status: 'passed', stock: { source: 7, destination: 3 },
    accepted: transfer.options.operationId, rejected: invalid.options.operationId,
    checked: ['guarded two-bin transfer and receipt', 'rejection leaves data and events unchanged',
      'same signer and outcomes after detach/reattach', 'saved input/revision/operation identities for exact retry'] }, null, 2));
} catch (error) {
  console.error(`${error.code ?? error.name}: ${error.message}`);
  console.error('Inspect the saved demo operation IDs before retrying. Do not delete .tendriller/pages or invent a new operation ID after an uncertain result.');
  process.exitCode = 1;
} finally {
  try { await closeOwned(); }
  catch (error) {
    // Report cleanup separately; never replace an already reported command or
    // reopen failure with an unhandled rejection from the finally block.
    console.error(`SQL attachment cleanup failed: ${error.code ?? error.name}: ${error.message}`);
    process.exitCode = 1;
  }
}
