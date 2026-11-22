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

test('command batches validate later envelopes before submitting earlier commands', async () => {
  let commands = 0;
  await assert.rejects(runSessionCommand({ session: { command() { commands++; } } }, 'command-batch', [JSON.stringify([
    { command: 'add', input: {}, operationId: 'first' }, null,
  ])]), /Every batched command/);
  assert.equal(commands, 0);
});

test('an uncertain batch keeps earlier results and does not submit later commands', async () => {
  const calls = [], saved = { status: 'saved', operationId: 'second' };
  const session = {
    command: async (_name, _input, { operationId }) => {
      calls.push(operationId);
      return { applied: async () => {
        if (operationId === 'second') throw Error('lost reply');
        return { status: 'applied', outcome: 'accepted' };
      } };
    }, operations: { get: async () => saved },
  };
  const result = await runSessionCommand({ session }, 'command-batch', [JSON.stringify(
    ['first', 'second', 'third'].map(operationId => ({ command: 'add', input: {}, operationId })),
  )]);
  assert.deepEqual(calls, ['first', 'second']);
  assert.equal(result.complete, false);
  assert.equal(result.nextIndex, 2);
  assert.equal(result.results[0].lifecycle, 'applied');
  assert.equal(result.results[1].lifecycle, 'unknown');
  assert.deepEqual(result.results[1].state, saved);
});

test('missing application setup reports the next step before issuing session work', async () => {
  let called = false;
  await assert.rejects(withSession(undefined, () => { called = true; }),
    error => /page handle does not open a Chronolog session/.test(error.message) && /BUILD_AN_APP\.md/.test(error.message));
  assert.equal(called, false);
  await assert.rejects(runSessionCommand({ session: {} }, 'publication', []),
    error => /session-owned control participant/.test(error.message) && /publisher grant/.test(error.message));
});

test('commands preserve exact operation identity and captured revision without a tool retry queue', async () => {
  const calls = [], revision = { generation: 'selected', point: { sequence: 4 } };
  const operation = { status: 'saved', operationId: 'intent-1', attemptId: 'signed-original' };
  const session = { command: async (...args) => { calls.push(args); return { get: async () => operation }; } };
  assert.deepEqual(await runSessionCommand({ session }, 'command', ['claim', '{"id":"task"}'], {
    operation: 'intent-1', 'based-on': JSON.stringify(revision), saved: true,
  }), operation);
  assert.deepEqual(calls, [['claim', { id: 'task' }, { operationId: 'intent-1', basedOn: revision }]]);
  await assert.rejects(runSessionCommand({ session }, 'command', ['claim', '{}']), /stable operation identity/);
  assert.equal(calls.length, 1);
});

test('an interrupted applied waiter retains its original saved operation for inspection', async () => {
  const expected = Error('reply unavailable'), saved = { status: 'saved', operationId: 'original', attemptId: 'attempt' };
  let calls = 0;
  const session = { command: async () => { calls++; return { applied: async () => { throw expected; } }; },
    operations: { get: async id => { assert.equal(id, 'original'); return saved; } } };
  await assert.rejects(runSessionCommand({ session }, 'command', ['post', '{}'], { operation: 'original' }),
    error => error === expected && error.operation === saved);
  assert.equal(calls, 1);
});

test('retry and reviewed reapply call the same session journal with distinct intent semantics', async () => {
  const calls = [], session = {
    retry: async id => calls.push(['retry', id]), operations: { get: async id => ({ operationId: id, status: 'saved' }) },
    reapply: async (...args) => { calls.push(['reapply', ...args]); return { get: async () => ({ operationId: 'new' }) }; },
  };
  assert.equal((await runSessionCommand({ session }, 'retry', ['original'], { saved: true })).operationId, 'original');
  await runSessionCommand({ session }, 'reapply', ['original', 'claim', '{"id":"task"}'], {
    operation: 'new', 'based-on': '{"generation":"recovered"}', saved: true,
  });
  assert.deepEqual(calls, [['retry', 'original'], ['reapply', 'original', 'claim', { id: 'task' },
    { operationId: 'new', basedOn: { generation: 'recovered' } }]]);
});

