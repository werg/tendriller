import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
const built = await build({ entryPoints: [new URL('../src/voice/index.ts', import.meta.url).pathname], bundle: true, format: 'iife', globalName: 'Voice', platform: 'browser', write: false });
const tick = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function environment(consent = () => true) {
  const spoken = [], handlers = new Map(), settings = new Map(); let reads = 0, starts = 0, aborted = 0, installs = 0;
  const window = Object.assign(new EventTarget(), { speechSynthesis: { speaking: false, speak(utterance) { spoken.push(utterance.text); }, cancel() {} } });
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  class Recognition extends EventTarget { processLocally = false; start() { starts++; this.onstart?.(); } abort() { aborted++; this.onend?.(); } static async available() { return 'available'; } static async install() { installs++; return true; } }
  window.SpeechRecognition = Recognition;
  const runtime = { identity: { page: 'page', base: 'https://test.example/page/' }, device: { role: 'owner', pending: false },
    assetUrl: path => new URL(path, 'https://test.example/runtime/').href,
    on(type, listener) { if (!handlers.has(type)) handlers.set(type, new Set()); handlers.get(type).add(listener); return () => handlers.get(type).delete(listener); } };
  const context = { window, document, navigator: { language: 'en-US' }, location: { href: runtime.identity.base },
    localStorage: { getItem: key => settings.get(key) || null, setItem: (key, value) => settings.set(key, value) },
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } }, URL, DOMException, AbortController, setTimeout, clearTimeout,
    fetch: async () => { reads++; throw Error('No resource should be fetched in this test'); } };
  runInNewContext(built.outputFiles[0].text, context);
  const transcripts = [], statuses = [];
  const voice = context.Voice.createVoice(runtime, { consent, transcript: text => transcripts.push(text), status: value => statuses.push(value), speakReplies: true });
  return { voice, window, document, runtime, spoken, transcripts, statuses, handlers, emit(type, payload) { for (const listener of handlers.get(type) || []) listener(payload); },
    get reads() { return reads; }, get starts() { return starts; }, get aborted() { return aborted; }, get installs() { return installs; } };
}
test('explicit construction is inert and output requires session consent', async () => {
  const env = environment(() => false);
  assert.equal(env.voice.muted, true);
  env.voice.speak('not enabled'); env.emit('reply', { text: 'not enabled either', speak: true }); await tick();
  assert.equal(env.reads, 0); assert.equal(env.starts, 0); assert.deepEqual(env.spoken, []);
  assert.equal(await env.voice.enableOutput(), false); env.voice.speak('declined'); await tick(); assert.deepEqual(env.spoken, []);
  assert.equal(await env.voice.startWake({ phrase: 'Hey test', mode: 'local' }), false); assert.equal(env.starts, 0);
  env.voice.dispose();
});
test('output and wake remain explicit, muted/hidden/stopped states do not auto-resume', async () => {
  const env = environment();
  assert.equal(await env.voice.enableOutput('browser'), true); env.voice.speak('hello'); await tick(); assert.deepEqual(env.spoken, ['hello']);
  assert.equal(env.voice.muted, false);
  env.voice.mute(); env.emit('reply', { text: 'muted', speak: true }); await tick(); assert.deepEqual(env.spoken, ['hello']);
  assert.equal(env.voice.muted, true);
  assert.equal(await env.voice.startWake({ phrase: 'Hey test', mode: 'local' }), true); assert.equal(env.voice.listening, true);
  env.emit('sensors_stopped', { count: 1 }); assert.equal(env.voice.listening, false); assert.equal(env.aborted, 1);
  assert.equal(await env.voice.startWake({ phrase: 'Hey test', mode: 'local' }), true);
  env.document.visibilityState = 'hidden'; env.document.dispatchEvent(new Event('visibilitychange'));
  env.document.visibilityState = 'visible'; env.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(env.voice.listening, false); assert.equal(env.starts, 2); assert.equal(env.reads, 0);
  env.voice.dispose(); assert.equal([...env.handlers.values()].reduce((total, listeners) => total + listeners.size, 0), 0);
});
test('stopping during consent invalidates the pending start and language install requires consent', async () => {
  let resolve; const env = environment(() => new Promise(done => { resolve = done; }));
  const starting = env.voice.startWake({ phrase: 'Hey test', mode: 'local' }); await tick();
  env.voice.stop(); resolve(true); assert.equal(await starting, false); assert.equal(env.starts, 0);
  const install = env.voice.installLocalLanguage(); await tick(); resolve(false); assert.equal(await install, false); assert.equal(env.installs, 0);
  env.voice.dispose();
});
