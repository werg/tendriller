import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setImmediate as tick } from 'node:timers/promises';
import test from 'node:test';
import { createLiveView } from '../../docs/tutorial/helpers/live-view.mjs';
import { createOperationView } from '../../docs/tutorial/helpers/operation-view.mjs';
import { createReviewedInput } from '../../docs/tutorial/helpers/reviewed-input.mjs';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};
const revision = (generation, sequence) => ({ applicationId: 'app', historyId: 'history', generation,
  point: { generation, sequence, root: `${generation}-${sequence}` }, controlRevision: 1,
  materializationRevision: `${generation}:${sequence}` });
const read = (generation, sequence, value) => ({ revision: revision(generation, sequence), value });
function fixture() {
  const lifetime = new AbortController(), statuses = new Set(), recoveries = new Set(), streams = new Set();
  let currentStatus = { phase: 'ready', database: 'ready', generation: 'first' }, closedSessions = 0;
  const session = {
    signal: lifetime.signal, get status() { return currentStatus; },
    query: async () => read('first', 1, ['initial']),
    operations: { inspect: async () => null }, retry: async () => {}, reapply: async () => {},
    onStatus(fn) { statuses.add(fn); fn(currentStatus); return () => statuses.delete(fn); },
    onRecovery(fn) { recoveries.add(fn); return () => recoveries.delete(fn); },
    close() { closedSessions++; lifetime.abort(Error('Session closed')); },
    changes({ signal }) {
      return { [Symbol.asyncIterator]() {
        let done = false, pending, queue = [];
        const stream = { push(value) { if (done) return; if (pending) { pending({ value, done: false }); pending = undefined; } else queue.push(value); } };
        streams.add(stream);
        const stop = () => { done = true; streams.delete(stream); signal.removeEventListener('abort', stop);
          pending?.({ done: true }); pending = undefined; queue = []; };
        signal.addEventListener('abort', stop, { once: true });
        if (signal.aborted) stop();
        return { next() { return done ? Promise.resolve({ done: true }) : queue.length
          ? Promise.resolve({ done: false, value: queue.shift() }) : new Promise(resolve => { pending = resolve; }); },
        async return() { stop(); return { done: true }; } };
      } };
    },
  };
  return { session,
    change(value = { kind: 'applied', revision: revision('first', 2), recovery: null }) { for (const stream of streams) stream.push(value); },
    status(value) { currentStatus = { ...currentStatus, ...value }; for (const fn of statuses) fn(currentStatus); },
    recover(value) { for (const fn of recoveries) fn(value); },
    get observers() { return statuses.size + recoveries.size + streams.size; },
    get closedSessions() { return closedSessions; },
  };
}

test('live views coalesce invalidations and never paint an older read across recovery or close', async () => {
  const f = fixture(), reads = [], painted = [], recoveries = [];
  f.session.query = () => { const next = deferred(); reads.push(next); return next.promise; };
  const view = createLiveView(f.session, { query: 'notes', onRecovery: notice => recoveries.push(notice) });
  view.subscribe(value => painted.push(value)); await tick();
  assert.equal(reads.length, 1);
  f.change(); f.change();
  const notice = { generation: 'replacement', unknownLoss: true, abandoned: [] };
  f.recover(notice); await tick(); reads[0].resolve(read('first', 200, ['excluded'])); await tick();
  assert.equal(reads.length, 2); assert.deepEqual(painted, []);
  reads[1].resolve(read('replacement', 1, ['retained'])); await tick();
  assert.deepEqual(painted, [read('replacement', 1, ['retained'])]);
  assert.equal(view.snapshot, painted[0]); assert.deepEqual(recoveries, [notice]);
  const pending = view.refresh(); await tick();
  const cancelled = assert.rejects(pending, /closed/);
  view.close(); await cancelled; reads[2].resolve(read('replacement', 2, ['too late'])); await tick();
  assert.equal(painted.length, 1); assert.equal(f.observers, 0); assert.equal(f.closedSessions, 0);
});

