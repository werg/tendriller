import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { RUNTIME_FEATURES } from '../resources.mjs';

// Bundle independently, like tendril.js and the lazily imported voice.mjs. The
// native-acquisition barrier must survive that boundary without a shared module.
const voiceCode = await build({ entryPoints: [new URL('../src/voice/index.ts', import.meta.url).pathname],
  bundle: true, format: 'iife', globalName: 'Voice', platform: 'browser', write: false });
const sensorCode = await build({ entryPoints: [new URL('../src/sensors.ts', import.meta.url).pathname],
  bundle: true, format: 'iife', globalName: 'Sensors', platform: 'browser', write: false });
const tick = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function locks() {
  let owner = null;
  return {
    get occupied() { return owner !== null; },
    async request(_name, _options, callback) {
      const lock = owner === null ? {} : null;
      if (lock) owner = lock;
      try { return await callback(lock); }
      finally { if (lock && owner === lock) owner = null; }
    },
  };
}
function environment(manager, pendingNative = null, { holdMetadata = false, consent = () => true } = {}) {
  const events = new Map(), storage = new Map(), transcripts = [], states = [], tracks = [], workers = [];
  const resourceRequests = [];
  let nativeCalls = 0, recorderStarts = 0;
  class Track extends EventTarget {
    kind = 'audio'; readyState = 'live'; muted = false; stopCalls = 0;
    constructor() { super(); tracks.push(this); }
    stop() { this.readyState = 'ended'; this.stopCalls++; }
    clone() { const track = new Track(); track.readyState = this.readyState; return track; }
  }
  class Stream extends EventTarget {
    constructor(current = [new Track()]) { super(); this.tracks = current; }
    getTracks() { return [...this.tracks]; }
    getAudioTracks() { return this.getTracks(); }
  }
  class MediaRecorder {
    state = 'inactive'; mimeType = 'audio/webm';
    constructor(stream) { this.stream = stream; }
    start() { this.state = 'recording'; recorderStarts++; }
    stop() { this.state = 'inactive'; queueMicrotask(() => this.onstop?.()); }
  }
  class Worker {
    constructor() { workers.push(this); }
    postMessage(message) { if (message.action === 'init') queueMicrotask(() => this.onmessage?.({ data: { id: message.id, ready: true } })); }
    terminate() { this.terminated = true; }
  }
  class OfflineAudioContext {}
  const window = Object.assign(new EventTarget(), { Worker, OfflineAudioContext,
    MediaStreamTrack: Track, MediaStream: Stream, setTimeout, clearTimeout,
    speechSynthesis: { speaking: false, cancel() {}, speak() {} } });
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const navigator = { language: 'en-US', locks: manager, mediaDevices: {
    getUserMedia() { nativeCalls++; return pendingNative?.promise || Promise.resolve(new Stream()); },
  } };
  const runtime = { identity: { page: 'shared-page', base: 'https://speech.test/page/' },
    assetUrl: path => new URL(path, 'https://speech.test/runtime/').href,
    on(name, callback) { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(callback); return () => events.get(name).delete(callback); },
  };
  const context = { window, document, navigator, Worker, OfflineAudioContext, MediaRecorder,
    URL, DOMException, AbortController, Blob, Float32Array, ArrayBuffer, setTimeout, clearTimeout,
    setInterval() {}, queueMicrotask, location: { href: runtime.identity.base },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    fetch: async (_url, options) => {
      if (!holdMetadata) return new Response(JSON.stringify({ features: RUNTIME_FEATURES }));
      const requested = deferred(), signal = options?.signal;
      const aborted = () => requested.reject(new DOMException('Metadata request cancelled', 'AbortError'));
      signal?.addEventListener('abort', aborted, { once: true });
      if (signal?.aborted) aborted();
      resourceRequests.push({ ...requested, signal, complete() { requested.resolve(new Response(JSON.stringify({ features: RUNTIME_FEATURES }))); } });
      try { return await requested.promise; } finally { signal?.removeEventListener('abort', aborted); }
    },
  };
  runInNewContext(sensorCode.outputFiles[0].text, context);
  const tracker = context.Sensors.installSensorWrappers();
  runInNewContext(voiceCode.outputFiles[0].text, context);
  const voice = context.Voice.createVoice(runtime, { consent,
    transcript: text => transcripts.push(text), status: value => states.push(value) });
  return { voice, tracker, tracks, workers, transcripts, states, Track, Stream, resourceRequests,
    get nativeCalls() { return nativeCalls; }, get recorderStarts() { return recorderStarts; },
    stopSensors() {
      const count = tracker.stopAll();
      for (const listener of events.get('sensors_stopped') || []) listener({ count });
      return count;
    },
  };
}

