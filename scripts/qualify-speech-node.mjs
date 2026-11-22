// Optional actual-model check for hosts that cannot launch a browser. This does
// not qualify getUserMedia, AudioWorklet, browser permissions or physical devices.
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash, webcrypto } from 'node:crypto';
import { createContext, runInContext } from 'node:vm';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { build } from 'esbuild';
import { RUNTIME_RESOURCES, RUNTIME_FEATURES } from '../runtime/resources.mjs';
import { wordErrorRate } from '../test/e2e/speech-fixture.mjs';

const root = resolve(new URL('..', import.meta.url).pathname);
const cache = execFileSync(process.execPath, [join(root, 'scripts/e2e-speech-assets.mjs')], { encoding: 'utf8', timeout: 150_000 }).trim();
const source = await readFile(join(root, 'dist/runtime/assets/voice-worker.js'), 'utf8');
const manifest = JSON.parse(await readFile(join(root, 'dist/runtime/assets/manifest.json'), 'utf8'));
const fixture = JSON.parse(await readFile(join(root, 'test/fixtures/speech/manifest.json'), 'utf8'));
const wav = await readFile(join(root, 'test/fixtures/speech', fixture.file));
const hash = value => createHash('sha256').update(value).digest('hex');
assert.equal(hash(wav), fixture.sha256);
const resources = new Map();
for (const file of RUNTIME_RESOURCES) {
  const bytes = await readFile(join(cache, file.name)); assert.equal(hash(bytes), file.sha256);
  resources.set(new URL(file.url, 'https://model.test/').href, bytes);
}
const blobs = new Map(), messages = [], network = [];
let serial = 0;
class FixtureBlob { constructor(parts) { this.parts = parts; } }
class FixtureURL extends URL {
  static createObjectURL(blob) { const id = `blob:verified-${++serial}`; blobs.set(id, Buffer.concat(blob.parts.map(part => Buffer.from(part)))); return id; }
  static revokeObjectURL(id) { blobs.delete(id); }
}
const scope = { location: { href: 'https://model.test/voice-worker.js' }, postMessage: value => messages.push(structuredClone(value)),
  importScripts(url) { const bytes = blobs.get(url); assert.ok(bytes, 'only already verified executable bytes may be imported'); runInContext(bytes.toString('utf8'), context); } };
const context = createContext({ self: scope, WorkerGlobalScope: class {}, crypto: webcrypto, WebAssembly, URL: FixtureURL, Blob: FixtureBlob,
  ArrayBuffer, Uint8Array, Float32Array, Int8Array, Int16Array, Uint16Array, Int32Array, Uint32Array, BigInt64Array, BigUint64Array,
  TextDecoder, TextEncoder, performance, console, navigator: { hardwareConcurrency: 1 },
  fetch: async (url, options) => { const address = new URL(url, scope.location.href).href; assert.ok(resources.has(address), 'only pinned resource GETs are allowed'); assert.equal(options?.method ?? 'GET', 'GET'); network.push(address); return new Response(resources.get(address)); },
});
runInContext(source, context);
const speech = RUNTIME_FEATURES.speech;
const absolute = path => new URL(path, 'https://model.test/').href;
const request = async data => {
  const start = performance.now(), id = ++serial;
  await scope.onmessage({ data: { id, ...data } });
  const response = messages.findLast(message => message.id === id && !message.progress);
  assert.ok(response, 'worker returned a terminal result'); assert.equal(response.error, undefined);
  return { response, milliseconds: performance.now() - start };
};
const initialized = await request({ action: 'init', engine: { ...speech.engine, script: absolute(speech.engine.script), wasm: absolute(speech.engine.wasm) },
  modelUrl: absolute(speech.url), modelSha256: speech.sha256, modelSize: speech.size });
