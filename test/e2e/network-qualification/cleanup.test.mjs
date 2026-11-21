import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer, connect } from 'node:net';
import { createFaults } from './faults.mjs';
import { udpProbe, openUdpProbes } from './udp-probe.mjs';
import { runControlProbe, closeTcpServer } from './control-probe.mjs';

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
    await assert.rejects(faults.blockUdp(), /NETWORK_LAB_CLOSED/);
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
  server.close = callback => { serverClosed = true; queueMicrotask(callback); };
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

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const turn = () => new Promise(setImmediate);

for (const kind of ['udp', 'shape']) {
  test(`close owns an in-flight first ${kind} syscall until setup stops and resources are removed`, async () => {
    const started = deferred(), release = deferred(), calls = [];
    let resources = 0;
    const faults = createFaults({ isolated: true, run: async (tool, args) => {
      calls.push([tool, ...args]);
      if (calls.length === 1) { started.resolve(); await release.promise; resources++; }
      if (args.includes('-X') || args.includes('del')) resources--;
    } });
    const setup = kind === 'udp' ? faults.blockUdp() : faults.impair();
    const rejected = assert.rejects(setup, /NETWORK_LAB_CLOSED/);
    await started.promise;
    let done = false;
    const close = faults.close().then(() => { done = true; });
    await turn();
    assert.equal(done, false, 'first syscall still owns cleanup');
    await assert.rejects(faults.blockApplicationNetwork(), /NETWORK_LAB_CLOSED/);
    await assert.rejects(faults.impair(), /NETWORK_LAB_CLOSED/);
    release.resolve(); await rejected; await close;
    assert.equal(resources, 0);
    const count = calls.length;
    await turn(); await faults.close();
    assert.equal(calls.length, count, 'no commands after successful cleanup');
    assert.equal(calls.filter(call => call.includes('-N') || call.includes('add')).length, 1);
    assert.equal(calls.some(call => call.includes('-A') || call.includes('-I')), false);
  });
}

test('close immediately after admission fences setup before its first syscall', async () => {
  const calls = [];
  const faults = createFaults({ isolated: true, run: async (...args) => calls.push(args) });
  const setup = faults.blockUdp(), closed = faults.close();
  await assert.rejects(setup, /NETWORK_LAB_CLOSED/); await closed;
  assert.deepEqual(calls, []);
});

test('close fences a queued setup and waits for an admitted restore without duplicate removals', async () => {
  const model = firewall(), started = deferred(), release = deferred();
  let hold = false;
  const faults = createFaults({ isolated: true, run: async (tool, args) => {
    if (hold && tool === 'iptables' && args.includes('-D')) { started.resolve(); await release.promise; }
    return model.run(tool, args);
  } });
  await faults.blockUdp(); hold = true;
  const restore = faults.restoreUdp(); await started.promise;
  const setup = faults.impair(), rejected = assert.rejects(setup, /NETWORK_LAB_CLOSED/);
  const close = faults.close();
  release.resolve(); await restore; await rejected; await close;
  assert.equal(model.empty(), true);
  assert.ok(model.calls.every(call => call[0] !== 'tc'));
});

test('bounded close reports uncertainty for an uncooperative syscall and retains ownership for retry', async () => {
  const started = deferred(), release = deferred(), model = firewall();
  const faults = createFaults({ isolated: true, cleanupTimeoutMs: 20, run: async (tool, args) => {
    if (args.includes('-N')) { started.resolve(); await release.promise; }
    return model.run(tool, args);
  } });
  const setup = faults.blockUdp(), rejected = assert.rejects(setup, /NETWORK_LAB_CLOSED/);
  await started.promise;
  await assert.rejects(faults.close(), /NETWORK_LAB_CLEANUP_TIMEOUT/);
  await assert.rejects(faults.blockUdp(), /NETWORK_LAB_CLOSED/);
  release.resolve(); await rejected; await faults.close();
  assert.equal(model.empty(), true);
  assert.equal(model.calls.filter(call => call.includes('-N')).length, 1);
});

