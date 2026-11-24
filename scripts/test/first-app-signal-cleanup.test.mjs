import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { qualifyFirstAppSignals } from '../first-app-signals.mjs';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(t, qualificationError) {
  let now = 100_000, nativeTime = now, browserTime = now;
  t.mock.method(Date, 'now', () => now);
  const native = deferred(), browser = deferred(), bothStarted = deferred();
  const started = [], settled = [];
  t.after(() => { native.resolve(); browser.resolve(); });
  const restore = (name, control) => {
    started.push(name);
    now += 10_000; // The fixture's monotone guard has caught up; no real wait.
    if (started.length === 2) bothStarted.resolve();
    return control.promise.then(value => { settled.push(name); return value; },
      error => { settled.push(name); throw error; });
  };
  const counters = { capacity: 0, clockSkew: 0, duplicate: 0, expired: 0, total: 0, unauthorized: 0 };
  const observed = [];
  const snapshot = () => structuredClone({ observed, revisions: [7], aborted: false,
    transport: { state: 'available', sampled: true, error: null, connectionRevision: 7,
      connections: [{ signalRejections: counters }] } });
  const receive = (label, ttlMs) => {
    const sent = { issuedAtMs: browserTime, expiresAtMs: browserTime + ttlMs };
    if (browserTime - nativeTime > 2000) { counters.clockSkew++; counters.total++; }
    else if (sent.expiresAtMs <= nativeTime) { counters.expired++; counters.total++; }
    else observed.push({ label, ...sent });
    return sent;
  };
  const peer = { request(action, input) {
    if (action === 'signal-qualification-begin') return Promise.resolve();
    if (action === 'signal-qualification-snapshot') return Promise.resolve(snapshot());
    assert.equal(action, 'signal-qualification-clock', 'No later qualification work may run after cleanup fails.');
    if (input.time === null) return restore('native', native);
    nativeTime = input.time;
    return Promise.resolve({ time: nativeTime });
  } };
  const page = { async evaluate(_evaluate, input) {
    if (input.name) {
      if (input.time === null) {
        assert.equal(input.close, true);
        return restore('browser', browser);
      }
      browserTime = input.time;
      return { time: browserTime };
    }
    if (input.count) {
      let sent;
      for (let index = 0; index < input.count; index++) sent = receive('outside-tolerance', 10_000);
      return { issuedAtMs: sent.issuedAtMs, completedLocalSends: input.count };
    }
    return receive(input.label, input.ttlMs);
  } };
  const expect = { poll(read) { return {
    async toBe(value) { assert.equal(await read(), value); },
    async toEqual(value) {
      const actual = await read();
      if (qualificationError) throw qualificationError;
      assert.deepEqual(actual, value);
    },
  }; } };
  let finished = false;
  const outcome = qualifyFirstAppSignals({ page, peer, expect,
    transportCounters: async () => ({ instance: 'fixture', relayBinaryBytes: 0 }) })
    .then(value => { finished = true; return { value }; },
      error => { finished = true; return { error }; });
  return { native, browser, bothStarted: bothStarted.promise, started, settled, outcome,
    finished: () => finished };
}

test('freshness failure remains primary while both failed clock restorations settle', { timeout: 2000 }, async t => {
  const original = Object.assign(Error('original freshness check failed'), { code: 'FRESHNESS_ASSERTION_FAILED' });
  const native = Object.assign(Error('native restore rejected'), { code: 'NATIVE_RESTORE_FAILED' });
  const browser = Object.assign(Error('browser restore timed out'), { code: 'SIGNAL_QUALIFICATION_WORKER_CLOCK_TIMEOUT' });
  const run = fixture(t, original);
  await run.bothStarted;
  run.native.reject(native);
  await setImmediate();
  assert.equal(run.finished(), false, 'The browser restoration must finish even after native restoration rejects.');
  run.browser.reject(browser);
  const { error } = await run.outcome;
  assert.ok(error instanceof AggregateError);
  assert.equal(error.cause, original);
  assert.equal(error.code, original.code);
  assert.deepEqual(error.errors, [original, native, browser]);
  assert.match(error.message, /^original freshness check failed/);
  assert.match(error.message, /native: native restore rejected/);
  assert.match(error.message, /browser: browser restore timed out/);
  assert.deepEqual(run.started, ['native', 'browser']);
  assert.deepEqual(run.settled, ['native', 'browser']);
});

test('successful freshness checks still fail after browser cleanup rejects and native cleanup finishes', { timeout: 2000 }, async t => {
  const browser = Object.assign(Error('browser restoration failed'), { code: 'SIGNAL_QUALIFICATION_WORKER_CLOCK_TIMEOUT' });
  const run = fixture(t);
  await run.bothStarted;
  run.browser.reject(browser);
  await setImmediate();
  assert.equal(run.finished(), false, 'The native restoration must finish even after browser restoration rejects.');
  run.native.resolve({ restored: true });
  const { error, value } = await run.outcome;
  assert.equal(value, undefined);
  assert.ok(error instanceof AggregateError);
  assert.equal(error.cause, browser);
  assert.equal(error.code, browser.code);
  assert.deepEqual(error.errors, [browser]);
  assert.match(error.message, /browser: browser restoration failed/);
  assert.deepEqual(run.settled, ['browser', 'native']);
});

test('successful clock restoration rethrows the original freshness error unchanged', { timeout: 2000 }, async t => {
  const original = Error('original assertion');
  const run = fixture(t, original);
  await run.bothStarted;
  run.native.resolve({ restored: true });
  run.browser.resolve({ time: null });
  assert.equal((await run.outcome).error, original);
  assert.deepEqual(run.settled, ['native', 'browser']);
});