test('coherent event reads always release their captured view, including a stale cursor failure', async () => {
  let released = 0;
  const session = { readView: async () => ({ readEvents: () => { throw Error('CURSOR_RECOVERED'); }, release: () => { released++; } }) };
  await assert.rejects(runSessionCommand({ session }, 'events', [], { cursor: 'old-generation' }), /CURSOR_RECOVERED/);
  assert.equal(released, 1);
});

test('session bootstrap ownership closes actual resources on failed actions and cancellation', async t => {
  const root = await directory(t), path = join(root, 'application.mjs'), closed = join(root, 'closed');
  await writeFile(path, `import { writeFile } from 'node:fs/promises';
export async function openSession() { return { session: { async close() { await writeFile(${JSON.stringify(closed)}, 'closed'); } } }; }`);
  await assert.rejects(withSession(path, async () => { throw Error('action failed'); }), /action failed/);
  assert.equal(await readFile(closed, 'utf8'), 'closed');
  const controller = new AbortController();
  await withSession(path, async () => { controller.abort(); }, { signal: controller.signal });
  assert.equal(await readFile(closed, 'utf8'), 'closed');
});

test('cleanup failure does not overwrite the original action or operation evidence', async t => {
  const root = await directory(t), path = join(root, 'failed-close.mjs');
  await writeFile(path, `export async function openSession() { return {session:{}, async close(){throw Object.assign(Error('cleanup failed'),{code:'CLOSE_FAILED'});}}; }`);
  const original = Object.assign(Error('publication verification failed'), { code: 'PUBLICATION_UNVERIFIED',
    publication: { operationId: 'original-release', outcome: 'committed', version: 1 } });
  await assert.rejects(withSession(path, async () => { throw original; }), error =>
    error === original && error.code === 'PUBLICATION_UNVERIFIED' && error.cleanupError.code === 'CLOSE_FAILED' && error.publication.operationId === 'original-release');
  await assert.rejects(withSession(path, async () => 'successful action'), { code: 'CLOSE_FAILED' });
});

test('deadline remains the primary error when closing the session rejects the pending action', async t => {
  const root = await directory(t), path = join(root, 'cancelled.mjs');
  await writeFile(path, `export async function openSession() { return {session:{}, async close(){throw Error('secondary cleanup failure');}}; }`);
  const controller = new AbortController();
  await assert.rejects(withSession(path, async () => {
    controller.abort(Object.assign(Error('Invocation timed out'), { code: 'invocation_timeout' }));
    throw Object.assign(Error('APPLICATION_SESSION_CLOSED'), { publication: { operationId: 'release-1', outcome: 'unknown' } });
  }, { signal: controller.signal }), error => error.code === 'invocation_timeout' && error.message === 'Invocation timed out'
    && error.cause.message === 'APPLICATION_SESSION_CLOSED' && error.publication.operationId === 'release-1'
    && error.cleanupError.message === 'secondary cleanup failure');
});

test('attachment is preferred, passes retained profile and context, and only detaches once on cancellation', async t => {
  const root = await directory(t), path = join(root, 'attached.mjs'), calls = join(root, 'calls');
  await writeFile(path, `import { appendFile } from 'node:fs/promises';
export async function openSession() { throw Error('must not open another signer'); }
export async function attachSession({mode,profile,context}) {
  await appendFile(${JSON.stringify(calls)}, JSON.stringify({mode,profile,context})+'\\n');
  return {session:{close(){throw Error('must not close the shared owner');}},
    async detach(){await appendFile(${JSON.stringify(calls)}, 'detach\\n');}};
}`);
  const controller = new AbortController();
  await withSession(path, async owned => {
    assert.equal(owned.mode, 'attach'); controller.abort();
    await Promise.resolve();
  }, { signal: controller.signal, profile: 'retained-main', runId: 'review-run' });
  assert.deepEqual((await readFile(calls, 'utf8')).trim().split('\n'), [
    JSON.stringify({ mode: 'attach', profile: 'retained-main', context: { runId: 'review-run' } }), 'detach',
  ]);
});

