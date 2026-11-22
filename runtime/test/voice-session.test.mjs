import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { RUNTIME_FEATURES } from '../resources.mjs';

const built = await build({ entryPoints: [new URL('../src/voice/index.ts', import.meta.url).pathname],
  bundle: true, format: 'iife', globalName: 'Voice', platform: 'browser', write: false });
const tick = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
function sharedLocks() {
  let owner = null;
  return {
    async request(_name, _options, callback) {
      const token = owner ? null : {};
      if (token) owner = token;
      try { return await callback(token); }
      finally { if (owner === token) owner = null; }
    },
    get held() { return !!owner; },
  };
}
function environment({ locks = sharedLocks(), consent = () => true, media, metadata, autoInit = true, delayedEnd = false,
  onTranscript, onStatus } = {}) {
  const workers = [], recorders = [], tracks = [], recognizers = [], consents = [], statuses = [], transcripts = [], spoken = [], fetches = [];
  const settings = new Map(), listeners = new Map(), timers = new Map(); let serial = 0, prompts = 0;
  const clock = { setTimeout(fn, ms) { const id = ++serial; timers.set(id, { fn, ms }); return id; }, clearTimeout(id) { timers.delete(id); } };
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const window = Object.assign(new EventTarget(), { ...clock, speechSynthesis: {
    speaking: false, cancel() {}, speak(utterance) { spoken.push({ text: utterance.text, activeMicrophones: tracks.filter(track => track.readyState === 'live').length }); },
  } });
  class Recognition {
    processLocally = false; results = []; started = false; aborted = false;
    constructor() { recognizers.push(this); }
    start() { this.started = true; this.onstart?.(); }
    abort() { this.aborted = true; if (!delayedEnd) this.onend?.(); }
    heard(transcript) {
      const resultIndex = this.results.length;
      this.results.push({ isFinal: true, 0: { transcript } });
      this.onresult?.({ resultIndex, results: this.results });
    }
    static async available() { return 'available'; }
    static async install() { return true; }
  }
  window.SpeechRecognition = Recognition;
  class Worker {
    messages = []; terminated = false;
    constructor(url) { this.url = url; workers.push(this); }
    postMessage(message) {
      this.messages.push(message);
      if (autoInit && message.action === 'init') queueMicrotask(() => this.respond('init', { ready: true }));
    }
    respond(action, result = {}) {
      const message = this.messages.findLast(item => item.action === action);
      assert.ok(message, `Missing worker ${action}`);
      this.onmessage?.({ data: { id: message.id, ...result } });
    }
    terminate() { this.terminated = true; }
  }
  class MediaRecorder {
    state = 'inactive'; mimeType = 'audio/webm';
    constructor(stream) { this.stream = stream; recorders.push(this); }
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      queueMicrotask(() => { this.ondataavailable?.({ data: new Blob(['utterance']) }); this.onstop?.(); });
    }
  }
  const stream = () => {
    const track = Object.assign(new EventTarget(), { readyState: 'live', stop() { this.readyState = 'ended'; } }); tracks.push(track);
    return { getTracks: () => [track], getAudioTracks: () => [track] };
  };
  class OfflineAudioContext {
    async decodeAudioData() { return { numberOfChannels: 1, length: 160, sampleRate: 16000, getChannelData: () => new Float32Array(160).fill(.1) }; }
  }
  Object.assign(window, { Worker, OfflineAudioContext });
  const runtime = { identity: { page: 'page', base: 'https://example.test/page/' },
    assetUrl: name => `https://example.test/runtime/${name}`,
    on(type, listener) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(listener); return () => listeners.get(type).delete(listener); } };
  const context = { window, document, navigator: { language: 'en-US', locks,
      mediaDevices: { getUserMedia: async () => { prompts++; return media ? media(stream) : stream(); } } },
    location: { href: runtime.identity.base }, isSecureContext: true, ...clock,
    Error, TypeError, DOMException, AbortController, URL, Blob, Float32Array, Worker, MediaRecorder, OfflineAudioContext, queueMicrotask,
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
    localStorage: { getItem: key => settings.get(key) || null, setItem: (key, value) => settings.set(key, value) },
    fetch: async (url, options) => {
      fetches.push({ url, options });
      return metadata ? metadata(options) : { ok: true, json: async () => ({ features: structuredClone(RUNTIME_FEATURES) }) };
    },
  };
  runInNewContext(built.outputFiles[0].text, context);
  const voice = context.Voice.createVoice(runtime, {
    consent(request) { consents.push(request); return consent(request); },
    transcript(text) { transcripts.push(text); onTranscript?.(text); },
    status(status) { statuses.push(status); onStatus?.(status); },
  });
  return { voice, context, workers, recorders, tracks, recognizers, consents, statuses, transcripts, spoken, fetches, locks, timers, window, document,
    get prompts() { return prompts; },
    emit(type) { for (const listener of listeners.get(type) || []) listener(); },
    get subscribed() { return [...listeners.values()].reduce((sum, current) => sum + current.size, 0); },
  };
}

