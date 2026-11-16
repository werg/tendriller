import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { startServer } from '../lib/preview.mjs';
import { pack } from '../../cli/lib/pack.mjs';

async function fixture(t, files, scenario = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tendril-authored-preview-'));
  for (const [name, text] of Object.entries(files)) {
    const target = join(dir, name);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, text);
  }
  const server = await startServer(dir, undefined, scenario);
  t.after(async () => { await server.stopPreview(); rmSync(dir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { dir, server, origin, get: path => fetch(origin + path) };
}

test('preview and packing enumerate identical authored bytes without completing a missing import', async t => {
  const files = { 'index.html': '<!doctype html><script src="missing.js"></script>',
    'reading.js': '// adapted algorithm', 'data/notes.json': '{"reading": 42}' };
  const { dir, get } = await fixture(t, files);
  const before = readdirSync(dir);
  const info = await (await get('/_tendril/info')).json();
  const publication = info.publication;
  const packed = pack(dir).files;
  assert.deepEqual(publication.assets.map(asset => asset.path).sort(), Object.keys(packed).sort());
  for (const asset of publication.assets) {
    const bytes = Buffer.from(packed[asset.path], 'utf8');
    assert.equal(asset.size, bytes.length);
    assert.equal(asset.sha256, createHash('sha256').update(bytes).digest('hex'));
  }
  assert.equal((await get(publication.base + 'missing.js')).status, 404);
  assert.equal((await get('/missing.js')).status, 404);
  assert.deepEqual(readdirSync(dir), before);
});

test('nested HTML pins its actual entry and resolves assets relative to its authored directory', async t => {
  const { get } = await fixture(t, { 'index.html': '<!doctype html><a href="reports/detail.html">Report</a>',
    'reports/detail.html': '<!doctype html><head></head><script src="detail.js"></script><img src="../photo.svg">',
    'reports/detail.js': '// local detail', 'photo.svg': '<svg></svg>' });
  const response = await get('/reports/detail.html');
  assert.equal(response.status, 200);
  const html = await response.text();
  const config = JSON.parse(/window\.__TENDRIL__=(.*?);<\/script>/.exec(html)[1]);
  assert.equal(config.publication.entry, 'reports/detail.html');
  const base = /<base href="([^"]+)"/.exec(html)[1];
  assert.equal(base, config.publication.base + 'reports/');
  assert.equal(await (await get(base + 'detail.js')).text(), '// local detail');
  assert.equal(await (await get(config.publication.base + 'photo.svg')).text(), '<svg></svg>');
});

test('an edited page creates a new publication while existing lazy asset URLs retain exact bytes', async t => {
  const { dir, get } = await fixture(t, { 'index.html': '<!doctype html><script src="lazy.js"></script>', 'lazy.js': 'before' });
  const old = (await (await get('/_tendril/info')).json()).publication;
  writeFileSync(join(dir, 'lazy.js'), 'after');
  await get('/');
  const current = (await (await get('/_tendril/info')).json()).publication;
  assert.notEqual(current.id, old.id);
  assert.equal(await (await get(old.base + 'lazy.js')).text(), 'before');
  assert.equal(await (await get(current.base + 'lazy.js')).text(), 'after');
});

test('service capabilities are explicit fixtures and unsupported operations fail visibly', async t => {
  const { get } = await fixture(t, { 'index.html': '<!doctype html><p>Plain page</p>',
    'app-settings.json': '{"service":{"workflows":["secret"]}}' });
  assert.deepEqual((await (await get('/api/service')).json()).workflows, []);
  const unsupported = await get('/_tendril/workflows/secret/records');
  assert.equal(unsupported.status, 501);
  assert.equal((await unsupported.json()).error.code, 'preview_unsupported');
  const explicit = await fixture(t, { 'index.html': '<!doctype html><p>Selected capability</p>' }, {
    service: { workflows: [{ id: 'review', interface_version: '1', schema_version: '1' }] },
  });
  assert.equal((await (await explicit.get('/api/service')).json()).workflows[0].id, 'review');
  assert.equal((await explicit.get('/_tendril/workflows/review/respond')).status, 501,
    'advertising fixture availability must never fabricate a server implementation');
});