test('unreachable owner never causes a fallback signer; explicit ownership and independent profiles are deliberate', async t => {
  const root = await directory(t), path = join(root, 'modes.mjs'), calls = join(root, 'calls');
  await writeFile(path, `import { appendFile } from 'node:fs/promises';
export async function attachSession(){throw Object.assign(Error('owner offline'),{code:'OWNER_UNREACHABLE'});}
export async function openSession({mode,profile}) {
  await appendFile(${JSON.stringify(calls)}, JSON.stringify({mode,profile})+'\\n');
  return {session:{close(){throw Error('close must also release the profile fence');}},
    async close(){await appendFile(${JSON.stringify(calls)}, 'release\\n');}};
}`);
  await assert.rejects(withSession(path, () => {}), error => error.code === 'OWNER_UNREACHABLE');
  await assert.rejects(readFile(calls), { code: 'ENOENT' });
  await assert.rejects(withSession(path, () => {}, { mode: 'independent' }), /requires --profile/);
  await withSession(path, () => {}, { mode: 'own', profile: 'retained-main' });
  await withSession(path, () => {}, { mode: 'independent', profile: 'enrolled-reviewer' });
  assert.deepEqual((await readFile(calls, 'utf8')).trim().split('\n'), [
    JSON.stringify({ mode: 'own', profile: 'retained-main' }), 'release',
    JSON.stringify({ mode: 'independent', profile: 'enrolled-reviewer' }), 'release',
  ]);
  const legacy = join(root, 'legacy.mjs');
  await writeFile(legacy, 'export function openSession(){throw Error("must not open");}');
  await assert.rejects(withSession(legacy, () => {}, { mode: 'attach' }), /Attachment never falls back/);
});

test('self and endpoint diagnostics expose the actual attachment provenance', async () => {
  const endpoint = { ownerInstanceId: 'owner', endpointId: 'endpoint', capabilities: ['queries'],
    identity: { agentBindingId: 'agent' }, context: { runId: 'review' } };
  const owned = { mode: 'attach', session: { applicationId: 'application', deviceId: 'signer', endpoint,
    describe: () => ({ id: 'definition' }), status: { phase: 'ready' }, endpoints: async () => [endpoint] } };
  assert.deepEqual(await runSessionCommand(owned, 'self', []), { mode: 'attach', applicationId: 'application',
    historyId: null, deviceId: 'signer', endpoint });
  const diagnostic = await runSessionCommand(owned, 'doctor', []);
  assert.deepEqual(diagnostic.identity.endpoint.identity, endpoint.identity); assert.deepEqual(diagnostic.capabilities, ['queries']);
  assert.equal(diagnostic.protocol, 'tendriller.diagnostics.v1'); assert.equal(diagnostic.assessment, 'ready');
  assert.deepEqual(await runSessionCommand(owned, 'endpoints', []), [endpoint]);
});

test('attached recovery uses the owner administration facade without opening a control signer', async () => {
  const calls = [], signal = new AbortController().signal;
  const owned = { mode: 'attach', session: { recovery: {
    takeover: async options => { calls.push(['takeover', options]); return null; },
    handover: async options => { calls.push(['handover', options]); return null; },
  } } };
  await runSessionCommand(owned, 'recovery', ['takeover'], { transition: 'reviewed-1' }, { signal });
  await runSessionCommand(owned, 'recovery', ['handover', 'successor'], { transition: 'reviewed-2' }, { signal });
  assert.deepEqual(calls, [['takeover', { transitionId: 'reviewed-1', signal }],
    ['handover', { transitionId: 'reviewed-2', coordinator: 'successor', signal }]]);
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
