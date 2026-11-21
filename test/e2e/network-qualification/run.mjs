import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const { values } = parseArgs({ options: {
  output: { type: 'string' }, image: { type: 'string', default: 'tendriller-network-lab:playwright-1.65' },
  'node-binary': { type: 'string', default: process.execPath },
} });
if (!values.output) throw new Error('Usage: node test/e2e/network-qualification/run.mjs --output NEW_DIRECTORY [--node-binary NODE24]');
const output = resolve(values.output);
await mkdir(output, { recursive: false, mode: 0o700 });
const source = fileURLToPath(new URL('.', import.meta.url));
const name = `tendriller-network-lab-${randomUUID()}`;
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
    child = spawn('docker', ['run', '--rm', '--name', name, '--cap-add', 'NET_ADMIN', '--cpus=2', '--memory=7g',
      '--mount', `type=bind,source=${source},target=/lab,readonly`,
      '--mount', `type=bind,source=${resolve(values['node-binary'])},target=/usr/local/bin/node,readonly`,
      '--mount', `type=bind,source=${output},target=/evidence`,
      values.image, 'node', '/lab/control-probe.mjs'], { stdio: 'inherit' });
    const timer = setTimeout(() => { void stop('SIGTERM'); reject(new Error('NETWORK_LAB_RUN_TIMEOUT')); }, 90_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); code === 0 && !stopped ? accept() : reject(new Error('NETWORK_LAB_PROBE_FAILED')); });
  });
} finally {
  await command(['rm', '--force', name], 10_000).catch(() => {});
  process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
}
