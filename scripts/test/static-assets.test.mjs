import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { assetRouting } from '../deployment-defaults.mjs';

test('only public root platform assets bypass the Worker, with deployment headers and missing-file fallback', async () => {
  const runtime = JSON.parse(readFileSync(new URL('../../server/src/runtime-release.json', import.meta.url)));
  const mf = new Miniflare({
    workers: [{ config: {
      name: 'static-asset-routing-test', compatibilityDate: '2026-11-01',
      exports: { default: { type: 'worker' } },
      manifest: { mainModule: 'worker.mjs', modules: { 'worker.mjs': { type: 'esm',
        contents: `export default { fetch(request) { return new Response(new URL(request.url).pathname, { status: 418 }); } };`,
      } } },
      assets: { directory: fileURLToPath(new URL('../../server/public', import.meta.url)), hasUserWorker: true, runWorkerFirst: assetRouting(runtime.id) },
    } }],
  });
  try {
    const origin = 'https://abcdefghijkl.tendriller.site';
    for (const path of [`/_tendril/runtime/${runtime.id}/tendril.js`, '/_tendril/brand/icon-64.png', '/favicon.ico']) {
      const response = await mf.dispatchFetch(origin + path);
      assert.equal(response.status, 200, `${path} must not invoke the sentinel Worker`);
      assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
      assert.match(response.headers.get('Strict-Transport-Security'), /includeSubDomains/);
      assert.equal(response.headers.get('X-Robots-Tag'), 'noindex, nofollow');
      assert.equal(response.headers.get('Cache-Control'), path.includes('/runtime/') ? 'public, max-age=31536000, immutable' : 'no-cache');
      const etag = response.headers.get('ETag');
      await response.arrayBuffer();
      const head = await mf.dispatchFetch(origin + path, { method: 'HEAD' });
      assert.equal(head.status, 200); assert.equal(await head.text(), '');
      assert.equal((await mf.dispatchFetch(origin + path, { headers: { 'If-None-Match': etag } })).status, 304);
    }
    for (const path of [
      `/_tendril/runtime/${'f'.repeat(64)}/historical.js`,
      '/_tendril/sw.js', '/agent.md', '/legal/privacy.html',
      `/s/${'a'.repeat(26)}/_tendril/runtime/${runtime.id}/tendril.js`,
      `/s/${'a'.repeat(26)}/_tendril/assets/${'a'.repeat(64)}/model.bin`,
      `/s/${'a'.repeat(26)}/_publications/1/private.js`,
    ]) {
      const response = await mf.dispatchFetch(origin + path);
      const body = await response.text();
      assert.equal(response.status, 418, `${path} must reach Worker routing: ${body}`);
    }
    const unknownCurrent = await mf.dispatchFetch(`${origin}/_tendril/runtime/${runtime.id}/not-in-the-graph.js`);
    assert.equal(unknownCurrent.status, 404, 'the current bundled graph is complete; unknown paths are static misses');
    await unknownCurrent.text();
  } finally { await mf.dispose(); }
});
