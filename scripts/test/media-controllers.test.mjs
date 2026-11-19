import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { build } from 'esbuild';

const sources = { Camera: '../../docs/tutorial/media/camera.mjs', VoiceControls: '../../docs/tutorial/media/voice.mjs',
  Sensors: '../../runtime/src/sensors.ts', Voice: '../../runtime/src/voice/index.ts' };
const bundles = await Promise.all(Object.entries(sources).map(async ([name, path]) => {
  const result = await build({ entryPoints: [new URL(path, import.meta.url).pathname], bundle: true,
    platform: 'browser', format: 'iife', globalName: name, write: false });
  return result.outputFiles[0].text;
}));
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const gesture = { isTrusted: true };
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

function environment({ media, consent = () => true, decode, encode } = {}) {
  const handlers = new Map(), tracks = [], workers = [], recordings = [], drafts = [], settings = new Map(), statuses = [], canvases = [];
  let acquisitions = 0, fetches = 0;
  class Track extends EventTarget {
    kind = 'video'; readyState = 'live';
    stop() { this.readyState = 'ended'; }
    clone() { return new Track(); }
  }
  class Stream extends EventTarget { constructor(track) { super(); this.track = track; } getTracks() { return [this.track]; } clone() { return new Stream(this.track.clone()); } }
  const stream = (kind = 'video') => { const track = new Track(); track.kind = kind; tracks.push(track); return new Stream(track); };
  class Worker {
    messages = []; terminated = false;
    constructor() { workers.push(this); }
    postMessage(message) { this.messages.push(message); }
    terminate() { this.terminated = true; }
    respond(action, value = {}) { const message = this.messages.findLast(item => item.action === action); assert(message, `No ${action} request`); this.onmessage?.({ data: { id: message.id, ...value } }); }
  }
  class MediaRecorder {
    state = 'inactive'; mimeType = 'audio/webm';
    constructor(value) { this.stream = value; recordings.push(this); }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; queueMicrotask(() => { this.ondataavailable?.({ data: new Blob(['audio']) }); this.onstop?.(); }); }
  }
  const decoded = () => ({ numberOfChannels: 1, length: 1, sampleRate: 16000, getChannelData: () => new Float32Array([0]) });
  class OfflineAudioContext { decodeAudioData() { return decode ? decode() : Promise.resolve(decoded()); } }
  const window = Object.assign(new EventTarget(), { MediaStreamTrack: Track, MediaStream: Stream, Worker, OfflineAudioContext,
    setTimeout, clearTimeout, speechSynthesis: { speaking: false, speak() {}, cancel() {} } });
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible', createElement(name) {
    assert.equal(name, 'canvas');
    const canvas = { width: 0, height: 0, drawn: null,
      getContext: () => ({ drawImage(...values) { canvas.drawn = values; } }),
      toBlob(callback, type) { if (encode) encode(callback, canvas); else callback(new Blob(['frame'], { type })); } };
    canvases.push(canvas); return canvas;
  } });
  const navigator = { language: 'en-US', mediaDevices: { getUserMedia(constraints) {
    acquisitions++; return media ? media(constraints, stream) : Promise.resolve(stream(constraints.audio ? 'audio' : 'video'));
  } } };
  const runtime = { identity: { page: 'test', base: 'https://page.example/' }, assetUrl: path => `https://page.example/runtime/${path}`,
    on(type, listener) { if (!handlers.has(type)) handlers.set(type, new Set()); handlers.get(type).add(listener); return () => handlers.get(type).delete(listener); } };
  const context = { window, document, navigator, URL, Blob, DOMException, AbortController, AbortSignal, Event, EventTarget,
    structuredClone, crypto: webcrypto, Float32Array, MediaRecorder, OfflineAudioContext, Worker, queueMicrotask, setTimeout, clearTimeout,
    setInterval() {}, clearInterval() {}, location: { href: runtime.identity.base },
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
    localStorage: { getItem: key => settings.get(key) ?? null, setItem: (key, value) => settings.set(key, value) },
    fetch: async () => { fetches++; return { ok: true, json: async () => ({ features: { speech: {
      model: 'fixture', url: 'model', sha256: 'a'.repeat(64), engine: { script: 'engine', wasm: 'engine.wasm', wasm_sha256: 'b'.repeat(64) },
    } } }) }; } };
  for (const bundle of bundles) runInNewContext(bundle, context);
  const tracker = context.Sensors.installSensorWrappers();
  const emit = (type, value) => { for (const callback of handlers.get(type) ?? []) callback(value); };
  runtime.sensors = { status: () => tracker.status(), on: listener => tracker.onChange(() => listener(tracker.status())),
    stopAll() { const count = tracker.stopAll(); emit('sensors_stopped', { count }); return count; } };
  const video = { srcObject: null, videoWidth: 2400, videoHeight: 1200, play: async () => {}, pause() {} };
  return { context, runtime, video, stream, document, window, workers, recordings, tracks, drafts, statuses, canvases, decoded,
    get acquisitions() { return acquisitions; }, get fetches() { return fetches; },
    camera() { return context.Camera.createCameraController({ runtime, video, onStatus: value => statuses.push(value) }); },
    voice() { return context.VoiceControls.createVoiceController({ runtime, consent, onDraft: value => drafts.push(value),
      onStatus: value => statuses.push(value), loadVoice: async () => context.Voice }); },
    async prepared(controller) { const preparing = controller.prepare(gesture); await flush(); workers.at(-1).respond('init'); await preparing; },
  };
}

