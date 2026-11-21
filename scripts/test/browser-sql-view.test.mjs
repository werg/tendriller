import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { observeSqlFixture } from '../../test/e2e/specimens/browser-sql-view.mjs';
const revision = (sequence, generation = 'first') => ({ applicationId: 'application', historyId: 'history', generation,
  point: { generation, sequence, root: `root-${sequence}` }, controlRevision: 0, materializationRevision: String(sequence) });
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
function fixture() {
  const lifetime = new AbortController(), queued = [], reads = [], rendered = [];
  let waiting, returned = 0; const statuses = new Set(), errors = [];
  const session = { signal: lifetime.signal,
    onStatus(fn) { statuses.add(fn); return () => statuses.delete(fn); },
    changes({ signal }) { return { [Symbol.asyncIterator]() {
      const end = () => { waiting?.({ done: true }); waiting = undefined; };
      signal.addEventListener('abort', end, { once: true });
      return { next() { return queued.length ? Promise.resolve(queued.shift()) : new Promise(resolve => { waiting = resolve; }); },
        async return() { returned++; signal.removeEventListener('abort', end); end(); return { done: true }; } };
    } }; },
    query() { const read = deferred(); reads.push(read); return read.promise; },
  };
  const view = observeSqlFixture(session, { query: 'board', onSnapshot: value => rendered.push(value), onError: error => errors.push(error) });
  const change = (sequence, generation, kind = 'applied') => {
    const value = { done: false, value: { kind, revision: revision(sequence, generation) } };
    if (waiting) { const resolve = waiting; waiting = undefined; resolve(value); } else queued.push(value);
  };
  const complete = (index, sequence, generation) => reads[index].resolve({ revision: revision(sequence, generation), value: [sequence] });
  return { view, reads, rendered, change, complete, errors,
    status(phase) { for (const fn of statuses) fn({phase}); }, get statusListeners() { return statuses.size; }, get returned() { return returned; } };
}

test('initial change precedes the only initial read; blocked read cannot expose Ready or trigger a post-Ready duplicate', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); let ready = false;
  f.view.ready.then(() => { ready = true; });
  await setImmediate(); assert.equal(f.reads.length, 0);
  f.change(0); await setImmediate(); assert.equal(f.reads.length, 1);
  // A duplicate initial snapshot during the controlled 16s read is not another
  // demand. No startup sleep or extra Worker RPC is used as a barrier.
  f.change(0); t.mock.timers.tick(16_000); await setImmediate();
  assert.equal(ready, false); assert.equal(f.reads.length, 1); assert.equal(f.rendered.length, 0);
  f.complete(0, 0); await f.view.ready; await setImmediate();
  assert.equal(ready, true); assert.equal(f.reads.length, 1);
  f.change(0); await setImmediate(); assert.equal(f.reads.length, 1);
  f.view.close();
});

test('a change during the first blocked read fences stale output and Ready until the new coherent read', async () => {
  const f = fixture(); let ready = false; f.view.ready.then(() => { ready = true; });
  f.change(0); await setImmediate();
  f.change(1); await setImmediate(); f.complete(0, 0); await setImmediate();
  assert.equal(ready, false); assert.equal(f.rendered.length, 0); assert.equal(f.reads.length, 2);
  f.complete(1, 1); await f.view.ready;
  assert.deepEqual(f.rendered.map(value => value.value), [[1]]); f.view.close();
});

test('a read already containing the newest change coalesces it, and recovery can select a lower sequence', async () => {
  const f = fixture(); f.change(0); await setImmediate(); f.change(1); await setImmediate();
  f.complete(0, 1); await f.view.ready; assert.equal(f.reads.length, 1);
  f.change(0, 'replacement', 'recovery'); await setImmediate(); f.complete(1, 0, 'replacement'); await setImmediate();
  assert.deepEqual(f.rendered.map(value => value.revision.generation), ['first', 'replacement']); f.view.close();
});

test('closing a blocked initial read rejects Ready, returns the subscription and ignores the late result', async () => {
  const f = fixture(); const ended = assert.rejects(f.view.ready, /SQL_FIXTURE_VIEW_CLOSED/);
  f.change(0); await setImmediate(); f.view.close(); await ended; await setImmediate();
  assert.equal(f.returned, 1); f.complete(0, 0); await setImmediate(); assert.equal(f.rendered.length, 0);
});

test('a missing initial observation cannot leave readiness unbounded', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(), failed = assert.rejects(f.view.ready, /SQL_FIXTURE_VIEW_TIMEOUT/);
  t.mock.timers.tick(20_000); await failed; await setImmediate();
  assert.equal(f.reads.length, 0); assert.equal(f.returned, 1);
});


test('SQL initial PEER_RECOVERING retains the observer until readiness, without a post-Ready duplicate', async () => {
  const f = fixture(); let ready = false; f.view.ready.then(() => { ready = true; });
  f.change(0); await setImmediate(); f.reads[0].reject(Error('PEER_RECOVERING')); await setImmediate();
  assert.equal(ready, false); assert.equal(f.returned, 0); assert.deepEqual(f.errors, []); assert.equal(f.reads.length, 1);
  f.status('ready'); await setImmediate(); assert.equal(f.reads.length, 2);
  f.complete(1, 0); await f.view.ready; f.change(0); await setImmediate(); assert.equal(f.reads.length, 2);
  f.view.close(); assert.equal(f.statusListeners, 0);
});

test('SQL initial recovery keeps its existing deadline; fatal query errors still close promptly', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  for (const fatal of [false, true]) {
    const f = fixture(), failure = Error(fatal ? 'APPLICATION_QUERY_UNKNOWN' : 'PEER_RECOVERING');
    const rejected = assert.rejects(f.view.ready, fatal ? {message:'APPLICATION_QUERY_UNKNOWN'} : /SQL_FIXTURE_VIEW_TIMEOUT/);
    f.change(0); await setImmediate(); f.reads[0].reject(failure); await setImmediate();
    if (!fatal) { t.mock.timers.tick(20_000); }
    await rejected; await setImmediate(); assert.equal(f.returned, 1); assert.equal(f.statusListeners, 0);
    assert.equal(f.errors.length, 1);
  }
});


test('SQL readiness arriving during a failed initial read is retained as one retry event', async () => {
  const f = fixture(); f.change(0); await setImmediate();
  f.status('ready'); f.reads[0].reject(Error('PEER_RECOVERING')); await setImmediate();
  assert.equal(f.reads.length, 2); f.complete(1, 0); await f.view.ready;
  assert.deepEqual(f.errors, []); f.view.close(); assert.equal(f.statusListeners, 0);
});
