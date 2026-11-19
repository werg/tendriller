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
