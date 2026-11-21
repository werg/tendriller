import assert from 'node:assert/strict';
import { createServer, connect } from 'node:net';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { writeFile } from 'node:fs/promises';
import { createFaults } from './faults.mjs';
import { openUdpProbes } from './udp-probe.mjs';
import { pathToFileURL } from 'node:url';

async function tcpEcho(port) {
  const start = performance.now();
  const socket = connect({ host: '127.0.0.1', port });
  try {
    await new Promise((resolve, reject) => {
      socket.setTimeout(3000, () => reject(new Error('TCP_PROBE_TIMEOUT')));
      socket.on('error', reject);
      socket.once('data', bytes => { assert.equal(bytes.toString(), 'probe'); resolve(); });
      socket.end('probe');
    });
    return performance.now() - start;
  } finally { socket.destroy(); }
}

// server.close() acknowledges listener and connection shutdown only in its
// callback. Give accepted connections a short drain, then retire every socket.
export function closeTcpServer(server, sockets, { drainMs = 1000, timeoutMs = 5000 } = {}) {
  if (![drainMs, timeoutMs].every(Number.isSafeInteger) || drainMs < 0 || timeoutMs <= drainMs || timeoutMs > 60_000) throw new Error('TCP_PROBE_INVALID_SHUTDOWN');
  return new Promise((resolve, reject) => {
    let settled = false, drainTimer, deadline, destroyError;
    const finish = error => {
      if (settled) return;
      settled = true; clearTimeout(drainTimer); clearTimeout(deadline);
      if (error || destroyError) reject(error || destroyError); else resolve();
    };
    const destroy = () => {
      for (const socket of sockets) {
        try { socket.destroy(); } catch (error) { destroyError ??= error; }
      }
    };
    drainTimer = setTimeout(destroy, drainMs);
    deadline = setTimeout(() => { destroy(); finish(new Error('TCP_PROBE_CLEANUP_TIMEOUT')); }, timeoutMs);
    try { server.close(error => { if (error) destroy(); finish(error); }); }
    catch (error) { destroy(); finish(error); }
  });
}

export async function runControlProbe({
  faults = createFaults(), openProbes = openUdpProbes, echo = tcpEcho,
  server = createServer(socket => { socket.on('error', () => {}); socket.on('data', bytes => socket.write(bytes)); }),
  tcpShutdown,
  saveReport = report => writeFile('/evidence/control-probe.json', JSON.stringify(report, null, 2) + '\n'),
} = {}) {
  const report = { version: 1, scope: 'packet-controls-only', startedAt: new Date().toISOString(),
    node: process.version, applicationRecoveryQualified: false,
    unsupported: ['physical-mobile-radio', 'carrier-nat', 'symmetric-nat', 'os-sleep', 'model-turn-observation'], checks: [] };
  const probes = [], sockets = new Set();
  let started = false;
  const accepted = socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  };
  server.on('connection', accepted);
  try {
    const listening = once(server, 'listening');
    server.listen(8790, '127.0.0.1');
    await listening; started = true;
    probes.push(...await openProbes());
    for (const probe of probes) assert.equal(await probe.echoes(), true);
    report.checks.push('ipv4-ipv6-udp-baseline');
    await faults.blockUdp();
    for (const probe of probes) assert.equal(await probe.echoes(), false, 'UDP bypassed the real firewall');
    const blockedTcpMs = await echo(server.address().port);
    report.checks.push('ipv4-ipv6-udp-blocked-tcp-working');
    await faults.restoreUdp();
    for (const probe of probes) assert.equal(await probe.echoes(), true, 'UDP did not recover');
    report.checks.push('ipv4-ipv6-udp-restored');
    await faults.blockApplicationNetwork();
    await assert.rejects(echo(server.address().port), 'Application TCP path bypassed the partition');
    for (const probe of probes) assert.equal(await probe.echoes(), false);
    await faults.restoreUdp();
    await echo(server.address().port);
    for (const probe of probes) assert.equal(await probe.echoes(), true);
    report.checks.push('application-tcp-and-udp-partition-restored');
    await faults.impair();
    const impairedTcpMs = await echo(server.address().port);
    assert.ok(impairedTcpMs >= 100, 'The real loopback qdisc did not delay the TCP exchange');
    await faults.restoreImpairment();
    report.checks.push('loss-latency-rule-tcp-working');
    report.impairment = { interfaces: ['lo', 'eth0'], delayMs: 60, lossPercent: 1, seed: null, lossSelection: 'stochastic' };
    report.timing = { blockedTcpMs, impairedTcpMs };
    report.success = true;
  } catch {
    report.success = false;
    // Tool stderr may contain local addresses; keep the public report closed-vocabulary.
    report.failure = 'NETWORK_LAB_CONTROL_PROBE_FAILED';
  } finally {
    try { await faults.close(); report.cleanup = true; }
    catch { report.cleanup = false; }
    for (const probe of probes) {
      try { probe.close(); } catch { report.cleanup = false; }
    }
    if (started) {
      try { await closeTcpServer(server, sockets, tcpShutdown); } catch { report.cleanup = false; }
    }
    server.off('connection', accepted);
    if (!report.cleanup) report.success = false;
    report.finishedAt = new Date().toISOString();
    await saveReport(report);
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runControlProbe();
  if (!report.success || !report.cleanup) process.exitCode = 1;
}
