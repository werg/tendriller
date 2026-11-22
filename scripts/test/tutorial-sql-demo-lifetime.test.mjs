// Caller-lifetime regression only: no SQL engine, native store, host or browser.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const source = (await readFile(new URL('../../docs/tutorial/sql/demo.mjs', import.meta.url), 'utf8'))
  .replace(/^import[^\n]*\n/gm, '');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const execute = new AsyncFunction('assert', 'openSession', 'readPrivate', 'savePrivate', 'process', 'console', source);
const tick = () => new Promise(resolve => setImmediate(resolve));
function latch() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}
function fixture({ commandFails = false, cleanupFails = false } = {}) {
  const gates = [latch(), latch()], events = [], output = [], errors = [], process = {};
  const records = new Map(); let active = false, opens = 0, transferred = false, finished = false;
  const openSession = async () => {
    if (active) throw Error('OWNER_BUSY');
    active = true; const index = opens++;
    events.push(`open:${index + 1}`);
    const session = {
      deviceId: 'retained-signer',
      async command(name, input, options) {
        if (commandFails) throw Error('PRIMARY_COMMAND_FAILURE');
        return { applied: async () => {
          const rejected = options.operationId === 'inventory-demo-rejected-v1';
          if (name === 'transfer' && !rejected) transferred = true;
          return rejected ? { outcome: 'rejected', rejectionCode: 'assert:insufficient_stock' } : { outcome: 'accepted' };
        } };
      },
      async query() {
        return { revision: { generation: 'retained-generation' }, value: {
          stock: [{ id: 'source', units: transferred ? 7 : 10 }, { id: 'destination', units: transferred ? 3 : 0 }],
          transfers: transferred ? [{ id: 'demo-transfer-3' }] : [],
          activity: transferred ? [{ topic: 'inventory.transferred' }] : [],
        } };
      },
      operations: { get: async id => ({ outcome: id === 'inventory-demo-rejected-v1' ? 'rejected' : 'accepted' }) },
      async close() { events.push(`kernel-close:${index + 1}`); },
    };
    let closing;
    return { session, close: () => closing ??= (async () => {
      events.push(`root-close:${index + 1}:start`);
      await session.close(); // Kernel close resolves while the lease remains held.
      await gates[index].promise;
      if (cleanupFails) throw Error('ROOT_CLEANUP_FAILURE');
      active = false; events.push(`root-close:${index + 1}:done`);
    })() };
  };
  const done = execute(assert, openSession, async name => records.get(name) ?? null,
    async (name, value) => { records.set(name, value); return value; }, process,
    { log: value => output.push(JSON.parse(value)), error: value => errors.push(value) }).finally(() => { finished = true; });
  return { gates, events, output, errors, process, done, get opens() { return opens; }, get finished() { return finished; } };
}

test('SQL demo waits for supervisor lease release before reopen and before reporting success', async t => {
  const f = fixture(); t.after(() => f.gates.forEach(gate => gate.release()));
  await tick();
  assert.deepEqual(f.events, ['open:1', 'root-close:1:start', 'kernel-close:1']);
  assert.equal(f.opens, 1); assert.equal(f.finished, false); assert.deepEqual(f.output, []);
  f.gates[0].release(); await tick();
  assert.deepEqual(f.events, ['open:1', 'root-close:1:start', 'kernel-close:1', 'root-close:1:done', 'open:2', 'root-close:2:start', 'kernel-close:2']);
  assert.equal(f.finished, false); assert.deepEqual(f.output, []);
  f.gates[1].release(); await f.done;
  assert.equal(f.output[0].status, 'passed'); assert.equal(f.events.at(-1), 'root-close:2:done');
  assert.deepEqual(f.errors, []); assert.equal(f.process.exitCode, undefined);
});
test('SQL demo awaits final supervisor cleanup and preserves the primary command error if cleanup rejects', async t => {
  const f = fixture({ commandFails: true, cleanupFails: true }); t.after(() => f.gates.forEach(gate => gate.release()));
  await tick();
  assert.deepEqual(f.events, ['open:1', 'root-close:1:start', 'kernel-close:1']);
  assert.equal(f.finished, false); assert.match(f.errors[0], /PRIMARY_COMMAND_FAILURE/);
  f.gates[0].release(); await f.done;
  assert.equal(f.opens, 1); assert.equal(f.process.exitCode, 1); assert.deepEqual(f.output, []);
  assert.match(f.errors[0], /PRIMARY_COMMAND_FAILURE/);
  assert.match(f.errors.at(-1), /SQL owner cleanup failed:.*ROOT_CLEANUP_FAILURE/);
});
test('SQL demo never reopens or reports passed when supervisor cleanup fails', async t => {
  const f = fixture({ cleanupFails: true }); t.after(() => f.gates.forEach(gate => gate.release()));
  await tick(); f.gates[0].release(); await f.done;
  assert.equal(f.opens, 1); assert.equal(f.process.exitCode, 1); assert.deepEqual(f.output, []);
  assert.match(f.errors[0], /ROOT_CLEANUP_FAILURE/);
});
