import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { RUNTIME_FEATURES, RUNTIME_RESOURCES } from '../resources.mjs';

const built = await build({
  stdin: {
    contents: `
      export * from './runtime/src/voice/shared-worker.ts';
      export * from './runtime/src/voice/capture.ts';
      export * from './runtime/src/voice/dictation.ts';
    `,
    resolveDir: new URL('../..', import.meta.url).pathname,
    loader: 'ts',
  },
  bundle: true,
  format: 'iife',
  globalName: 'VoiceDictation',
  platform: 'browser',
  write: false,
});

const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

const SPEECH_DOWNLOAD_BYTES = RUNTIME_RESOURCES.reduce((sum, r) => sum + r.size, 0);
const VERIFIED_RESOURCES_JSON = {
  features: {
    speech: {
      ...RUNTIME_FEATURES.speech,
      total_size: SPEECH_DOWNLOAD_BYTES,
    },
  },
};

function makeVoiceEnv({ worklet = true, workletError = false, transcribeReply } = {}) {
  const workers = [];
  const recordings = [];
  const tracks = [];
  const workletNodes = [];
  let decodeCalls = 0;
  let micPrompts = 0;

  class Worker {
    messages = [];
    terminated = false;
    constructor(url) { this.url = url; workers.push(this); }
    postMessage(message) {
      this.messages.push(message);
      if (message.action === 'init') {
        queueMicrotask(() => this.onmessage?.({ data: { id: message.id, ok: true } }));
      } else if (message.action === 'transcribe') {
        const reply = transcribeReply ? transcribeReply(message, this) : 'hello from cactus';
        queueMicrotask(() => this.onmessage?.({ data: { id: message.id, text: reply } }));
      }
    }
    terminate() { this.terminated = true; }
  }

  class MediaRecorder {
    state = 'inactive';
    mimeType = 'audio/webm';
    constructor(stream) { this.stream = stream; recordings.push(this); }
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      queueMicrotask(() => {
        this.ondataavailable?.({ data: new Blob(['fallback-audio']) });
        this.onstop?.();
      });
    }
  }

  class AudioWorkletNode {
    port = {
      onmessage: null,
      postMessage: msg => { this.posted.push(msg); },
    };
    posted = [];
    disconnected = false;
    constructor(_ctx, name, opts) {
      this.name = name;
      this.opts = opts;
      workletNodes.push(this);
    }
    connect() {}
    disconnect() { this.disconnected = true; }
    emitPcm(samples, level = 0.5) {
      const copy = new Float32Array(samples);
      this.port.onmessage?.({ data: { type: 'pcm', samples: copy.buffer } });
      this.port.onmessage?.({ data: { type: 'level', level } });
    }
  }

  class AudioContext {
    state = 'running';
    closed = false;
    destination = {};
    audioWorklet = {
      addModule: async () => {
        if (workletError) throw new Error('worklet load failed');
      },
    };
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
    async resume() {}
    async close() { this.closed = true; }
  }

  class OfflineAudioContext {
    async decodeAudioData() {
      decodeCalls++;
      return {
        numberOfChannels: 2,
        length: 6,
        sampleRate: 48000,
        getChannelData: ch => new Float32Array(ch === 0 ? [0.2, 0.2, 0.2, 0.6, 0.6, 0.6] : [0.4, 0.4, 0.4, 0.8, 0.8, 0.8]),
      };
    }
  }

  const stream = () => {
    const track = Object.assign(new EventTarget(), { readyState: 'live', stop() { this.readyState = 'ended'; } });
    tracks.push(track);
    return { getTracks: () => [track], getAudioTracks: () => [track] };
  };

  const listeners = new Map();
  const win = {
    Worker,
    OfflineAudioContext,
    setTimeout,
    clearTimeout,
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
  };
  if (worklet) {
    win.AudioContext = AudioContext;
    win.AudioWorkletNode = AudioWorkletNode;
  }

  const context = {
    Worker,
    MediaRecorder,
    OfflineAudioContext,
    ...(worklet ? { AudioContext, AudioWorkletNode } : {}),
    Blob,
    URL,
    Float32Array,
    Event,
    EventTarget,
    DOMException,
    AbortController,
    AbortSignal,
    queueMicrotask,
    setTimeout,
    clearTimeout,
    fetch: async url => {
      if (String(url).endsWith('resources.json')) {
        return { ok: true, status: 200, json: async () => VERIFIED_RESOURCES_JSON };
      }
      return { ok: false, status: 404 };
    },
    window: win,
    document: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} },
    location: { href: 'https://example.test/s/demo/' },
    navigator: {
      language: 'en-US',
      locks: {
        request: async (_name, optsOrFn, maybeFn) => {
          const fn = typeof optsOrFn === 'function' ? optsOrFn : maybeFn;
          return fn({});
        },
      },
      mediaDevices: {
        getUserMedia: async () => { micPrompts++; return stream(); },
      },
    },
  };
  runInNewContext(built.outputFiles[0].text, context);

  const runtime = {
    identity: { page: 'demo', base: 'https://example.test/s/demo/' },
    assetUrl: path => `https://example.test/_tendril/runtime/r1/${path}`,
    on: () => () => {},
    sensors: {
      register: () => ({ update() {}, release() {} }),
    },
  };

  return {
    api: context.VoiceDictation,
    runtime,
    workers,
    recordings,
    tracks,
    workletNodes,
    get decodeCalls() { return decodeCalls; },
    get micPrompts() { return micPrompts; },
  };
}