test('live view status/error are separate from coherent data, readiness can resume a failed first read', async () => {
  const f = fixture(), errors = [], statuses = [], values = [];
  f.status({ phase: 'awaiting-keys' });
  f.session.query = async () => { if (f.session.status.phase !== 'ready') throw Error('Keys unavailable'); return read('first', 2, ['ready']); };
  const view = createLiveView(f.session, { query: 'notes', onError: error => errors.push(error.message), onStatus: value => statuses.push(value) });
  const unsubscribe = view.subscribe(value => values.push(value)); await tick();
  assert.equal(view.snapshot, null); assert.match(view.error.message, /Keys unavailable/);
  assert.equal(view.status.phase, 'awaiting-keys'); assert.equal(errors.length, 1);
  f.status({ phase: 'ready' }); await tick();
  assert.equal(view.error, null); assert.deepEqual(values, [read('first', 2, ['ready'])]);
  const replay = []; view.subscribe(value => replay.push(value)); assert.deepEqual(replay, values);
  unsubscribe(); f.change(); await tick(); assert.equal(values.length, 1);
  assert.equal(statuses.at(-1).phase, 'ready'); view.close();
});

test('a refresh requested by a snapshot listener waits for its own later read', async () => {
  const f = fixture(), second = deferred(); let reads = 0, nextRead, first = true;
  f.session.query = async () => ++reads === 1 ? read('first', 1, ['first']) : second.promise;
  const view = createLiveView(f.session, { query: 'notes' });
  view.subscribe(() => { if (first) { first = false; nextRead = view.refresh(); } }); await tick();
  let resolved = false; nextRead.then(() => { resolved = true; }); await tick(); assert.equal(resolved, false);
  second.resolve(read('first', 2, ['second'])); assert.deepEqual(await nextRead, read('first', 2, ['second'])); view.close();
});

test('operation state, retained coverage and recovery stay distinct; retry and reapply remain explicit', async () => {
  const f = fixture(), changes = [], retries = [], reapplies = [], shared = deferred();
  let state = { status: 'saved', operationId: 'original', attemptId: 'signed-attempt', generation: 'first' };
  const attempt = { id: 'signed-attempt', payload: { ciphertext: 'immutable' } };
  f.session.operations.inspect = async () => ({ state, attempt });
  f.session.retry = async id => { retries.push(id); };
  f.session.reapply = async (...args) => { reapplies.push(args); return { operationId: args[3].operationId }; };
  const operation = { operationId: 'original', shared: () => shared.promise };
  const view = createOperationView(f.session, { operationId: 'original', operation, onChange: value => changes.push(value) });
  await tick(); assert.equal(view.snapshot.state.status, 'saved'); assert.deepEqual(retries, []);
  await view.retry(); assert.deepEqual(retries, ['original']); assert.equal(view.snapshot.inspection.attempt, attempt);
  state = { ...state, status: 'applied', author: 'signer', sequence: 1, outcome: 'rejected', rejectionCode: 'STALE_TASK' };
  f.change(); await tick(); assert.equal(view.snapshot.state.outcome, 'rejected');
  const coverageWait = view.waitForShared();
  assert.equal(view.snapshot.state.status, 'applied'); assert.equal(view.snapshot.waitingForShared, true);
  const receipts = [{ payload: { peer: 'other', generation: 'first' }, signature: 'receipt' }];
  shared.resolve(receipts); await coverageWait;
  assert.deepEqual(view.snapshot.coverage, receipts); assert.equal(view.snapshot.state.status, 'applied');
  state = { status: 'abandoned', operationId: 'original', attemptId: 'signed-attempt', generation: 'first', selectedGeneration: 'replacement', previous: state };
  f.recover({ generation: 'replacement', unknownLoss: true, abandoned: [state] }); await tick();
  assert.equal(view.snapshot.state.status, 'abandoned'); assert.deepEqual(view.snapshot.coverage, receipts);
  await assert.rejects(view.retry(), /Review the current/); assert.equal(retries.length, 1);
  await assert.rejects(view.reapply({ name: 'addNote', input: 'reviewed', operationId: 'original', basedOn: revision('replacement', 1) }), /new operation ID/);
  const result = await view.reapply({ name: 'addNote', input: { text: 'reviewed' }, operationId: 'reviewed-again', basedOn: revision('replacement', 1) });
  assert.equal(result.operationId, 'reviewed-again');
  assert.deepEqual(reapplies, [['original', 'addNote', { text: 'reviewed' }, { operationId: 'reviewed-again', basedOn: revision('replacement', 1) }]]);
  assert.equal(changes.some(value => value.state?.status === 'shared'), false);
  view.close(); assert.equal(f.observers, 0); assert.equal(f.closedSessions, 0);
});

