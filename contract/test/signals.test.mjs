import test from 'node:test';
import assert from 'node:assert/strict';
import { createSignalBinding } from '../signals.mjs';

test('uninstalled signals fail immediately and are never replayed after installation', async () => {
  const binding = createSignalBinding(), calls = [];
  assert.equal(binding.available, false);
  await assert.rejects(binding.send('typing', true), { code: 'signal_unavailable' });
  assert.throws(() => binding.subscribe(), { code: 'signal_unavailable' });
  const provider = { async send(...args) { calls.push(args); }, async *subscribe() {} };
  binding.install(provider);
  assert.equal(await binding.ready(), provider);
  assert.equal(binding.available, true);
  assert.deepEqual(calls, [], 'installation must not revive stale live-only work');
  assert.throws(() => binding.install(provider), { code: 'signals_already_installed' });
});

test('signals preserve cancellation, delivery mode, sender context and dispatch failures', async () => {
  const controller = new AbortController(), payload = { active: true };
  const options = { ttlMs: 1000, signal: controller.signal };
  const subscription = { topics: ['typing'], mode: 'latest', signal: controller.signal };
  const event = { payload }, failure = Error('route closed');
  let calls = 0;
  const provider = {
    async send(topic, data, opts) {
      assert.equal(this, provider); assert.equal(topic, 'typing'); assert.equal(data, payload); assert.equal(opts, options);
      calls++; if (calls > 1) throw failure; return event;
    },
    async *subscribe(opts) { assert.equal(this, provider); assert.equal(opts, subscription); yield event; },
  };
  const binding = createSignalBinding(provider);
  assert.equal(await binding.send('typing', payload, options), event);
  assert.equal((await binding.subscribe(subscription)[Symbol.asyncIterator]().next()).value, event);
  await assert.rejects(binding.send('typing', payload, options), error => error === failure);
  assert.equal(calls, 2, 'a failed transient send must not be retried');
});

test('invalid signal installations leave the independent port available for correct composition', () => {
  const binding = createSignalBinding();
  for (const value of [null, {}, { send() {} }, binding])
    assert.throws(() => binding.install(value), { code: 'invalid_signals' });
  assert.equal(binding.available, false);
});
