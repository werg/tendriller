import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const compiled = await build({ entryPoints: [new URL('../src/voice/pcm.ts', import.meta.url).pathname], bundle: true, format: 'esm', platform: 'node', write: false });
const { PcmResampler, PcmVoiceSegmenter, MAX_WAKE_SAMPLES } = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const block = (length, amplitude = 0) => Float32Array.from({ length }, (_, i) => amplitude * Math.sin(i * 0.1));

test('resampling is stable across 44.1k/48k microphone callback boundaries and bounded', () => {
  for (const rate of [16000, 44100, 48000, 96000]) {
    const input = block(rate, 0.5), one = new PcmResampler(rate).push(input), streaming = new PcmResampler(rate), chunks = [];
    for (let start = 0; start < input.length; start += 128) chunks.push(...streaming.push(input.subarray(start, start + 128)));
    assert.equal(one.length, 16000); assert.equal(chunks.length, one.length);
    for (let i = 0; i < chunks.length; i++) assert.ok(Math.abs(chunks[i] - one[i]) < 1e-6);
  }
  assert.throws(() => new PcmResampler(8000), /Unsupported/);
  assert.throws(() => new PcmResampler(Infinity), /Unsupported/);
  assert.deepEqual([...new PcmResampler(16000).push(new Float32Array([NaN, Infinity, 2, -2]))], [0, 0, 1, -1]);
});

test('silence and short clicks do not invoke recognition; speech retains its prefix and endpoint', () => {
  const segment = new PcmVoiceSegmenter();
  assert.equal(segment.push(block(16000)), null);
  assert.equal(segment.push(block(320, 0.2)), null);
  assert.equal(segment.push(block(16000)), null, 'a brief click is discarded');
  assert.equal(segment.push(block(16000 * 0.5, 0.2)), null);
  const result = segment.push(block(16000));
  assert.ok(result instanceof Float32Array);
  assert.ok(result.length >= 16000 * (0.26 + 0.5 + 0.64));
  assert.equal(result.slice(0, 16000 * 0.2).every(value => value === 0), true, 'preroll is kept');
});

test('continuous audio is cut at eight seconds, discarded buffers reset, and no second queued utterance leaks', () => {
  const segment = new PcmVoiceSegmenter();
  const result = segment.push(block(16000 * 30, 0.2));
  assert.equal(result.length, MAX_WAKE_SAMPLES);
  assert.equal(segment.push(block(16000)), null, 'unconsumed input from overlong callback is not queued');
  segment.push(block(16000, 0.2)); segment.reset();
  assert.equal(segment.push(block(16000)), null, 'explicit reset discards any partial speech');
});
