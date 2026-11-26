import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { shareOrDownloadFile } from '../../docs/tutorial/shared/helpers/mobile-media.mjs';

const layoutBundle = await build({
  entryPoints: [new URL('../src/utility-layout.ts', import.meta.url).pathname],
  bundle: true, format: 'iife', globalName: 'Layout', platform: 'browser', write: false,
});
const outputBundle = await build({
  entryPoints: [new URL('../src/voice/output.ts', import.meta.url).pathname],
  bundle: true, format: 'iife', globalName: 'VoiceOutput', platform: 'browser', write: false,
});
const shareBundle = await build({
  entryPoints: [new URL('../src/share-target.ts', import.meta.url).pathname],
  bundle: true, format: 'iife', globalName: 'ShareTarget', platform: 'browser', write: false,
});
const captureBundle = await build({
  entryPoints: [new URL('../src/voice/capture.ts', import.meta.url).pathname],
  bundle: true, format: 'iife', globalName: 'VoiceCapture', platform: 'browser', write: false,
});

test('observeVisualViewport publishes and restores viewport and keyboard CSS properties', () => {
  const props = new Map();
  const style = {
    getPropertyValue: name => props.get(name) ?? '',
    getPropertyPriority: () => '',
    setProperty: (name, value) => props.set(name, value),
    removeProperty: name => props.delete(name),
  };
  const vv = Object.assign(new EventTarget(), { height: 800, offsetTop: 0 });
  const ctx = {
    window: { innerHeight: 800, visualViewport: vv },
    document: { documentElement: { style } },
  };
  runInNewContext(layoutBundle.outputFiles[0].text, ctx);

  const observed = [];
  const dispose = ctx.Layout.observeVisualViewport(m => observed.push(m));
  assert.equal(props.get('--tendril-viewport-height'), '800px');
  assert.equal(props.get('--tendril-keyboard-height'), '0px');

  vv.height = 480;
  vv.dispatchEvent(new Event('resize'));
  assert.equal(props.get('--tendril-viewport-height'), '480px');
  assert.equal(props.get('--tendril-keyboard-height'), '320px');
  assert.deepEqual(JSON.parse(JSON.stringify(observed.at(-1))), { viewportHeight: 480, keyboardHeight: 320 });

  dispose();
  assert.equal(props.has('--tendril-viewport-height'), false);
  assert.equal(props.has('--tendril-keyboard-height'), false);
});

test('createSpeechOutput sets Media Session metadata & handlers only while speaking and clears them on stop', async () => {
  const handlers = new Map();
  const mediaSession = {
    metadata: null,
    playbackState: 'none',
    setActionHandler(action, fn) { handlers.set(action, fn); },
  };
  class MediaMetadata { constructor(init) { Object.assign(this, init); } }
  const utterances = [];
  const speechSynthesis = {
    speaking: false,
    speak(u) { utterances.push(u); this.speaking = true; },
    cancel() { this.speaking = false; },
  };
  class SpeechSynthesisUtterance { constructor(text) { this.text = text; } }
  const win = Object.assign(new EventTarget(), { speechSynthesis });
  const doc = Object.assign(new EventTarget(), { title: 'My App' });
  const ctx = {
    window: win, document: doc, navigator: { language: 'en-US', mediaSession },
    MediaMetadata, SpeechSynthesisUtterance, URL, location: new URL('https://app.test/'),
    setTimeout, clearTimeout, Promise, DOMException, AbortController,
  };
  runInNewContext(outputBundle.outputFiles[0].text, ctx);

  let pref = { voice: 'browser', audio: true, language: 'en-US' };
  const prefs = { get: () => pref, update: patch => { pref = { ...pref, ...patch }; }, on: () => () => {} };
  const events = [];
  const output = ctx.VoiceOutput.createSpeechOutput('https://app.test/', { on: () => () => {}, emit: (t, v) => events.push([t, v]) }, prefs, undefined, {
    title: 'Kitchen Helper',
    artworkUrl: 'https://app.test/_tendril/icon.svg',
  });

  // Idle before speaking: Media Session untouched
  assert.equal(mediaSession.metadata, null);
  assert.equal(mediaSession.playbackState, 'none');

  output.speak('Timer is done.');
  await new Promise(r => setTimeout(r, 10));
  assert.equal(mediaSession.playbackState, 'playing');
  assert.equal(mediaSession.metadata.title, 'Kitchen Helper');
  assert.equal(typeof handlers.get('pause'), 'function');
  assert.equal(typeof handlers.get('stop'), 'function');

  // Calling pause handler stops playback and clears handlers so music apps resume cleanly.
  handlers.get('pause')();
  assert.equal(mediaSession.playbackState, 'none');
  assert.equal(handlers.get('pause'), null);
  assert.equal(handlers.get('stop'), null);
  output.dispose();
});

