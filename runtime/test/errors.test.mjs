import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const built = await build({
  entryPoints: [new URL('../src/errors.ts', import.meta.url).pathname],
  bundle: true,
  format: 'iife',
  globalName: 'Errors',
  platform: 'browser',
  write: false,
});

function createEnv() {
  const storage = new Map();
  const window = new EventTarget();
  const context = {
    window,
    sessionStorage: {
      getItem: k => storage.get(k) ?? null,
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: k => storage.delete(k),
    },
    crypto,
    ErrorEvent: class ErrorEvent extends Event {
      constructor(type, init = {}) {
        super(type);
        this.message = init.message ?? '';
        this.filename = init.filename ?? '';
        this.lineno = init.lineno ?? 0;
        this.colno = init.colno ?? 0;
        this.error = init.error ?? null;
      }
    },
  };
  runInNewContext(built.outputFiles[0].text, context);
  return { createErrorTracker: context.Errors.createErrorTracker, window, storage, ErrorEvent: context.ErrorEvent };
}

test('error tracker captures window errors, unhandled rejections, reports, redacts tokens, and persists across reload', () => {
  const env = createEnv();
  const recorded = [];
  const tracker = env.createErrorTracker('page-1', entry => recorded.push(entry));
  const received = [];
  const off = tracker.api.on(entry => received.push(entry));

  env.window.dispatchEvent(new env.ErrorEvent('error', {
    message: 'Request failed with Bearer secret-jwt-token-123',
    filename: 'https://example.test/app.js?token=abc123&ok=1',
    lineno: 42,
    colno: 7,
  }));
  const rej = new Event('unhandledrejection');
  rej.reason = new Error('Boom ?code=xyz999');
  env.window.dispatchEvent(rej);
  tracker.api.report(new Error('Manual report'), 'dashboard-card');

  const list = tracker.api.list();
  assert.equal(list.length, 3);
  assert.equal(recorded.length, 3);
  assert.equal(received.length, 3);
  assert.equal(list[0].kind, 'error');
  assert.match(list[0].message, /Bearer \[redacted\]/);
  assert.doesNotMatch(list[0].message, /secret-jwt-token-123/);
  assert.match(list[0].source, /token=\[redacted\]/);
  assert.equal(list[0].line, 42);
  assert.equal(list[1].kind, 'unhandledrejection');
  assert.match(list[1].message, /code=\[redacted\]/);
  assert.equal(list[2].kind, 'report');
  assert.equal(list[2].context, 'dashboard-card');

  off();
  tracker.dispose();

  // Reopen in same tab session: buffered errors survive reload.
  const reloaded = env.createErrorTracker('page-1');
  assert.equal(reloaded.api.list().length, 3);
  reloaded.api.clear();
  assert.equal(reloaded.api.list().length, 0);
  reloaded.dispose();
});

test('error tracker bounds ring buffer to 30 entries', () => {
  const env = createEnv();
  const tracker = env.createErrorTracker('page-bound');
  for (let i = 0; i < 45; i++) tracker.api.report(`error-${i}`);
  const list = tracker.api.list();
  assert.equal(list.length, 30);
  assert.equal(list[0].message, 'error-15');
  assert.equal(list[29].message, 'error-44');
  tracker.dispose();
});
