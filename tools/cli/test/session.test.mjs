import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSessionCommand, withSession } from '../lib/session.mjs';
import { pack } from '../lib/pack.mjs';

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'session-tools-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}


const facts = id => ({ applicationId: 'app', author: 'author', proposalId: 'proposal', operationId: id, stored: true, pending: null, materialized: null, retained: [], finalized: false, excluded: false });
test('batch validates every envelope before storing any command', async () => {
  let calls = 0;
  await assert.rejects(runSessionCommand({ session: { command() { calls++; } } }, 'command-batch', [JSON.stringify([{ command: 'add', input: {}, operationId: 'one' }, null])]), /Every batch/);
  assert.equal(calls, 0);
});
test('default command acknowledges local storage without waiting for materialization or peers', async () => {
  const calls = [], observation = facts('stable');
  const operation = { inspect: async () => observation, materialized: () => assert.fail('not an authoring gate') };
  const session = { command: async (...args) => { calls.push(args); return operation; } };
  assert.deepEqual(await runSessionCommand({ session }, 'command', ['post', '{"text":"offline"}'], { operation: 'stable', 'author-time': '9223372036854775807' }), observation);
  assert.deepEqual(calls, [['post', { text: 'offline' }, { operationId: 'stable', authorTimestampMs: 9223372036854775807n }]]);
});
test('an explicit materialization wait preserves original stored intent on uncertainty', async () => {
  const failure = Error('wait interrupted'), observation = facts('original'), operation = { inspect: async () => observation, materialized: async () => { throw failure; } };
  const session = { command: async () => operation, operations: { get: async () => operation } };
  await assert.rejects(runSessionCommand({ session }, 'command', ['post', '{}'], { operation: 'original', wait: 'materialized' }), error => error === failure && error.operation === observation);
});
test('retry calls only the existing operation journal, never a replacement command', async () => {
  const observation = facts('original'), ids = [], session = { operations: { retry: async id => { ids.push(id); return { inspect: async () => observation }; } } };
  assert.deepEqual(await runSessionCommand({ session }, 'retry', ['original']), observation); assert.deepEqual(ids, ['original']);
});
test('batch reports independent local facts and stops at an uncertain original', async () => {
  const calls = [], operation = id => ({ inspect: async () => facts(id) });
  const session = { command: async (_name, _input, { operationId }) => { calls.push(operationId); if (operationId === 'two') throw Error('uncertain store reply'); return operation(operationId); }, operations: { get: async id => operation(id) } };
  const result = await runSessionCommand({ session }, 'command-batch', [JSON.stringify(['one', 'two', 'three'].map(operationId => ({ operationId, command: 'post', input: {} })))]);
  assert.deepEqual(calls, ['one', 'two']); assert.equal(result.complete, false); assert.equal(result.results[0].observation.stored, true); assert.equal(result.results[1].observation.operationId, 'two');
});

test('missing application setup reports the next step before issuing session work', async () => {
  let called = false;
  await assert.rejects(withSession(undefined, () => { called = true; }), /page attachment/);
  await assert.rejects(withSession(async () => ({ session: {} }), () => { called = true; }), /detach/);
  assert.equal(called, false);
  await assert.rejects(runSessionCommand({ session: {} }, 'publication', []), /independently authorized publisher\/control port/);
});

test('coherent event reads always release their captured view, including a stale cursor failure', async () => {
  let released = 0;
  const session = { readView: async () => ({ readEvents: () => { throw Error('CURSOR_STALE'); }, release: () => { released++; } }) };
  await assert.rejects(runSessionCommand({ session }, 'events', [], { cursor: 'old-snapshot' }), /CURSOR_STALE/);
  assert.equal(released, 1);
});

test('a page attachment detaches on failed actions and cancellation', async () => {
  let detached = 0;
  const open = async () => ({ session: {}, async detach() { detached++; } });
  await assert.rejects(withSession(open, async () => { throw Error('action failed'); }), /action failed/);
  assert.equal(detached, 1);
  const controller = new AbortController();
  await withSession(open, async owned => { assert.equal(owned.mode, 'attach'); controller.abort(); await Promise.resolve(); }, { signal: controller.signal });
  assert.equal(detached, 2, 'cancellation detaches exactly once');
});

test('cleanup failure does not overwrite the original action or operation evidence', async () => {
  const open = async () => ({ session: {}, async detach() { throw Object.assign(Error('cleanup failed'), { code: 'CLOSE_FAILED' }); } });
  const original = Object.assign(Error('publication verification failed'), { code: 'PUBLICATION_UNVERIFIED',
    publication: { operationId: 'original-release', outcome: 'committed', version: 1 } });
  await assert.rejects(withSession(open, async () => { throw original; }), error =>
    error === original && error.code === 'PUBLICATION_UNVERIFIED' && error.cleanupError.code === 'CLOSE_FAILED' && error.publication.operationId === 'original-release');
  await assert.rejects(withSession(open, async () => 'successful action'), { code: 'CLOSE_FAILED' });
});

