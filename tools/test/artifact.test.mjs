import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

test('the core tools archive serves public libraries and commands without a checkout or installed runtime package', async t => {
  const dist = resolve(import.meta.dirname, '../../dist');
  const manifest = JSON.parse(readFileSync(join(dist, 'tools-manifest.json')));
  const artifact = manifest.artifacts[0];
  const bytes = readFileSync(join(dist, artifact.file));
  assert.equal(bytes.length, artifact.size);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.sha256);
  const root = mkdtempSync(join(tmpdir(), 'tendril-tools-artifact-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const installed = join(root, 'installed'); mkdirSync(installed);
  execFileSync('tar', ['-xzf', join(dist, artifact.file), '-C', installed]);
  const pkg = JSON.parse(readFileSync(join(installed, 'package.json')));
  assert.equal(pkg.name, '@tendriller/tools');
  assert.equal(pkg.tendriller.runtime, manifest.runtime);
  assert.deepEqual(Object.keys(pkg.exports).sort(), ['./pack', './preview', './session']);
  assert.equal(pkg.dependencies, undefined, 'operational runtime dependencies are bundled');
  assert.doesNotMatch(readFileSync(join(installed, 'THIRD_PARTY_NOTICES.txt'), 'utf8'), /ws@|@modelcontextprotocol/);
  assert.deepEqual(Object.keys(pkg.bin).sort(), ['tendril', 'tendril-preview']);
  const help = execFileSync(process.execPath, [join(installed, pkg.bin.tendril), '--help'], { cwd: root, encoding: 'utf8' });
  assert.match(help, /publish <directory>/);
  assert.doesNotMatch(help, /scaffold|assets sync|recipes/);
  const page = join(root, 'page'); mkdirSync(page);
  writeFileSync(join(page, 'index.html'), '<!doctype html><title>Independent authored page</title>');
  const { pack } = await import(pathToFileURL(join(installed, 'lib/pack.mjs')).href);
  assert.deepEqual(pack(page).files.map(file => file.path), ['index.html']);
  const { startServer } = await import(pathToFileURL(join(installed, 'lib/preview.mjs')).href);
  const server = await startServer(page);
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(origin + '/');
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Independent authored page/);
    const info = await (await fetch(origin + '/_preview/info')).json();
    assert.equal(info.mode, 'authored-files');
    assert.equal(info.publication.runtime.id, manifest.runtime);
    assert.equal((await fetch(origin + '/_tendril/runtime/' + manifest.runtime + '/tendril.js')).status, 200);
  } finally { await server.stopPreview(); }
});
