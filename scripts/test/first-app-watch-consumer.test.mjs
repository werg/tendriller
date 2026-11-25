import assert from 'node:assert/strict';
import test from 'node:test';
import { createWatchConsumerView } from '../first-app-publication.mjs';
import { watchSession } from '../../tools/cli/lib/session.mjs';

const revision = digest => ({ digest: digest.repeat(64).slice(0, 64), view: 'local', executionManifestDigest: 'b'.repeat(64), policyDigest: 'c'.repeat(64) });
const event = (operationId, text) => ({ operationId, payload: { text } });
const snapshot = (events, digest = 'a', cursor = 'cursor-' + digest) => ({ kind: 'snapshot', revision: revision(digest), events, cursor, hasMore: false });
const reset = digest => ({ kind: 'reset', reason: 'materialization-revised', revision: revision(digest), events: [], cursor: null, hasMore: true });

test('status lines carry no events and snapshots accumulate the current projection', () => {
  const view = createWatchConsumerView();
  assert.equal(view.accept({ kind: 'status', status: { canAuthor: true } }), null);
  view.accept(JSON.stringify(snapshot([event('one', 'browser note')])));
  assert.equal(view.observed('browser note'), true);
  assert.equal(view.observed('missing'), false);
  assert.equal(view.batches.length, 1, 'only event batches count as consumer progress');
});

test('a reset restarts the current projection: an old event the revised projection no longer holds is not observed', () => {
  const view = createWatchConsumerView();
  view.accept(snapshot([event('one', 'kept'), event('two', 'retracted')]));
  assert.equal(view.observed('retracted'), true);
  view.accept(reset('d'));
  assert.equal(view.observed('kept'), false, 'nothing is current until the revised projection is re-delivered');
  assert.equal(view.resets, 1);
  view.accept(snapshot([event('one', 'kept'), event('three', 'new')], 'd'));
  assert.equal(view.observed('kept'), true);
  assert.equal(view.observed('new'), true);
  assert.equal(view.observed('retracted'), false, 'the historical event stays retracted, never replayed from before the reset');
});

test('only the current line shapes are accepted: no legacy batch, unknown kind, malformed reset or snapshot', () => {
  const view = createWatchConsumerView();
  assert.throws(() => view.accept({ events: [], cursor: 'legacy' }), /revision/);
  assert.throws(() => view.accept({ kind: 'batch', revision: revision('a'), events: [], cursor: 'x' }), /UNKNOWN_LINE_KIND/);
  assert.throws(() => view.accept({ ...reset('a'), events: [event('x', 'y')] }), /reset carries no events/);
  assert.throws(() => view.accept({ ...reset('a'), cursor: 'x' }), /null cursor/);
  assert.throws(() => view.accept({ ...reset('a'), reason: 'other' }));
  assert.throws(() => view.accept({ ...snapshot([]), cursor: null }), /opaque cursor/);
  assert.throws(() => view.accept([]), /non-object/);
  const bounded = createWatchConsumerView({ limit: 2 });
  bounded.accept(snapshot([], 'a', 'one')); bounded.accept(snapshot([], 'a', 'two'));
  assert.throws(() => bounded.accept(snapshot([], 'a', 'three')), /BATCH_LIMIT/);
});

test('the consumer accepts the real watch stream across a materialization revision and drops the retracted event', async () => {
  // An earlier-authored operation arrives: the projection is revised, the CLI emits a reset and re-delivers current events.
  const projections = { a: [event('one', 'browser note'), event('two', 'retracted note')], d: [event('one', 'browser note'), event('three', 'native note')] };
  let current = 'a'; const revised = Promise.withResolvers(), stop = new AbortController();
  const session = { signal: new AbortController().signal, status: { canAuthor: true },
    async *changes({ signal }) {
      yield { kind: 'materialized', revision: revision('a'), revisedProposalIds: [] };
      await Promise.race([revised.promise, new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))]);
      if (!signal.aborted) yield { kind: 'materialized', revision: revision('d'), revisedProposalIds: ['two'] };
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    },
    async readView() {
      const digest = current;
      return { revision: revision(digest), release() {},
        readEvents({ cursor } = {}) { return cursor === 'cursor-' + digest ? { events: [], cursor, hasMore: false, revision: revision(digest) }
          : { events: structuredClone(projections[digest]), cursor: 'cursor-' + digest, hasMore: false, revision: revision(digest) }; } };
    } };
  const view = createWatchConsumerView(), kinds = [];
  const running = watchSession({ session }, value => { kinds.push(value.kind); view.accept(value); if (value.kind === 'snapshot' && value.revision.digest[0] === 'a') { current = 'd'; revised.resolve(); } },
    { signal: stop.signal, events: true, topics: ['note.put'] });
  for (let i = 0; i < 200 && !view.observed('native note'); i++) await new Promise(resolve => setTimeout(resolve, 5));
  stop.abort(Object.assign(Error('Invocation interrupted'), { code: 'invocation_interrupted' }));
  await running.catch(() => {});
  assert.deepEqual(kinds, ['snapshot', 'reset', 'snapshot'], 'events mode emits revision snapshots and a reset, never status lines');
  assert.equal(view.observed('native note'), true);
  assert.equal(view.observed('browser note'), true);
  assert.equal(view.observed('retracted note'), false, 'an event observed before the revision is not counted after it');
  assert.equal(view.resets, 1);
});
