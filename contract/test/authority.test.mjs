import test from 'node:test';
import assert from 'node:assert/strict';
import { authorityRecord, authorityRecordBytes, createAuthorityClient } from '../authority.mjs';
import { createApplicationBinding } from '../application.mjs';
const applicationId = 'ab'.repeat(32);
test('control record hex round trips without JSON number narrowing', () => {
  const bytes = new TextEncoder().encode('{"authorTimeAfterMs":{"$integer":"9223372036854775807"}}');
  assert.deepEqual(authorityRecordBytes(authorityRecord(bytes)), bytes);
  for (const value of [{ record: 'AA' }, { record: '0' }, { record: '00', keys: 'private' }, { record: '00'.repeat(4) }]) {
    assert.throws(() => authorityRecordBytes(value, 2));
  }
});
test('browser-first host prepare is independent of data authority and native participation', async () => {
  const calls = [], client = createAuthorityClient(async (path, options) => { calls.push({ path, options }); return { authority: null }; });
  const configuration = { executionManifestDigest: 'cd'.repeat(32), executionProfile: 'events', publisherKeys: ['ef'.repeat(32)] };
  await client.prepare(configuration);
  assert.deepEqual(calls, [{ path: 'application', options: { method: 'POST', body: configuration } }]);
  await client.challenge('12'.repeat(32));
  assert.equal(calls[1].path, 'peers/enrollment');
});
test('admission actions are exact host enrollment requests; the host-signed grant action is gone', async () => {
  const calls = [], client = createAuthorityClient(async (path, options) => { calls.push({ path, body: options?.body }); return { selection: { id: applicationId } }; }, { applicationId });
  const record = { record: '00' }, invite = { inviteId: 'ab'.repeat(16), secret: 'cd'.repeat(32) };
  await client.enroll(record); await client.enroll(record, invite); await client.enrollAgent(); await client.initialize(record); await client.membership(record);
  await client.admissions(); await client.wrap(record); await client.wraps('12'.repeat(32));
  assert.ok(calls.every(call => call.path === 'peers/enrollment'));
  assert.deepEqual(calls.map(call => call.body), [
    { action: 'enroll', proof: record }, { action: 'enroll', proof: record, invite }, { action: 'enroll-agent' }, { action: 'initialize', bundle: record },
    { action: 'membership', bundle: record }, { action: 'admissions' }, { action: 'wrap', wrap: record }, { action: 'wraps', recipient: '12'.repeat(32) }]);
  assert.equal(client.grant, undefined);
});
test('a stable explicit scope pin rejects mismatched metadata without resolving another host scope', async () => {
  const client = createAuthorityClient(async () => ({ selection: { id: 'ff'.repeat(32) } }), { applicationId });
  await assert.rejects(client.application(), { code: 'application_scope_mismatch' });
  assert.throws(() => createAuthorityClient(async () => {}, { applicationId: async () => applicationId }), /stable application ID/);
});
test('runtime accepts the owned operation-set facade without ordering or recovery capabilities', async () => {
  const session = { applicationId, status: { phase: 'ready', database: 'ready', connectedPeers: 0 },
    onStatus() {}, submit() {}, readView() {}, changes() {}, operations: { get() {}, retry() {}, subscribe() {} } };
  const binding = createApplicationBinding({ id: applicationId });
  binding.install(session);
  assert.equal(await binding.ready(), session);
  assert.throws(() => binding.install(session), /cannot change/);
  assert.throws(() => createApplicationBinding({ id: applicationId }, { ...session, applicationId: '00'.repeat(32) }), /selected owned/);
});