test('late first-syscall failure still settles close without installing any rules', async () => {
  const started = deferred(), release = deferred(), calls = [];
  const faults = createFaults({ isolated: true, run: async (...args) => {
    calls.push(args); started.resolve(); await release.promise; throw new Error('syscall failed');
  } });
  const setup = faults.blockUdp(), rejected = assert.rejects(setup, /syscall failed/);
  await started.promise;
  const close = faults.close(); release.resolve(); await rejected; await close;
  assert.equal(calls.length, 1);
});

test('TCP cleanup waits for the actual close acknowledgement before saving a report', async () => {
  const server = new EventEmitter(), closing = deferred();
  let callback, saved = false;
  server.listen = () => queueMicrotask(() => server.emit('listening'));
  server.close = done => { callback = done; closing.resolve(); };
  const run = runControlProbe({ server, faults: { close: async () => {} },
    openProbes: async () => { throw new Error('stop before packet controls'); },
    saveReport: async () => { saved = true; },
  });
  await closing.promise; await turn(); assert.equal(saved, false);
  callback(); const report = await run;
  assert.equal(saved, true); assert.equal(report.cleanup, true);
  assert.equal(server.listenerCount('connection'), 0);
});

test('TCP close failure and missing acknowledgement cannot report cleanup success', async () => {
  for (const mode of ['callback-error', 'never-calls-back', 'throw']) {
    const server = new EventEmitter();
    server.listen = () => queueMicrotask(() => server.emit('listening'));
    server.close = callback => {
      if (mode === 'throw') throw new Error('close failed');
      if (mode === 'callback-error') queueMicrotask(() => callback(new Error('close failed')));
    };
    const report = await runControlProbe({ server, faults: { close: async () => {} },
      tcpShutdown: { drainMs: 0, timeoutMs: 20 },
      openProbes: async () => { throw new Error('stop before packet controls'); }, saveReport: async () => {},
    });
    assert.equal(report.cleanup, false, mode); assert.equal(report.success, false, mode);
  }
});

test('a TCP server that never listened has no listener to drain', async () => {
  const server = new EventEmitter();
  let closeCalls = 0;
  server.listen = () => queueMicrotask(() => server.emit('error', new Error('listen failed')));
  server.close = () => { closeCalls++; };
  const report = await runControlProbe({ server, faults: { close: async () => {} },
    saveReport: async () => {},
  });
  assert.equal(report.cleanup, true); assert.equal(report.success, false); assert.equal(closeCalls, 0);
});

test('TCP drain destroys a held real loopback connection and awaits server closure', async t => {
  const sockets = new Set(), accepted = deferred();
  const server = createServer({ allowHalfOpen: true }, socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket)); accepted.resolve(socket);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const client = connect({ host: '127.0.0.1', port: server.address().port });
  client.on('error', () => {});
  t.after(() => { client.destroy(); for (const socket of sockets) socket.destroy(); if (server.listening) server.close(); });
  await once(client, 'connect'); const socket = await accepted.promise;
  const clientClosed = once(client, 'close'), socketClosed = once(socket, 'close');
  let acknowledged = false;
  server.once('close', () => { acknowledged = true; });
  const closing = closeTcpServer(server, sockets, { drainMs: 20, timeoutMs: 1000 });
  assert.equal(acknowledged, false); assert.equal(server.listening, false);
  await Promise.all([closing, clientClosed, socketClosed]);
  assert.equal(socket.destroyed, true); assert.equal(acknowledged, true); assert.equal(sockets.size, 0);
});

test('a socket destroy failure does not skip other sockets or turn cleanup into success', async () => {
  let secondDestroyed = false, callback;
  const server = { close(done) { callback = done; } };
  const sockets = new Set([{ destroy() { throw new Error('destroy failed'); } }, { destroy() { secondDestroyed = true; callback(); } }]);
  await assert.rejects(closeTcpServer(server, sockets, { drainMs: 0, timeoutMs: 100 }), /destroy failed/);
  assert.equal(secondDestroyed, true);
});