for (const outcome of ['grant', 'denial']) test(`Stop sensors preserves native microphone ownership through early wrapper rejection and a late ${outcome}`, async () => {
  const manager = locks(), native = deferred();
  const first = environment(manager, native), second = environment(manager);
  try {
    const opening = first.voice.startCapture(); await tick();
    assert.equal(first.nativeCalls, 1, 'the first native permission chooser is pending');
    assert.deepEqual([...first.tracker.status().pending], ['microphone']);
    assert.equal(manager.occupied, true);
    assert.equal(first.stopSensors(), 1);
    await opening; await tick();
    assert.deepEqual([...first.tracker.status().pending], [], 'Stop sensors still rejects its public wrapper immediately');
    assert.equal(first.voice.microphoneActive, false);
    assert.equal(manager.occupied, true, 'early wrapper rejection must not release the still-unanswered native acquisition');
    await second.voice.startCapture();
    assert.equal(second.nativeCalls, 0, 'another tab cannot open a parallel native microphone chooser');
    assert.match(second.voice.captureStatus.message, /Another tab/i);

    let lateTracks = [];
    if (outcome === 'grant') {
      lateTracks = [new first.Track(), new first.Track()];
      native.resolve(new first.Stream(lateTracks));
    } else native.reject(new DOMException('Permission denied', 'NotAllowedError'));
    await tick();
    assert.ok(lateTracks.every(track => track.readyState === 'ended'), 'every late native track is stopped before releasing ownership');
    assert.equal(first.recorderStarts, 0, 'a cancelled late grant is never recorded');
    assert.deepEqual(first.transcripts, []);
    assert.equal(manager.occupied, false);

    await second.voice.startCapture();
    assert.equal(second.nativeCalls, 1, 'a fresh local start succeeds after the old native request actually ends');
    assert.equal(second.voice.microphoneActive, true);
    assert.equal(second.recorderStarts, 1);
    second.voice.stop(); await tick();
    assert.ok(second.tracks.every(track => track.readyState === 'ended'));
    assert.equal(manager.occupied, false);
  } finally {
    // Resolve a still-pending fixture on assertion failure without leaving an
    // unhandled native request or session timer behind.
    native.reject(new DOMException('Test finished', 'AbortError'));
    first.voice.dispose(); second.voice.dispose(); await tick();
  }
});

test('superseded warm consent and metadata cannot restart a download after Stop', async () => {
  const decisions = [], env = environment(locks(), null, { holdMetadata: true,
    consent() { const decision = deferred(); decisions.push(decision); return decision.promise; } });
  try {
    const first = env.voice.prepareCapture(), second = env.voice.prepareCapture();
    const outcomes = Promise.allSettled([first, second]);
    await tick(); assert.equal(decisions.length, 2);
    decisions[1].resolve(true); await tick();
    assert.equal(env.resourceRequests.length, 1, 'only the latest consent proceeds to metadata');
    env.voice.stop();
    decisions[0].resolve(true);
    for (const request of env.resourceRequests) request.complete();
    await outcomes; await tick();
    assert.equal(env.workers.length, 0, 'neither old consent nor cancelled metadata may start a model worker');
    assert.equal(env.nativeCalls, 0);
    assert.equal(env.voice.captureStatus.state, 'idle');
  } finally { for (const decision of decisions) decision.resolve(false); env.voice.dispose(); await tick(); }
});

test('a late warm preparation cannot replace a newer recording or hide its live microphone', async () => {
  const env = environment(locks(), null, { holdMetadata: true });
  try {
    const first = env.voice.prepareCapture(); const firstDone = Promise.allSettled([first]); await tick();
    const second = env.voice.prepareCapture(); const secondDone = Promise.allSettled([second]); await tick();
    const starting = env.voice.startCapture(); await tick();
    assert.ok(env.resourceRequests.length >= 2);
    env.resourceRequests.at(-1).complete();
    await starting; await tick();
    assert.equal(env.nativeCalls, 1); assert.equal(env.recorderStarts, 1);
    assert.equal(env.voice.microphoneActive, true);
    for (const request of env.resourceRequests.slice(0, -1)) request.complete();
    await Promise.all([firstDone, secondDone]); await tick();
    assert.equal(env.workers.length, 1, 'superseded warm work must not allocate an orphan worker');
    assert.equal(env.voice.microphoneActive, true, 'the adapter still owns and reports the actual recording');
    env.voice.stop(); await tick();
    assert.ok(env.tracks.every(track => track.readyState === 'ended'), 'Stop must close the real recording, not a stale replacement');
    assert.deepEqual(env.transcripts, []);
  } finally {
    for (const request of env.resourceRequests) request.complete();
    env.voice.dispose(); await tick();
  }
});

test('successful explicit warming has a ready idle status and one disposable worker', async () => {
  const env = environment(locks(), null, { holdMetadata: true });
  try {
    const first = env.voice.prepareCapture(); const firstDone = Promise.allSettled([first]); await tick();
    const second = env.voice.prepareCapture(); const secondDone = Promise.allSettled([second]); await tick();
    for (const request of env.resourceRequests) request.complete();
    await Promise.all([firstDone, secondDone]); await tick();
    assert.equal(env.workers.length, 1);
    assert.equal(env.voice.captureStatus.state, 'idle');
    assert.match(env.voice.captureStatus.message, /ready/i);
    assert.equal(env.nativeCalls, 0, 'warming alone never requests a microphone');
    assert.equal(env.voice.microphoneActive, false);
    env.voice.dispose();
    assert.ok(env.workers.every(worker => worker.terminated), 'every warmed worker remains owned and disposable');
  } finally { env.voice.dispose(); await tick(); }
});
