import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runSessionCommand, watchSignals } from '../lib/session.mjs';

test('publish skips already-published asset hashes, derives deterministic operationId when omitted, and falls back on missing content', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tendril-pub-'));
  try {
    mkdirSync(join(dir, 'sub'), { recursive: true });
    const indexHtml = '<!doctype html><title>V2</title><script type="module" src="./app.mjs"></script>';
    const appMjs = 'console.log("unchanged");';
    writeFileSync(join(dir, 'index.html'), indexHtml);
    writeFileSync(join(dir, 'app.mjs'), appMjs);
    const appHash = createHash('sha256').update(appMjs).digest('hex');

    const prepared = [];
    const calls = [];
    const control = {
      async publication() {
        return {
          publication: {
            id: 'pub-prev-3',
            payload: {
              revision: 3,
              files: [{ path: 'app.mjs', hash: appHash, size: Buffer.byteLength(appMjs), type: 'text/javascript; charset=utf-8' }],
            },
          },
        };
      },
      async preparePublication(input) {
        prepared.push(input);
        return { id: 'pub-next-4', operationId: input.operationId, payload: input };
      },
      async publish(pub, assets) {
        calls.push({ pub, assets });
        if (calls.length === 1) {
          throw Object.assign(new Error('Missing content'), { code: 'peer_publication_content_missing' });
        }
        return { revision: 4, operationId: pub.operationId, uploaded: assets.length };
      },
    };
    const owned = { mode: 'attach', session: {}, control };
    const result = await runSessionCommand(owned, 'publish', [dir], {});
    assert.equal(prepared.length, 1);
    assert.match(prepared[0].operationId, /^pub-4-[a-f0-9]{16}$/);
    assert.equal(calls.length, 2);
    // First attempt only sent changed index.html (delta).
    assert.equal(calls[0].assets.length, 1);
    assert.notEqual(calls[0].assets[0].hash, appHash);
    // Fallback sent full asset list (both files) with exact same operationId.
    assert.equal(calls[1].pub.operationId, calls[0].pub.operationId);
    assert.equal(calls[1].assets.length, 2);
    assert.equal(result.uploaded, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('automatic publication identity never treats a failed head read as an empty history', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tendril-pub-head-'));
  try {
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Retained</title>');
    let prepared = 0;
    const unavailable = Object.assign(Error('Head unavailable'), { code: 'TIMEOUT' });
    const control = {
      publication: async () => { throw unavailable; },
      preparePublication: async input => { prepared++; return { id: 'signed', payload: input }; },
      publish: async (_publication, assets) => ({ uploaded: assets.length }),
    };
    await assert.rejects(runSessionCommand({ session: {}, control }, 'publish', [dir], {}), error => error === unavailable);
    assert.equal(prepared, 0);
    const result = await runSessionCommand({ session: {}, control }, 'publish', [dir], { operation: 'retained-original' });
    assert.equal(prepared, 1);
    assert.equal(result.uploaded, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('watchSignals streams live telemetry signals and stops cleanly on abort', async () => {
  const controller = new AbortController();
  const emitted = [];
  const session = {
    signals: {
      async *subscribe({ topics, mode, signal }) {
        assert.deepEqual(topics, ['dev/telemetry', 'dev/error', 'dev/health']);
        assert.equal(mode, 'all');
        yield { topic: 'dev/telemetry', authorId: 'peer-1', issuedAtMs: 1234, payload: { kind: 'error', message: 'boom' } };
        controller.abort();
        if (signal.aborted) return;
      },
    },
  };
  await watchSignals({ session }, event => emitted.push(event), { signal: controller.signal });
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].topic, 'dev/telemetry');
  assert.equal(emitted[0].authorId, 'peer-1');
  assert.deepEqual(emitted[0].payload, { kind: 'error', message: 'boom' });
});
