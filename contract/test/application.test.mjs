import test from 'node:test';
import assert from 'node:assert/strict';
import { applicationSelection, createApplicationBinding, applicationFilter, publishConversation } from '../application.mjs';
const id = '12'.repeat(32);
function application() {
  return { applicationId: id, status: { canAuthor: true, phase: 'ready', database: 'opening', connectedPeers: 0, pendingOperations: 0, materializationError: null },
    onStatus() { return () => {}; }, async submit() {}, readView() {}, async *changes() {},
    operations: { get() {}, retry() {}, async *subscribe() {} } };
}
test('stable host selection has no runtime ordering profile selector', () => {
  assert.deepEqual(applicationSelection({ id }), { id });
  for (const input of [undefined, null, { id: 'page-id' }, { id, kind: 'peer' }, { id, profile: 'ordered' }]) assert.throws(() => applicationSelection(input), { code: 'invalid_application' });
});
test('one owned session supplies durable submission, coherent views and independent journal facts', async () => {
  const selected = createApplicationBinding({ id }); assert.equal(selected.available, false); assert.throws(() => selected.backend, { code: 'backend_unavailable' });
  const backend = application();
  assert.throws(() => selected.install({ ...backend, applicationId: '34'.repeat(32) }), { code: 'invalid_backend' });
  for (const key of ['status', 'onStatus', 'operations', 'submit', 'changes', 'readView']) { const incomplete = { ...backend }; delete incomplete[key]; assert.throws(() => selected.install(incomplete), { code: 'invalid_backend' }); }
  const ready = selected.ready(); selected.install(backend); assert.equal(await ready, backend); assert.equal(selected.available, true);
  assert.equal(backend.status.canAuthor, true); assert.equal(backend.status.connectedPeers, 0); assert.throws(() => selected.install(backend), { code: 'backend_already_selected' });
});
test('event filtering and conversation submission preserve caller-owned identities without waiting for peers', async () => {
  assert.deepEqual(applicationFilter(['b', 'a', 'a']), ['a', 'b']); assert.throws(() => applicationFilter(['bad topic']), { code: 'invalid_topic' });
  const calls = []; await publishConversation({ publish: async (...args) => { calls.push(args); return { stored: true }; } }, { messageId: 'message-1', text: 'Hello', inReplyTo: 'message-0' }, { operationId: 'send-1' });
  assert.deepEqual(calls, [['conversation', { type: 'message.posted', version: 1, messageId: 'message-1', text: 'Hello', inReplyTo: 'message-0' }, { operationId: 'send-1' }]]);
});
