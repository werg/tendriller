import test from 'node:test';
import assert from 'node:assert/strict';
import { acquireRootLifetime, rootLifetimeLockName, rootLifetimeWitness, createDocumentLifetimeObserver } from '../root-lifetime.mjs';

function manager() {
  const held = new Map(), requests = [];
  const locks = {
    async query() { return { held: [...held.values()], pending: [] }; },
    async request(name, options, run) {
      requests.push({ name, options });
      if (held.has(name)) return run(null);
      const record = { name, mode: 'exclusive', clientId: 'document-client' };
      held.set(name, record);
      try { return await run(record); }
      finally { if (held.get(name) === record) held.delete(name); }
    },
  };
  return { held, requests, locks };
}

test('a unique document witness is retained without timers and explicit release is idempotent', async t => {
  const f = manager();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const witness = await acquireRootLifetime('profile', 'root', { locks: f.locks });
  assert.equal(witness.name, 'tendriller:root-lifetime:profile:root');
  t.mock.timers.tick(48 * 60 * 60 * 1000);
  assert.deepEqual(rootLifetimeWitness(await f.locks.query(), 'profile', 'root'), { name: witness.name, clientId: 'document-client' });
  const first = witness.release(); assert.equal(witness.release(), first); await first;
  assert.equal(f.held.size, 0); assert.equal(f.requests.length, 1);
});

test('abort releases an acquired witness without passing the forbidden signal/ifAvailable combination', async () => {
  const f = manager(), stop = new AbortController();
  const witness = await acquireRootLifetime('profile', 'root', { signal: stop.signal, locks: f.locks });
  assert.deepEqual(f.requests[0].options, { mode: 'exclusive', ifAvailable: true });
  stop.abort(Error('cancelled')); await witness.release();
  assert.equal(f.held.size, 0);
});

test('pre-abort never requests a lock', async () => {
  const f = manager(), stop = new AbortController(); stop.abort(Error('cancelled'));
  await assert.rejects(acquireRootLifetime('profile', 'root', { signal: stop.signal, locks: f.locks }), /cancelled/);
  assert.equal(f.requests.length, 0); assert.equal(f.held.size, 0);
});

test('abort rejects before a delayed native grant and the late grant releases without exposing a handle', async () => {
  const f = manager(), stop = new AbortController(), reason = Error('cancelled');
  let grant, requested, finished, rejection;
  const started = new Promise(resolve => { requested = resolve; });
  const ready = new Promise(resolve => { grant = resolve; });
  const nativeFinished = new Promise(resolve => { finished = resolve; });
  const locks = { query: f.locks.query, async request(...args) {
    requested(); await ready;
    try { return await f.locks.request(...args); } finally { finished(); }
  } };
  const opening = acquireRootLifetime('profile', 'root', { signal: stop.signal, locks });
  const settled = opening.then(() => { rejection = 'unexpected handle'; }, error => { rejection = error; });
  await started; stop.abort(reason);
  try {
    // One event-loop turn drains rejection microtasks without granting the lock.
    await new Promise(setImmediate);
    assert.equal(rejection, reason, 'cancellation must not wait for native grant');
    assert.equal(f.requests.length, 0); assert.equal(f.held.size, 0);
  } finally {
    grant(); await settled; await nativeFinished;
  }
  await new Promise(setImmediate); // Node's test runner also detects any unhandled late rejection.
  assert.equal(f.held.size, 0); assert.equal(f.requests.length, 1);
  assert.equal(rejection, reason);
});

test('normal explicit release still waits for the native request to finish', async () => {
  let complete, callbackDone;
  const held = new Set(), completion = new Promise(resolve => { complete = resolve; });
  const callbackFinished = new Promise(resolve => { callbackDone = resolve; });
  const locks = { query() {}, async request(name, _options, run) {
    held.add(name);
    try { await run({ name }); callbackDone(); await completion; }
    finally { held.delete(name); }
  } };
  const witness = await acquireRootLifetime('profile', 'root', { locks });
  let released = false;
  const releasing = witness.release().then(() => { released = true; });
  await callbackFinished;
  assert.equal(released, false); assert.equal(held.has(witness.name), true);
  complete(); await releasing;
  assert.equal(released, true); assert.equal(held.size, 0);
});

test('a duplicate root lock cannot borrow another document lifetime', async () => {
  const f = manager(), witness = await acquireRootLifetime('profile', 'root', { locks: f.locks });
  await assert.rejects(acquireRootLifetime('profile', 'root', { locks: f.locks }), /OWNER_ROOT_LIFETIME_BUSY/);
  assert.equal(f.held.size, 1); await witness.release(); assert.equal(f.held.size, 0);
});

test('request failure preserves its error and leaves no lifetime handle', async () => {
  const original = Error('lock manager failed');
  await assert.rejects(acquireRootLifetime('profile', 'root', {
    locks: { query() {}, request() { throw original; } },
  }), error => error === original);
});

