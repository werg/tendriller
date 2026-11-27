import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { createHash, webcrypto } from 'node:crypto';
import { build } from 'esbuild';
import { RUNTIME_FEATURES, RUNTIME_RESOURCES } from '../resources.mjs';

const workerBundle = await build({
  entryPoints: [new URL('../src/voice/worker.ts', import.meta.url).pathname],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  write: false,
});

const voiceBundle = await build({
  entryPoints: [new URL('../src/voice/index.ts', import.meta.url).pathname],
  bundle: true,
  format: 'iife',
  globalName: 'Voice',
  platform: 'browser',
  write: false,
});

const digest = data => createHash('sha256').update(data).digest('hex');

function makeMemoryCaches() {
  const buckets = new Map();
  return {
    buckets,
    async open(name) {
      let store = buckets.get(name);
      if (!store) { store = new Map(); buckets.set(name, store); }
      return {
        async match(key) {
          const hit = store.get(String(key));
          return hit ? hit.clone() : undefined;
        },
        async put(key, response) {
          store.set(String(key), response.clone());
        },
        async delete(key) {
          return store.delete(String(key));
        },
      };
    },
  };
}

function makeWorkerEnv({ caches, nativeStream = true } = {}) {
  const assets = new Map([
    ['https://speech.test/engine.js', new TextEncoder().encode('/* verified fixture code */')],
    ['https://speech.test/engine.wasm', new Uint8Array([0, 97, 115, 109])],
    ['https://speech.test/model.bin', new Uint8Array([1, 3, 7, 9, 11, 13])],
  ]);
  const messages = [];
  const reads = [];
  let serial = 0;
  let chunkIndex = 0;
  const streamOutputs = [
    { text: '', pending: 'hello' },
    { text: 'hello', pending: 'world' },
  ];
  const engine = {
    HEAPU8: new Uint8Array(2_000_000),
    _malloc(size) { const ptr = serial + 128; serial = ptr + size; return ptr; },
    _free() {},
    _cactus_load() { return 0; },
    ...(nativeStream ? {
      _cactus_stream_transcribe_process() { return 0; },
      _cactus_stream_transcribe_stop() { return 0; },
    } : {}),
    lastPayload: '',
    ccall(name) {
      if (name === 'cactus_stream_transcribe_process') {
        const next = streamOutputs[Math.min(chunkIndex++, streamOutputs.length - 1)];
        this.lastPayload = JSON.stringify(next);
        return next.text ? 1 : 0;
      }
      if (name === 'cactus_stream_transcribe_stop') {
        this.lastPayload = JSON.stringify({ text: 'world', pending: '' });
        chunkIndex = 0;
        return 1;
      }
      this.lastPayload = JSON.stringify({ text: 'batch fallback result' });
      return 0;
    },
    UTF8ToString() { return this.lastPayload; },
  };
  class WorkerURL extends URL {
    static createObjectURL() { return 'blob:verified-fixture'; }
    static revokeObjectURL() {}
  }
  const self = {
    location: { href: 'https://speech.test/worker.js' },
    caches,
    postMessage: message => messages.push(structuredClone(message)),
    importScripts() {},
  };
  runInNewContext(workerBundle.outputFiles[0].text, {
    self,
    crypto: webcrypto,
    URL: WorkerURL,
    Blob,
    Response,
    ArrayBuffer,
    Uint8Array,
    Float32Array,
    Set,
    fetch: async url => {
      reads.push(url);
      const bytes = assets.get(url);
      return new Response(bytes, { headers: { 'Content-Length': String(bytes.byteLength) } });
    },
    createCactus: async () => engine,
  });
  const config = {
    engine: {
      script: 'https://speech.test/engine.js',
      script_sha256: digest(assets.get('https://speech.test/engine.js')),
      script_size: assets.get('https://speech.test/engine.js').byteLength,
      wasm: 'https://speech.test/engine.wasm',
      wasm_sha256: digest(assets.get('https://speech.test/engine.wasm')),
      wasm_size: 4,
    },
    modelUrl: 'https://speech.test/model.bin',
    modelSha256: digest(assets.get('https://speech.test/model.bin')),
    modelSize: 6,
  };
  let reqId = 0;
  return {
    messages,
    reads,
    async call(data) {
      const id = ++reqId;
      await self.onmessage({ data: { id, ...data } });
      return messages.findLast(m => m.id === id && !m.progress);
    },
    init() { return this.call({ action: 'init', ...config }); },
  };
}

