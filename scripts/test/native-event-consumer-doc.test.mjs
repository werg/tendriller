import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as p from '@chronolog/peer-session';
import { openNativeApplication, openNativeDevice } from '@chronolog/peer-session/native';
import { definition } from '../../docs/tutorial/templates/notes/domain.mjs';

// Execute the published example itself: the native API and cleanup contract
// must stay usable without a private package import or an undocumented method.
const guide = await readFile(new URL('../../docs/AGENT_RESTART.md', import.meta.url), 'utf8');
const example = guide.match(/```js\n(\/\/ native-event-consumer-example\n[\s\S]*?)\n```/)[1];
const { consumeNativeEvents } = await import('data:text/javascript;base64,' + Buffer.from(example).toString('base64'));

function fixture({ failRead, failCommit, cancelOnAcquire, recoverOnCommit, change } = {}) {
  const owner = new AbortController(), cancellation = new AbortController();
  let released = 0, observed = 0, cursor = 'handled', committed = 0, recovery;
  const failure = Error('Retained failure');
  const session = {
    signal: owner.signal,
    onRecovery(fn) { recovery = fn; return () => { recovery = undefined; }; },
    async *changes() { yield change ?? { kind: 'applied', revision: { generation: 'first' }, recovery: null }; },
    async readView() {
      observed++;
      if (cancelOnAcquire) cancellation.abort(failure);
      return {
        async readEvents(options) {
          assert.deepEqual(options.topics, ['note']); assert.equal(options.cursor, 'handled');
          if (failRead) throw failure;
          return { events: [{ id: 'stable-event' }], cursor: 'next', hasMore: false };
        },
        async release() { released++; },
      };
    },
  };
  const run = () => consumeNativeEvents(session, { topics: ['note'], signal: cancellation.signal,
    loadCursor: () => cursor,
    async commitBatch(batch, { signal }) {
      if (recoverOnCommit) recovery({ unknownLoss: true, adopted: null });
      signal.throwIfAborted();
      if (failCommit) throw failure;
      committed++; cursor = batch.cursor;
    },
  });
  return { run, failure, get released() { return released; }, get observed() { return observed; },
    get cursor() { return cursor; }, get committed() { return committed; }, get listening() { return Boolean(recovery); } };
}

for (const scenario of ['failRead', 'failCommit', 'cancelOnAcquire', 'recoverOnCommit']) {
  test(`documented event consumer releases its captured view on ${scenario} without advancing handled work`, async () => {
    const f = fixture({ [scenario]: true });
    await assert.rejects(f.run(), error => scenario === 'recoverOnCommit'
      ? error.recovery?.unknownLoss === true : error === f.failure);
    assert.equal(f.released, 1); assert.equal(f.committed, 0);
    assert.equal(f.cursor, 'handled'); assert.equal(f.listening, false);
  });
}

test('documented event consumer stops on recovery before reading and treats unexpected stream end as failure', async () => {
  const recovery = { unknownLoss: true, adopted: null };
  const recovered = fixture({ change: { kind: 'recovery', revision: { generation: 'new' }, recovery } });
  await assert.rejects(recovered.run(), error => error.recovery === recovery && error.revision.generation === 'new');
  assert.equal(recovered.observed, 0); assert.equal(recovered.cursor, 'handled'); assert.equal(recovered.listening, false);
  const ended = fixture();
  await assert.rejects(ended.run(), /Event observation ended/);
  assert.equal(ended.released, 1); assert.equal(ended.committed, 1);
  assert.equal(ended.cursor, 'next'); assert.equal(ended.listening, false);
});

test('documented consumer reads the pinned public native session and resumes its actual opaque cursor', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'native-read-doc-'));
  const device = await openNativeDevice({ path: join(directory, 'device.sqlite'), create: true });
  let session;
  t.after(async () => { try { await (session ? session.close() : device.close()); }
    finally { await rm(directory, { recursive: true, force: true }); } });
  const signer = await p.createPeerIdentity(), epochKey = crypto.getRandomValues(new Uint8Array(32));
  const execution = await p.executionManifestArtifacts(await p.eventExecutionManifest());
  const descriptor = await p.signApplicationDescriptor({ applicationId: '75'.repeat(32),
    historyId: 'native-read-doc', profile: 'peer-generation-v1', policy: 'eligible-members-v1',
    controlPublicKey: signer.publicKey, schemaAdministrator: device.identity.publicKey,
    definitionDigest: await p.applicationDefinitionDigest(definition),
    executionManifestDigest: p.bytesToHex(execution.executionManifestDigest), schemaDigest: null }, signer);
  const control = await p.signControlRevision({ applicationId: descriptor.payload.applicationId,
    profile: descriptor.payload.profile, policy: descriptor.payload.policy, revision: 0,
    previous: null, epoch: 0, keyDigest: await p.bytesDigest(epochKey), recoveryFloor: null,
    grants: [p.participantGrant(device.identity.publicKey, { administrator: true, publisher: true })] }, signer);
  const registry = await p.createGenerationRegistry({ store: new p.MemoryBytesStore(), descriptor, controls: [control], signer });
  await registry.select(await p.signTransitionRequest({ applicationId: descriptor.payload.applicationId,
    profile: descriptor.payload.profile, policy: descriptor.payload.policy, transitionId: 'initial',
    expectedGeneration: null, coordinator: device.identity.publicKey, requester: device.identity.publicKey,
    controlRevision: 0, reason: 'create', base: null }, device.identity));
  session = await openNativeApplication({ device, definition, authority: await registry.read(), epochKeys: new Map([[0, epochKey]]) });
  for (const operationId of ['first', 'second']) {
    const operation = await session.command('addNote', { text: operationId }, { operationId });
    assert.equal((await operation.applied({ signal: AbortSignal.timeout(5000) })).outcome, 'accepted');
  }
  let released = 0, cursor;
  const observed = { signal: session.signal, onRecovery: session.onRecovery.bind(session), changes: session.changes.bind(session),
    async readView() {
      const view = await session.readView();
      return { readEvents: view.readEvents.bind(view), async release() { await view.release(); released++; } };
    } };
  for (const expected of [['first', 'second'], []]) {
    const cancellation = new AbortController(), handled = Promise.withResolvers(), events = [];
    const run = consumeNativeEvents(observed, { topics: ['note'], signal: cancellation.signal, loadCursor: () => cursor,
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
