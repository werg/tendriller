import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { createServer, connect } from 'node:net';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { writeFile } from 'node:fs/promises';
import { createFaults } from './faults.mjs';

const faults = createFaults();
const report = { version: 1, scope: 'packet-controls-only', startedAt: new Date().toISOString(),
  node: process.version, applicationRecoveryQualified: false,
  unsupported: ['physical-mobile-radio', 'carrier-nat', 'symmetric-nat', 'os-sleep', 'model-turn-observation'], checks: [] };

async function udpProbe(type, address) {
  const server = dgram.createSocket(type);
  const client = dgram.createSocket(type);
  server.on('message', (bytes, remote) => server.send(bytes, remote.port, remote.address));
  server.bind(0, address);
  await once(server, 'listening');
  client.bind(0, address);
  await once(client, 'listening');
  return {
    async echoes() {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { client.off('message', received); resolve(false); }, 400);
        const received = bytes => { clearTimeout(timer); assert.equal(bytes.toString(), 'probe'); resolve(true); };
        client.once('message', received);
        client.send(Buffer.from('probe'), server.address().port, address, error => {
          if (error) {
            clearTimeout(timer); client.off('message', received);
            // Local OUTPUT DROP can reject sendmsg immediately instead of
            // silently timing out. It is not a successful echo.
            if (error.code === 'EPERM') resolve(false); else reject(error);
          }
        });
      });
    },
    close() { server.close(); client.close(); },
  };
}

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

const server = createServer(socket => { socket.on('error', () => {}); socket.on('data', bytes => socket.write(bytes)); });
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const probes = [];
try {
  probes.push(await udpProbe('udp4', '127.0.0.1'), await udpProbe('udp6', '::1'));
  for (const probe of probes) assert.equal(await probe.echoes(), true);
  report.checks.push('ipv4-ipv6-udp-baseline');
  await faults.blockUdp();
  for (const probe of probes) assert.equal(await probe.echoes(), false, 'UDP bypassed the real firewall');
  const blockedTcpMs = await tcpEcho(server.address().port);
  report.checks.push('ipv4-ipv6-udp-blocked-tcp-working');
  await faults.restoreUdp();
  for (const probe of probes) assert.equal(await probe.echoes(), true, 'UDP did not recover');
  report.checks.push('ipv4-ipv6-udp-restored');
  await faults.impair();
  const impairedTcpMs = await tcpEcho(server.address().port);
  assert.ok(impairedTcpMs >= 100, 'The real loopback qdisc did not delay the TCP exchange');
  await faults.restoreImpairment();
  report.checks.push('loss-latency-rule-tcp-working');
  report.impairment = { interface: 'loopback', delayMs: 60, lossPercent: 1, seed: null, lossSelection: 'stochastic' };
  report.timing = { blockedTcpMs, impairedTcpMs };
  report.success = true;
} catch {
  report.success = false;
  // Tool stderr may contain local addresses; keep the public report closed-vocabulary.
  report.failure = 'NETWORK_LAB_CONTROL_PROBE_FAILED';
  process.exitCode = 1;
} finally {
  try { await faults.close(); report.cleanup = true; }
  catch { report.cleanup = false; process.exitCode = 1; }
  for (const probe of probes) probe.close();
  server.close();
  report.finishedAt = new Date().toISOString();
  await writeFile('/evidence/control-probe.json', JSON.stringify(report, null, 2) + '\n');
}
