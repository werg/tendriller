import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const compiled = await build({ entryPoints: [new URL('../src/installation.ts', import.meta.url).pathname],
  bundle: true, format: 'iife', globalName: 'Installation', platform: 'browser', write: false });
const plain = value => JSON.parse(JSON.stringify(value));

function environment(options = {}) {
  const calls = { prompts: 0, requests: 0, writes: 0 }, listeners = new Map();
  class Browser extends EventTarget {
    addEventListener(type, listener) {
      super.addEventListener(type, listener);
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    }
    removeEventListener(type, listener) { super.removeEventListener(type, listener); listeners.get(type)?.delete(listener); }
  }
  const display = Object.assign(new EventTarget(), { matches: options.standalone ?? false });
  const window = Object.assign(new Browser(), { isSecureContext: options.secure ?? true,
    matchMedia: options.noMatchMedia ? undefined : query => options.fullscreenOnly
      ? Object.assign(new EventTarget(), { matches: query.includes('(display-mode: fullscreen)') }) : display });
  window.self = window; window.top = options.framed ? {} : window;
  const navigator = { userAgent: options.userAgent ?? 'Mozilla/5.0 (Linux; Android 15)',
    platform: options.platform ?? '', maxTouchPoints: options.maxTouchPoints ?? 0,
    standalone: options.appleStandalone ?? false,
    serviceWorker: { register() { calls.requests++; throw Error('must not register'); } } };
  const context = { window, navigator, setTimeout,
    fetch() { calls.requests++; throw Error('must not fetch'); },
    localStorage: { setItem() { calls.writes++; throw Error('must not write'); } } };
  runInNewContext(compiled.outputFiles[0].text, context);
  const controller = context.Installation.createInstallation(), reports = [];
  controller.api.on(value => reports.push(plain(value)));
  function offer({ outcome = 'accepted', choice, prompt } = {}) {
    const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
      userChoice: choice ?? Promise.resolve({ outcome }),
      prompt() { calls.prompts++; return prompt ? prompt() : Promise.resolve(); },
    });
    window.dispatchEvent(event);
    return event;
  }
  return { ...controller, window, navigator, display, reports, calls, listeners, offer,
    displayMode(value) { display.matches = value; display.dispatchEvent(new Event('change')); } };
}

test('the controller imports without browser globals and starts with no network, storage or native prompt', () => {
  const context = {};
  runInNewContext(compiled.outputFiles[0].text, context);
  assert.equal(typeof context.Installation.createInstallation, 'function');
  const env = environment();
  assert.deepEqual(plain(env.api.status()), { state: 'manual', platform: 'android' });
  assert.deepEqual(env.calls, { prompts: 0, requests: 0, writes: 0 });
  assert.equal(Object.isFrozen(env.api), true);
});

test('only an available browser event enables prompting and each event is consumed exactly once', async () => {
  const env = environment();
  assert.equal(await env.api.prompt(), 'unavailable');
  const event = env.offer();
  assert.equal(event.defaultPrevented, true);
  assert.equal(env.api.status().state, 'available');
  const pending = env.api.prompt();
  assert.equal(env.calls.prompts, 1, 'prompt must run synchronously in the user gesture');
  assert.equal(env.api.status().state, 'manual');
  assert.equal(await env.api.prompt(), 'unavailable');
  assert.equal(await pending, 'accepted');
  assert.equal(env.api.status().state, 'manual', 'acceptance does not confirm a completed install');
  assert.equal(env.calls.prompts, 1);
  env.window.dispatchEvent(new Event('appinstalled'));
  assert.equal(env.api.status().state, 'installed');
  assert.deepEqual(env.reports.map(value => value.state), ['available', 'manual', 'installed']);
  assert.equal(env.calls.requests, 0);
});

test('dismissed prompts remain manual until a fresh browser event arrives', async () => {
  const env = environment();
  env.offer({ outcome: 'dismissed' });
  assert.equal(await env.api.prompt(), 'dismissed');
  assert.equal(env.api.status().state, 'manual');
  assert.equal(await env.api.prompt(), 'unavailable');
  env.offer();
  assert.equal(env.api.status().state, 'available');
  assert.equal(await env.api.prompt(), 'accepted');
  assert.equal(env.calls.prompts, 2);
});

