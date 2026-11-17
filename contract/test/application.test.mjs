import test from 'node:test';
import assert from 'node:assert/strict';
import { applicationSelection, createApplicationBinding, applicationFilter, publishConversation } from '../application.mjs';
const id = '12'.repeat(32);
function application() {
  return { id, capabilities: ['events'], status: { phase: 'ready', role: 'coordinator', generation: 'g', coordinator: 'a', connectedPeers: 0 },
    onStatus() { return () => {}; }, onRecovery() { return () => {}; }, async inspectRecovery() { return []; },
    async submit() {}, readView() {}, async *changes() {},
    events: { publish() {}, read() {}, subscribe() {} }, operations: { get() {}, subscribe() {} } };
}
test('a stable application identity has no runtime backend or profile selector', () => {
  assert.deepEqual(applicationSelection({ id }), { id });
  for (const input of [undefined, null, { id: 'page-id' }, { id, kind: 'peer' }, { id, profile: 'finality' }])
    assert.throws(() => applicationSelection(input), { code: 'invalid_application' });
});
test('one owned session supplies applied operations, status and explicit recovery', async () => {
  const selected = createApplicationBinding({ id });
  assert.equal(selected.available, false);
  assert.throws(() => selected.backend, { code: 'backend_unavailable' });
  const backend = application();
  assert.throws(() => selected.install({ ...backend, id: '34'.repeat(32) }), { code: 'invalid_backend' });
  for (const key of ['status', 'onStatus', 'onRecovery', 'inspectRecovery', 'operations']) {
    const incomplete = { ...backend }; delete incomplete[key];
    assert.throws(() => selected.install(incomplete), { code: 'invalid_backend' });
  }
  const ready = selected.ready(); selected.install(backend);
  assert.equal(await ready, backend); assert.equal(selected.backend, backend); assert.equal(selected.available, true);
  assert.throws(() => selected.install(backend), { code: 'backend_already_selected' });
});
test('event filtering and conversation submission preserve caller-owned identities', async () => {
  assert.deepEqual(applicationFilter(['b', 'a', 'a']), ['a', 'b']);
  assert.throws(() => applicationFilter(['bad topic']), { code: 'invalid_topic' });
  const calls = [];
  await publishConversation({ publish: async (...args) => { calls.push(args); return { status: 'saved' }; } },
    { messageId: 'message-1', text: 'Hello', inReplyTo: 'message-0' }, { operationId: 'send-1' });
  assert.deepEqual(calls, [['conversation', { type: 'message.posted', version: 1, messageId: 'message-1', text: 'Hello', inReplyTo: 'message-0' }, { operationId: 'send-1' }]]);
});