test('resampleTo16kMono and decodeAudioToPcm16k downmix stereo 48kHz to clamped 16kHz mono', async () => {
  const env = makeVoiceEnv();
  const left = new Float32Array([0.2, 0.2, 0.2, 1.5, 1.5, 1.5]);
  const right = new Float32Array([0.4, 0.4, 0.4, 1.5, 1.5, 1.5]);
  const pcm = env.api.resampleTo16kMono([left, right], 48000);
  assert.equal(pcm.length, 2);
  assert.ok(Math.abs(pcm[0] - 0.3) < 0.01);
  assert.equal(pcm[1], 1);

  const decoded = await env.api.decodeAudioToPcm16k(new Blob(['fake-wav']));
  assert.equal(env.decodeCalls, 1);
  assert.equal(decoded.length, 2);
  assert.ok(Math.abs(decoded[0] - 0.3) < 0.01);
  assert.ok(Math.abs(decoded[1] - 0.7) < 0.01);
});

test('getSharedSpeechWorker shares one Worker across callers and deduplicates initialization', async () => {
  const env = makeVoiceEnv();
  const speech = {
    engine: { script: 'e.js', script_sha256: 'b'.repeat(64), script_size: 5, wasm: 'e.wasm', wasm_sha256: 'c'.repeat(64), wasm_size: 6 },
    url: 'model.bin',
    sha256: 'a'.repeat(64),
    size: 7,
  };
  const w1 = env.api.getSharedSpeechWorker('https://example.test/runtime/voice-worker.js', speech.sha256);
  const w2 = env.api.getSharedSpeechWorker('https://example.test/runtime/voice-worker.js', speech.sha256);
  assert.equal(w1, w2);

  await Promise.all([w1.ensureInit(speech), w2.ensureInit(speech)]);
  assert.equal(env.workers.length, 1, 'Only one WASM worker is spawned');
  assert.equal(env.workers[0].messages.filter(m => m.action === 'init').length, 1, 'init is only sent once');

  const [t1, t2] = await Promise.all([
    w1.transcribe(new Float32Array(320), 'en'),
    w2.transcribe(new Float32Array(320), 'en'),
  ]);
  assert.equal(t1, 'hello from cactus');
  assert.equal(t2, 'hello from cactus');
  assert.equal(env.workers.length, 1);
});

