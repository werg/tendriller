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
test('a valid registration can activate later and announce on reconnect or worker requests', async () => {
  const messages = [], saved = { active: null, waiting: null, installing: null };
  const env = registrations(async () => saved); await tick();
  assert.equal(env.protocol.size, 1); assert.equal(env.browser.size, 2); assert.equal(messages.length, 0);
  saved.active = { postMessage(message) { messages.push(message); } };
  env.protocol.get('welcome')(); env.browser.get('controllerchange')();
  env.browser.get('message')({ data: { t: 'publication_request' } });
  assert.equal(messages.length, 3); assert.ok(messages.every(message => message.publication === env.publication));
  assert.equal(env.reports.length, 0);
});
