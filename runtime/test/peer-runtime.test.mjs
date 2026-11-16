import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { build } from 'esbuild';

const compiled = await build({ entryPoints: [new URL('../src/kernel.ts', import.meta.url).pathname],
  bundle: true, format: 'iife', globalName: 'Kernel', platform: 'browser', write: false });
const bootstrap = await build({ entryPoints: [new URL('../src/index.ts', import.meta.url).pathname],
  bundle: true, format: 'iife', target: 'es2022', minify: true, platform: 'browser', write: false });
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
const plain = value => JSON.parse(JSON.stringify(value));

function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
}

function backend() {
  const operations = new Map();
  const submit = async (program, { operationId }) => {
    if (!operations.has(operationId)) operations.set(operationId, { operationId, proposalId: `proposal:${operationId}`,
      status: 'final', outcome: 'accepted', program: structuredClone(program) });
    return operations.get(operationId);
  };
  return { id: 'history-one', capabilities: ['events'], submit,
    readView: () => ({ revision: 'one', query: () => [...operations.keys()], readEvents: async () => ({}), release() {} }),
    events: { publish: (topic, payload, options) => submit({ topic, payload }, options), read: async () => ({}), async *subscribe() {} },
    operations: { get: id => operations.get(id), async *subscribe({ operationId }) { yield operations.get(operationId); } },
  };
}

class Element extends EventTarget {
  constructor(tagName) { super(); this.tagName = tagName; this.style = {}; this.children = []; this.attributes = new Map(); this.parentNode = null; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  append(...children) { for (const child of children) { child.remove(); child.parentNode = this; this.children.push(child); } }
  remove() { if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; }
  attachShadow() { return this.shadowRoot = new Element('shadow-root'); }
}

function environment({ defaultEntry = false } = {}) {
  const calls = { fetch: [], sockets: 0, stores: 0, registrations: 0, publications: [] };
  let nextTimer = 0;
  const timers = new Map(), intervals = new Map();
  const window = Object.assign(new EventTarget(), { isSecureContext: true, Notification: { permission: 'granted' }, PushManager: class {} });
  const observers = new Set();
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible', readyState: 'complete',
    body: new Element('body'), documentElement: new Element('html'), createElement: tag => new Element(tag) });
  document.documentElement.append(document.body);
  const publication = { id: '1', base: '/page/_publications/1/', entry: 'app.html',
    assets: [{ path: 'app.html', type: 'text/html', sha256: 'a'.repeat(64) }], runtime: { base: '/runtime/' } };
  const registration = { scope: 'https://fixture.test/page/', active: { postMessage(message, ports) {
    calls.publications.push(message);
    if (ports) queueMicrotask(() => ports[0].other.onmessage?.({ data: { t: 'publication', id: publication.id, status: 'ready' } }));
  } } };
  const serviceWorker = Object.assign(new EventTarget(), {
    async register() { calls.registrations++; return registration; },
    async getRegistration() { return registration; }, ready: Promise.resolve(registration),
  });
  const context = { window, document, URL, TextEncoder, Uint8Array, ArrayBuffer, AbortController, Response, Blob,
    location: new URL('https://fixture.test/page/_publications/1/app.html'),
    navigator: { userAgent: 'Fixture', onLine: true, serviceWorker }, screen: {},
    localStorage: storage(), sessionStorage: storage(), crypto: webcrypto, queueMicrotask,
    Notification: window.Notification, console: { log() {}, info() {}, warn() {}, error() {} },
    setTimeout(fn, ms) { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval(fn, ms) { const id = ++nextTimer; intervals.set(id, { fn, ms }); return id; },
    clearInterval(id) { intervals.delete(id); },
    WebSocket: class { constructor() { calls.sockets++; throw Error('Page host is unreachable'); } },
    indexedDB: { open() { calls.stores++; throw Error('Host outbox must not be opened'); } },
    async fetch(url, options) { calls.fetch.push({ url, options }); return new Response(JSON.stringify({ explicit: true })); },
    MessageChannel: class {
      constructor() {
        this.port1 = { close() {} }; this.port2 = { close() {} };
        this.port1.other = this.port2; this.port2.other = this.port1;
      }
    },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; }
      observe() { observers.add(this); }
      disconnect() { observers.delete(this); }
    },
  };
  const configuration = { id: 'page', base: '/page/', version: 1, documentPath: 'app.html', publication,
    ws: '/page/_tendril/ws', application: { kind: 'peer', id: 'history-one' },
    features: { push: true, vapid: 'AAAA', shared_by: 'Fixture', speech: null } };
  let api;
  if (defaultEntry) {
    window.__TENDRIL__ = configuration;
    runInNewContext(bootstrap.outputFiles[0].text, context); api = window.tendril;
  } else {
    runInNewContext(compiled.outputFiles[0].text, context); api = context.Kernel.startRuntime(configuration);
  }
  return { api, context, calls, window, document,
    mutate() { for (const observer of observers) observer.callback(); },
    reloadScript() { runInNewContext(bootstrap.outputFiles[0].text, context); },
    async advance() {
      for (const [id, { fn }] of [...timers]) { timers.delete(id); fn(); }
      for (const { fn } of intervals.values()) fn();
      await flush();
    },
  };
}

