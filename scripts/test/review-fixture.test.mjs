import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupFixturePage, restoreFixtureCreationMode } from '../review/fixture.mjs';

const origin = 'https://selected.example';
const handle = { id: 'aaaaaaaaaaaa', api: origin + '/api/agent/pages/aaaaaaaaaaaa', token: 'ta_' + 'a'.repeat(32) };
function project(t, saved) {
  const path = mkdtempSync(join(tmpdir(), 'review-cleanup-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  mkdirSync(join(path, '.private'));
  if (saved) writeFileSync(join(path, '.private/handle.json'), JSON.stringify(saved));
  return path;
}

test('failed create child cleanup recovers its already-saved handle without creating again', async t => {
  const calls = [];
  const errors = await cleanupFixturePage({ project: project(t, handle), origin, creationAttempted: true,
    fetch: async (url, options) => { calls.push({ url, options }); return Response.json({ deleted: true }); } });
  assert.deepEqual(errors, []); assert.equal(calls.length, 2);
  assert.equal(calls[0].url, handle.api); assert.equal(calls[0].options.method, 'DELETE');
  assert.equal(calls[0].options.redirect, 'error');
  // The fixture's own agent is revoked after its only page.
  assert.equal(calls[1].url, origin + '/api/agent'); assert.equal(calls[1].options.method, 'DELETE');
});

test('unknown creation and cross-origin saved handles preserve recovery state without network cleanup', async t => {
  let requests = 0;
  const fetch = async () => { requests++; throw Error('must not send'); };
  const unknown = await cleanupFixturePage({ project: project(t), origin, creationAttempted: true, fetch });
  assert.match(unknown[0], /outcome is unknown/);
  const wrong = await cleanupFixturePage({ project: project(t, { ...handle, api: 'https://another.example/api/agent/pages/aaaaaaaaaaaa' }),
    origin, creationAttempted: true, fetch });
  assert.match(wrong[0], /no cleanup request/); assert.equal(requests, 0);
  assert(!JSON.stringify([...unknown, ...wrong]).includes(handle.token));
});

test('no attempted creation needs no cleanup, while failed deletion remains explicitly incomplete', async t => {
  let requests = 0;
  const fetch = async () => { requests++; return new Response(null, { status: 503 }); };
  assert.deepEqual(await cleanupFixturePage({ project: project(t), origin, creationAttempted: false, fetch }), []);
  assert.equal(requests, 0);
  const errors = await cleanupFixturePage({ project: project(t, handle), origin, creationAttempted: true, fetch });
  assert.match(errors[0], /Could not delete/); assert.equal(requests, 1);
});

test('restoration verifies the actual paused state and preserves a concurrent read-only decision', () => {
  for (const initial of ['open', 'creation_paused', 'read_only']) {
    let mode = initial;
    const db = sql => {
      if (sql.startsWith('UPDATE')) {
        assert.match(sql, /WHERE id=1 AND mode='open'/);
        if (mode === 'open') mode = 'creation_paused';
        return {};
      }
      return { results: [{ mode }] };
    };
    if (initial === 'read_only') {
      assert.throws(() => restoreFixtureCreationMode(db), /operator review/);
      assert.equal(mode, 'read_only');
    } else { restoreFixtureCreationMode(db); assert.equal(mode, 'creation_paused'); }
  }
});