test('ID-only operation views cannot invent retention or an absent saved attempt', async () => {
  const f = fixture(); let writes = 0; f.session.retry = async () => { writes++; };
  const view = createOperationView(f.session, { operationId: 'uncertain' }); await tick();
  assert.equal(view.snapshot.state, null); assert.equal(view.snapshot.coverage, null);
  await assert.rejects(view.waitForShared(), /original operation handle/);
  await assert.rejects(view.retry(), /No saved attempt/); assert.equal(writes, 0); view.close();
});

test('operation observations ignore stale inspection after recovery and after closing', async () => {
  const f = fixture(), inspections = [], seen = [];
  f.session.operations.inspect = () => { const value = deferred(); inspections.push(value); return value.promise; };
  const view = createOperationView(f.session, { operationId: 'old', onChange: value => seen.push(value) });
  await tick(); f.recover({ generation: 'new', unknownLoss: true });
  inspections[0].resolve({ state: { status: 'applied' } }); await tick();
  assert.equal(seen.some(value => value.state?.status === 'applied'), false);
  view.close(); inspections[1].resolve({ state: { status: 'needsReapply' } }); await tick();
  assert.equal(seen.some(value => value.state), false); assert.equal(f.observers, 0);
});

test('retaking cancels analysis, rejects its stale result and preserves immutable evidence/context', async () => {
  const analysis = deferred(), signals = []; let commits = 0;
  const controller = createReviewedInput({ analyze: ({ signal }) => { signals.push(signal); return analysis.promise; }, commit: async () => { commits++; return {}; } });
  const context = { task: { id: 'repair', version: 1 }, revision: revision('first', 1) };
  const blob = new Blob(['frame one'], { type: 'image/png' });
  const first = await controller.capture({ blob, context }); context.task.version = 99;
  assert.equal(first.context.task.version, 1); assert.ok(Object.isFrozen(first.context.task));
  assert.equal(first.sha256, createHash('sha256').update('frame one').digest('hex'));
  const analyzed = controller.analyze(), rejected = assert.rejects(analyzed, /superseded/);
  const second = await controller.capture({ blob: new Blob(['frame two']), context: { task: 'second' } });
  await rejected; assert.equal(signals[0].aborted, true);
  analysis.resolve({ caption: 'outdated' }); await tick();
  assert.equal(controller.snapshot.candidate.id, second.id); assert.notEqual(second.id, first.id);
  assert.equal(controller.snapshot.analysis, null); assert.equal(commits, 0); controller.close();
});

test('analysis never supplies reviewed values or commits; explicit edits cancel pending suggestions', async () => {
  const pending = deferred(); let calls = 0;
  const controller = createReviewedInput({ analyze: async () => ++calls === 1 ? { suggestion: 'model text' } : pending.promise,
    commit: async () => { throw Error('Must not commit'); } });
  await controller.capture({ blob: new Blob(['image']), context: { version: 1 } });
  await controller.analyze(); assert.deepEqual(controller.snapshot.analysis, { suggestion: 'model text' });
  assert.equal(controller.snapshot.reviewed, null);
  await assert.rejects(controller.commit({ operationId: 'first' }), /Explicitly review/);
  const next = controller.analyze(), rejected = assert.rejects(next, /editing superseded/);
  const edited = { caption: 'person text' }; controller.edit(edited); edited.caption = 'mutated'; await rejected;
  pending.resolve({ suggestion: 'late text' }); await tick();
  assert.deepEqual(controller.snapshot.reviewed, { caption: 'person text' });
  controller.cancel(); assert.equal(controller.snapshot.phase, 'idle'); assert.equal(controller.snapshot.candidate, null); controller.close();
});