test('dedicated tendril-models-v1 cache serves second cold worker with zero network requests and evicts tampered entries', async () => {
  const caches = makeMemoryCaches();

  const w1 = makeWorkerEnv({ caches });
  const r1 = await w1.init();
  assert.equal(r1.ready, true);
  assert.equal(r1.streaming, true);
  assert.equal(w1.reads.length, 3, 'cold start downloads all 3 verified assets once');
  assert.equal(caches.buckets.get('tendril-models-v1').size, 3, 'all 3 assets stored in tendril-models-v1');

  const w2 = makeWorkerEnv({ caches });
  const r2 = await w2.init();
  assert.equal(r2.ready, true);
  assert.equal(w2.reads.length, 0, 'warm start loads verified assets from tendril-models-v1 with 0 network requests');

  // Corrupt one cached entry and verify worker auto-evicts and re-fetches cleanly.
  const store = caches.buckets.get('tendril-models-v1');
  const firstKey = [...store.keys()][0];
  store.set(firstKey, new Response(new Uint8Array([9, 9, 9, 9, 9, 9])));

  const w3 = makeWorkerEnv({ caches });
  const r3 = await w3.init();
  assert.equal(r3.ready, true);
  assert.equal(w3.reads.length, 1, 'only the corrupted asset is re-fetched');
});

test('worker streaming protocol emits progressive confirmed + pending partials and flushes final text', async () => {
  const env = makeWorkerEnv({ nativeStream: true });
  await env.init();

  const started = await env.call({ action: 'stream-start', sessionId: 's1', language: 'en' });
  assert.equal(started.streaming, true);
  assert.equal(started.native, true);

  const p1 = await env.call({ action: 'stream-chunk', sessionId: 's1', samples: new Float32Array(8000).fill(0.1).buffer });
  assert.deepEqual({ confirmed: p1.confirmed, pending: p1.pending, text: p1.text }, { confirmed: '', pending: 'hello', text: 'hello' });

  const p2 = await env.call({ action: 'stream-chunk', sessionId: 's1', samples: new Float32Array(8000).fill(0.1).buffer });
  assert.deepEqual({ confirmed: p2.confirmed, pending: p2.pending, text: p2.text }, { confirmed: 'hello', pending: 'world', text: 'hello world' });

  const final = await env.call({ action: 'stream-stop', sessionId: 's1' });
  assert.equal(final.text, 'hello world');

  // Cancellation resets without terminating worker
  await env.call({ action: 'stream-start', sessionId: 's2', language: 'en' });
  const cancelled = await env.call({ action: 'stream-cancel', sessionId: 's2' });
  assert.equal(cancelled.cancelled, true);
});

test('transcribeAudio rejects unsupported explicit language unless fallbackLanguage is explicitly passed (#109)', async () => {
  const ctx = {
    window: new EventTarget(),
    document: new EventTarget(),
    navigator: { language: 'en-US' },
    location: { href: 'https://example.test/' },
    URL,
    Event,
    EventTarget,
    DOMException,
    AbortController,
    Float32Array,
    setTimeout,
    clearTimeout,
  };
  runInNewContext(voiceBundle.outputFiles[0].text, ctx);
  const { resolveSpeechLanguage, UnsupportedLanguageError, SPEECH_ENGINE_CATALOG } = ctx.Voice;

  assert.equal(resolveSpeechLanguage('de-DE'), 'de');
  assert.throws(() => resolveSpeechLanguage('ja-JP'), err => err instanceof UnsupportedLanguageError && err.code === 'UNSUPPORTED_SPEECH_LANGUAGE');
  assert.equal(resolveSpeechLanguage('ja-JP', { fallbackLanguage: 'en' }), 'en');
  assert.ok(SPEECH_ENGINE_CATALOG.some(e => e.id === 'whistle' && e.streaming));
  assert.ok(SPEECH_ENGINE_CATALOG.some(e => e.id === 'browser-local' && e.downloadBytes === 0));
});