test('deadline remains the primary error when detaching rejects the pending action', async () => {
  const open = async () => ({ session: {}, async detach() { throw Error('secondary cleanup failure'); } });
  const controller = new AbortController();
  await assert.rejects(withSession(open, async () => {
    controller.abort(Object.assign(Error('Invocation timed out'), { code: 'invocation_timeout' }));
    throw Object.assign(Error('APPLICATION_SESSION_CLOSED'), { publication: { operationId: 'release-1', outcome: 'unknown' } });
  }, { signal: controller.signal }), error => error.code === 'invocation_timeout' && error.message === 'Invocation timed out'
    && error.cause.message === 'APPLICATION_SESSION_CLOSED' && error.publication.operationId === 'release-1'
    && error.cleanupError.message === 'secondary cleanup failure');
});

test('an unreachable agent program is reported and never replaced by a second signer', async () => {
  let opened = 0;
  await assert.rejects(withSession(async () => { opened++; throw Object.assign(Error('owner offline'), { code: 'OWNER_UNREACHABLE' }); }, () => {}),
    error => error.code === 'OWNER_UNREACHABLE');
  assert.equal(opened, 1);
});

test('self and endpoint diagnostics expose the actual attachment provenance', async () => {
  const endpoint = { ownerInstanceId: 'owner', endpointId: 'endpoint', capabilities: ['queries'],
    identity: { agentBindingId: 'agent' }, context: { runId: 'review' } };
  const owned = { mode: 'attach', session: { applicationId: 'application', identity: { publicKey: 'signer' }, endpoint,
    describe: () => ({ id: 'definition' }), status: { phase: 'ready' }, endpoints: async () => [endpoint] } };
  assert.deepEqual(await runSessionCommand(owned, 'self', []), { mode: 'attach', page: null, applicationId: 'application',
    identity: { publicKey: 'signer' }, endpoint });
  const diagnostic = await runSessionCommand(owned, 'doctor', []);
  assert.deepEqual(diagnostic.identity.endpoint.identity, endpoint.identity); assert.deepEqual(diagnostic.capabilities, ['queries']);
  assert.equal(diagnostic.protocol, 'tendriller.diagnostics.v1'); assert.equal(diagnostic.assessment, 'ready');
  assert.deepEqual(await runSessionCommand(owned, 'endpoints', []), [endpoint]);
});

test('finality close, vote and submit keep exact int64 author times through canonical JSON-safe records', async () => {
  const { encodeRecord, decodeRecord } = await import('@chronolog/peer-session');
  const { authorityRecordBytes } = await import('@tendriller/core/authority');
  const MAX = 9223372036854775807n, closed = MAX - 1n;
  // Signed statements carry exact bigint times above Number.MAX_SAFE_INTEGER. This is serialization evidence only:
  // the stub signatures are not verified and prove nothing about the real finality cryptography.
  const proofs = [{ payload: { throughMs: MAX, closedThroughMs: closed }, signer: 'a'.repeat(64), signature: 'b'.repeat(128) }];
  const votes = [{ payload: { throughMs: MAX }, signer: 'c'.repeat(64), signature: 'd'.repeat(128) }];
  const calls = [];
  const session = { finality: {
    closeAuthorTime: async input => { calls.push(['close', input]); return { closedThroughMs: closed, proofs }; },
    voteAuthorTime: async input => { calls.push(['vote', input]); return votes; },
    submitProofs: async value => { calls.push(['submit', value]); return { admitted: true, closedThroughMs: closed, evidence: value }; },
  } };
  const decoded = wrapped => decodeRecord(authorityRecordBytes(wrapped));
  const closeResult = await runSessionCommand({ session }, 'finality', ['close'], { through: MAX.toString() });
  assert.deepEqual(calls.shift(), ['close', { throughMs: MAX }], 'the exact int64 frontier reaches the provider');
  assert.equal(closeResult.closedThroughMs, closed.toString(), 'the closed frontier is an exact decimal string');
  assert.doesNotThrow(() => JSON.stringify(closeResult), 'the result is JSON-safe after certification');
  assert.deepEqual(decoded(closeResult.proofs), proofs, 'signed statements and their bigint times decode exactly from canonical bytes');
  const unclosed = await runSessionCommand({ session: { finality: { closeAuthorTime: async () => ({ closedThroughMs: null, proofs: [] }) } } }, 'finality', ['close'], { through: '1' });
  assert.equal(unclosed.closedThroughMs, null); assert.deepEqual(decoded(unclosed.proofs), []);
  const voteResult = await runSessionCommand({ session }, 'finality', ['vote'], { through: MAX.toString() });
  assert.deepEqual(calls.shift(), ['vote', { throughMs: MAX }]);
  assert.doesNotThrow(() => JSON.stringify(voteResult));
  assert.deepEqual(decoded(voteResult.votes), votes);
  // Submitting canonical proof bytes decodes them back to the original signed values and returns the provider's raw result.
  const wrapped = closeResult.proofs, submitted = await runSessionCommand({ session }, 'finality', ['submit', JSON.stringify(wrapped)], {});
  const [, handed] = calls.shift();
  assert.deepEqual(handed, proofs); assert.equal(handed[0].payload.throughMs, MAX);
  assert.equal(submitted.closedThroughMs, closed, 'submit returns the provider evidence untouched, raw bigints included');
  assert.deepEqual(submitted.evidence, proofs);
  assert.equal(encodeRecord(handed).length, encodeRecord(proofs).length, 'no lossy rewrite of the signed statements');
  await assert.rejects(runSessionCommand({ session }, 'finality', ['close'], { through: (MAX + 1n).toString() }), /exact nonnegative int64/);
  assert.equal(calls.length, 0, 'an out-of-range frontier never reaches the provider');
});