async function finish(env, text) {
  env.voice.finishCapture(); await tick();
  env.workers.at(-1).respond('transcribe', { text }); await tick();
}

test('each recording requires fresh consent even when the verified model is prepared', async () => {
  const env = environment(); assert.equal(env.fetches.length, 0); assert.equal(env.prompts, 0);
  await env.voice.startCapture(); assert.equal(env.prompts, 1); assert.equal(env.voice.microphoneActive, true);
  assert.equal(env.consents.length, 1); assert.equal(Object.isFrozen(env.consents[0]), true); assert.equal(env.consents[0].downloadBytes, 18224260);
  await finish(env, 'first words'); assert.deepEqual(env.transcripts, ['first words']); assert.equal(env.voice.microphoneActive, false);
  await env.voice.startCapture(); assert.equal(env.prompts, 2); assert.equal(env.consents.length, 2); assert.equal(env.workers.length, 1);
  env.voice.stop(); await tick(); env.voice.dispose(); assert.equal(env.locks.held, false);
});

test('stopping during resource loading prevents a late worker or microphone', async () => {
  let resolve;
  const env = environment({ metadata: () => new Promise(done => { resolve = done; }) });
  const pending = env.voice.startCapture(); await tick(); assert.equal(env.fetches.length, 1);
  env.voice.stop(); assert.equal(env.fetches[0].options.signal.aborted, true);
  resolve({ ok: true, json: async () => ({ features: structuredClone(RUNTIME_FEATURES) }) });
  await pending; await tick();
  assert.equal(env.workers.length, 0); assert.equal(env.prompts, 0); assert.equal(env.locks.held, false); env.voice.dispose();
});

test('stopping while the worker initializes terminates setup and releases an unopened microphone', async () => {
  const env = environment({ autoInit: false });
  const pending = env.voice.startCapture(); await tick(); assert.equal(env.workers.length, 1); assert.equal(env.prompts, 0);
  env.voice.stop(); await pending; await tick();
  assert.equal(env.workers[0].terminated, true); assert.equal(env.locks.held, false);
  env.workers[0].respond('init', { ready: true }); await tick(); assert.equal(env.prompts, 0); env.voice.dispose();
});

test('a cancelled late microphone permission keeps all adapters excluded until its stream is stopped', async () => {
  const locks = sharedLocks(); let grant;
  const first = environment({ locks, media: stream => new Promise(resolve => { grant = () => resolve(stream()); }) });
  const other = environment({ locks });
  const pending = first.voice.startCapture(); await tick(); assert.equal(first.prompts, 1); assert.equal(locks.held, true);
  first.voice.stop(); await pending; await tick(); assert.equal(locks.held, true);
  assert.equal(await other.voice.startWake({ phrase: 'Hey Tendril', mode: 'browser' }), false);
  assert.equal(other.recognizers.length, 0); assert.match(other.statuses.at(-1).message, /Another tab/);
  grant(); await tick(); assert.equal(first.tracks[0].readyState, 'ended'); assert.equal(first.recorders.length, 0); assert.equal(locks.held, false);
  assert.equal(await other.voice.startWake({ phrase: 'Hey Tendril', mode: 'browser' }), true);
  first.voice.dispose(); other.voice.dispose(); await tick(); assert.equal(locks.held, false);
});

test('browser recognizer ownership lasts through a delayed native onend', async () => {
  const locks = sharedLocks(); const first = environment({ locks, delayedEnd: true }), other = environment({ locks });
  assert.equal(await first.voice.startWake({ phrase: 'Hey Tendril', mode: 'browser' }), true);
  const rec = first.recognizers.at(-1); first.voice.stop(); await tick();
  assert.equal(rec.aborted, true); assert.equal(first.voice.microphoneActive, true); assert.equal(locks.held, true);
  assert.equal(await other.voice.startWake({ phrase: 'Hey Tendril', mode: 'browser' }), false);
  rec.onend(); await tick(); assert.equal(first.voice.microphoneActive, false); assert.equal(locks.held, false);
  assert.equal(await other.voice.startWake({ phrase: 'Hey Tendril', mode: 'browser' }), true);
  rec.heard('Hey Tendril, stale input'); assert.deepEqual(first.transcripts, []);
  first.voice.dispose(); other.voice.dispose(); await tick();
});

