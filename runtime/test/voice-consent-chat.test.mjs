import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const built = await build({
  entryPoints: [new URL('../src/voice/index.ts', import.meta.url).pathname],
  bundle: true,
  format: 'iife',
  globalName: 'Voice',
  platform: 'browser',
  write: false,
});
const tick = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

function setup(options = {}) {
  const spoken = [], handlers = new Map(), settings = new Map();
  let starts = 0;
  const window = Object.assign(new EventTarget(), {
    setTimeout, clearTimeout,
    speechSynthesis: {
      speaking: false,
      speak(utterance) {
        this.speaking = true;
        spoken.push(utterance.text);
        utterance.onstart?.();
        utterance.onend?.();
        this.speaking = false;
      },
      cancel() { this.speaking = false; },
    },
  });
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  class Recognition extends EventTarget {
    processLocally = false;
    start() { starts++; this.onstart?.(); }
    abort() { this.onend?.(); }
    static async available() { return 'available'; }
    static async install() { return true; }
  }
  window.SpeechRecognition = Recognition;
  const runtime = {
    identity: { page: 'chat-page', base: 'https://test.example/page/' },
    assetUrl: path => new URL(path, 'https://test.example/runtime/').href,
    on(type, listener) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type).add(listener);
      return () => handlers.get(type).delete(listener);
    },
  };
  let locked = false;
  const locks = {
    async request(_name, _opts, cb) {
      if (locked) return cb(null);
      locked = true;
      try { return await cb({ name: 'tendriller-microphone' }); } finally { locked = false; }
    },
  };
  const context = {
    window, document,
    navigator: { language: 'en-US', locks },
    location: { href: runtime.identity.base },
    localStorage: { getItem: k => settings.get(k) || null, setItem: (k, v) => settings.set(k, v) },
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
    URL, DOMException, AbortController, setTimeout, clearTimeout,
    fetch: async () => { throw Error('No fetch expected'); },
  };
  runInNewContext(built.outputFiles[0].text, context);
  const statuses = [];
  const voice = context.Voice.createVoice(runtime, {
    transcript: () => {},
    status: s => statuses.push(s),
    ...options,
  });
  return {
    voice, spoken, statuses,
    get starts() { return starts; },
    emit(type, payload) { for (const fn of handlers.get(type) || []) fn(payload); },
  };
}

test('consentMode auto grants immediately without callback and supports autoOutput', async () => {
  const env = setup({ consentMode: 'auto', autoOutput: 'browser' });
  assert.equal(env.voice.consentMode, 'auto');
  assert.equal(env.voice.muted, false);
  env.voice.speak('Hello right away');
  await tick();
  assert.deepEqual(env.spoken, ['Hello right away']);
  assert.ok(env.statuses.some(s => s.kind === 'output' && s.speaking === true));
  assert.ok(env.statuses.some(s => s.kind === 'output' && s.speaking === false));
  assert.equal(await env.voice.startWake({ phrase: 'Hey agent', mode: 'local' }), true);
  assert.equal(env.starts, 1);
  env.voice.dispose();
});

test('explicit consent modes require a callback and revocation invalidates a pending decision', async () => {
  for (const consentMode of ['session', 'prompt']) {
    assert.throws(() => setup({ consentMode }), /require a consent callback/);
  }
  let approve;
  const env = setup({ consentMode: 'session', consent: () => new Promise(resolve => { approve = resolve; }) });
  const starting = env.voice.startWake({ phrase: 'Hey agent', mode: 'local' });
  env.voice.revokeConsent();
  approve(true);
  assert.equal(await starting, false);
  assert.equal(env.starts, 0);
  env.voice.dispose();
});

test('consentMode session asks once per purpose/engine instead of per utterance, and clears on sensors_stopped or revokeConsent', async () => {
  let consentCalls = 0;
  const env = setup({
    consentMode: 'session',
    consent() { consentCalls++; return true; },
  });
  assert.equal(await env.voice.startWake({ phrase: 'Hey agent', mode: 'local' }), true);
  env.voice.stopWake();
  // Second start in same session reuses approval without re-prompting.
  assert.equal(await env.voice.startWake({ phrase: 'Hey agent', mode: 'local' }), true);
  assert.equal(consentCalls, 1);
  // Stop sensors revokes session grants.
  env.emit('sensors_stopped', { count: 1 });
  assert.equal(await env.voice.startWake({ phrase: 'Hey agent', mode: 'local' }), true);
  assert.equal(consentCalls, 2);
  // Explicit revokeConsent clears session grants too.
  env.voice.stopWake();
  env.voice.revokeConsent();
  assert.equal(await env.voice.startWake({ phrase: 'Hey agent', mode: 'local' }), true);
  assert.equal(consentCalls, 3);
  env.voice.dispose();
});
