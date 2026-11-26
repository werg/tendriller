import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as p from '@chronolog/peer-session';
import { openNativeDevice } from '@chronolog/peer-session/native';
import { definition, imports, topics } from '../../docs/tutorial/templates/notes/domain.mjs';
import { genesisForDevices } from '../../collaboration/test/physical-fixture.mjs';

// Execute the published example itself: the native API and cleanup contract
// must stay usable without a private package import or an undocumented method.
const guide = await readFile(new URL('../../docs/AGENT_RESTART.md', import.meta.url), 'utf8');
const example = guide.match(/```js\n(\/\/ native-event-consumer-example\n[\s\S]*?)\n```/)[1];
const { consumeNativeEvents } = await import('data:text/javascript;base64,' + Buffer.from(example).toString('base64'));

function fixture({ failRead, failCommit, cancelOnAcquire, staleCursor, change } = {}) {
  const owner = new AbortController(), cancellation = new AbortController();
  let released = 0, observed = 0, cursor = 'handled', committed = 0;
  const failure = Error('Retained failure');
  const session = {
    signal: owner.signal,
    // changes() sends no initial notification: the documented consumer subscribes first, then reads once.
    async *changes() { if (change) yield change; },
    async readView() {
      observed++;
      if (cancelOnAcquire) cancellation.abort(failure);
      return {
        async readEvents(options) {
          assert.deepEqual(options.topics, ['note']); assert.equal(options.cursor, 'handled');
          if (failRead) throw failure;
          if (staleCursor) throw Object.assign(Error('EVENT_CURSOR_STALE'), { code: 'EVENT_CURSOR_STALE' });
          return { events: [{ id: 'stable-event' }], cursor: 'next', hasMore: false };
        },
        async release() { released++; },
      };
    },
  };
  const run = () => consumeNativeEvents(session, { topics: ['note'], signal: cancellation.signal,
    loadCursor: () => cursor,
    async commitBatch(batch, { signal }) {
      signal.throwIfAborted();
      if (failCommit) throw failure;
      committed++; cursor = batch.cursor;
    },
  });
  return { run, failure, get released() { return released; }, get observed() { return observed; },
    get cursor() { return cursor; }, get committed() { return committed; } };
}

for (const scenario of ['failRead', 'failCommit', 'cancelOnAcquire', 'staleCursor']) {
  test(`documented event consumer releases its captured view on ${scenario} without advancing handled work`, async () => {
    const f = fixture({ [scenario]: true });
    await assert.rejects(f.run(), error => scenario === 'staleCursor'
      ? error.code === 'EVENT_CURSOR_STALE' : error === f.failure);
    assert.equal(f.released, 1); assert.equal(f.committed, 0);
    assert.equal(f.cursor, 'handled');
  });
}

test('documented event consumer reads once after subscribing, then treats a stream that yields nothing and ends as failure', async () => {
  const ended = fixture();
  await assert.rejects(ended.run(), /Event observation ended/);
  assert.equal(ended.released, 1); assert.equal(ended.committed, 1); assert.equal(ended.cursor, 'next');
});

test('documented event consumer subscribes before its initial read and a change during that read wakes a second pass', async () => {
  const owner = new AbortController(), cancellation = new AbortController(), order = [], batches = [];
  let wake, reads = 0;
  const session = { signal: owner.signal,
    changes({ signal }) { order.push('subscribe'); return { [Symbol.asyncIterator]() { return { next() {
      order.push('next');
      return new Promise((resolve, reject) => { wake = () => resolve({ done: false, value: { kind: 'materialized' } }); signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
    }, async return() { return { done: true }; } }; } }; },
    async readView() {
      order.push('read'); const pass = reads++;
      // The change lands while the first coherent read is in progress; it is not lost.
      if (pass === 0) queueMicrotask(() => wake());
      return { async readEvents() { return { events: [{ id: 'pass-' + pass }], cursor: 'cursor-' + pass, hasMore: false }; }, async release() { order.push('release'); } };
    } };
  const running = consumeNativeEvents(session, { topics: ['note.put'], signal: cancellation.signal, loadCursor: () => undefined,
    commitBatch: batch => { batches.push(batch.cursor); if (batches.length === 2) cancellation.abort(Error('done')); } });
  await assert.rejects(running, error => error === cancellation.signal.reason);
  assert.deepEqual(order.slice(0, 3), ['subscribe', 'next', 'read'], 'the first pending next() exists before the initial read');
  assert.deepEqual(batches, ['cursor-0', 'cursor-1']);
});

test('documented consumer reads the pinned public native session and resumes its actual opaque cursor', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'native-read-doc-'));
  const device = await openNativeDevice({ path: join(directory, 'device.sqlite'), create: true });
  let session;
  t.after(async () => { try { await (session ? session.close() : device.close()); }
    finally { await rm(directory, { recursive: true, force: true }); } });
  const { genesisBytes, casNodes, key: epoch0Key } = await genesisForDevices([device], { imports, topics });
  session = await p.createApplicationSession({ device, definition, genesis: genesisBytes, casNodes, epochKeys: new Map([[0, epoch0Key]]) });
  for (const operationId of ['first', 'second']) {
    const operation = await session.command('putNote', { noteId: operationId, text: operationId }, { operationId });
    assert.equal((await operation.materialized({ signal: AbortSignal.timeout(5000) })).outcome, 'accepted');
  }
  let released = 0, cursor;
  const observed = { signal: session.signal, changes: session.changes.bind(session),
    async readView() {
      const view = await session.readView();
      return { readEvents: view.readEvents.bind(view), async release() { await view.release(); released++; } };
    } };
  for (const expected of [['first', 'second'], []]) {
    const cancellation = new AbortController(), handled = Promise.withResolvers(), events = [];
    const run = consumeNativeEvents(observed, { topics: ['note.put'], signal: cancellation.signal, loadCursor: () => cursor,
      commitBatch(batch) { events.push(...batch.events.map(event => event.operationId)); cursor = batch.cursor; handled.resolve(); } });
    const ended = assert.rejects(run, error => error === cancellation.signal.reason);
    await handled.promise;
    // Let the local commit finish and its captured view release before cancelling
    // the idle changes wait. This is read/cursor evidence, not external-effect qualification.
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(events, expected); assert.equal(typeof cursor, 'string');
    cancellation.abort(Error('Consumer stopped')); await ended;
  }
  assert.equal(released, 2);
  assert.equal((await session.query('notes', null)).value.length, 2, 'consumer cleanup never closes the owned session');
});