test('commit sends the exact reviewed candidate and ID once, with actual result evidence', async () => {
  const calls = [], receipt = { status: 'saved', operationId: 'reviewed-1' };
  const controller = createReviewedInput({ analyze: async () => ({ suggestion: 'draft' }), commit: async request => { calls.push(request); return receipt; } });
  const candidate = await controller.capture({ blob: new Blob(['outgoing']), context: { revision: revision('first', 7) } });
  controller.edit({ caption: 'reviewed' });
  await assert.rejects(controller.commit({}), /stable caller-owned/); assert.equal(calls.length, 0);
  const result = await controller.commit({ operationId: 'reviewed-1' }); receipt.status = 'mutated';
  assert.equal(calls.length, 1); assert.equal(calls[0].candidate, candidate);
  assert.deepEqual(calls[0].reviewed, { caption: 'reviewed' }); assert.equal(calls[0].operationId, 'reviewed-1');
  assert.deepEqual(result, { status: 'saved', operationId: 'reviewed-1' }); assert.equal(controller.snapshot.phase, 'submitted');
  await assert.rejects(controller.commit({ operationId: 'fresh-id' }), /commit was dispatched/);
  await assert.rejects(controller.capture({ blob: new Blob(['new']), context: {} }), /commit was dispatched/);
  assert.throws(() => controller.cancel(), /commit was dispatched/); controller.close();
});

test('cancelling a commit response preserves uncertainty and cannot authorize a new attempt', async () => {
  const response = deferred(), abort = new AbortController(); let calls = 0;
  const controller = createReviewedInput({ analyze: async () => ({}), commit: () => { calls++; return response.promise; } });
  await controller.capture({ blob: new Blob(['evidence']), context: {} }); controller.edit({ accepted: true });
  const submitted = controller.commit({ operationId: 'same-id', signal: abort.signal });
  const rejected = assert.rejects(submitted, /Lost observation/); abort.abort(Error('Lost observation')); await rejected;
  assert.equal(controller.snapshot.phase, 'uncertain'); assert.equal(controller.snapshot.operationId, 'same-id');
  response.resolve({ status: 'applied' }); await tick(); assert.equal(controller.snapshot.phase, 'uncertain');
  await assert.rejects(controller.commit({ operationId: 'another-id' }), /commit was dispatched/);
  assert.equal(calls, 1); controller.close();
});

test('capture enforces its byte budget and JSON boundaries before analysis or commit', async () => {
  const controller = createReviewedInput({ maxBytes: 3, analyze: async () => ({}), commit: async () => ({}) });
  await assert.rejects(controller.capture({ blob: new Blob(['four']), context: {} }), /3-byte/);
  await assert.rejects(controller.capture({ blob: new Blob(['ok']), context: { version: NaN } }), /plain JSON/);
  assert.equal(controller.snapshot.candidate, null); controller.close();
});