test('createShareTarget consumes and deletes staged cache entry and strips _shared from URL', async () => {
  const store = new Map();
  const cache = {
    async match(key) { return store.get(key); },
    async delete(key) { store.delete(key); return true; },
  };
  const scope = 'https://app.test/p/';
  const id = '0123456789abcdef';
  const base = `${scope}_tendril/share-inbox/${id}`;
  store.set(`${base}/meta.json`, new Response(JSON.stringify({
    title: 'Article', text: 'Check this out', url: 'https://example.org',
    files: [{ name: 'note.txt', type: 'text/plain', index: 0 }],
    expiresAt: Date.now() + 60_000,
  })));
  store.set(`${base}/file-0`, new Response('hello shared file', { headers: { 'Content-Type': 'text/plain' } }));

  let replacedUrl = null;
  const ctx = {
    URL, File, Response, Blob, Promise, queueMicrotask,
    location: new URL(`${scope}?_shared=${id}&view=inbox`),
    history: { state: null, replaceState: (_s, _t, u) => { replacedUrl = u; } },
    caches: { async open() { return cache; } },
  };
  runInNewContext(shareBundle.outputFiles[0].text, ctx);

  const shareTarget = ctx.ShareTarget.createShareTarget(scope);
  const payload = await shareTarget.consume();
  assert.equal(payload.title, 'Article');
  assert.equal(payload.text, 'Check this out');
  assert.equal(payload.url, 'https://example.org');
  assert.equal(payload.files.length, 1);
  assert.equal(payload.files[0].name, 'note.txt');
  assert.equal(await payload.files[0].text(), 'hello shared file');
  assert.equal(replacedUrl, `${scope}?view=inbox`);
  assert.equal(store.size, 0);
  // Consumed once only
  assert.equal(await shareTarget.consume(), null);
});

test('shareOrDownloadFile uses native file share when available and falls back to download', async () => {
  const origNav = globalThis.navigator;
  const origDoc = globalThis.document;
  try {
    const shared = [];
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        canShare: ({ files }) => Array.isArray(files) && files.length === 1,
        share: async data => { shared.push(data); },
      },
    });
    const res1 = await shareOrDownloadFile(new Blob(['csv,data'], { type: 'text/csv' }), { filename: 'report.csv', title: 'Report' });
    assert.equal(res1.method, 'share');
    assert.equal(shared.length, 1);
    assert.equal(shared[0].files[0].name, 'report.csv');

    // AbortError reports cancelled without falling back to download
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        canShare: () => true,
        share: async () => { throw new DOMException('Cancelled', 'AbortError'); },
      },
    });
    const res2 = await shareOrDownloadFile(new Blob(['x']), { filename: 'a.txt' });
    assert.equal(res2.method, 'cancelled');

    // Desktop fallback without navigator.share creates and clicks <a download>
    let clicked = null;
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        body: { append() {} },
        createElement: tag => ({
          tag, style: {},
          click() { clicked = { download: this.download, href: this.href }; },
          remove() {},
        }),
      },
    });
    const res3 = await shareOrDownloadFile(new Blob(['hello']), { filename: 'notes.txt' });
    assert.equal(res3.method, 'download');
    assert.equal(clicked.download, 'notes.txt');
    assert.ok(clicked.href.startsWith('blob:'));
  } finally {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: origNav });
    if (origDoc === undefined) delete globalThis.document;
    else Object.defineProperty(globalThis, 'document', { configurable: true, value: origDoc });
  }
});

test('classifyCaptureError turns opaque platform microphone errors into actionable stage-specific diagnostics', () => {
  const ctx = {};
  runInNewContext(captureBundle.outputFiles[0].text, ctx);
  const { classifyCaptureError } = ctx.VoiceCapture;
  const firefoxAndroidErr = Object.assign(new Error('The request is not allowed by the user agent or the platform in the current context.'), { name: 'NotAllowedError' });
  const deniedMsg = classifyCaptureError(firefoxAndroidErr, 'microphone_permission', 'denied');
  assert.match(deniedMsg, /NotAllowedError/);
  assert.match(deniedMsg, /site settings/i);
  assert.match(deniedMsg, /device app permissions/i);

  const promptBlockedMsg = classifyCaptureError(firefoxAndroidErr, 'microphone_permission', 'prompt');
  assert.match(promptBlockedMsg, /NotAllowedError/);
  assert.match(promptBlockedMsg, /If no prompt appeared/i);

  assert.match(classifyCaptureError(Object.assign(new Error('insecure'), { name: 'SecurityError' }), 'microphone_permission'), /HTTPS|policy/i);
  assert.match(classifyCaptureError(Object.assign(new Error('missing'), { name: 'NotFoundError' }), 'microphone_permission'), /No microphone/i);
  assert.match(classifyCaptureError(Object.assign(new Error('busy'), { name: 'NotReadableError' }), 'microphone_permission'), /busy|another app/i);
  assert.match(classifyCaptureError(Object.assign(new Error('interrupted'), { name: 'AbortError' }), 'microphone_permission'), /interrupted/i);
});
