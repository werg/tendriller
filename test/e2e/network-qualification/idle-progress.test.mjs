import test from 'node:test';
import assert from 'node:assert/strict';
import { observeIdleDuration, waitForIdleDeadline } from './idle-progress.mjs';

test('fractionally early idle timer wake rearms against the same monotonic deadline', async () => {
  const started = 100.25;
  let clock = started;
  const waits = [];
  await waitForIdleDeadline(started + 1000, {
    now: () => clock,
    wait: async ms => {
      waits.push(ms);
      clock += waits.length === 1 ? ms - 0.4 : ms;
      if (waits.length === 1) assert.ok(clock - started < 1000, 'single original timer would end too early');
    },
  });
  assert.deepEqual(waits, [1000, 1]);
  assert.ok(clock - started >= 1000);
  assert.ok(clock - started > 1000, 'retain the actual overrun, do not clamp it');
});

test('multiple early wakes cannot reset or shorten the fixed idle deadline', async () => {
  let clock = 0;
  const waits = [];
  await waitForIdleDeadline(10.25, { now: () => clock, wait: async ms => {
    waits.push(ms);
    clock += [9.5, 0.5, 0.5][waits.length - 1];
  } });
  assert.deepEqual(waits, [11, 1, 1]);
  assert.equal(clock, 10.5);
});

test('an expired idle deadline requires no extra delay', async () => {
  await waitForIdleDeadline(10, { now: () => 12.5, wait: async () => assert.fail('no sleep after deadline') });
});

test('abort at an early wake cannot be mistaken for completion', async () => {
  const controller = new AbortController();
  const reason = Error('operator stopped');
  let clock = 0;
  await assert.rejects(waitForIdleDeadline(1000, {
    signal: controller.signal, now: () => clock,
    wait: async (_ms, signal) => {
      assert.equal(signal, controller.signal);
      clock = 999.5;
      controller.abort(reason);
    },
  }), error => error === reason);
});

test('real pending idle timer aborts promptly and preserves its abort reason', async () => {
  const controller = new AbortController();
  const reason = Error('stop');
  const promise = waitForIdleDeadline(performance.now() + 60000, { signal: controller.signal });
  controller.abort(reason);
  await assert.rejects(promise, error => error.name === 'AbortError' && error.cause === reason);
});

test('UTC rollback cannot make idle progress elapsed time negative or change planned UTC endpoints', async t => {
  const wallStart = Date.now();
  let reads = 0;
  t.mock.method(Date, 'now', () => ++reads === 1 ? wallStart : wallStart - 3600000);
  const progress = [];
  const result = await observeIdleDuration(35, { intervalMs: 5, onProgress: async value => progress.push(value) });
  assert.ok(progress.length >= 2);
  assert.ok(progress.every(value => value.elapsedMs >= 0));
  assert.ok(progress.every((value, index) => index === 0 || value.elapsedMs >= progress[index - 1].elapsedMs));
  assert.equal(result.idleStartedAt, new Date(wallStart).toISOString());
  assert.equal(Date.parse(result.idlePlannedEndAt) - Date.parse(result.idleStartedAt), 35);
  assert.ok(progress.every(value => value.idleStartedAt === result.idleStartedAt && value.idlePlannedEndAt === result.idlePlannedEndAt));
});
