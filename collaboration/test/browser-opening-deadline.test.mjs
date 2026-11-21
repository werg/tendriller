import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { openBrowserOwner } from '../browser.mjs';

function fixture(t) {
  const names = ['navigator', 'location', 'SharedWorker', 'performance', 'setTimeout', 'clearTimeout'];
  const saved = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const realTimeout = globalThis.setTimeout, realClear = globalThis.clearTimeout;
  let now = 0, next = 0, grant, started, workers = 0, held = 0;
  const pending = new Promise(resolve => { started = resolve; });
  const timers = new Map();
  const locks = { async query() { return { held: [], pending: [] }; }, request(_name, _options, run) {
    return new Promise((resolve, reject) => {
      grant = async () => { held++; try { const value = await run({}); resolve(value); }
        catch (error) { reject(error); throw error; } finally { held--; } };
      started();
    });
  } };
  class Port extends EventTarget { start() {} close() {} postMessage() {} }
  class Worker extends EventTarget { constructor() { super(); workers++; this.port = new Port(); } }
  const values = { navigator: { locks }, location: new URL('https://opening.test/'), SharedWorker: Worker,
    performance: { now: () => now }, setTimeout: (run, ms) => {
      const id = ++next; timers.set(id, { at: now + ms, run }); return id;
    }, clearTimeout: id => timers.delete(id) };
  for (const [name, value] of Object.entries(values)) Object.defineProperty(globalThis, name, { configurable: true, value });
  t.after(() => { for (const [name, value] of saved) {
    if (value) Object.defineProperty(globalThis, name, value); else delete globalThis[name];
  } });
  return { pending, grant: () => grant(), get workers() { return workers; }, get held() { return held; },
    options: { workerUrl: 'https://opening.test/worker.mjs', profileId: 'retained', timeoutMs: 100,
      applicationId: 'a'.repeat(64), definitionId: 'opening', definitionVersion: '1' },
    async rejects(promise, predicate) {
      let timer;
      try { await assert.rejects(Promise.race([promise, new Promise((_, reject) => {
        timer = realTimeout(() => reject(Error('FIXTURE_OPENING_DID_NOT_SETTLE')), 500);
      })]), predicate); } finally { realClear(timer); }
    },
    advance(ms, deliver = true) {
      now += ms;
      if (deliver) for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.run(); }
    },
  };
}

test('a pending native witness is bounded before any Worker exists and a late grant releases', async t => {
  const f = fixture(t), opening = openBrowserOwner(f.options);
  await f.pending; f.advance(100);
  await f.rejects(opening, error => error.code === 'OWNER_UNREACHABLE');
  assert.equal(f.workers, 0);
  await assert.rejects(f.grant(), error => error.code === 'OWNER_UNREACHABLE');
  assert.equal(f.held, 0);
});

test('caller abort rejects before a delayed native witness grant', async t => {
  const f = fixture(t), stop = new AbortController(), reason = Error('FIXTURE_CALLER_ABORT');
  const opening = openBrowserOwner({ ...f.options, signal: stop.signal });
  await f.pending; stop.abort(reason);
  await f.rejects(opening, error => error === reason);
  assert.equal(f.workers, 0);
  await assert.rejects(f.grant(), error => error === reason); assert.equal(f.held, 0);
});

test('witness acquisition and Worker readiness share one opening budget', async t => {
  const f = fixture(t), opening = openBrowserOwner(f.options);
  await f.pending; f.advance(70); const grant = f.grant();
  // Native lock callback/SharedWorker construction run on separate microtasks.
  for (let count = 0; f.workers === 0 && count < 20; count++) await delay(1);
  assert.equal(f.workers, 1); f.advance(30);
  await f.rejects(opening, error => error.code === 'OWNER_UNREACHABLE');
  await grant; assert.equal(f.held, 0);
});

test('a late native grant cannot open a Worker even before a delayed timer is delivered', async t => {
  const f = fixture(t), opening = openBrowserOwner(f.options);
  await f.pending; f.advance(101, false); const grant = f.grant();
  await f.rejects(opening, error => error.code === 'OWNER_UNREACHABLE');
  await grant; assert.equal(f.workers, 0); assert.equal(f.held, 0);
});