test('camera is inert, requests from a gesture, and rejects Cancel before releasing a late grant', async () => {
  const grant = deferred(), env = environment({ media: () => grant.promise }), camera = env.camera();
  assert.equal(env.acquisitions, 0);
  await assert.rejects(camera.start({ isTrusted: false }), /deliberate/);
  const starting = camera.start(gesture), rejected = assert.rejects(starting, { name: 'AbortError' });
  await flush(); assert.deepEqual([...camera.snapshot().sensors.pending], ['camera']);
  camera.stop(); await rejected;
  const late = env.stream(); grant.resolve(late); await flush();
  assert.equal(late.getTracks()[0].readyState, 'ended'); assert.equal(env.video.srcObject, null);
  assert.equal(camera.snapshot().phase, 'idle'); camera.dispose();
});

test('camera stops live tracks before encoding and discards a cancelled asynchronous frame', async () => {
  let finish; const env = environment({ encode: callback => { finish = callback; } }), camera = env.camera();
  await camera.start(gesture);
  const captured = camera.capture(), rejected = assert.rejects(captured, { name: 'AbortError' });
  assert.equal(env.tracks[0].readyState, 'ended'); assert.equal(env.video.srcObject, null);
  assert.deepEqual(env.canvases[0].drawn.slice(1), [0, 0, 1280, 640]);
  camera.stop(); await rejected; finish(new Blob(['late'], { type: 'image/jpeg' })); await flush();
  assert.equal(camera.snapshot().phase, 'idle'); camera.dispose();
});

test('camera visibility and Stop all stop actual resources; a file remains a complete fallback', async () => {
  const env = environment(), camera = env.camera();
  await camera.start(gesture); const blob = await camera.capture();
  assert.equal(blob.type, 'image/jpeg'); assert.equal(env.tracks[0].readyState, 'ended');
  await camera.start(gesture); env.document.visibilityState = 'hidden'; env.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(env.tracks[1].readyState, 'ended');
  env.document.visibilityState = 'visible'; env.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(env.acquisitions, 2, 'Restoring visibility must not reacquire a camera.');
  await camera.start(gesture); env.runtime.sensors.stopAll(); assert.equal(env.tracks[2].readyState, 'ended');
  const file = new Blob(['chosen'], { type: 'image/png' }); assert.equal(camera.useFile(file), file);
  assert.throws(() => camera.useFile(new Blob(['active'], { type: 'image/svg+xml' })), /JPEG, PNG or WebP/);
  assert.equal(env.acquisitions, 3); camera.dispose();
});

test('voice uses real core preparation and cancels pending microphone permission without a late draft', async () => {
  const grant = deferred(), env = environment({ media: () => grant.promise }), voice = env.voice();
  assert.equal(env.fetches, 0); assert.equal(env.acquisitions, 0);
  await env.prepared(voice); assert.equal(env.acquisitions, 0, 'Preparing the actual adapter must not acquire the microphone.');
  const starting = voice.start(gesture, { context: { task: 'original', revision: 'r1' } }), rejected = assert.rejects(starting, { name: 'AbortError' });
  await flush(); env.runtime.sensors.stopAll(); await rejected;
  const late = env.stream('audio'); grant.resolve(late); await flush();
  assert.equal(late.getTracks()[0].readyState, 'ended'); assert.equal(env.recordings.length, 0);
  assert.deepEqual(env.drafts, []); voice.dispose();
});

test('voice cancels decoding and keeps a later reviewed transcript bound to its original context', async () => {
  const decoding = deferred(); let delay = true;
  const env = environment({ decode: () => delay ? decoding.promise : Promise.resolve(env.decoded()) }), voice = env.voice();
  await env.prepared(voice); await voice.start(gesture, { context: { task: 'discarded' } }); voice.finish(); await flush();
  voice.cancel(); decoding.resolve(env.decoded()); await flush(); assert.deepEqual(env.drafts, []);
  delay = false; const context = { task: 'second', revision: { sequence: 2 } };
  await voice.start(gesture, { context }); context.task = 'mutated form'; context.revision.sequence = 99;
  voice.finish(); await flush(); env.workers.at(-1).respond('transcribe', { text: '  editable suggestion  ' }); await flush();
  assert.equal(env.drafts.length, 1); assert.equal(env.drafts[0].text, 'editable suggestion');
  assert.equal(env.drafts[0].context.task, 'second'); assert.equal(env.drafts[0].context.revision.sequence, 2);
  assert.equal(voice.snapshot().phase, 'draft'); assert.equal(env.tracks.every(track => track.readyState === 'ended'), true);
  voice.dispose();
});

test('voice cancellation during consent prevents downloads and hidden pages never restart recording', async () => {
  const decision = deferred(), env = environment({ consent: () => decision.promise }), voice = env.voice();
  const preparing = voice.prepare(gesture), rejected = assert.rejects(preparing, { name: 'AbortError' });
  await flush(); voice.cancel(); await rejected; decision.resolve(true); await flush();
  assert.equal(env.fetches, 0); assert.equal(env.acquisitions, 0); voice.dispose();

  const visible = environment(), controls = visible.voice(); await visible.prepared(controls);
  await controls.start(gesture, { context: { task: 'visible' } });
  visible.document.visibilityState = 'hidden'; visible.document.dispatchEvent(new Event('visibilitychange')); await flush();
  visible.document.visibilityState = 'visible'; visible.document.dispatchEvent(new Event('visibilitychange')); await flush();
  assert.equal(visible.acquisitions, 1); assert.equal(visible.tracks[0].readyState, 'ended'); assert.deepEqual(visible.drafts, []);
  controls.dispose();
});
