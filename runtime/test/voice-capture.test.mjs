import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const built = await build({ entryPoints: [new URL('../src/voice/capture.ts', import.meta.url).pathname], bundle: true, format: 'iife', globalName: 'Capture', platform: 'browser', write: false });
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function environment({ consent = async () => true, media, decode, delayedStop = false } = {}) {
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
      this.complete = () => { this.ondataavailable?.({ data: new Blob(['recorded audio']) }); this.onstop?.(); };
      if (!delayedStop) queueMicrotask(this.complete);
    }
  }
  const stream = () => {
    const track = Object.assign(new EventTarget(), { readyState: 'live', stop() { this.readyState = 'ended'; } }); tracks.push(track);
    return { getTracks: () => [track], getAudioTracks: () => [track] };
  };
  class OfflineAudioContext { async decodeAudioData() { return decode ? decode() : { numberOfChannels: 1, length: 3, sampleRate: 16000, getChannelData: () => new Float32Array([.1, -.1, 0]) }; } }
  const context = { Worker, MediaRecorder, OfflineAudioContext, Blob, URL, Float32Array, queueMicrotask, ...clock,
    window: { Worker, OfflineAudioContext, ...clock }, location: { href: 'https://example.test/page/' },
    navigator: { mediaDevices: { getUserMedia: async () => { prompts++; return media ? media(stream) : stream(); } } } };
  runInNewContext(built.outputFiles[0].text, context);
  const capture = new context.Capture.SpeechCapture({ onConsent: consent, onInterim() {}, onFinal: text => transcripts.push(text), onState: active => states.push(active), onError: message => errors.push(message) },
    () => 'en-US', 'https://example.test/runtime/', { engine: { script: 'engine.js', script_sha256: 'b'.repeat(64), script_size: 5, wasm: 'engine.wasm', wasm_sha256: 'c'.repeat(64), wasm_size: 6 }, url: 'model.bin', sha256: 'a'.repeat(64), size: 7 });
  return { capture, workers, recordings, tracks, transcripts, states, errors, timers, stream, get prompts() { return prompts; },
    async ready() { const result = capture.prepare(); await tick(); workers.at(-1).respond('init'); await result; },
    expire(ms) { const found = [...timers.entries()].find(([, timer]) => timer.ms === ms); assert.ok(found, `No ${ms}ms deadline`); timers.delete(found[0]); found[1].fn(); } };
}

test('preparation is shared and inert until recording; concurrent recording cannot replace an active transcription', async () => {
  const env = environment();
  assert.equal(env.prompts, 0); assert.equal(env.workers.length, 0);
  const first = env.capture.prepare(), second = env.capture.prepare(); await tick();
  assert.equal(env.workers.length, 1); assert.equal(env.workers[0].url, 'https://example.test/runtime/voice-worker.js');
  assert.equal(env.workers[0].messages[0].modelSize, 7); assert.equal(env.workers[0].messages[0].engine.script_sha256, 'b'.repeat(64));
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
  assert.equal(env.workers[0].terminated, true);
  assert.equal(env.workers[0].messages.some(message => message.action === 'transcribe'), false); assert.deepEqual(env.transcripts, []);
  await env.ready();
  await env.capture.start(); env.capture.cancel(); assert.equal(env.capture.listening, false); assert.equal(env.tracks[1].readyState, 'ended');
  const stoppedPrompts = env.prompts; await env.capture.start(); await tick(); assert.equal(env.prompts, stoppedPrompts + 1);
  assert.equal(env.capture.listening, true); assert.equal(env.tracks[2].readyState, 'live');
  env.capture.dispose();
});

test('cancelled and timed-out permission prompts retain settlement until late streams are stopped', async () => {
  let grant;
  const env = environment({ media: stream => new Promise(resolve => { grant = () => resolve(stream()); }) });
  await env.ready(); const starting = env.capture.start(); await tick();
  let settled = false; env.capture.microphoneSettled.then(() => { settled = true; });
  env.capture.cancel(); await starting; await tick(); assert.equal(settled, false); assert.equal(env.capture.listening, false);
  await env.capture.start(); assert.equal(env.prompts, 1);
  grant(); await env.capture.microphoneSettled; assert.equal(settled, true); assert.equal(env.tracks[0].readyState, 'ended');
  assert.equal(env.recordings.length, 0); env.capture.dispose();

  let allow;
  const timeout = environment({ media: stream => new Promise(resolve => { allow = () => resolve(stream()); }) });
  await timeout.ready(); const pending = timeout.capture.start(); await tick(); timeout.expire(30000); await pending;
  assert.match(timeout.errors.at(-1), /permission request timed out/);
  await timeout.capture.start(); assert.equal(timeout.prompts, 1);
  allow(); await timeout.capture.microphoneSettled; assert.equal(timeout.tracks[0].readyState, 'ended'); assert.equal(timeout.recordings.length, 0); timeout.capture.dispose();
});

test('finish closes the microphone synchronously even when recorder delivery is late or missing', async () => {
  const env = environment({ delayedStop: true }); await env.ready(); await env.capture.start();
  env.capture.stop(); assert.equal(env.capture.microphoneActive, false); assert.equal(env.tracks[0].readyState, 'ended');
  assert.equal(env.workers[0].messages.some(message => message.action === 'transcribe'), false);
  env.recordings[0].complete(); await tick(); env.workers[0].respond('transcribe', { text: 'saved words' }); await tick();
  assert.deepEqual(env.transcripts, ['saved words']); env.capture.dispose();
  const stalled = environment({ delayedStop: true }); await stalled.ready(); await stalled.capture.start(); stalled.capture.stop();
  stalled.expire(5000); assert.match(stalled.errors.at(-1), /did not finish/); assert.equal(stalled.tracks[0].readyState, 'ended');
  stalled.recordings[0].complete(); await tick(); assert.deepEqual(stalled.transcripts, []); stalled.capture.dispose();
});

test('microphone interruption and cancellation during inference terminate input and suppress late words', async () => {
  for (const type of ['ended', 'mute']) {
    const env = environment(); await env.ready(); await env.capture.start();
    env.tracks[0].dispatchEvent(new Event(type)); assert.equal(env.capture.listening, false); assert.equal(env.tracks[0].readyState, 'ended');
    await tick(); assert.match(env.errors.at(-1), /interrupted/); assert.deepEqual(env.transcripts, []); env.capture.dispose();
  }
  const env = environment(); await env.ready(); await env.capture.start(); env.capture.stop(); await tick();
  env.capture.cancel(); assert.equal(env.workers[0].terminated, true); env.workers[0].respond('transcribe', { text: 'late' }); await tick();
  assert.deepEqual(env.transcripts, []); assert.equal(env.timers.size, 0); env.capture.dispose();
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

test('worker load errors and HTTP failure details are preserved instead of genericized', async () => {
  const env = environment();
  const preparing = env.capture.prepare();
  await tick();
  env.workers[0].onerror?.({ message: 'Speech speech code download failed (404: The runtime resource is not installed)' });
  await assert.rejects(preparing, /404: The runtime resource is not installed/);
  env.capture.dispose();

  const env2 = environment();
  const starting = env2.capture.start();
  await tick();
  env2.workers[0].respond('init', { error: 'Speech speech code download failed (404: The runtime resource is not installed)' });
  await starting;
  assert.match(env2.errors.at(-1), /404: The runtime resource is not installed/);
  env2.capture.dispose();
});
