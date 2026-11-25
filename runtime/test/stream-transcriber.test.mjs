import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const compiled = await build({ entryPoints: [new URL('../src/voice/pcm.ts', import.meta.url).pathname], bundle: true, format: 'esm', platform: 'node', write: false });
const { ContinuousPcmSegmenter, PCM_RATE } = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));

function tone(ms, amp = 0.2, freq = 300) {
  const count = Math.round((ms / 1000) * PCM_RATE);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / PCM_RATE);
  return out;
}
function silence(ms) {
  return new Float32Array(Math.round((ms / 1000) * PCM_RATE));
}

test('ContinuousPcmSegmenter emits consecutive utterances separated by silence without pausing capture', () => {
  const seg = new ContinuousPcmSegmenter({ maxSegmentMs: 8000, silenceMs: 400, overlapMs: 200 });
  const results = [];
  results.push(...seg.push(silence(200)));
  results.push(...seg.push(tone(600)));
  results.push(...seg.push(silence(500)));
  results.push(...seg.push(tone(700)));
  results.push(...seg.push(silence(500)));
  assert.equal(results.length, 2);
  assert.ok(results[0].samples.length > PCM_RATE * 0.5);
  assert.ok(results[1].startedOffsetMs > results[0].startedOffsetMs);
  assert.ok(results[1].endedOffsetMs > results[0].endedOffsetMs);
  assert.ok(results[1].endedOffsetMs > results[1].startedOffsetMs);
});

test('ContinuousPcmSegmenter splits long uninterrupted speech at maxSegmentMs with overlap tail', () => {
  const seg = new ContinuousPcmSegmenter({ maxSegmentMs: 3000, silenceMs: 500, overlapMs: 300 });
  const results = seg.push(tone(6500));
  assert.ok(results.length >= 2, `expected >= 2 segments, got ${results.length}`);
  assert.equal(results[0].samples.length, PCM_RATE * 3);
  // Overlap means second segment starts ~300ms before the first ended.
  assert.ok(results[1].startedOffsetMs < results[0].endedOffsetMs);
  const tail = seg.flush();
  assert.ok(tail && tail.samples.length > 0);
});

test('ContinuousPcmSegmenter rejects brief clicks below minVoicedMs and reports audio level', () => {
  const seg = new ContinuousPcmSegmenter({ minVoicedMs: 180, silenceMs: 300 });
  const click = seg.push(tone(60));
  assert.equal(click.length, 0);
  assert.ok(seg.level > 0.1);
  const after = seg.push(silence(400));
  assert.equal(after.length, 0);
});