test('SpeechCapture uses direct AudioWorklet 16kHz PCM without MediaRecorder/decodeAudioData, and falls back when AudioWorklet fails', async () => {
  const env = makeVoiceEnv({ worklet: true });
  const transcripts = [];
  const levels = [];
  const speech = {
    engine: { script: 'e.js', script_sha256: 'b'.repeat(64), script_size: 5, wasm: 'e.wasm', wasm_sha256: 'c'.repeat(64), wasm_size: 6 },
    url: 'model.bin',
    sha256: 'a'.repeat(64),
    size: 7,
  };
  const shared = env.api.getSharedSpeechWorker('https://example.test/runtime/voice-worker.js', speech.sha256);
  const capture = new env.api.SpeechCapture(
    {
      onConsent: async () => true,
      onInterim() {},
      onFinal: t => transcripts.push(t),
      onState() {},
      onError(m) { throw new Error(`Unexpected error: ${m}`); },
      onLevel: lvl => levels.push(lvl),
    },
    () => 'en-US',
    'https://example.test/runtime/',
    speech,
    'https://example.test/runtime/pcm-worklet.js',
    shared,
  );

  await capture.prepare();
  await capture.start();
  assert.equal(env.workletNodes.length, 1, 'AudioWorklet capture node created');
  assert.equal(env.recordings.length, 0, 'MediaRecorder is bypassed when AudioWorklet succeeds');

  env.workletNodes[0].emitPcm(new Float32Array(400).fill(0.25), 0.42);
  assert.equal(levels.at(-1), 0.42);
  capture.stop();
  await new Promise(r => setTimeout(r, 60));
  await tick();

  assert.equal(env.decodeCalls, 0, 'OfflineAudioContext.decodeAudioData is never needed for PCM capture');
  assert.deepEqual(transcripts, ['hello from cactus']);
  assert.equal(env.tracks[0].readyState, 'ended');
  capture.dispose();

  // Now verify fallback to MediaRecorder when AudioWorklet fails
  const fb = makeVoiceEnv({ worklet: true, workletError: true });
  const fbTranscripts = [];
  const fbCapture = new fb.api.SpeechCapture(
    {
      onConsent: async () => true,
      onInterim() {},
      onFinal: t => fbTranscripts.push(t),
      onState() {},
      onError(m) { throw new Error(`Unexpected fallback error: ${m}`); },
    },
    () => 'en-US',
    'https://example.test/runtime/',
    speech,
    'https://example.test/runtime/pcm-worklet.js',
    fb.api.getSharedSpeechWorker('https://example.test/runtime/voice-worker.js', speech.sha256),
  );
  await fbCapture.prepare();
  await fbCapture.start();
  assert.equal(fb.recordings.length, 1, 'Falls back cleanly to MediaRecorder');
  fbCapture.stop();
  await new Promise(r => setTimeout(r, 25));
  await tick();
  assert.equal(fb.decodeCalls, 1);
  assert.deepEqual(fbTranscripts, ['hello from cactus']);
  fbCapture.dispose();
});

test('transcribeAudio chunks >28s recordings automatically without touching the microphone', async () => {
  let chunkIndex = 0;
  const env = makeVoiceEnv({
    transcribeReply: () => `part-${++chunkIndex}`,
  });
  // 35 seconds at 16 kHz -> 2 chunks (28s + 7s)
  const longPcm = new Float32Array(16_000 * 35).fill(0.1);
  const result = await env.api.transcribeAudio(env.runtime, longPcm, { language: 'en-US' });
  assert.equal(env.micPrompts, 0, 'transcribeAudio never prompts for microphone');
  assert.equal(result.text, 'part-1 part-2');
  assert.equal(result.language, 'en');
  assert.equal(result.durationMs, 35_000);
});

test('bindDictation wires button state, appends/replaces into a textarea, and dispatches input events', async () => {
  const env = makeVoiceEnv({
    worklet: true,
    transcribeReply: () => 'water the tomatoes',
  });
  let inputEvents = 0;
  const textarea = Object.assign(new EventTarget(), {
    value: 'Morning chores:',
    focused: false,
    focus() { this.focused = true; },
  });
  textarea.addEventListener('input', () => { inputEvents++; });

  const attrs = new Map();
  const props = new Map();
  const button = Object.assign(new EventTarget(), {
    dataset: {},
    style: { setProperty(k, v) { props.set(k, v); } },
    setAttribute(k, v) { attrs.set(k, v); },
  });

  const dictation = env.api.bindDictation(env.runtime, textarea, { button, mode: 'append' });
  assert.equal(button.dataset.state, 'idle');
  assert.equal(attrs.get('aria-pressed'), 'false');

  await dictation.start();
  assert.equal(dictation.state, 'recording');
  assert.equal(button.dataset.state, 'recording');
  assert.equal(attrs.get('aria-pressed'), 'true');

  env.workletNodes[0].emitPcm(new Float32Array(320).fill(0.2), 0.75);
  assert.equal(props.get('--level'), '0.750');

  dictation.stop();
  await new Promise(r => setTimeout(r, 60));
  await tick();

  assert.equal(textarea.value, 'Morning chores: water the tomatoes');
  assert.equal(inputEvents, 1, 'Dispatches standard input event');
  assert.equal(textarea.focused, true);
  assert.equal(dictation.state, 'idle');
  dictation.dispose();
});