assert.equal(initialized.response.ready, true);
function samplesFromWav(bytes) {
  let dataOffset = 12, pcm;
  while (dataOffset + 8 <= bytes.length) {
    const name = bytes.toString('ascii', dataOffset, dataOffset + 4), size = bytes.readUInt32LE(dataOffset + 4);
    if (name === 'data') { pcm = bytes.subarray(dataOffset + 8, dataOffset + 8 + size); break; }
    dataOffset += 8 + size + size % 2;
  }
  assert.ok(pcm);
  return Float32Array.from({ length: pcm.length / 2 }, (_, i) => pcm.readInt16LE(i * 2) / 32768);
}
const samples = samplesFromWav(wav);
const spoken = await request({ action: 'transcribe', samples: samples.slice().buffer, language: 'en' });
const errorRate = wordErrorRate(fixture.transcript, spoken.response.text || '');
assert.ok(errorRate <= fixture.max_word_error_rate, `Unexpected model transcript: ${spoken.response.text}`);
const positive = await request({ action: 'detect', samples: samples.slice().buffer, language: 'en', phrase: 'Please check' });
assert.equal(positive.response.matched, true); assert.match(positive.response.command, /sensor.*temperature/i); assert.equal(positive.response.text, undefined);
const negative = await request({ action: 'detect', samples: samples.slice().buffer, language: 'en', phrase: 'Hey Tendril' });
assert.equal(negative.response.matched, false); assert.equal(negative.response.command, ''); assert.equal(negative.response.text, undefined);
const silence = await request({ action: 'detect', samples: new Float32Array(16000).buffer, language: 'en', phrase: 'Please check' });
assert.equal(silence.response.matched, false); assert.equal(silence.response.command, '');
const pcmCode = await build({ entryPoints: [join(root, 'runtime/src/voice/pcm.ts')], bundle: true, format: 'esm', write: false });
const { PcmVoiceSegmenter } = await import('data:text/javascript;base64,' + Buffer.from(pcmCode.outputFiles[0].text).toString('base64'));
const segmenter = new PcmVoiceSegmenter(), padded = new Float32Array(samples.length + 16000); padded.set(samples);
let segment;
for (let i = 0; i < padded.length && !segment; i += 128) segment = segmenter.push(padded.subarray(i, i + 128));
assert.ok(segment, 'actual spoken fixture must pass sound-activity gating');
const segmentSamples = segment.length;
const segmented = await request({ action: 'detect', samples: segment.buffer, language: 'en', phrase: 'Please check' });
assert.equal(segmented.response.matched, true); assert.match(segmented.response.command, /sensor.*temperature/i);
assert.equal(network.length, 3, 'ambient/command audio causes no network request after verified initialization');
const wakeManifest = JSON.parse(await readFile(join(root, 'test/fixtures/speech/wake-manifest.json'), 'utf8'));
const defaultWake = [];
const words = text => (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).join(' ');
for (const entry of wakeManifest.cases) {
  const bytes = await readFile(join(root, 'test/fixtures/speech', entry.file));
  assert.equal(hash(bytes), entry.sha256);
  const decision = await request({ action: 'detect', samples: samplesFromWav(bytes).buffer, language: wakeManifest.language, phrase: wakeManifest.phrase });
  assert.equal(decision.response.matched, entry.matched, entry.file);
  assert.equal(words(decision.response.command), words(entry.command), entry.file);
  assert.equal(decision.response.text, undefined, 'ambient transcripts never leave detect');
  defaultWake.push({ file: entry.file, sha256: entry.sha256, ...decision });
}
const evidence = { environment: 'Node VM running exact bundled worker and real pinned Cactus WASM/Whistle model; browser APIs supplied by an in-memory fixture',
  limitation: 'No browser, physical microphone, mobile, Safari or recognition-accuracy corpus qualification.',
  runtime_id: manifest.id, worker_sha256: hash(source), fixture_sha256: fixture.sha256,
  resources: RUNTIME_RESOURCES.map(({ name, sha256, size }) => ({ name, sha256, size })),
  initialized, spoken, word_error_rate: errorRate, positive, negative, silence, segmented, segment_samples: segmentSamples, download_requests: network.length,
  default_wake_phrase: wakeManifest.phrase, default_wake: defaultWake };
if (process.argv.includes('--probe-default')) {
  evidence.probes = [];
  const probes = [
    ['Hey Tendril, record the temperature.', 'Hey Tendril'],
    ['Hey Tendrils, record the temperature.', 'Hey Tendril'],
    ['There is a tendril near the kitchen.', 'Hey Tendril'],
    ['Hey kitchen, record the temperature.', 'Hey Tendril'],
    ['Hello computer, record the temperature.', 'Hello computer'],
    ['Hey assistant, record the temperature.', 'Hey assistant'],
    ['Hello Tendril, record the temperature.', 'Hello Tendril'],
    ['Please listen, check the sensor and record the temperature.', 'Please listen'],
    ['Please listen.', 'Please listen'],
    ['Computer listen, check the sensor and record the temperature.', 'Computer listen'],
    ['Computer listen.', 'Computer listen'],
    ['Computers listen, check the sensor and record the temperature.', 'Computer listen'],
    ['The computer is listening to music.', 'Computer listen'],
    ['Please check the sensor and record the temperature.', 'Computer listen'],
    ['Listen computer, check the sensor and record the temperature.', 'Listen computer'],
    ['Listen computer.', 'Listen computer'],
    ['Please listening, check the sensor and record the temperature.', 'Please listen'],
    ['I listened to the computer today.', 'Listen computer'],
    ['Please listen Tendril, check the sensor and record the temperature.', 'Please listen Tendril'],
  ];
  const filterAt = process.argv.indexOf('--probe-phrase');
  const selected = filterAt < 0 ? probes : probes.filter(([, phrase]) => phrase === process.argv[filterAt + 1]);
  for (const [sentence, phrase] of selected) {
    const args = ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `flite=text='${sentence}':voice=slt`, '-af', 'adelay=250,apad=pad_dur=0.75', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-map_metadata', '-1', '-fflags', '+bitexact', '-f', 'wav', 'pipe:1'];
    const bytes = execFileSync('ffmpeg', args, { timeout: 30_000 });
    const audio = samplesFromWav(bytes);
    const transcript = await request({ action: 'transcribe', samples: audio.slice().buffer, language: 'en' });
    const decision = await request({ action: 'detect', samples: audio.slice().buffer, language: 'en', phrase });
    evidence.probes.push({ sentence, phrase, generator: 'CMU Flite slt synthetic voice via ffmpeg', command: ['ffmpeg', ...args], sha256: hash(bytes), transcript, decision });
  }
}
await mkdir(join(root, 'test-results/speech-node'), { recursive: true });
await writeFile(join(root, 'test-results/speech-node/evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
process.stdout.write(JSON.stringify(evidence, null, 2) + '\n');
