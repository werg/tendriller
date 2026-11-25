// Caller-lifetime regression only: no SQL engine, native store, host or browser.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const source = (await readFile(new URL('../../docs/tutorial/sql/demo.mjs', import.meta.url), 'utf8'))
  .replace(/^import[^\n]*\n/gm, '');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const execute = new AsyncFunction('openSession', 'console', source);
const tick = () => new Promise(resolve => setImmediate(resolve));
function latch() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}
function fixture({ queryFails = false, cleanupFails = false } = {}) {
  const gate = latch(), events = [], output = [], forbidden = [];
  let opens = 0, finished = false, signal;
  const openSession = async options => {
    opens++; signal = options?.signal; events.push('open');
    const trap = name => () => { forbidden.push(name); throw Error('The optional native read must not call ' + name); };
    const session = {
      applicationId: 'a'.repeat(64),
      async query(name, input) {
        events.push(`query:${name}`);
        if (queryFails) throw Error('PRIMARY_QUERY_FAILURE');
        assert.equal(input, null);
        return { applicationId: 'a'.repeat(64), revision: { digest: 'retained-local-revision', view: 'local' },
          value: { stock: [{ id: 'source', units: 10 }], catalog: [{ id: 'widget' }] } };
      },
      command: trap('command'), submit: trap('submit'), provisioning: new Proxy({}, { get: (_t, key) => trap('provisioning.' + String(key)) }),
    };
    let closing;
    return { session, close: () => closing ??= (async () => {
      events.push('close:start');
      await gate.promise; // The supervisor lease remains held until cleanup completes.
      if (cleanupFails) throw Error('ROOT_CLEANUP_FAILURE');
      events.push('close:done');
    })() };
  };
  const done = execute(openSession, { log: value => output.push(JSON.parse(value)) });
  done.then(() => { finished = true; }, () => { finished = true; });
  return { gate, events, output, forbidden, done, get opens() { return opens; }, get finished() { return finished; }, get signal() { return signal; } };
}

test('SQL demo is one bounded optional native read of the provisioned application and waits for owner release', async t => {
  const f = fixture(); t.after(() => f.gate.release());
  await tick();
  assert.deepEqual(f.events, ['open', 'query:inventory', 'close:start']);
  assert.equal(f.opens, 1); assert.equal(f.signal instanceof AbortSignal, true, 'the read has its own deadline');
  assert.equal(f.finished, false, 'the process does not finish until the supervisor lease is released');
  f.gate.release(); await f.done;
  assert.equal(f.events.at(-1), 'close:done');
  assert.equal(f.output.length, 1);
  assert.deepEqual({ ...f.output[0], note: undefined }, { applicationId: 'a'.repeat(64), revision: { digest: 'retained-local-revision', view: 'local' },
    stock: [{ id: 'source', units: 10 }], catalog: [{ id: 'widget' }], provisional: true, note: undefined });
  assert.match(f.output[0].note, /not global exclusivity or finality/);
  assert.match(f.output[0].note, /No new schema, data root or device/);
  assert.deepEqual(f.forbidden, [], 'the demo never authors, submits, changes schema or provisions keys');
});

test('SQL demo never reports a read as complete work when its supervisor cleanup fails', async t => {
  const f = fixture({ cleanupFails: true }); t.after(() => f.gate.release());
  await tick(); f.gate.release();
  await assert.rejects(f.done, /ROOT_CLEANUP_FAILURE/);
  assert.equal(f.opens, 1, 'a failed cleanup is never followed by a reopen');
  assert.deepEqual(f.forbidden, []);
});

test('SQL demo still awaits owner cleanup before surfacing a failed read', async t => {
  const f = fixture({ queryFails: true }); t.after(() => f.gate.release());
  await tick();
  assert.deepEqual(f.events, ['open', 'query:inventory', 'close:start']);
  assert.equal(f.finished, false, 'the primary failure is not reported while the lease is still held');
  f.gate.release();
  await assert.rejects(f.done, /PRIMARY_QUERY_FAILURE/);
  assert.deepEqual(f.output, []); assert.equal(f.events.at(-1), 'close:done');
});

test('a failed read stays visible with its exact cause when owner cleanup also fails', async t => {
  const f = fixture({ queryFails: true, cleanupFails: true }); t.after(() => f.gate.release());
  await tick(); f.gate.release();
  await assert.rejects(f.done, error => {
    assert(error instanceof AggregateError); assert.equal(error.cause, error.errors[0]);
    assert.equal(error.errors[0].message, 'PRIMARY_QUERY_FAILURE');
    assert.equal(error.errors[1].message, 'ROOT_CLEANUP_FAILURE'); return true;
  });
  assert.equal(f.opens, 1); assert.deepEqual(f.output, []);
});