test('a peer runtime operates with no host connection, host outbox, background fetch or diagnostics', async () => {
  const env = environment();
  assert.equal(env.api.connected, false);
  const installed = backend(); env.api.application.install(installed);
  assert.equal(await env.api.application.ready(), installed); await flush();
  assert.equal(env.api.connected, true, 'connected means the selected backend is installed, independently of host reachability');
  const first = await installed.submit({ value: 'original' }, { operationId: 'edit' });
  assert.equal(await installed.submit({ value: 'original' }, { operationId: 'edit' }), first);
  await installed.events.publish('messages', 'offline-host', { operationId: 'message' });
  assert.deepEqual(installed.readView().query(), ['edit', 'message']);
  assert.equal(installed.operations.get('edit').status, 'final');
  env.api.ready(); env.api.ready.manual();
  env.context.console.error('application-local diagnostic');
  for (const type of ['load', 'online', 'offline', 'pagehide']) env.window.dispatchEvent(new Event(type));
  env.window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
  env.document.dispatchEvent(new Event('visibilitychange'));
  env.window.addEventListener('devicemotion', () => {});
  for (let i = 0; i < 3; i++) await env.advance();
  assert.deepEqual(plain(env.api.sensors.status().active), ['motion']);
  assert.deepEqual(plain(env.api.pendingWork()), { events: 0, state: 0, captures: 0, timers: 0 });
  assert.equal(env.api.notifications.available, false);
  assert.deepEqual(env.calls, { fetch: [], sockets: 0, stores: 0, registrations: 0, publications: [] });
});

test('the served bootstrap mounts working management and sensor controls without touching hosted application services', async () => {
  const env = environment({ defaultEntry: true });
  assert.equal(env.window.tendril, env.api);
  const host = env.document.body.children.find(element => element.tagName === 'tendril-utility');
  assert.ok(host, 'the complete default entry must mount its operational utility');
  const nav = host.shadowRoot.children.find(element => element.tagName === 'nav');
  const link = nav.children.find(element => element.tagName === 'a');
  const indicator = nav.children.find(element => element.tagName === 'span');
  const stop = nav.children.find(element => element.tagName === 'button');
  assert.equal(link.textContent, 'Manage page');
  assert.equal(link.href, 'https://fixture.test/page/_tendril/manage');
  assert.equal(link.target, '_blank');
  assert.equal(link.rel, 'noopener');
  assert.equal(stop.hidden, true);

  env.api.application.install(backend()); await env.api.application.ready();
  env.window.addEventListener('devicemotion', () => {});
  await env.advance();
  assert.equal(indicator.textContent, 'Motion active');
  assert.equal(stop.hidden, false);
  stop.dispatchEvent(new Event('click')); await env.advance();
  assert.deepEqual(plain(env.api.sensors.status()), { active: [], pending: [] });
  assert.equal(stop.hidden, true);

  host.remove(); env.mutate();
  assert.equal(host.parentNode, env.document.body, 'page DOM replacement cannot remove sensor cancellation');
  env.reloadScript();
  assert.equal(env.document.body.children.filter(element => element.tagName === 'tendril-utility').length, 1);
  for (const type of ['load', 'online', 'offline', 'pagehide']) env.window.dispatchEvent(new Event(type));
  env.window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
  env.document.dispatchEvent(new Event('visibilitychange'));
  for (let i = 0; i < 3; i++) await env.advance();
  assert.deepEqual(env.calls, { fetch: [], sockets: 0, stores: 0, registrations: 0, publications: [] });
});

test('peer host operations remain explicit and publication saving registers offline support on demand', async () => {
  const env = environment(); await flush();
  assert.deepEqual(plain(await env.api.request('members')), { explicit: true });
  assert.equal(env.calls.fetch.length, 1);
  assert.equal(env.calls.fetch[0].url, '/page/_tendril/members');
  assert.equal(env.calls.fetch[0].options.credentials, 'same-origin');
  assert.equal(env.calls.registrations, 0);
  assert.deepEqual(plain(await env.api.publication.saveOffline()), { id: '1', status: 'ready' });
  assert.deepEqual(plain(await env.api.publication.saveOffline()), { id: '1', status: 'ready' });
  assert.equal(env.calls.registrations, 1, 'one explicit registration is shared by later save requests');
  assert.equal(env.calls.sockets, 0); assert.equal(env.calls.stores, 0);
});

test('peer pages reject hosted application and upload work instead of creating another queue', async () => {
  const env = environment();
  for (const method of [() => env.api.send({ value: 1 }), () => env.api.upload(new Blob(['local'])),
    () => env.api.uploadEvent(new Blob(['local']), {}), () => env.api.setBlobRetention('b_' + 'a'.repeat(20), { keep: true })])
    await assert.rejects(method, { code: 'application_backend' });
  for (const method of [() => env.api.state.apply([]), () => env.api.streams.read('events'),
    () => env.api.records.head(), () => env.api.scopes.list(), () => env.api.timers.list()])
    assert.throws(method, { code: 'application_backend' });
  assert.equal(env.calls.fetch.length, 0); assert.equal(env.calls.sockets, 0); assert.equal(env.calls.stores, 0);
});
