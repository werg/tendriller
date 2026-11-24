import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const compiled = await build({
  entryPoints: [new URL('../src/qr.ts', import.meta.url).pathname],
  bundle: true, format: 'iife', globalName: 'Qr', platform: 'browser', write: false,
});
const ctx = { TextEncoder, Uint8Array };
runInNewContext(compiled.outputFiles[0].text, ctx);
const { encodeQr, renderQrSvg } = ctx.Qr;

test('encodeQr produces valid finder, timing, dark module, and matching format copies across versions', () => {
  for (const [text, expectedMinVersion] of [
    ['https://example.test', 2],
    ['https://abc.pages.tendriller.dev/t/abc1234567890abcdef1234567890abcdef/', 4],
    ['a'.repeat(200), 9],
    ['b'.repeat(271), 10],
  ]) {
    const qr = encodeQr(text);
    assert.ok(qr.version >= expectedMinVersion && qr.version <= 10, `unexpected version ${qr.version}`);
    assert.equal(qr.size, qr.version * 4 + 17);
    assert.equal(qr.modules.length, qr.size * qr.size);
    const at = (r, c) => qr.modules[r * qr.size + c];

    // All three 7x7 finder corners have dark borders and dark 3x3 centers.
    for (const [tr, tc] of [[0, 0], [0, qr.size - 7], [qr.size - 7, 0]]) {
      assert.equal(at(tr, tc), 1);
      assert.equal(at(tr + 1, tc + 1), 0);
      assert.equal(at(tr + 3, tc + 3), 1);
      assert.equal(at(tr + 6, tc + 6), 1);
    }

    // Timing patterns alternate on row 6 and col 6.
    for (let i = 8; i < qr.size - 8; i++) {
      assert.equal(at(6, i), i % 2 === 0 ? 1 : 0);
      assert.equal(at(i, 6), i % 2 === 0 ? 1 : 0);
    }

    // Always-dark module at (size - 8, 8).
    assert.equal(at(qr.size - 8, 8), 1);

    // Format info copy 1 (top-left) matches copy 2 (bottom-left + top-right) bit-for-bit.
    const copy1 = [
      at(8, 0), at(8, 1), at(8, 2), at(8, 3), at(8, 4), at(8, 5), at(8, 7),
      at(8, 8), at(7, 8), at(5, 8), at(4, 8), at(3, 8), at(2, 8), at(1, 8), at(0, 8),
    ];
    const copy2 = [
      at(qr.size - 1, 8), at(qr.size - 2, 8), at(qr.size - 3, 8), at(qr.size - 4, 8),
      at(qr.size - 5, 8), at(qr.size - 6, 8), at(qr.size - 7, 8),
      at(8, qr.size - 8), at(8, qr.size - 7), at(8, qr.size - 6), at(8, qr.size - 5),
      at(8, qr.size - 4), at(8, qr.size - 3), at(8, qr.size - 2), at(8, qr.size - 1),
    ];
    assert.deepEqual(copy1, copy2);
  }
});

test('encodeQr rejects payloads exceeding 271 UTF-8 bytes and renderQrSvg escapes labels', () => {
  assert.throws(() => encodeQr('x'.repeat(272)), { name: 'RangeError' });
  const svg = renderQrSvg('https://tendriller.dev/', { quiet: 4, label: 'Share <"page">', sizePx: 180 });
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 \d+ \d+" width="180" height="180"/);
  assert.ok(svg.includes('aria-label="Share &lt;&quot;page&quot;&gt;"'));
  assert.ok(svg.includes('fill="#ffffff"'));
  assert.ok(svg.includes('fill="#111111"'));
});
