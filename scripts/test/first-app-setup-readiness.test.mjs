import test from 'node:test';
import assert from 'node:assert/strict';
import { observeLocalReadiness, describeLocalReadiness } from '../first-app-setup-readiness.mjs';

const ready = { canAuthor: true, phase: 'ready', database: 'ready', connectedPeers: 0, pendingOperations: 0, materializationError: null };
// A session double with exactly the public status surface. `listeners` lets tests prove cleanup.
function fixture(initial = ready) {
  let status = initial;
  const listeners = new Set();
  const session = {
    get status() { return status; },
    onStatus(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  return { session, listeners, observer: observeLocalReadiness(session),
    set(patch) { status = { ...status, ...patch }; for (const listener of [...listeners]) listener(status); } };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('local storage and key prerequisites define readiness; network and finality never do', async () => {
  // Offline, no peers, an unseen remote body pending, no finalizer: still ready to author and read.
  const f = fixture({ ...ready, connectedPeers: 0, pendingDependencies: ['body/' + 'a'.repeat(64)], pendingOperations: 1 });
  const value = await f.observer.wait();
  assert.equal(value.ready, true);
  assert.equal(f.listeners.size, 0, 'the status subscription is released after settlement');
  // The same snapshot omits peer, route and finality vocabulary entirely.
  assert.deepEqual(Object.keys(value).sort(), ['awaitingKeys', 'canAuthor', 'database', 'materializationError', 'pendingOperations', 'phase', 'ready']);
});

test('a missing writer grant or epoch key is not ready until the local prerequisite arrives', async () => {
  const f = fixture({ ...ready, canAuthor: false, phase: 'awaiting-keys' });
  let finished = false;
  const waiting = f.observer.wait().then(value => { finished = true; return value; });
  await flush(); assert.equal(finished, false);
  assert.equal(f.observer.snapshot().awaitingKeys, true);
  f.set({ phase: 'awaiting-keys', canAuthor: false, connectedPeers: 3 });
  await flush(); assert.equal(finished, false, 'connected peers cannot substitute for keys');
  f.set({ canAuthor: true, phase: 'ready' });
  assert.equal((await waiting).ready, true);
  assert.equal(f.listeners.size, 0);
});

test('an unseen older-epoch key does not block a device that can author with its current key', () => {
  const value = describeLocalReadiness({ ...ready, phase: 'awaiting-keys', canAuthor: true });
  assert.equal(value.ready, true);
  assert.equal(value.awaitingKeys, true);
});

test('failed local materialization and closure fail closed with distinct codes', async () => {
  const failed = fixture({ ...ready, canAuthor: false });
  const waiting = failed.observer.wait();
  failed.set({ database: 'failed', materializationError: 'STORE_CORRUPT' });
  await assert.rejects(waiting, { code: 'LOCAL_MATERIALIZATION_FAILED', cause: 'STORE_CORRUPT' });
  assert.equal(failed.listeners.size, 0);
  assert.equal(failed.observer.snapshot().ready, false);
  const closed = fixture({ ...ready, canAuthor: false });
  const closing = closed.observer.wait();
  closed.set({ phase: 'closed', database: 'closed' });
  await assert.rejects(closing, { code: 'SESSION_CLOSED' });
  // Already-terminal sessions fail immediately and cannot report ready from stale canAuthor.
  assert.equal(describeLocalReadiness({ ...ready, phase: 'closed', database: 'closed' }).ready, false);
  await assert.rejects(fixture({ ...ready, database: 'failed', materializationError: 'X' }).observer.wait(), { code: 'LOCAL_MATERIALIZATION_FAILED' });
});

test('abort and finite deadline release every listener and timer without reporting readiness', async () => {
  const f = fixture({ ...ready, canAuthor: false });
  const stop = new AbortController(), reason = Error('stop');
  const waiting = f.observer.wait({ signal: stop.signal });
  assert.equal(f.listeners.size, 1);
  stop.abort(reason);
  await assert.rejects(waiting, error => error === reason);
  assert.equal(f.listeners.size, 0);
  const already = new AbortController(); already.abort(reason);
  assert.throws(() => f.observer.wait({ signal: already.signal }), error => error === reason);
  assert.equal(f.listeners.size, 0, 'a pre-aborted wait never subscribes');
  const g = fixture({ ...ready, canAuthor: false });
  await assert.rejects(g.observer.wait({ timeoutMs: 5 }), { code: 'LOCAL_READY_TIMEOUT' });
  assert.equal(g.listeners.size, 0);
});

test('a synchronously reporting onStatus cannot leak its subscription', async () => {
  let unsubscribed = 0;
  const session = {
    status: ready,
    onStatus(listener) { listener(ready); return () => { unsubscribed++; }; },
  };
  assert.equal((await observeLocalReadiness(session).wait()).ready, true);
  assert.equal(unsubscribed, 1);
  const throwing = { status: ready, onStatus() { throw Error('subscription refused'); } };
  await assert.rejects(observeLocalReadiness(throwing).wait(), /subscription refused/);
});

test('the observer introduces no polling: waiting changes nothing until status changes', async () => {
  const f = fixture({ ...ready, canAuthor: false });
  const waiting = f.observer.wait({ timeoutMs: 1_000 });
  let reads = 0;
  const original = Object.getOwnPropertyDescriptor(f.session, 'status').get;
  Object.defineProperty(f.session, 'status', { get() { reads++; return original(); } });
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(reads, 0);
  f.set({ canAuthor: true });
  await waiting;
});
