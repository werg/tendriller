import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
const compiled = await build({ entryPoints: [new URL('../src/kernel.ts', import.meta.url).pathname], bundle: true, format: 'iife', globalName: 'Kernel', platform: 'browser', metafile: true, write: false });
test('the headless kernel imports no presentation, voice, domain rules or Node tools', () => {
  const forbidden = /(?:\/control\/|\/voice\/|\/rules\.|\/tools\/|phonon-tts|qrcode-generator)/;
  for (const input of Object.keys(compiled.metafile.inputs)) assert.equal(forbidden.test(input), false, input);
});
test('importing the kernel works without browser globals and performs no mounting or permissions', () => {
  const context = {};
  runInNewContext(compiled.outputFiles[0].text, context);
  assert.equal(typeof context.Kernel.startRuntime, 'function');
  assert.deepEqual(Object.keys(context).sort(), ['Kernel']);
});

const publication = {
  id: '7', base: '/page/_publications/7/', entry: 'app.html',
  runtime: { version: 'fixture', base: '/runtime/' },
  assets: ['app.html', 'index.html', 'notes #1?/café 100%/review.html'].map(path => ({ path, type: 'text/html', sha256: 'a'.repeat(64) })),
};
const configuration = { id: 'page', base: '/page/', version: 7, application: { id: '12'.repeat(32) },
  features: { shared_by: 'Fixture', speech: null }, publication, documentPath: 'app.html' };
test('startup rejects missing or undeclared document context before browser side effects', () => {
  const context = {};
  runInNewContext(compiled.outputFiles[0].text, context);
  for (const documentPath of [undefined, null, 'missing.html', '../app.html'])
    assert.throws(() => context.Kernel.startRuntime({ ...configuration, documentPath }), /documentPath must identify/);
  for (const entry of [undefined, 'missing.html'])
    assert.throws(() => context.Kernel.startRuntime({ ...configuration, publication: { ...publication, entry } }), /canonical declared HTML entry/);
  assert.throws(() => context.Kernel.startRuntime({ ...configuration, publication: undefined }), /documentPath: null/);
  const script = { path: 'app.js', type: 'text/javascript', sha256: 'a'.repeat(64) };
  assert.throws(() => context.Kernel.startRuntime({ ...configuration, documentPath: script.path,
    publication: { ...publication, assets: [...publication.assets, script] } }), /documentPath must identify/);
});
test('startup keeps the page URL so reloads and new tabs open the latest release; only a /_publications/ URL pins', () => {
  for (const documentPath of ['index.html', 'notes #1?/café 100%/review.html']) {
    const rewritten = [], stop = new Error('stop before connecting the core');
    const context = { URL, location: new URL('https://fixture.test/page/?review=1#draft'),
      history: { state: { draft: true }, replaceState(state, title, url) { rewritten.push(url); } } };
    // A non-browser policy is inert; sensor bootstrap is the deliberate boundary.
    context.navigator = {};
    context.window = { get MediaStreamTrack() { throw stop; } };
    runInNewContext(compiled.outputFiles[0].text, context);
    assert.throws(() => context.Kernel.startRuntime({ ...configuration, documentPath }), error => error === stop);
    assert.deepEqual(rewritten, [], 'The address bar is not pinned to the release that happened to load.');
    assert.equal(publication.entry, 'app.html');
  }
});

// Expose only this internal lifecycle to the VM; the shipped kernel still exports
// startRuntime alone. Exercise registration and later browser/protocol callbacks.
const registration = await build({ stdin: {
  contents: await readFile(new URL('../src/kernel.ts', import.meta.url), 'utf8') + '\nexport { registerServiceWorker };',
  resolveDir: new URL('../src/', import.meta.url).pathname, loader: 'ts',
}, bundle: true, format: 'iife', globalName: 'Registration', platform: 'browser', write: false });
const tick = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function registrations(register) {
  const protocol = new Map(), browser = new Map(), reports = [];
  const context = { navigator: { serviceWorker: { register, addEventListener(type, listener) { browser.set(type, listener); } } },
    document: { readyState: 'complete' }, window: {}, setTimeout: fn => fn(), console: { info: (...args) => reports.push(args) } };
  runInNewContext(registration.outputFiles[0].text, context);
  const publication = { id: 'saved-page' };
  context.Registration.registerServiceWorker({ id: 'page', base: '/page/', publication }, { bus: { on(type, listener) { protocol.set(type, listener); } } });
  return { protocol, browser, reports, publication };
}
test('unavailable registration leaves no welcome or browser callbacks to fail later', async () => {
  for (const register of [async () => undefined, async () => null, async () => { throw Error('blocked'); }, () => { throw Error('not available'); }]) {
    const env = registrations(register); await tick();
    assert.equal(env.protocol.size, 0); assert.equal(env.browser.size, 0);
    assert.doesNotThrow(() => env.protocol.get('welcome')?.());
    assert.doesNotThrow(() => env.browser.get('controllerchange')?.());
  }
});
test('a valid registration announces after controller activation or an explicit worker request', async () => {
  const messages = [], saved = { active: null, waiting: null, installing: null };
  const env = registrations(async () => saved); await tick();
  assert.equal(env.protocol.size, 0); assert.equal(env.browser.size, 2); assert.equal(messages.length, 0);
  saved.active = { postMessage(message) { messages.push(message); } };
  env.browser.get('controllerchange')();
  env.browser.get('message')({ data: { t: 'publication_request' } });
  assert.equal(messages.length, 2); assert.ok(messages.every(message => message.publication === env.publication));
  assert.equal(env.reports.length, 0);
});
