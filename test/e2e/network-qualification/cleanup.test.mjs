import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createFaults } from './faults.mjs';
import { udpProbe, openUdpProbes } from './udp-probe.mjs';
import { runControlProbe } from './control-probe.mjs';

// A strict in-memory syscall model: repeated deletion of an already removed
// hook/chain fails, just as it does with the real tools. Never execute host tools.
function firewall({ fail = () => false } = {}) {
  const families = new Map(['iptables', 'ip6tables'].map(tool => [tool, { chain: false, hook: false, rules: 0 }]));
  const calls = [];
  const run = async (tool, args) => {
    calls.push([tool, ...args]);
    if (fail(tool, args)) throw new Error('injected syscall failure');
    const state = families.get(tool);
    assert.ok(state, `Unexpected executable ${tool}`);
    const action = args[1];
    if (action === '-N') { assert.equal(state.chain, false); state.chain = true; }
    else if (action === '-A') { assert.equal(state.chain, true); state.rules++; }
    else if (action === '-I') { assert.equal(state.chain, true); assert.equal(state.hook, false); state.hook = true; }
    else if (action === '-D') { assert.equal(state.hook, true); state.hook = false; }
    else if (action === '-F') { assert.equal(state.chain, true); state.rules = 0; }
    else if (action === '-X') {
      assert.equal(state.chain, true); assert.equal(state.hook, false); assert.equal(state.rules, 0); state.chain = false;
    } else assert.fail(`Unexpected action ${action}`);
  };
  return { families, calls, run, empty: () => [...families.values()].every(state => !state.chain && !state.hook) };
}

for (const action of ['-N', '-A', '-I']) {
  test(`failed IPv6 ${action} plus failed IPv4 rollback stays tracked until close succeeds`, async () => {
    let denyRemoval = true;
    const model = firewall({ fail: (tool, args) =>
      (tool === 'ip6tables' && args[1] === action) ||
      (denyRemoval && tool === 'iptables' && ['-D', '-F', '-X'].includes(args[1])) });
    const faults = createFaults({ isolated: true, run: model.run });
    await assert.rejects(faults.blockUdp(), /ROLLBACK_FAILED/);
    assert.equal(model.families.get('iptables').hook, true);
    await assert.rejects(faults.blockUdp(), /ALREADY_ACTIVE/);
    await assert.rejects(faults.close(), /CLEANUP_FAILED/);
    assert.equal(model.empty(), false);
    denyRemoval = false;
    await faults.close();
    assert.equal(model.empty(), true);
    const count = model.calls.length;
    await faults.close();
    assert.equal(model.calls.length, count, 'successful resources must not be removed twice');
  });
}

for (const action of ['-D', '-F', '-X']) {
  test(`restore retries only remaining resources after IPv4 ${action} fails`, async () => {
    let denyRemoval = false;
    const model = firewall({ fail: (tool, args) => denyRemoval && tool === 'iptables' && args[1] === action });
    const faults = createFaults({ isolated: true, run: model.run });
    await faults.blockUdp();
    denyRemoval = true;
    await assert.rejects(faults.restoreUdp(), /RESTORE_FAILED/);
    assert.equal(model.families.get('ip6tables').chain, false);
    const start = model.calls.length;
    denyRemoval = false;
    await faults.close();
    assert.equal(model.empty(), true);
    const retried = model.calls.slice(start);
    assert.ok(retried.every(call => call[0] === 'iptables'));
    if (action !== '-D') assert.ok(retried.every(call => !call.includes('-D')));
    await faults.blockUdp();
    await faults.close();
    assert.equal(model.empty(), true);
  });
}

