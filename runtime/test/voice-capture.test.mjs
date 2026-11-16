import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const built = await build({ entryPoints: [new URL('../src/voice/capture.ts', import.meta.url).pathname], bundle: true, format: 'iife', globalName: 'Capture', platform: 'browser', write: false });
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function environment({ consent = async () => true, media, decode } = {}) {
  const workers = [], recordings = [], tracks = [], transcripts = [], states = [], errors = [], timers = new Map();
  let serial = 0, prompts = 0;
  const clock = { setTimeout(fn, ms) { const id = ++serial; timers.set(id, { fn, ms }); return id; }, clearTimeout(id) { timers.delete(id); } };
  class Worker {
    messages = []; terminated = false;
    constructor(url) { this.url = url; workers.push(this); }
    postMessage(message) { this.messages.push(message); }
    terminate() { this.terminated = true; }
    respond(action, result = {}) { const message = this.messages.findLast(item => item.action === action); assert.ok(message, `No ${action} request`); this.onmessage?.({ data: { id: message.id, ...result } }); }
  }
  class MediaRecorder {
    state = 'inactive'; mimeType = 'audio/webm';
    constructor(stream) { this.stream = stream; recordings.push(this); }
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      queueMicrotask(() => { this.ondataavailable?.({ data: new Blob(['recorded audio']) }); this.onstop?.(); });
    }
  }
  const stream = () => {
    const track = { readyState: 'live', stop() { this.readyState = 'ended'; } }; tracks.push(track);
    return { getTracks: () => [track] };
  };
  class OfflineAudioContext { async decodeAudioData() { return decode ? decode() : { numberOfChannels: 1, length: 3, sampleRate: 16000, getChannelData: () => new Float32Array([.1, -.1, 0]) }; } }
  const context = { Worker, MediaRecorder, OfflineAudioContext, Blob, URL, Float32Array, queueMicrotask, ...clock,
    window: { Worker, OfflineAudioContext, ...clock }, location: { href: 'https://example.test/page/' },
    navigator: { mediaDevices: { getUserMedia: async () => { prompts++; return media ? media(stream) : stream(); } } } };
  runInNewContext(built.outputFiles[0].text, context);
  const capture = new context.Capture.SpeechCapture({ onConsent: consent, onInterim() {}, onFinal: text => transcripts.push(text), onState: active => states.push(active), onError: message => errors.push(message) },
    () => 'en-US', 'https://example.test/runtime/', { engine: { script: 'engine.js', wasm: 'engine.wasm' }, url: 'model.bin', sha256: 'a'.repeat(64) });
  return { capture, workers, recordings, tracks, transcripts, states, errors, timers, stream, get prompts() { return prompts; },
    async ready() { const result = capture.prepare(); await tick(); workers.at(-1).respond('init'); await result; },
    expire(ms) { const found = [...timers.entries()].find(([, timer]) => timer.ms === ms); assert.ok(found, `No ${ms}ms deadline`); timers.delete(found[0]); found[1].fn(); } };
}

test('preparation is shared and inert until recording; concurrent recording cannot replace an active transcription', async () => {
  const env = environment();
  assert.equal(env.prompts, 0); assert.equal(env.workers.length, 0);
  const first = env.capture.prepare(), second = env.capture.prepare(); await tick();
  assert.equal(env.workers.length, 1); assert.equal(env.workers[0].url, 'https://example.test/runtime/voice-worker.js');
  env.workers[0].respond('init'); await Promise.all([first, second]); assert.equal(env.prompts, 0);
  await Promise.all([env.capture.start(), env.capture.start()]); assert.equal(env.prompts, 1); assert.equal(env.capture.listening, true);
  env.capture.stop(); await tick();
  assert.equal(env.capture.listening, false); assert.equal(env.tracks[0].readyState, 'ended');
  await env.capture.start(); assert.equal(env.prompts, 1); assert.match(env.errors.at(-1), /still in progress/);
  env.workers[0].respond('transcribe', { text: '  deliberate input  ' }); await tick();
  assert.deepEqual(env.transcripts, ['deliberate input']); assert.equal(env.timers.size, 0);
  env.capture.dispose();
});

test('cancelled microphone permissions, recordings and decoding never deliver a late command', async () => {
  let release; const waiting = environment({ media: stream => new Promise(resolve => { release = () => resolve(stream()); }) });
  await waiting.ready(); const starting = waiting.capture.start(); await tick(); waiting.capture.cancel(); release(); await starting;
  assert.equal(waiting.tracks[0].readyState, 'ended'); assert.equal(waiting.recordings.length, 0); assert.deepEqual(waiting.transcripts, []); waiting.capture.dispose();

  let decoded; const env = environment({ decode: () => new Promise(resolve => { decoded = resolve; }) });
  await env.ready(); await env.capture.start(); env.capture.stop(); await tick(); env.capture.cancel();
  assert.equal(env.capture.listening, false); assert.equal(env.tracks[0].readyState, 'ended');
  decoded({ numberOfChannels: 1, length: 1, sampleRate: 16000, getChannelData: () => new Float32Array([0]) }); await tick();
  assert.equal(env.workers[0].messages.some(message => message.action === 'transcribe'), false); assert.deepEqual(env.transcripts, []);
  await env.capture.start(); env.capture.cancel(); assert.equal(env.capture.listening, false); assert.equal(env.tracks[1].readyState, 'ended');
  const stoppedPrompts = env.prompts; const tooEarly = env.capture.start(); assert.equal(env.prompts, stoppedPrompts); await tooEarly; await tick();
  env.capture.dispose();
});

test('stalled workers have deadlines, can be retried, and disposal invalidates pending consent', async () => {
  const env = environment();
  const preparing = env.capture.prepare(); await tick(); env.expire(120000);
  await assert.rejects(preparing, /timed out/); assert.equal(env.workers[0].terminated, true); assert.equal(env.timers.size, 0);
  await env.ready(); await env.capture.start(); env.capture.stop(); await tick(); env.expire(30000); await tick();
  assert.equal(env.workers[1].terminated, true); assert.match(env.errors.at(-1), /transcription failed/); assert.deepEqual(env.transcripts, []); assert.equal(env.timers.size, 0);
  await env.ready(); assert.equal(env.workers.length, 3); env.capture.dispose();

  let consent; const pending = environment({ consent: () => new Promise(resolve => { consent = resolve; }) });
  const result = pending.capture.prepare(); await tick(); pending.capture.dispose(); consent(true);
  await assert.rejects(result, /disposed/); assert.equal(pending.workers.length, 0); assert.equal(pending.prompts, 0);
});
