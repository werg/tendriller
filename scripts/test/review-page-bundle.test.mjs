import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { installReviewFixtureSources } from '../review/fixture.mjs';

// The signed page and its Worker must bundle for the browser from the enumerated public fixture sources, with
// every named import present in the current public contract. This checks composition, not browser behavior.
const root = resolve(import.meta.dirname, '../..');
const core = { 'browser-owner': 'session/browser.mjs', 'worker-owner': 'session/worker.mjs', participation: 'session/participation.mjs',
  authority: 'contract/authority.mjs', peers: 'contract/peers.mjs', assistant: 'contract/assistant.mjs', setup: 'contract/setup.mjs', '': 'contract/index.mjs' };
test('the review page and Worker bundle from copied fixture sources using only current public imports', async t => {
  const project = mkdtempSync(join(tmpdir(), 'review-bundle-')); t.after(() => rmSync(project, { recursive: true, force: true }));
  installReviewFixtureSources(root, project);
  const result = await build({ absWorkingDir: project, entryPoints: { page: 'review-page.mjs', worker: 'review-worker.mjs' }, bundle: true, write: false,
    splitting: true, outdir: join(project, 'page'), format: 'esm', platform: 'browser', target: 'es2022', outExtension: { '.js': '.mjs' }, logLevel: 'silent', nodePaths: [join(root, 'node_modules')],
    plugins: [{ name: 'public-core', setup(builder) {
      builder.onResolve({ filter: /^@tendriller\/core(\/.*)?$/ }, args => {
        const key = args.path.slice('@tendriller/core'.length + 1);
        if (!(key in core)) return { errors: [{ text: 'Unmapped core import ' + args.path }] };
        return { path: join(root, core[key]) };
      });
    } }] });
  const text = result.outputFiles.map(file => file.text).join('\n');
  assert.match(text, /completeItem/);
  assert.doesNotMatch(text, /handle\.json|publisher\.json|assistant-key|REVIEW_ACCESS_TOKEN|review-local/, 'no private handle, signer or setup credential enters the public graph');
  assert(result.outputFiles.some(file => file.path.endsWith('page.mjs')) && result.outputFiles.some(file => file.path.endsWith('worker.mjs')));
});
