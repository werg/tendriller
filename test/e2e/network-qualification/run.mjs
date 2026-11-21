import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { basename, resolve } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { NETWORK_PROFILES } from './scenarios.mjs';
import { releaseAnchor, sha256 } from './anchor.mjs';

const { values } = parseArgs({ options: {
  output: { type: 'string' }, image: { type: 'string', default: 'tendriller-network-lab:playwright-1.65' },
  'node-binary': { type: 'string', default: process.execPath },
  'browser-controls': { type: 'boolean', default: false },
  'artifact-root': { type: 'string' }, profile: { type: 'string' },
  'idle-ms': { type: 'string', default: '15000' },
} });
if (!values.output) throw new Error('Usage: node test/e2e/network-qualification/run.mjs --output NEW_DIRECTORY [--node-binary NODE24]');
const application = Boolean(values['artifact-root']);
if (application && (!(values.profile === 'suite' || NETWORK_PROFILES.includes(values.profile)) || values['browser-controls'])) throw new Error('Choose one application --profile, without --browser-controls');
if (!application && values.profile) throw new Error('An application profile requires --artifact-root');
const idleMs = Number(values['idle-ms']);
if (!Number.isSafeInteger(idleMs) || idleMs < 1000 || idleMs > 48 * 60 * 60 * 1000) throw new Error('Invalid bounded idle interval');
let kit;
let anchor;
if (application) {
  anchor = await releaseAnchor(values['artifact-root']);
  kit = anchor.kit;
  if (typeof kit !== 'string' || basename(kit) !== kit || !/^tendriller-first-app-[a-zA-Z0-9.-]+\.tgz$/.test(kit)) throw new Error('Invalid immutable first-app record');
}
const output = resolve(values.output);
await mkdir(output, { recursive: false, mode: 0o700 });
const source = fileURLToPath(new URL('.', import.meta.url));
const workspace = resolve(source, '../../..');
const name = `tendriller-network-lab-${randomUUID()}`;
await writeFile(resolve(output, 'run.json'), JSON.stringify({ version: 1, startedAt: new Date().toISOString(),
  observerPid: process.pid, container: name, profile: values.profile ?? null, idleMs, anchor: anchor ?? null,
  nodeSha256: sha256(await readFile(values['node-binary'])), harnessEntrySha256: sha256(await readFile(fileURLToPath(import.meta.url))),
  config: { image: values.image, cpus: 2, memoryBytes: 7 * 1024 ** 3, publishedPorts: [], restart: 'no',
    idleCounterSampling: 'closed-segment-endpoints-only', localProgressIntervalMs: 60_000 },
  scope: 'local application/host traffic; not Cloudflare billing, physical OS sleep, or future model wake' }, null, 2) + '\n', { mode: 0o600 });
let stopped = false;
let child;
const command = (args, timeout = 120_000) => new Promise((accept, reject) => {
  const proc = spawn('docker', args, { stdio: 'ignore' });
  const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('NETWORK_LAB_DOCKER_TIMEOUT')); }, timeout);
  proc.once('error', error => { clearTimeout(timer); reject(error); });
  proc.once('exit', code => { clearTimeout(timer); code === 0 ? accept() : reject(new Error('NETWORK_LAB_DOCKER_FAILED')); });
});
async function stop(signal) {
  if (stopped) return;
  stopped = true;
  // Timestamp precedes interruption, not inferred retrospectively from exit.
  await writeFile(resolve(output, 'stop-request.json'), JSON.stringify({ at: new Date().toISOString(), event: 'stop-request' }) + '\n');
  await command(['rm', '--force', name], 10_000).catch(() => {});
  child?.kill(signal);
}
const interrupt = () => { void stop('SIGTERM'); };
process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
try {
  // No host networking, no published ports and no host filesystem state except
  // this new output directory and the read-only fixture/Node binary.
  await new Promise((accept, reject) => {
    child = spawn('docker', ['run', '--rm', '--init', '--name', name, '--cap-add', 'NET_ADMIN', '--cpus=2', '--memory=7g',
      '--mount', `type=bind,source=${source},target=/lab,readonly`,
      '--mount', `type=bind,source=${resolve(values['node-binary'])},target=/usr/local/bin/node,readonly`,
      '--mount', `type=bind,source=${output},target=/evidence`,
      ...(values['browser-controls'] ? ['--mount', `type=bind,source=${resolve(workspace, 'node_modules')},target=/node_modules,readonly`] : []),
      ...(application ? [
        '--mount', `type=bind,source=${workspace},target=/workspace,readonly`,
        '--mount', `type=bind,source=${resolve(values['artifact-root'], 'dist')},target=/workspace/dist,readonly`,
        '--env', `NETWORK_LAB_IDLE_MS=${idleMs}`,
        '--env', 'NETWORK_LAB_PROGRESS=/evidence/network-progress.json',
      ] : []),
      values.image, ...(values['browser-controls'] || application ? ['xvfb-run', '-a'] : []), 'node',
      ...(application ? ['/workspace/scripts/test-first-app.mjs', '--first-app-archive', `/workspace/dist/${kit}`,
        '--network-lab-profile', values.profile, '--report', '/evidence/first-app.json'] :
        [values['browser-controls'] ? '/lab/browser-probe.mjs' : '/lab/control-probe.mjs'])], { stdio: 'inherit' });
    const idleSegments = values.profile === 'suite' ? NETWORK_PROFILES.length : 1;
    const timer = setTimeout(() => { void stop('SIGTERM'); reject(new Error('NETWORK_LAB_RUN_TIMEOUT')); }, application ? 25 * 60_000 + idleSegments * idleMs : 90_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); code === 0 && !stopped ? accept() : reject(new Error('NETWORK_LAB_PROBE_FAILED')); });
  });
} finally {
  await command(['rm', '--force', name], 10_000).catch(() => {});
  process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
}