test('recognizer restart after a completed stop does not race its own Web Lock release', async () => {
  const env = environment();
  assert.equal(await env.voice.startWake({ phrase: 'Hey Tendril', mode: 'local' }), true);
  env.voice.stop();
  assert.equal(await env.voice.startWake({ phrase: 'Hey Tendril', mode: 'local' }), true);
  env.voice.dispose(); await tick(); assert.equal(env.locks.held, false);
});

test('settings mutation during consent cannot change local recognition into a network provider', async () => {
  let decide;
  const env = environment({ consent: () => new Promise(resolve => { decide = resolve; }) });
  const settings = { phrase: 'Hey Tendril', mode: 'local' };
  const pending = env.voice.startWake(settings); await tick();
  settings.phrase = 'Different Phrase'; settings.mode = 'browser';
  assert.equal(env.consents[0].engine, 'local'); assert.equal(env.consents[0].phrase, 'Hey Tendril');
  decide(true); assert.equal(await pending, true); const rec = env.recognizers.at(-1);
  assert.equal(rec.processLocally, true); rec.heard('Different Phrase, do not accept'); assert.deepEqual(env.transcripts, []);
  rec.heard('Hey Tendril, accepted command'); assert.deepEqual(env.transcripts, ['accepted command']); env.voice.dispose();
});

test('output stops active input before speech is queued and drops delayed feedback', async () => {
  const env = environment(); await env.voice.enableOutput();
  await env.voice.startCapture(); env.voice.speak('Hey Tendril, this is output');
  assert.equal(env.tracks[0].readyState, 'ended'); assert.equal(env.voice.microphoneActive, false);
  await tick(); assert.deepEqual(env.spoken, [{ text: 'Hey Tendril, this is output', activeMicrophones: 0 }]); assert.deepEqual(env.transcripts, []);
  assert.equal(await env.voice.startWake({ phrase: 'Hey Tendril', mode: 'browser' }), true);
  const rec = env.recognizers.at(-1); env.voice.speak('Hey Tendril, feedback'); await tick(); rec.heard('Hey Tendril, feedback');
  assert.deepEqual(env.transcripts, []); assert.equal(rec.aborted, true); env.voice.dispose();
});

test('throwing consent, transcript, and status callbacks cannot retain microphone ownership', async () => {
  const denied = environment({ consent: () => { throw new Error('consent failed'); } });
  assert.equal(await denied.voice.startWake({ phrase: 'Hey Tendril', mode: 'browser' }), false);
  assert.equal(denied.locks.held, false); assert.equal(denied.recognizers.length, 0); denied.voice.dispose();
  const env = environment({ onTranscript: () => { throw new Error('page callback failed'); }, onStatus: () => { throw new Error('UI observer failed'); } });
  assert.equal(await env.voice.startWake({ phrase: 'Hey Tendril', mode: 'browser' }), true);
  env.recognizers.at(-1).heard('Hey Tendril, command'); await tick();
  assert.equal(env.voice.listening, false); assert.equal(env.voice.microphoneActive, false); assert.equal(env.locks.held, false);
  assert.equal(env.voice.wakeStatus.state, 'error'); env.voice.dispose();
});

test('dispose is idempotent and hidden pages do not rearm when visible again', async () => {
  const env = environment(); await env.voice.startCapture();
  env.document.visibilityState = 'hidden'; env.document.dispatchEvent(new Event('visibilitychange')); await tick();
  assert.equal(env.voice.microphoneActive, false); assert.equal(env.tracks[0].readyState, 'ended');
  env.document.visibilityState = 'visible'; env.document.dispatchEvent(new Event('visibilitychange')); await tick();
  assert.equal(env.prompts, 1); assert.equal(env.voice.listening, false);
  env.voice.dispose(); env.voice.dispose(); await tick(); assert.equal(env.subscribed, 0); assert.equal(env.timers.size, 0); assert.equal(env.locks.held, false);
});

test('unsupported complete language subtags are not silently truncated to a supported language', async () => {
  for (const language of ['enx', 'dee', 'plk']) {
    const env = environment(); env.voice.language(language);
    await env.voice.startCapture();
    assert.equal(env.prompts, 0); assert.equal(env.fetches.length, 0); assert.match(env.voice.captureStatus.message, /supported speech language/);
    assert.equal(await env.voice.startWake({ phrase: 'Computer listen', mode: 'model' }), false);
    assert.equal(env.prompts, 0); assert.equal(env.fetches.length, 0); assert.match(env.voice.wakeStatus.message, /supported language/);
    env.voice.dispose();
  }
});