test('failed rollback and close preserve cleanup false in the saved control report', async () => {
  let denyRemoval = true;
  const model = firewall({ fail: (tool, args) =>
    (tool === 'ip6tables' && args[1] === '-N') ||
    (denyRemoval && tool === 'iptables' && ['-D', '-F', '-X'].includes(args[1])) });
  const faults = createFaults({ isolated: true, run: model.run });
  const server = new EventEmitter();
  let serverClosed = false, probeClosed = false, saved;
  server.listen = () => queueMicrotask(() => server.emit('listening'));
  server.close = () => { serverClosed = true; };
  const report = await runControlProbe({ faults, server,
    openProbes: async () => [{ echoes: async () => true, close: () => { probeClosed = true; } }],
    saveReport: async value => { saved = structuredClone(value); },
  });
  assert.equal(report.success, false);
  assert.equal(report.cleanup, false);
  assert.equal(saved.cleanup, false);
  assert.equal(saved.failure, 'NETWORK_LAB_CONTROL_PROBE_FAILED');
  assert.equal(model.empty(), false);
  assert.equal(serverClosed && probeClosed, true);
  denyRemoval = false;
  await faults.close();
  assert.equal(model.empty(), true);
  assert.equal(saved.cleanup, false, 'a later retry cannot rewrite failed-run evidence');
});

function sockets({ createFailure = -1, bindFailure = -1, synchronous = false, closeFailure = -1 } = {}) {
  const created = [];
  const createSocket = () => {
    const index = created.length;
    if (index === createFailure) throw new Error('injected create failure');
    const socket = new EventEmitter();
    socket.bound = false;
    socket.closeCalls = 0;
    socket.bind = () => {
      if (index === bindFailure) {
        if (synchronous) throw new Error('injected bind failure');
        queueMicrotask(() => socket.emit('error', new Error('injected bind failure')));
      } else {
        socket.bound = true;
        queueMicrotask(() => socket.emit('listening'));
      }
    };
    socket.close = () => {
      socket.closeCalls++;
      if (index === closeFailure) throw new Error('injected close failure');
      if (!socket.bound) throw Object.assign(new Error('not running'), { code: 'ERR_SOCKET_DGRAM_NOT_RUNNING' });
      socket.bound = false;
    };
    created.push(socket);
    return socket;
  };
  return { created, createSocket };
}

for (const createFailure of [0, 1, 2, 3]) {
  test(`socket creation failure ${createFailure} closes all previously created sockets`, async () => {
    const fake = sockets({ createFailure });
    await assert.rejects(openUdpProbes((type, address) => udpProbe(type, address, fake.createSocket)), /create failure/);
    assert.equal(fake.created.length, createFailure);
    assert.ok(fake.created.every(socket => !socket.bound && socket.closeCalls === 1));
  });
}

for (const bindFailure of [0, 1, 2, 3]) {
  for (const synchronous of [false, true]) {
    test(`${synchronous ? 'sync' : 'async'} bind failure ${bindFailure} closes partial family and completed IPv4`, async () => {
      const fake = sockets({ bindFailure, synchronous });
      await assert.rejects(openUdpProbes((type, address) => udpProbe(type, address, fake.createSocket)), /bind failure/);
      assert.ok(fake.created.every(socket => !socket.bound && socket.closeCalls === 1));
      assert.ok(fake.created.every(socket => socket.listenerCount('listening') === 0 && socket.listenerCount('error') === 0));
    });
  }
}

test('failure closing one partial socket still attempts to close the other', async () => {
  const fake = sockets({ bindFailure: 1, closeFailure: 0 });
  await assert.rejects(udpProbe('udp4', '127.0.0.1', fake.createSocket), error => {
    assert.match(error.message, /UDP_CLEANUP_FAILED/);
    assert.match(error.errors[0].message, /bind failure/);
    return true;
  });
  assert.deepEqual(fake.created.map(socket => socket.closeCalls), [1, 1]);
});

test('successful dual-family startup retains both probes for caller cleanup', async () => {
  const fake = sockets();
  const probes = await openUdpProbes((type, address) => udpProbe(type, address, fake.createSocket));
  assert.equal(probes.length, 2);
  assert.ok(fake.created.every(socket => socket.bound && socket.closeCalls === 0));
  for (const probe of probes) { probe.close(); probe.close(); }
  assert.ok(fake.created.every(socket => !socket.bound));
});