test('witness lookup validates every held entry before declaring absence', () => {
  const name = rootLifetimeLockName('profile', 'root');
  const valid = { name, mode: 'exclusive', clientId: 'document' };
  for (const held of [null, [undefined], [valid, { name: 'unrelated', mode: 'exclusive' }]]) {
    assert.throws(() => rootLifetimeWitness({ held }, 'profile', 'root'), /OWNER_LIFETIME_QUERY_INVALID/);
  }
  assert.equal(rootLifetimeWitness({ held: [] }, 'profile', 'root'), undefined);
  assert.deepEqual(rootLifetimeWitness({ held: [valid] }, 'profile', 'root'), { name, clientId: 'document' });
});

test('names reject malformed identifiers and acquisition requires query support', async () => {
  for (const value of [undefined, null, 42, '', '../root', 'x'.repeat(129)]) {
    assert.throws(() => rootLifetimeLockName(value, 'root'), /OWNER_HANDSHAKE_INVALID/);
    assert.throws(() => rootLifetimeLockName('profile', value), /OWNER_HANDSHAKE_INVALID/);
  }
  await assert.rejects(acquireRootLifetime('profile', 'root', { locks: { request() {} } }), /OWNER_CAPABILITY_UNAVAILABLE/);
});

test('one observer coalesces shared/elected sweeps and never reaps a registration newer than its snapshot', async t => {
  const f = manager(), left = await acquireRootLifetime('profile', 'shared', { locks: f.locks });
  const right = await acquireRootLifetime('profile', 'elected', { locks: f.locks });
  t.after(async () => { await left.release(); await right.release(); });
  let complete, calls = 0;
  const snapshot = () => ({ held: [...f.held.values()] });
  const observer = createDocumentLifetimeObserver({ profileId: 'profile', locks: { query() {
    calls++; const value = snapshot(); return new Promise(resolve => { complete = () => resolve(value); });
  } } });
  t.after(() => observer.close());
  const retired = [];
  const shared = observer.register('shared', rootLifetimeWitness(snapshot(), 'profile', 'shared'), () => retired.push('shared'));
  const elected = observer.register('elected', rootLifetimeWitness(snapshot(), 'profile', 'elected'), () => retired.push('elected'));
  shared.setParked(true); elected.setParked(true);
  const first = observer.reapFresh(); await new Promise(setImmediate); assert.equal(calls, 1);
  const second = observer.reapFresh(), third = observer.reapFresh();
  // This registration was not captured by the first query and must survive it.
  const newcomer = observer.register('new', { name: rootLifetimeLockName('profile', 'new'), clientId: 'new-document' }, () => retired.push('new'));
  complete(); await first; await new Promise(setImmediate);
  assert.deepEqual(retired, []); assert.equal(calls, 2);
  // Concurrent admissions share one fresh post-arrival scan, not one query each.
  newcomer.close(); complete(); await Promise.all([second, third]);
  assert.equal(calls, 2); assert.deepEqual(retired, []);
  await left.release(); await right.release();
  const last = observer.reapFresh(); await new Promise(setImmediate); complete(); await last;
  assert.deepEqual(retired.sort(), ['elected', 'shared']);
  assert.equal(observer.hasParked, false);
});

test('document identity replacement and malformed held entries cannot authorize unrelated disposal', async t => {
  const f = manager(), lock = await acquireRootLifetime('profile', 'root', { locks: f.locks });
  t.after(() => lock.release());
  let snapshot = await f.locks.query();
  const observer = createDocumentLifetimeObserver({ profileId: 'profile', locks: { query: async () => snapshot } });
  t.after(() => observer.close());
  let retired = 0;
  const handle = observer.register('root', rootLifetimeWitness(snapshot, 'profile', 'root'), () => retired++);
  handle.setParked(true);
  snapshot = { held: [{ name: 'bad', mode: 'exclusive' }] };
  await observer.reapFresh(); assert.equal(retired, 0);
  snapshot = { held: [{ name: lock.name, mode: 'exclusive', clientId: 'different-document' }] };
  await observer.reapFresh(); assert.equal(retired, 1);
  await observer.reapFresh(); assert.equal(retired, 1);
});

test('observer close aborts a pending proof and fences a late empty snapshot', async () => {
  let resolve;
  const observer = createDocumentLifetimeObserver({ profileId: 'profile', locks: { query: () => new Promise(yes => { resolve = yes; }) } });
  let retired = 0;
  observer.register('root', { name: rootLifetimeLockName('profile', 'root'), clientId: 'document' }, () => retired++).setParked(true);
  const proof = observer.prove('opening');
  const rejected = assert.rejects(proof, /OWNER_UNREACHABLE/);
  await new Promise(setImmediate); observer.close(); await rejected;
  resolve({ held: [] }); await new Promise(setImmediate);
  assert.equal(retired, 0); assert.equal(observer.hasParked, false);
});
