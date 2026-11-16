import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const compiled = await build({ stdin: { contents: 'export { createSpeechOutput } from "./voice/output"; export { createPreferences } from "./voice/preferences";', resolveDir: new URL('../src/', import.meta.url).pathname, loader: 'ts' }, bundle: true, format: 'esm', platform: 'node', write: false });
const { createSpeechOutput, createPreferences } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function environment() {
  const spoken = [], state = new Map();
  globalThis.window = Object.assign(new EventTarget(), { speechSynthesis: { speak: utterance => spoken.push(utterance.text), cancel() {} } });
  globalThis.document = new EventTarget();
  globalThis.location = { href: 'https://example.test/page/' };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { language: 'en-US' } });
  globalThis.localStorage = { getItem: key => state.get(key), setItem: (key, value) => state.set(key, value) };
  globalThis.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  globalThis.Worker = class {};
  globalThis.AudioContext = class { state = 'running'; async resume() {} async close() {} };
  const events = [];
  const bus = { on: () => () => {}, emit: (type, data) => events.push({ type, data }) };
  return { spoken, state, events, bus, preferences: (() => { const preferences = createPreferences('fixture'); preferences.update({ audio: true }); return preferences; })() };
}

test('first reply uses browser speech immediately without downloading neural assets', async () => {
  const env = environment(); let loads = 0;
  const voice = createSpeechOutput('/page/', env.bus, env.preferences, async () => { loads++; throw Error('unexpected download'); });
  voice.speak('Ready now'); await tick();
  assert.equal(voice.status.enabled, false); assert.deepEqual(env.spoken, ['Ready now']); assert.equal(loads, 0);
});

test('a chosen neural download leaves current replies immediate and does not replay them', async () => {
  const env = environment(); let release, loads = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const model = { dispose() {}, stream() { throw Error('already-spoken reply must not replay'); } };
  const voice = createSpeechOutput('/page/', env.bus, env.preferences, async () => ({ PhononTTS: class { static async load() { loads++; await pending; return model; } } }));
  const preparation = voice.enable(); await tick(); voice.speak('Keep working'); await tick();
  assert.deepEqual(env.spoken, ['Keep working']); assert.equal(voice.status.state, 'loading');
  release(); await preparation; await tick();
  assert.equal(voice.status.state, 'ready'); assert.equal(loads, 1); assert.deepEqual(env.spoken, ['Keep working']);
});

test('declining natural voice while loading disposes the late model', async () => {
  const env = environment(); let release, disposed = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const voice = createSpeechOutput('/page/', env.bus, env.preferences, async () => ({ PhononTTS: class { static async load() { await pending; return { dispose() { disposed++; } }; } } }));
  const preparation = voice.enable().catch(() => {}); await tick(); voice.disable(); release(); await preparation;
  assert.equal(voice.status.enabled, false); assert.equal(disposed, 1); assert.equal(env.preferences.get().voice, 'browser');
  assert.equal(JSON.parse(env.state.get('tendril:voice:fixture:preferences')).voice, 'browser');
});

test('mute does not speak or download, and non-English uses browser speech', async () => {
  const env = environment(); env.preferences.update({ audio: false }); let loads = 0;
  const voice = createSpeechOutput('/page/', env.bus, env.preferences, async () => { loads++; throw Error(); });
  voice.speak('Muted'); await tick(); assert.deepEqual(env.spoken, []);
  env.preferences.update({ audio: true, language: 'de-DE' }); voice.speak('Hallo'); await tick(); assert.deepEqual(env.spoken, ['Hallo']); assert.equal(loads, 0);
});
