import test from 'node:test';
import assert from 'node:assert/strict';
import { createSetupIntent, setupRequest, completeSetupIntent, prepareTendrilSetup } from '../setup.mjs';
const service = 'https://staging.tendriller.dev';
function storage() {
  const values = new Map();
  return { async load(key) { return values.get(key) ?? null; }, async save(key, value) { if (!values.has(key)) values.set(key, structuredClone(value)); } };
}
function receipt(intent) { return { schemaVersion: 1, serviceOrigin: service, operationId: intent.operationId, requestDigest: intent.requestDigest,
  credentialCommitment: intent.credentialCommitment, applicationId: intent.applicationId, pageId: 'abcdefghijkl', state: 'ready', code: null,
  page: { id: 'abcdefghijkl', api: service + '/api/t/abcdefghijkl', page_url: 'https://abcdefghijkl.staging.tendriller.site/s/' + 'a'.repeat(26) + '/', application: { id: intent.applicationId } } }; }
test('retains one private credential before exposing MCP input and resumes omitted fields', async () => {
  const store = storage(), first = await createSetupIntent(service, { operationId: 'create-one', name: 'Private setup' }, { store });
  const resumed = await createSetupIntent(service, { operationId: 'create-one' }, { store });
  assert.deepEqual(resumed, first); assert.equal(first.name, 'Private setup');
  assert.equal((await store.load(first.operationId)).credential, first.credential);
  assert.equal('credential' in setupRequest(first), false); assert.equal(JSON.stringify(setupRequest(first)).includes(first.credential), false);
  await assert.rejects(createSetupIntent(service, { operationId: first.operationId, name: 'Changed' }, { store }), { code: 'setup_operation_conflict' });
  await assert.rejects(createSetupIntent('https://tendriller.dev', { operationId: first.operationId }, { store }), { code: 'setup_operation_conflict' });
});
test('fails without durable save and readback before networking', async () => {
  await assert.rejects(createSetupIntent(service, { operationId: 'missing' }), { code: 'setup_storage_required' });
  await assert.rejects(createSetupIntent(service, { operationId: 'not-persisted' }, { store: { load: async () => null, save: async () => {} } }), { code: 'setup_storage_required' });
  await assert.rejects(createSetupIntent(service, { operationId: 'disk' }, { store: { load: async () => null, save: async () => { throw new Error('disk failure'); } } }), /disk failure/);
});
test('concurrent preparation accepts only the durable winning credential', async () => {
  const store = storage(), input = { operationId: 'parallel' };
  const [a, b] = await Promise.all([createSetupIntent(service, input, { store }), createSetupIntent(service, input, { store })]);
  assert.deepEqual(a, b);
});
test('reconstructs the same handle after a lost HTTP response using the saved operation', async () => {
  const store = storage(), intent = await createSetupIntent(service, { operationId: 'lost-response' }, { store });
  let submitted;
  await assert.rejects(prepareTendrilSetup(intent, { accessToken: 'oauth', fetch: async (url, init) => { submitted = { url, init }; throw new Error('lost reply'); } }), /lost reply/);
  assert.equal(submitted.url, service + '/api/setup'); assert.equal(submitted.init.redirect, 'error');
  assert.deepEqual(JSON.parse(submitted.init.body), setupRequest(intent));
  const restored = await createSetupIntent(service, { operationId: intent.operationId }, { store });
  assert.equal((await completeSetupIntent(restored, receipt(intent))).token, intent.credential);
});
test('refuses mismatched receipts, nonready states and returned secrets', async () => {
  const intent = await createSetupIntent(service, { operationId: 'receipt' }, { store: storage() }), ready = receipt(intent);
  for (const change of [{ serviceOrigin: 'https://tendriller.dev' }, { requestDigest: 'f'.repeat(64) }, { credentialCommitment: 'f'.repeat(64) }, { operationId: 'different' }, { page: { ...ready.page, token: 'server-secret' } }, { page: { ...ready.page, api: 'https://tendriller.dev/api/t/abcdefghijkl' } }])
    await assert.rejects(completeSetupIntent(intent, { ...ready, ...change }), { code: 'setup_receipt_mismatch' });
  await assert.rejects(completeSetupIntent(intent, { ...ready, state: 'expired', code: 'setup_expired' }), { code: 'setup_expired' });
  await assert.rejects(completeSetupIntent({ ...intent, credential: 'tk_' + 'z'.repeat(32) }, ready), { code: 'setup_state_invalid' });
});
