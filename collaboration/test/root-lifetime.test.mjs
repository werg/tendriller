import test from 'node:test';
import assert from 'node:assert/strict';
import { acquireRootLifetime, rootLifetimeLockName, rootLifetimeWitness } from '../root-lifetime.mjs';

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

test('abort before native grant releases a late granted witness without exposing it', async () => {
  const f = manager(), stop = new AbortController();
  let grant, requested;
  const started = new Promise(resolve => { requested = resolve; });
  const ready = new Promise(resolve => { grant = resolve; });
  const locks = { query: f.locks.query, async request(...args) { requested(); await ready; return f.locks.request(...args); } };
  const opening = acquireRootLifetime('profile', 'root', { signal: stop.signal, locks });
  const rejected = assert.rejects(opening, /cancelled/);
  await started; stop.abort(Error('cancelled')); grant(); await rejected;
  assert.equal(f.held.size, 0);
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
