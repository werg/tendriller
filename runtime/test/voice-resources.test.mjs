import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { RUNTIME_FEATURES, RUNTIME_RESOURCES } from '../resources.mjs';
const compiled = await build({ entryPoints: [new URL('../src/voice/resources.ts', import.meta.url).pathname],
  bundle: true, format: 'iife', globalName: 'Resources', platform: 'browser', write: false });
const runtime = { identity: { base: '/page/' }, assetUrl: path => `https://fixture.example/runtime/${path}` };
function environment(metadata = structuredClone(RUNTIME_FEATURES), fetcher) {
  const requests = [], timers = new Map(); let serial = 0;
  const context = { URL, DOMException, AbortController, location: { href: 'https://fixture.example/page/' },
    setTimeout(fn, ms) { const id = ++serial; timers.set(id, { fn, ms }); return id; }, clearTimeout(id) { timers.delete(id); },
    fetch: async (url, options) => { requests.push({ url, options }); return fetcher ? fetcher(options) : { ok: true, json: async () => ({ features: metadata }) }; } };
  runInNewContext(compiled.outputFiles[0].text, context);
  return { api: context.Resources, requests, timers };
}
test('disclosed sizes and loaded resources come from the same immutable registry', async () => {
  const env = environment();
  assert.equal(env.requests.length, 0);
  assert.equal(env.api.SPEECH_DOWNLOAD_BYTES, RUNTIME_RESOURCES.reduce((sum, file) => sum + file.size, 0));
  assert.equal(env.api.SPEECH_MODEL_BYTES, 16919407);
  const speech = await env.api.loadSpeechResources(runtime);
  assert.equal(env.requests.length, 1);
  assert.equal(env.requests[0].url, 'https://fixture.example/runtime/resources.json');
  assert.equal(env.requests[0].options.redirect, 'error');
  assert.equal(speech.engine.script_sha256, RUNTIME_RESOURCES[0].sha256);
  assert.equal(speech.url, new URL(RUNTIME_FEATURES.speech.url, 'https://fixture.example/page/').href);
  assert.equal(env.timers.size, 0);
});
test('metadata cannot substitute executable assets, model bytes, undisclosed sizes or URLs', async () => {
  const changes = [
    speech => { speech.engine.script_sha256 = 'a'.repeat(64); },
    speech => { delete speech.engine.script_sha256; },
    speech => { speech.sha256 = 'a'.repeat(64); },
    speech => { speech.engine.wasm_sha256 = 'a'.repeat(64); },
    speech => { speech.engine.script = 'https://other.example/engine.js'; },
    speech => { speech.url = 'https://other.example/model'; },
    speech => { speech.size++; },
    speech => { speech.total_size++; },
    speech => { speech.engine.script_size++; },
    speech => { speech.engine.wasm_size++; },
  ];
  for (const change of changes) {
    const metadata = structuredClone(RUNTIME_FEATURES); change(metadata.speech);
    const env = environment(metadata);
    await assert.rejects(env.api.loadSpeechResources(runtime), /verified model/);
    assert.equal(env.requests.length, 1); assert.equal(env.timers.size, 0);
  }
});
test('cancellation and timeout invalidate even a late successful metadata response', async () => {
  for (const action of ['abort', 'timeout']) {
    let resolve;
    const env = environment(undefined, () => new Promise(done => { resolve = done; }));
    const controller = new AbortController();
    const pending = env.api.loadSpeechResources(runtime, controller.signal);
    if (action === 'abort') controller.abort();
    else [...env.timers.values()].find(timer => timer.ms === 15000).fn();
    assert.equal(env.requests[0].options.signal.aborted, true);
    resolve({ ok: true, json: async () => ({ features: structuredClone(RUNTIME_FEATURES) }) });
    await assert.rejects(pending, { name: 'AbortError' }); assert.equal(env.timers.size, 0);
  }
});
