import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const compiled = await build({ entryPoints: [new URL('../src/voice/local-wake.ts', import.meta.url).pathname], bundle: true, format: 'iife', globalName: 'Local', platform: 'browser', write: false });
const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function environment({ microphone, resume, addModule } = {}) {
  const contexts = [], workers = [], worklets = [], tracks = [], states = [], commands = [], wakes = [], timers = new Map();
  let serial = 0, requests = 0, speaking = false, timestamp = Date.now();
  class ClockDate extends Date { static now() { return timestamp; } }
  const clock = { setTimeout(fn, ms) { const id = ++serial; timers.set(id, { fn, ms }); return id; }, clearTimeout(id) { timers.delete(id); } };
  class AudioContext extends EventTarget {
    state = 'suspended'; destination = {}; sampleRate = 48000;
    audioWorklet = { addModule: async () => { if (addModule) await addModule(); } };
    constructor() { super(); contexts.push(this); }
    async resume() { if (resume) await resume(); this.state = 'running'; }
    async close() { this.state = 'closed'; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  }
  class Worker {
    messages = []; terminated = false;
    constructor() { workers.push(this); }
    postMessage(message) { this.messages.push(message); }
    terminate() { this.terminated = true; }
    respond(action, result) { const request = this.messages.findLast(item => item.action === action); assert.ok(request, `No ${action} message`); this.onmessage?.({ data: { id: request.id, ...result } }); }
  }
  class AudioWorkletNode {
    port = { messages: [], postMessage(message) { this.messages.push(message); }, close() {} };
    constructor() { worklets.push(this); }
    connect() {} disconnect() {}
    utterance(sequence = this.port.messages.findLast(message => message.type === 'listen').sequence) {
      this.port.onmessage?.({ data: { type: 'utterance', sequence, samples: new Float32Array(1600).fill(0.1).buffer } });
    }
  }
  const stream = () => {
    const track = Object.assign(new EventTarget(), { readyState: 'live', muted: false, stop() { this.readyState = 'ended'; } }); tracks.push(track);
    return { getTracks: () => [track], getAudioTracks: () => [track] };
  };
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const window = Object.assign(new EventTarget(), { AudioContext, speechSynthesis: { speaking: false } });
  const context = { window, document, AudioWorkletNode, Worker, WebAssembly, navigator: { mediaDevices: { getUserMedia: () => { requests++; return microphone ? microphone(stream) : Promise.resolve(stream()); } } },
    DOMException, Event, ArrayBuffer, Float32Array, Uint8Array, URL, Date: ClockDate, ...clock };
  runInNewContext(compiled.outputFiles[0].text, context);
  const capture = new context.Local.LocalWakeCapture({ onState: (state, detail) => states.push({ state, detail }), onWake: () => wakes.push(true), onCommand: text => commands.push(text), isOutputSpeaking: () => speaking });
  const settings = { phrase: 'Hey Tendril', lang: 'en-US', workerUrl: '/voice-worker.js', workletUrl: '/voice-pcm-worklet.js',
    speech: { url: '/model', sha256: 'a'.repeat(64), size: 4, engine: { script: '/engine', script_sha256: 'b'.repeat(64), wasm: '/wasm', wasm_sha256: 'c'.repeat(64) } } };
  return { capture, settings, contexts, workers, worklets, tracks, states, commands, wakes, timers, document, window, stream,
    get requests() { return requests; }, setSpeaking(value) { speaking = value; },
    advance(milliseconds) { timestamp += milliseconds; },
    async start() { const task = capture.start(settings); await tick(); workers.at(-1).respond('init', { ready: true }); assert.equal(await task, true); },
    expire(ms) { const found = [...timers.entries()].find(([, timer]) => timer.ms === ms); assert.ok(found, `Missing ${ms}ms timer`); timers.delete(found[0]); found[1].fn(); } };
}

test('construction is inert; download/preparation precedes one microphone and one worker request at a time', async () => {
  const env = environment(); assert.equal(env.contexts.length, 0); assert.equal(env.requests, 0);
  env.capture.unlock(); assert.equal(env.contexts.length, 1);
  const starting = env.capture.start(env.settings); await tick();
  assert.equal(env.capture.preparing, true); assert.equal(env.requests, 0); assert.equal(env.capture.microphoneActive, false);
  env.workers[0].respond('init', { ready: true }); assert.equal(await starting, true);
  assert.equal(env.contexts.length, 1, 'gesture-unlocked context was retained'); assert.equal(env.requests, 1);
  assert.equal(env.capture.microphoneActive, true); assert.equal(env.states.at(-1).state, 'listening');
  env.worklets[0].utterance(); env.worklets[0].utterance();
  assert.equal(env.workers[0].messages.filter(message => message.action === 'detect').length, 1);
  env.workers[0].respond('detect', { matched: false, command: '' }); await tick();
  assert.deepEqual(env.commands, []); assert.equal(env.states.at(-1).state, 'listening');
  env.capture.stop(); await tick(); assert.equal(env.timers.size, 0); assert.equal(env.tracks[0].readyState, 'ended'); assert.equal(env.contexts[0].state, 'closed'); assert.equal(env.workers[0].terminated, true);
});

test('unsupported complete primary language subtags never silently select a different language', async () => {
  const env = environment();
  for (const lang of ['enx', 'eno', 'dee', 'plk', 'zh-Hant']) {
    assert.equal(await env.capture.start({ ...env.settings, lang }), false);
    assert.match(env.states.at(-1).detail, /supported language/);
  }
  assert.equal(env.requests, 0); assert.equal(env.workers.length, 0); assert.equal(env.contexts.length, 0);
});

test('phrase-only opens an eight-second command window; same-utterance commands and duplicate frames deliver once', async () => {
  const env = environment(); await env.start();
  env.worklets[0].utterance(); env.workers[0].respond('detect', { matched: true, command: '' }); await tick();
  assert.equal(env.wakes.length, 1); assert.equal(env.states.at(-1).state, 'command');
  const sequence = env.worklets[0].port.messages.at(-1).sequence;
  env.worklets[0].utterance(); env.workers[0].respond('transcribe', { text: 'turn on the lights' }); await tick();
  assert.deepEqual(env.commands, ['turn on the lights']);
  env.worklets[0].utterance(sequence); assert.equal(env.workers[0].messages.filter(message => message.action === 'transcribe').length, 1);
  env.expire(1000); env.worklets[0].utterance(); env.workers[0].respond('detect', { matched: true, command: 'close the window' }); await tick();
  assert.deepEqual(env.commands, ['turn on the lights', 'close the window']);
  env.capture.stop(); await tick(); assert.equal(env.timers.size, 0);
});

test('expired command windows discard partial speech and late transcripts cannot survive stop', async () => {
  const env = environment(); await env.start();
  env.worklets[0].utterance(); env.workers[0].respond('detect', { matched: true, command: '' }); await tick();
  const oldSequence = env.worklets[0].port.messages.at(-1).sequence;
  env.expire(8000); env.worklets[0].utterance(oldSequence);
  assert.equal(env.workers[0].messages.some(message => message.action === 'transcribe'), false);
  env.worklets[0].utterance(); env.capture.stop(); env.workers[0].respond('detect', { matched: true, command: 'must not escape' }); await tick();
  assert.deepEqual(env.commands, []); assert.equal(env.timers.size, 0);
});

test('cancelled pending permission retains its settlement promise until late granted tracks are stopped', async () => {
  let release;
  const env = environment({ microphone: stream => new Promise(resolve => { release = () => resolve(stream()); }) });
  const starting = env.capture.start(env.settings); await tick(); env.workers[0].respond('init', { ready: true }); await tick();
  assert.equal(env.requests, 1); let settled = false; const settlement = env.capture.microphoneSettled.then(() => { settled = true; });
  env.capture.stop(); await tick(); assert.equal(settled, false); assert.equal(env.capture.microphoneActive, false);
  assert.equal(await starting, false, 'the public start resolves before the native permission prompt settles');
  assert.equal(await env.capture.start(env.settings), false); assert.equal(env.requests, 1, 'standalone class also excludes an overlapping permission prompt');
  release(); await settlement;
  assert.equal(env.tracks[0].readyState, 'ended'); assert.equal(env.worklets.length, 0); assert.deepEqual(env.commands, []); assert.equal(env.timers.size, 0);
});

test('permission deadlines finish the start while retaining ownership until a late grant is stopped', async () => {
  let release;
  const env = environment({ microphone: stream => new Promise(resolve => { release = () => resolve(stream()); }) });
  const starting = env.capture.start(env.settings); await tick(); env.workers[0].respond('init', { ready: true }); await tick();
  const settlement = env.capture.microphoneSettled; let settled = false; settlement.then(() => { settled = true; });
  env.expire(30000); assert.equal(await starting, false); await tick();
  assert.equal(settled, false); assert.equal(env.capture.running, false); assert.match(env.states.at(-1).detail, /permission timed out/);
  release(); await settlement; assert.equal(env.tracks[0].readyState, 'ended'); assert.equal(env.timers.size, 0);
});

test('a sensor-wrapper early cancellation retains the underlying native microphone barrier', async () => {
  let cancelWrapper, finishNative;
  const env = environment({ microphone: stream => {
    const wrapped = new Promise((_resolve, reject) => { cancelWrapper = () => reject(new DOMException('Stop all', 'AbortError')); });
    const native = new Promise(resolve => { finishNative = () => { stream().getTracks().forEach(track => track.stop()); resolve(); }; });
    Object.defineProperty(wrapped, Symbol.for('tendriller.media-settled.v1'), { value: native });
    return wrapped;
  } });
  const starting = env.capture.start(env.settings); await tick(); env.workers[0].respond('init', { ready: true }); await tick();
  let settled = false; const barrier = env.capture.microphoneSettled.then(() => { settled = true; });
  cancelWrapper(); assert.equal(await starting, false); await tick(); assert.equal(settled, false);
  assert.equal(await env.capture.start(env.settings), false); assert.equal(env.requests, 1);
  finishNative(); await barrier; assert.equal(env.tracks[0].readyState, 'ended'); assert.equal(env.timers.size, 0);
});

test('visibility, track mute, audio interruption and output feedback stop resources with no auto-rearm', async () => {
  for (const interrupt of [
    env => { env.document.visibilityState = 'hidden'; env.document.dispatchEvent(new Event('visibilitychange')); },
    env => env.tracks[0].dispatchEvent(new Event('mute')),
    env => { env.contexts[0].state = 'interrupted'; env.contexts[0].dispatchEvent(new Event('statechange')); },
    env => { env.setSpeaking(true); env.worklets[0].utterance(); },
  ]) {
    const env = environment(); await env.start(); interrupt(env); await tick();
    assert.equal(env.capture.running, false); assert.equal(env.tracks[0].readyState, 'ended'); assert.equal(env.workers[0].terminated, true); assert.equal(env.states.at(-1).state, 'paused');
    env.document.visibilityState = 'visible'; env.document.dispatchEvent(new Event('visibilitychange')); assert.equal(env.requests, 1); assert.equal(env.timers.size, 0);
  }
});

test('a stalled inference, five-minute session or pending audio unlock is bounded and cancellable', async () => {
  const slow = environment(); await slow.start(); slow.worklets[0].utterance(); slow.expire(10000); await tick();
  assert.equal(slow.capture.running, false); assert.equal(slow.tracks[0].readyState, 'ended'); assert.match(slow.states.at(-1).detail, /too long/); assert.equal(slow.timers.size, 0);
  const long = environment(); await long.start(); long.expire(300000); await tick(); assert.equal(long.capture.running, false); assert.equal(long.timers.size, 0);
  const pending = environment({ resume: () => new Promise(() => {}) });
  const starting = pending.capture.start(pending.settings); await tick(); pending.capture.stop(); assert.equal(await starting, false); await tick();
  assert.equal(pending.requests, 0); assert.equal(pending.timers.size, 0); assert.equal(pending.contexts[0].state, 'closed');
});

test('repeated ambient sound and slow successful inference exhaust fixed device-work budgets', async () => {
  const frequent = environment(); await frequent.start();
  for (let i = 0; i < 15; i++) { frequent.worklets[0].utterance(); frequent.workers[0].respond('detect', { matched: false, command: '' }); await tick(); }
  frequent.worklets[0].utterance(); await tick();
  assert.equal(frequent.workers[0].messages.filter(message => message.action === 'detect').length, 15);
  assert.equal(frequent.capture.microphoneActive, false); assert.match(frequent.states.at(-1).detail, /device work limit/); assert.equal(frequent.timers.size, 0);
  const costly = environment(); await costly.start();
  for (let i = 0; i < 4; i++) { costly.worklets[0].utterance(); costly.advance(5000); costly.workers[0].respond('detect', { matched: false, command: '' }); await tick(); }
  costly.worklets[0].utterance(); await tick();
  assert.equal(costly.workers[0].messages.filter(message => message.action === 'detect').length, 4);
  assert.equal(costly.capture.microphoneActive, false); assert.match(costly.states.at(-1).detail, /device work limit/); assert.equal(costly.timers.size, 0);
});

test('a stalled model load times out without ever requesting microphone permission', async () => {
  const env = environment(); const starting = env.capture.start(env.settings); await tick();
  env.expire(120000); assert.equal(await starting, false); await tick();
  assert.equal(env.requests, 0); assert.equal(env.contexts[0].state, 'closed'); assert.equal(env.workers[0].terminated, true); assert.equal(env.timers.size, 0);
});
