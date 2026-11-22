import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { createHash, webcrypto } from 'node:crypto';
import { build } from 'esbuild';

const compiled = await build({ entryPoints: [new URL('../src/voice/worker.ts', import.meta.url).pathname], bundle: true, format: 'iife', platform: 'browser', write: false });
const digest = data => createHash('sha256').update(data).digest('hex');
function environment({ scriptHash, modelSize, failAllocation = 0 } = {}) {
  const assets = new Map([
    ['https://speech.test/engine.js', new TextEncoder().encode('/* verified fixture code */')],
    ['https://speech.test/engine.wasm', new Uint8Array([0, 97, 115, 109])],
    ['https://speech.test/model.bin', new Uint8Array([1, 3, 7, 9])],
  ]);
  const messages = [], reads = [], imports = [], revoked = [], freed = [], loads = [];
  let text = 'ambient private conversation', serial = 0, mallocs = 0;
  const engine = {
    HEAPU8: new Uint8Array(2_000_000),
    _malloc(size) { if (++mallocs === failAllocation) return 0; const ptr = serial + 128; serial = ptr + size; return ptr; },
    _free(ptr) { freed.push(ptr); }, _cactus_load(ptr, length) { loads.push({ ptr, length }); return 0; },
    ccall() { return 0; }, UTF8ToString() { return JSON.stringify({ text }); },
  };
  class WorkerURL extends URL {
    static createObjectURL(blob) { assert.equal(blob.type, 'text/javascript'); return 'blob:verified-fixture'; }
    static revokeObjectURL(value) { revoked.push(value); }
  }
  const self = { location: { href: 'https://speech.test/worker.js' }, postMessage: message => messages.push(structuredClone(message)), importScripts(url) { imports.push(url); } };
  runInNewContext(compiled.outputFiles[0].text, {
    self, crypto: webcrypto, URL: WorkerURL, Blob, ArrayBuffer, Uint8Array, Float32Array, Set,
    fetch: async (url, options) => { reads.push({ url, options }); return new Response(assets.get(url), { headers: { 'Content-Length': assets.get(url).byteLength } }); },
    createCactus: async () => engine,
  });
  const config = {
    engine: { script: 'https://speech.test/engine.js', script_sha256: scriptHash ?? digest(assets.get('https://speech.test/engine.js')), script_size: assets.get('https://speech.test/engine.js').byteLength,
      wasm: 'https://speech.test/engine.wasm', wasm_sha256: digest(assets.get('https://speech.test/engine.wasm')), wasm_size: 4 },
    modelUrl: 'https://speech.test/model.bin', modelSha256: digest(assets.get('https://speech.test/model.bin')), modelSize: modelSize ?? 4,
  };
  return { messages, reads, imports, revoked, freed, loads, engine, setText(value) { text = value; },
    async init() { await self.onmessage({ data: { id: 1, action: 'init', ...config } }); return messages.at(-1); },
    async request(data) { await self.onmessage({ data: { id: 2, ...data } }); return messages.at(-1); } };
}

test('every executable/model asset is verified before code executes, including exact script bytes', async () => {
  const env = environment(); assert.deepEqual(await env.init(), { id: 1, ready: true });
  assert.equal(env.reads.length, 3); assert.deepEqual(env.imports, ['blob:verified-fixture']); assert.deepEqual(env.revoked, env.imports);
  assert.equal(env.loads[0].length, 4n); assert.equal(env.freed.length, 1);
  assert.ok(env.reads.every(read => read.options.redirect === 'error' && read.options.credentials === 'same-origin'));
  const tampered = environment({ scriptHash: '0'.repeat(64) }); assert.match((await tampered.init()).error, /hash mismatch/); assert.deepEqual(tampered.imports, []);
  const oversized = environment({ modelSize: 3 }); assert.match((await oversized.init()).error, /declared size/); assert.deepEqual(oversized.imports, []);
  const truncated = environment({ modelSize: 5 }); assert.match((await truncated.init()).error, /size mismatch/); assert.deepEqual(truncated.imports, []);
});

test('ambient transcripts remain inside the worker; only an exact phrase and its command leave', async () => {
  const env = environment(); await env.init();
  const audio = new Float32Array(1600).fill(0.1);
  const ambient = await env.request({ action: 'detect', samples: audio.buffer, phrase: 'Hey Tendril', language: 'en' });
  assert.deepEqual(ambient, { id: 2, matched: false, command: '' }); assert.equal(audio.some(value => value !== 0), false);
  assert.ok(!JSON.stringify(env.messages).includes('ambient private conversation'));
  env.setText('Hey tendrils, open the window.');
  assert.equal((await env.request({ action: 'detect', samples: new Float32Array(1600).buffer, phrase: 'Hey Tendril', language: 'en' })).matched, false);
  env.setText('Hey Tendril, open the window.');
  assert.deepEqual(await env.request({ action: 'detect', samples: new Float32Array(1600).buffer, phrase: 'Hey Tendril', language: 'en' }), { id: 2, matched: true, command: 'open the window.' });
  env.setText('Open the window.');
  assert.deepEqual(await env.request({ action: 'transcribe', samples: new Float32Array(1600).buffer, language: 'en' }), { id: 2, text: 'Open the window.' });
});

test('unbounded, malformed or unsupported audio is rejected and partial allocations are freed', async () => {
  const env = environment(); await env.init();
  assert.match((await env.request({ action: 'detect', samples: new Float32Array(16000 * 8 + 1).buffer, phrase: 'Hey Tendril', language: 'en' })).error, /bounded window/);
  assert.match((await env.request({ action: 'detect', samples: new Float32Array([NaN]).buffer, phrase: 'Hey Tendril', language: 'en' })).error, /Invalid microphone/);
  assert.match((await env.request({ action: 'detect', samples: new Float32Array([0]).buffer, phrase: '', language: 'en' })).error, /wake phrase/);
  assert.match((await env.request({ action: 'transcribe', samples: new Float32Array([0]).buffer, language: 'xx' })).error, /Unsupported speech language/);
  assert.match((await env.request({ action: 'unknown' })).error, /Unknown/);
  const failure = environment({ failAllocation: 3 }); await failure.init();
  assert.match((await failure.request({ action: 'transcribe', samples: new Float32Array([0.2]).buffer, language: 'en' })).error, /allocate/);
  assert.equal(failure.freed.length, 2, 'initial model and successful PCM allocations are both freed when output allocation fails');
});