test('synchronous prompt errors, rejected prompts and rejected choices are contained without reusing the event', async () => {
  for (const options of [
    { prompt() { throw Error('activation expired'); } },
    { prompt() { return Promise.reject(Error('blocked')); } },
    { choice: Promise.reject(Error('choice failed')) },
  ]) {
    const env = environment(); env.offer(options);
    assert.equal(await env.api.prompt(), 'unavailable');
    assert.equal(env.api.status().state, 'manual');
    assert.equal(await env.api.prompt(), 'unavailable');
    assert.equal(env.calls.prompts, 1);
  }
});

test('installation through browser UI and standalone display changes suppress promotion', async () => {
  const env = environment(); env.offer();
  env.displayMode(true);
  assert.equal(env.api.status().state, 'installed');
  assert.equal(await env.api.prompt(), 'unavailable');
  env.displayMode(false);
  assert.equal(env.api.status().state, 'manual');
  env.window.dispatchEvent(new Event('appinstalled'));
  const event = env.offer();
  assert.equal(event.defaultPrevented, false);
  assert.equal(env.api.status().state, 'installed');
  assert.equal(env.calls.prompts, 0);
});

test('ordinary fullscreen browsing is not proof that the page is installed', async () => {
  const env = environment({ fullscreenOnly: true });
  assert.equal(env.api.status().state, 'manual');
  env.offer();
  assert.equal(env.api.status().state, 'available');
  assert.equal(await env.api.prompt(), 'accepted');
  assert.equal(env.api.status().state, 'manual');
});

test('Apple devices including iPad desktop mode get manual instructions and standalone detection', () => {
  for (const options of [
    { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X)' },
    { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)', platform: 'MacIntel', maxTouchPoints: 5 },
  ]) {
    assert.deepEqual(plain(environment(options).api.status()), { state: 'manual', platform: 'ios' });
    assert.deepEqual(plain(environment({ ...options, appleStandalone: true }).api.status()), { state: 'installed', platform: 'ios' });
  }
  assert.equal(environment({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)', platform: 'MacIntel' }).api.status().platform, 'desktop');
  assert.equal(environment({ noMatchMedia: true }).api.status().state, 'manual');
});

test('insecure and embedded pages do not capture browser installation events', async () => {
  for (const options of [{ secure: false }, { framed: true }]) {
    const env = environment(options), event = env.offer();
    assert.equal(env.api.status().state, 'unavailable');
    assert.equal(event.defaultPrevented, false);
    assert.equal(await env.api.prompt(), 'unavailable');
    assert.equal(env.calls.prompts, 0);
  }
});

test('BFCache suspension drops stale prompt events and resumption reattaches only once', async () => {
  const env = environment(); env.offer();
  env.suspend(); env.suspend();
  assert.equal(env.listeners.get('beforeinstallprompt').size, 0);
  assert.equal(env.listeners.get('appinstalled').size, 0);
  assert.equal(env.api.status().state, 'manual');
  const count = env.reports.length;
  env.offer(); env.displayMode(true);
  assert.equal(env.reports.length, count, 'suspended state must not notify UI observers');
  env.resume(); env.resume();
  assert.equal(env.listeners.get('beforeinstallprompt').size, 1);
  assert.equal(env.listeners.get('appinstalled').size, 1);
  assert.equal(env.api.status().state, 'installed');
  assert.equal(env.reports.at(-1).state, 'installed');
  assert.equal(await env.api.prompt(), 'unavailable');
});

test('subscriptions can detach and status snapshots cannot mutate controller state', () => {
  const env = environment(), first = [], second = [];
  const off = env.api.on(value => { first.push(value); value.state = 'installed'; });
  env.api.on(value => second.push(value.state));
  env.offer();
  assert.equal(env.api.status().state, 'available');
  assert.deepEqual(second, ['available']);
  env.api.status().state = 'unavailable';
  assert.equal(env.api.status().state, 'available');
  off(); env.window.dispatchEvent(new Event('appinstalled'));
  assert.equal(first.length, 1);
  assert.deepEqual(second, ['available', 'installed']);
});