test('dictate() streams live partials and final events over AsyncIterable<TranscriptEvent>', async () => {
  const workers = [];
  const workletNodes = [];
  class Worker {
    messages = [];
    constructor() { workers.push(this); }
    postMessage(message) {
      this.messages.push(message);
      if (message.action === 'init') {
        queueMicrotask(() => this.onmessage?.({ data: { id: message.id, ready: true, streaming: true } }));
      } else if (message.action === 'stream-start') {
        queueMicrotask(() => this.onmessage?.({ data: { id: message.id, sessionId: message.sessionId, streaming: true, native: true } }));
      } else if (message.action === 'stream-chunk') {
        queueMicrotask(() => this.onmessage?.({ data: { id: message.id, sessionId: message.sessionId, confirmed: 'hello', pending: 'there', text: 'hello there' } }));
      } else if (message.action === 'stream-stop') {
        queueMicrotask(() => this.onmessage?.({ data: { id: message.id, sessionId: message.sessionId, text: 'hello there' } }));
      }
    }
    terminate() {}
  }
  class AudioWorkletNode {
    port = {
      onmessage: null,
      postMessage: msg => {
        if (msg?.type === 'capture' && msg.enabled === false) {
          queueMicrotask(() => this.port.onmessage?.({ data: { type: 'capture-flushed', sequence: msg.sequence } }));
        }
      },
    };
    constructor() { workletNodes.push(this); }
    connect() {}
    disconnect() {}
    emitPcm(len) {
      const samples = new Float32Array(len).fill(0.2);
      this.port.onmessage?.({ data: { type: 'pcm', samples: samples.buffer } });
    }
  }
  class AudioContext {
    state = 'running';
    destination = {};
    audioWorklet = { addModule: async () => {} };
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    async resume() {}
    async close() {}
  }
  const track = Object.assign(new EventTarget(), { readyState: 'live', stop() { this.readyState = 'ended'; } });
  const win = Object.assign(new EventTarget(), { Worker, AudioContext, AudioWorkletNode, setTimeout, clearTimeout });
  const SPEECH_DOWNLOAD_BYTES = RUNTIME_RESOURCES.reduce((s, r) => s + r.size, 0);
  const storage = new Map();
  const ctx = {
    window: win,
    document: Object.assign(new EventTarget(), { visibilityState: 'visible' }),
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) },
    navigator: {
      language: 'en-US',
      locks: { request: async (_n, _o, fn) => (typeof _o === 'function' ? _o({}) : fn({})) },
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }) },
    },
    location: { href: 'https://example.test/s/demo/' },
    Worker,
    AudioContext,
    AudioWorkletNode,
    URL,
    Blob,
    Event,
    EventTarget,
    DOMException,
    AbortController,
    Float32Array,
    queueMicrotask,
    setTimeout,
    clearTimeout,
    fetch: async () => ({
      ok: true,
      json: async () => ({ features: { speech: { ...RUNTIME_FEATURES.speech, total_size: SPEECH_DOWNLOAD_BYTES } } }),
    }),
  };
  runInNewContext(voiceBundle.outputFiles[0].text, ctx);

  const runtime = {
    identity: { page: 'demo', base: 'https://example.test/s/demo/' },
    assetUrl: path => `https://example.test/_tendril/runtime/r1/${path}`,
    on: () => () => {},
  };

  const session = ctx.Voice.dictate(runtime, { language: 'en-US' });
  const events = [];
  const consumer = (async () => {
    for await (const ev of session) {
      events.push(ev);
      if (ev.type === 'status' && ev.state === 'listening') {
        workletNodes[0].emitPcm(8000);
      }
      if (ev.type === 'partial') {
        session.stop();
      }
    }
  })();

  await consumer;
  assert.equal(workers.length, 1);
  assert.ok(events.some(e => e.type === 'partial' && e.text === 'hello there'), 'emits live partial before stop');
  assert.ok(events.some(e => e.type === 'final' && e.text === 'hello there'), 'emits final transcript');
});
