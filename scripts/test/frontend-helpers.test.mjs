import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setImmediate as tick } from 'node:timers/promises';
import test from 'node:test';
import { createLiveView } from '@chronolog/peer-session';
import { createOperationView } from '../../docs/tutorial/shared/helpers/operation-view.mjs';
import { createReviewedInput } from '../../docs/tutorial/shared/helpers/reviewed-input.mjs';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};
const revision = (digest, sequence = 0) => ({ digest: `${digest}-${sequence}`, view: 'local', executionManifestDigest: 'execution', policyDigest: 'policy' });
function fixture() {
  const lifetime = new AbortController(), statuses = new Set(), changes = new Set(), streams = new Set();
  let status = { canAuthor: true, phase: 'ready', database: 'ready', connectedPeers: 0 }, closedSessions = 0;
  const session = { applicationId: 'app', signal: lifetime.signal, get status() { return status; },
    readView: async () => ({ applicationId: 'app', revision: revision('initial'), query: () => ['initial'], release() {} }),
    operations: { get: async () => null, retry: async () => { throw Error('OPERATION_UNKNOWN'); } },
    onStatus(fn) { statuses.add(fn); fn(status); return () => statuses.delete(fn); },
    onChange(fn) { changes.add(fn); return () => changes.delete(fn); },
    close() { closedSessions++; lifetime.abort(Error('Session closed')); },
    changes({ signal }) { return { [Symbol.asyncIterator]() {
      let done = false, pending; const queue = [];
      const stream = { push(value) { if (done) return; if (pending) { pending({ value, done: false }); pending = undefined; } else queue.push(value); } }; streams.add(stream);
      const stop = () => { done = true; streams.delete(stream); signal.removeEventListener('abort', stop); pending?.({ done: true }); pending = undefined; queue.length = 0; };
      signal.addEventListener('abort', stop, { once: true }); if (signal.aborted) stop();
      return { next() { return done ? Promise.resolve({ done: true }) : queue.length ? Promise.resolve({ value: queue.shift(), done: false }) : new Promise(resolve => { pending = resolve; }); }, async return() { stop(); return { done: true }; } };
    } }; },
  };
  session.operations.subscribe = async function* ({ operationId, signal }) {
    let dirty = true, wake;
    const changed = () => { dirty = true; wake?.(); }, stopStatus = session.onStatus(changed), stopChange = session.onChange(changed);
    signal.addEventListener('abort', changed);
    try { while (!signal.aborted) { if (!dirty) await new Promise(resolve => { wake = resolve; }); if (signal.aborted) break; dirty = false; const op = await session.operations.get(operationId); if (op) yield await op.inspect(); } }
    finally { stopStatus(); stopChange(); signal.removeEventListener('abort', changed); }
  };
  return { session, change() { const change = { kind: 'materialized', revision: revision('revised'), revisedProposalIds: [] }; for (const listener of changes) listener(change); for (const stream of streams) stream.push(change); },
    status(value) { status = { ...status, ...value }; for (const fn of statuses) fn(status); }, get observers() { return statuses.size + changes.size + streams.size; }, get closedSessions() { return closedSessions; } };
}
test('live views coalesce late-operation invalidations and never paint an obsolete captured read', async () => {
  const f = fixture(), reads = [], painted = [];
  f.session.readView = () => { const next = deferred(); reads.push(next); return next.promise; };
  const view = createLiveView(f.session, captured => captured.query()); view.subscribe(value => painted.push(value)); await tick();
  f.change(); f.change();
  reads[0].resolve({ revision: revision('obsolete'), query: () => ['obsolete'], release() {} }); await tick();
  assert.equal(reads.length, 2); assert.deepEqual(painted, []);
  reads[1].resolve({ revision: revision('revised'), query: () => ['rederived'], release() {} }); await tick();
  assert.deepEqual(painted, [{ revision: revision('revised'), value: ['rederived'] }]);
  view.close(); await tick(); assert.equal(f.observers, 0); assert.equal(f.closedSessions, 0);
});
test('schema/query failure retains the last successful domain snapshot and does not close the authoring session', async () => {
  const f = fixture(), failures = []; let missing = false;
  f.session.readView = async () => ({ revision: revision(missing ? 'schema-dropped' : 'schema-present'), query() { if (missing) throw Error('no such table'); return ['row']; }, release() {} });
  const view = createLiveView(f.session, captured => captured.query(), { onError: error => failures.push(error.message) }); await tick(); const previous = view.snapshot;
  missing = true; f.change(); await tick(); assert.equal(view.snapshot, previous); assert.match(view.error.message, /no such table/); assert.equal(f.session.status.canAuthor, true); assert.deepEqual(failures, ['no such table']); view.close();
});
test('operation facts revise materialization without conflating authenticated retention or finality', async () => {
  const f = fixture(), retries = [], retained = deferred();
  let inspection = { applicationId: 'app', author: 'signer', proposalId: 'proposal', operationId: 'original', stored: true, pending: null, materialized: { outcome: 'accepted', revision: revision('first') }, retained: [], finalized: false, excluded: false };
  const operation = { inspect: async () => inspection, retained: () => retained.promise, finalized: async () => { throw Error('FINALITY_UNSUPPORTED'); } };
  f.session.operations.get = async () => operation; f.session.operations.retry = async id => { retries.push(id); return operation; };
  const view = createOperationView(f.session, { operationId: 'original' }); await tick(); assert.equal(view.snapshot.inspection.stored, true);
  inspection = { ...inspection, materialized: { outcome: 'rejected', revision: revision('earlier-arrived'), rejectionCode: 'guard_changed' } }; f.change(); await tick();
  assert.equal(view.snapshot.inspection.materialized.outcome, 'rejected'); assert.equal(view.snapshot.inspection.finalized, false);
  const waiting = view.waitFor('retained'); await tick(); assert.equal(view.snapshot.waitingFor, 'retained');
  const evidence = [{ signer: 'peer' }]; inspection = { ...inspection, retained: evidence }; retained.resolve(evidence); assert.deepEqual(await waiting, evidence);
  f.status({}); await tick(); assert.deepEqual(view.snapshot.inspection.retained, evidence, 'A retention-only notification must not wait for a new materialized snapshot');
  assert.equal(view.snapshot.inspection.materialized.outcome, 'rejected'); await assert.rejects(view.waitFor('finalized'), /FINALITY_UNSUPPORTED/);
  await view.retry(); assert.deepEqual(retries, ['original']); view.close(); await tick(); assert.equal(f.observers, 0); assert.equal(f.closedSessions, 0);
});
test('pure authenticated retention/finality notifications update an operation view without a new materialized revision or manual refresh', async () => {
  const f=fixture();let state={applicationId:'app',operationId:'facts-only',proposalId:'p',stored:true,materialized:{outcome:'accepted',revision:revision('same')},retained:[],finalized:false,excluded:false};
  f.session.operations.get=async()=>({inspect:async()=>state});const painted=[];
  const view=createOperationView(f.session,{operationId:'facts-only',onChange:value=>painted.push(value)});await tick();
  state={...state,retained:[{signer:'actual-peer'}]};f.status({});await tick();assert.equal(view.snapshot.inspection.retained.length,1);
  state={...state,finalized:true};f.status({});await tick();assert.equal(view.snapshot.inspection.finalized,true);assert.equal(view.snapshot.inspection.materialized.revision.digest,'same-0');
  view.close();await tick();const count=painted.length;f.status({});await tick();assert.equal(painted.length,count);assert.equal(f.observers,0);
});
test('an absent original operation cannot invent storage or retention', async () => {
  const f = fixture(), view = createOperationView(f.session, { operationId: 'uncertain' }); await tick(); assert.equal(view.snapshot.inspection, null);
  await assert.rejects(view.waitFor('retained'), /not locally visible/); await assert.rejects(view.retry(), /OPERATION_UNKNOWN/); view.close();
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
  const calls = [], receipt = { stored: true, operationId: 'reviewed-1' };
  const controller = createReviewedInput({ analyze: async () => ({ suggestion: 'draft' }), commit: async request => { calls.push(request); return receipt; } });
  const candidate = await controller.capture({ blob: new Blob(['outgoing']), context: { revision: revision('first', 7) } });
  controller.edit({ caption: 'reviewed' });
  await assert.rejects(controller.commit({}), /stable caller-owned/); assert.equal(calls.length, 0);
  const result = await controller.commit({ operationId: 'reviewed-1' }); receipt.stored = false;
  assert.equal(calls.length, 1); assert.equal(calls[0].candidate, candidate);
  assert.deepEqual(calls[0].reviewed, { caption: 'reviewed' }); assert.equal(calls[0].operationId, 'reviewed-1');
  assert.deepEqual(result, { stored: true, operationId: 'reviewed-1' }); assert.equal(controller.snapshot.phase, 'submitted');
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

for (const reason of ['cancel', 'timeout', 'view-close']) test(`bounded initial observation ${reason} does not own or close the signing session`, async () => {
  const f = fixture(), stop = new AbortController();
  f.session.readView = async () => new Promise(() => {});
  const view = createLiveView(f.session, captured => captured.query());
  const waiting = view.ready({ signal: stop.signal, timeoutMs: reason === 'timeout' ? 20 : 1000 });
  const rejected = assert.rejects(waiting, error => reason === 'timeout' ? error.message === 'LIVE_VIEW_TIMEOUT' : reason === 'view-close' ? /closed/i.test(error.message) : error === stop.signal.reason);
  if (reason === 'cancel') stop.abort(Error('caller cancelled'));
  if (reason === 'view-close') view.close();
  await rejected; view.close(); assert.equal(f.closedSessions, 0); assert.equal(f.observers, 0);
});
test('a late invalidation cannot make an obsolete captured read satisfy initial observation', async () => {
  const f = fixture(), reads = [];
  f.session.readView = () => { const next = deferred(); reads.push(next); return next.promise; };
  const view = createLiveView(f.session, captured => captured.query());
  const ready = view.ready({ timeoutMs: 1000 }); let settled = false; ready.then(() => { settled = true; });
  await tick(); f.change(); reads[0].resolve({ revision: revision('obsolete'), query: () => ['old'], release() {} }); await tick();
  assert.equal(settled, false); reads[1].resolve({ revision: revision('current'), query: () => ['current'], release() {} });
  assert.deepEqual(await ready, { revision: revision('current'), value: ['current'] }); view.close();
});
for (const failure of [Error('query unavailable'), null, undefined, 0]) test(`exact query failure ${String(failure)} stays a view error, not an authoring failure`, async () => {
  const f = fixture(), errors = []; f.session.readView = async () => ({ revision: revision('schema-changed'), query() { throw failure; }, release() {} });
  const view = createLiveView(f.session, captured => captured.query(), { onError: value => errors.push(value) });
  await assert.rejects(view.ready({ timeoutMs: 100 }), error => Object.is(error, failure)); assert.equal(view.snapshot, null); assert.equal(f.session.status.canAuthor, true); assert.ok(errors.some(error => Object.is(error, failure))); view.close();
});