test('initial coherent readiness retains one owner through PEER_RECOVERING and retries only on readiness events', async () => {
  const f = fixture(), recover = Error('PEER_RECOVERING'); let reads = 0, resolved = false;
  f.status({ phase: 'recovering' });
  f.session.query = async () => { reads++; if (f.session.status.phase !== 'ready') throw recover; return read('first', 2, ['retained']); };
  const view = createLiveView(f.session, { query: 'notes' });
  const ready = view.ready({ timeoutMs: 1000 }).then(value => { resolved = true; return value; });
  await tick(); await tick();
  assert.equal(resolved, false); assert.equal(reads, 1); assert.equal(f.closedSessions, 0);
  assert.equal(view.error, recover);
  // Database activation may still be idle when protocol recovery becomes ready.
  f.status({ phase: 'ready', database: 'idle' });
  assert.deepEqual(await ready, read('first', 2, ['retained']));
  assert.equal(reads, 2); assert.equal(f.closedSessions, 0);
  assert.deepEqual(await view.ready(), view.snapshot); assert.equal(reads, 2);
  view.close(); assert.equal(f.observers, 0); assert.equal(f.closedSessions, 0);
});

for (const reason of ['cancel', 'timeout', 'fatal', 'view-close']) test(`initial readiness ${reason} rejects and removes its waiter without owning the session`, async t => {
  const f = fixture(), controller = new AbortController(), active = new Set();
  const add = controller.signal.addEventListener.bind(controller.signal), remove = controller.signal.removeEventListener.bind(controller.signal);
  t.mock.method(controller.signal, 'addEventListener', (type, listener, options) => { if (type === 'abort') active.add(listener); return add(type, listener, options); });
  t.mock.method(controller.signal, 'removeEventListener', (type, listener, options) => { if (type === 'abort') active.delete(listener); return remove(type, listener, options); });
  let reads = 0; const failure = Error(reason === 'fatal' ? 'APPLICATION_QUERY_UNKNOWN' : 'PEER_RECOVERING');
  f.session.query = async () => { reads++; throw failure; };
  const view = createLiveView(f.session, { query: 'notes' });
  const ready = view.ready({ signal: controller.signal, timeoutMs: reason === 'timeout' ? 20 : 1000 });
  const expected = reason === 'cancel' ? Error('Caller cancelled') : reason === 'fatal' ? failure : null;
  const rejected = assert.rejects(ready, error => reason === 'timeout' ? error.code === 'INITIAL_READ_TIMEOUT'
    : reason === 'view-close' ? /closed/i.test(error.message) : error === expected);
  assert.equal(active.size, 1);
  if (reason === 'cancel') controller.abort(expected);
  if (reason === 'view-close') view.close();
  await rejected; assert.equal(active.size, 0); assert.equal(f.closedSessions, 0);
  await tick(); assert.ok(reads <= 1, 'the readiness deadline must not poll or retry the read');
  view.close(); assert.equal(f.observers, 0); assert.equal(f.closedSessions, 0);
});

test('initial readiness ignores an invalidated recovery read and waits for the coherent replacement', async () => {
  const f = fixture(), reads = [];
  f.session.query = () => { const next = deferred(); reads.push(next); return next.promise; };
  const view = createLiveView(f.session, { query: 'notes' });
  let settled = false; const ready = view.ready({ timeoutMs: 1000 }).then(value => { settled = true; return value; });
  await tick(); f.recover({ generation: 'replacement', unknownLoss: true, abandoned: [] });
  reads[0].resolve(read('first', 9, ['excluded'])); await tick();
  assert.equal(settled, false); assert.equal(reads.length, 2);
  reads[1].resolve(read('replacement', 1, ['retained']));
  assert.deepEqual(await ready, read('replacement', 1, ['retained'])); view.close(); assert.equal(f.observers, 0);
});

test('initial recovery notifications cannot renew the fixed readiness deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); let reads = 0;
  f.session.query = async () => { reads++; throw Error('PEER_RECOVERING'); };
  const view = createLiveView(f.session, { query: 'notes' });
  const ready = view.ready({ timeoutMs: 100 });
  const rejected = assert.rejects(ready, { code: 'INITIAL_READ_TIMEOUT' });
  await tick(); t.mock.timers.tick(90);
  f.status({ phase: 'recovering' }); f.status({ phase: 'ready' }); await tick();
  assert.equal(reads, 2);
  t.mock.timers.tick(10); await rejected; view.close(); assert.equal(f.observers, 0); assert.equal(f.closedSessions, 0);
});
