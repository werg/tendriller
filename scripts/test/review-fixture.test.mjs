import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupFixturePage, readFixtureHandle, restoreFixtureCreationMode } from '../review/fixture.mjs';

const origin = 'https://selected.example';
const id = 'aaaaaaaaaaaa', token = 'ta_' + 'a'.repeat(32);
const handle = { id, service: origin, api: origin + '/api/agent/pages/' + id, token };
/** A workspace as the fixture leaves it: one account-level credential and, once created, its one registered page. */
function project(t, { credential = true, page = true } = {}) {
  const path = mkdtempSync(join(tmpdir(), 'review-cleanup-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  if (credential) {
    mkdirSync(join(path, '.tendriller/agent'), { recursive: true });
    writeFileSync(join(path, '.tendriller/agent/credential.json'), JSON.stringify({ service: origin, token, publicKey: 'ab'.repeat(32), agent: { id: 'ag_' + 'a'.repeat(26), name: 'review-fixture' } }));
    writeFileSync(join(path, 'tendriller.json'), JSON.stringify({ schemaVersion: 1, service: origin, pages: page ? { review: { id } } : {} }));
  }
  if (credential && page) {
    mkdirSync(join(path, '.tendriller/pages', id), { recursive: true });
    writeFileSync(join(path, '.tendriller/pages', id, 'page.json'), JSON.stringify({ id, name: 'Checklist', page_url: 'https://page.example/s/key/', application: { id: '12'.repeat(32) } }));
  }
  return path;
}

test('the retained workspace is the only cleanup handle: its agent credential, shared signer key and one registered page', t => {
  assert.deepEqual(readFixtureHandle(project(t)), { id, service: origin, token, signerPublicKey: 'ab'.repeat(32), intendedApplicationId: null, api: handle.api,
    page_url: 'https://page.example/s/key/', name: 'Checklist', application: { id: '12'.repeat(32) } });
  assert.equal(readFixtureHandle(project(t, { page: false })).id, null);
  assert.throws(() => readFixtureHandle(project(t, { credential: false })), /ENOENT/);
});

test('failed setup child cleanup recovers its already-retained workspace without creating again', async t => {
  const calls = [];
  const errors = await cleanupFixturePage({ project: project(t), origin, creationAttempted: true,
    fetch: async (url, options) => { calls.push({ url, options }); return Response.json({ deleted: true }); } });
  assert.deepEqual(errors, []); assert.equal(calls.length, 2);
  assert.equal(calls[0].url, handle.api); assert.equal(calls[0].options.method, 'DELETE');
  assert.equal(calls[0].options.redirect, 'error');
  // The fixture's own agent is revoked after its only page.
  assert.equal(calls[1].url, origin + '/api/agent'); assert.equal(calls[1].options.method, 'DELETE');
});

test('an agent registered without a page is revoked, and a missing workspace or cross-origin handle sends nothing', async t => {
  const calls = [];
  assert.deepEqual(await cleanupFixturePage({ project: project(t, { page: false }), origin, creationAttempted: true,
    fetch: async (url, options) => { calls.push({ url, method: options.method }); return new Response(null, { status: 204 }); } }), []);
  assert.deepEqual(calls, [{ url: origin + '/api/agent', method: 'DELETE' }]);
  let requests = 0;
  const fetch = async () => { requests++; throw Error('must not send'); };
  const unknown = await cleanupFixturePage({ project: project(t, { credential: false }), origin, creationAttempted: true, fetch });
  assert.match(unknown[0], /outcome is unknown/);
  const wrong = await cleanupFixturePage({ project: project(t), origin: 'https://another.example', creationAttempted: true, fetch });
  assert.match(wrong[0], /no cleanup request/); assert.equal(requests, 0);
  assert(!JSON.stringify([...unknown, ...wrong]).includes(token));
});

test('no attempted creation needs no cleanup, while failed deletion remains explicitly incomplete', async t => {
  let requests = 0;
  const fetch = async () => { requests++; return new Response(null, { status: 503 }); };
  assert.deepEqual(await cleanupFixturePage({ project: project(t), origin, creationAttempted: false, fetch }), []);
  assert.equal(requests, 0);
  const errors = await cleanupFixturePage({ project: project(t), origin, creationAttempted: true, fetch });
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

test('every enumerated fixture source imports only copied sources or public packages, and keeps one workspace stack', async t => {
  const { installReviewFixtureSources, REVIEW_FIXTURE_FILES } = await import('../review/fixture.mjs');
  const { readFileSync, existsSync } = await import('node:fs');
  const { dirname, resolve } = await import('node:path');
  const root = resolve(import.meta.dirname, '../..'), target = mkdtempSync(join(tmpdir(), 'review-imports-'));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  installReviewFixtureSources(root, target);
  for (const [file] of REVIEW_FIXTURE_FILES.filter(([name]) => name.endsWith('.mjs'))) {
    const source = readFileSync(join(target, file), 'utf8');
    for (const match of source.matchAll(/^(?:import|export)\b[^'"\n]*from\s*['"](\.{1,2}\/[^'"]+)['"]|^\s*(?:await\s+)?import\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]/gm))
      { const spec = match[1] ?? match[2]; assert(existsSync(resolve(dirname(join(target, file)), spec)), `${file} imports ${spec}, which the fixture does not install`); }
    // No per-page client, setup intent, session file or second workspace/credential implementation.
    assert.doesNotMatch(source, /\bcreateClient\b|prepareTendrilSetup|createSetupIntent|--session|createNativeBootstrap|publisher\.json/, file);
  }
  assert(REVIEW_FIXTURE_FILES.some(([, source]) => source === 'docs/tutorial/shared/helpers/page-provisioning.mjs'));
});