test('optional finality is an explicit author-time provider request, not a write gate, and none stays explicitly unsupported', async () => {
  const calls = [], session = { finality: { closeAuthorTime: async input => { calls.push(input); return { closedThroughMs: input.throughMs, proofs: [] }; } } };
  const result = await runSessionCommand({ session }, 'finality', ['close'], { through: '123' });
  assert.equal(result.closedThroughMs, '123'); assert.deepEqual(calls, [{ throughMs: 123n }]);
  await assert.rejects(runSessionCommand({ session }, 'finality', ['close'], {}), /--through/);
  await assert.rejects(runSessionCommand({ session }, 'finality', [], {}), /none is explicitly unsupported/);
  await assert.rejects(runSessionCommand({ session }, 'finality', ['elect'], {}), /none is explicitly unsupported and unavailable finalizers never block local submission/);
});

test('publication sends a complete signed graph through the owned control participant', async t => {
  const root = await directory(t);
  await writeFile(join(root, 'index.html'), '<main>authored</main>');
  await writeFile(join(root, 'page.mjs'), 'export const revision = 1;');
  await writeFile(join(root, 'same.mjs'), 'export const revision = 1;');
  const signed = { id: 'signed-publication' }, calls = [];
  const control = { preparePublication: async input => { calls.push(input); return signed; },
    publish: async (publication, assets) => { calls.push({ publication, assets }); return { publication, version: 1 }; } };
  const result = await runSessionCommand({ session: {}, control }, 'publish', [root], { operation: 'release-1' });
  assert.deepEqual(result, { publication: signed, version: 1 });
  assert.equal(calls[0].operationId, 'release-1'); assert.equal(calls[0].entry, 'index.html');
  assert.deepEqual(calls[0].files.map(file => file.path), ['index.html', 'page.mjs', 'same.mjs']);
  assert.equal(calls[1].assets.length, 2, 'Content addressed bytes are uploaded once');
  assert.ok(calls[1].assets.every(asset => /^[a-f0-9]{64}$/u.test(asset.hash)));
  assert.equal(Buffer.from(calls[1].assets[1].bytes, 'base64').toString(), 'export const revision = 1;');
});

test('publication failure retains known receipt or unknown outcome and the original stable identity', async t => {
  const root = await directory(t);
  await writeFile(join(root, 'index.html'), '<main>exact bytes</main>');
  const signed = { id: 'signed-publication', payload: { operationId: 'release-1' } };
  for (const committed of [true, false]) {
    const cause = Object.assign(Error(committed ? 'head read unavailable' : 'upload reply lost'), { outcome: committed ? 'committed' : 'unknown',
      phase: committed ? 'selection' : 'submission', receipt: committed ? { publication: signed, version: 1 } : null });
    const control = { preparePublication: async () => signed, publish: async () => { throw cause; } };
    await assert.rejects(runSessionCommand({ session: {}, control }, 'publish', [root], { operation: 'release-1' }), error => error === cause
      && error.publication.operationId === 'release-1' && error.publication.outcome === (committed ? 'committed' : 'unknown')
      && error.publication.receipt?.version === (committed ? 1 : undefined));
  }
});

test('publication operation inspection reads the existing journal without preparing or sending work', async () => {
  const saved = { publication: { id: 'signed' }, receipt: null }, calls = [];
  const control = { publicationOperation: async id => { calls.push(id); return saved; } };
  assert.equal(await runSessionCommand({ session: {}, control }, 'publication-operation', ['original']), saved);
  assert.deepEqual(calls, ['original']);
  await assert.rejects(runSessionCommand({ session: {}, control: {} }, 'publication-operation', ['original']), { code: 'publication_inspection_unsupported' });
});

test('authored graphs retain exact bytes and reject incomplete, oversized or linked sources', async t => {
  const root = await directory(t);
  await writeFile(join(root, 'index.html'), '<title>exact</title>');
  await writeFile(join(root, '.secret'), 'private');
  await mkdir(join(root, 'images')); await writeFile(join(root, 'images', 'pixel.bin'), Buffer.from([0, 255, 127]));
  assert.deepEqual(pack(root).files.map(file => file.path), ['images/pixel.bin', 'index.html']);
  assert.deepEqual(pack(root).files[0].bytes, Buffer.from([0, 255, 127]));
  assert.throws(() => pack(root, { entry: 'missing.html' }), /complete authored graph/);
  assert.throws(() => pack(root, { maxBytes: 4 }), /upload limit|total byte/);
  await symlink(join(root, 'index.html'), join(root, 'linked.html'));
  assert.throws(() => pack(root), /symlink/);
});
