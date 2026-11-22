import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { runParticipant } from '../../deploy/participant.mjs';

const template = path => readFileSync(new URL('../../deploy/' + path, import.meta.url), 'utf8');

test('launcher awaits the exported peer and requires verified owned shutdown', async () => {
  const stop = new AbortController(); let peerFinished = false;
  const running = runParticipant({ sessionPath: './session.mjs', signal: stop.signal, load: async () => ({
    async runPeer({ signal }, hooks) {
      hooks.onOwned();
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      peerFinished = true; hooks.onClosed(); throw signal.reason;
    },
  }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(peerFinished, false);
  stop.abort(new Error('test stop'));
  assert.equal(await running, 0); assert.equal(peerFinished, true);
});

test('missing entry point and premature peer return cannot look like a running service', async () => {
  const signal = new AbortController().signal;
  await assert.rejects(runParticipant({ sessionPath: 'session.mjs', signal, load: async () => ({}) }), /export runPeer/);
  await assert.rejects(runParticipant({ sessionPath: 'session.mjs', signal, load: async () => ({ async runPeer() {} }) }), /returned before/);
});

test('cleanup failures stay errors even during requested shutdown', async () => {
  for (const cleanupFailure of [false, true]) {
    const stop = new AbortController(); const failure = new Error('close failed');
    const running = runParticipant({ sessionPath: 'session.mjs', signal: stop.signal, load: async () => ({
      async runPeer({ signal }, hooks) {
        hooks.onOwned(); stop.abort(new Error('stop'));
        if (cleanupFailure) { hooks.onClosed(); throw failure; }
        throw signal.reason; // no verified close
      },
    }) });
    await assert.rejects(running, cleanupFailure ? failure : stop.signal.reason);
  }
});

test('real executable loads a path containing spaces and awaits cleanup on SIGTERM', {
  skip: process.platform === 'win32' || Number(process.versions.node.split('.')[0]) < 24,
  timeout: 5000,
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'participant launcher '));
  const sessionPath = join(directory, 'session fixture.mjs');
  writeFileSync(sessionPath, `export async function runPeer({signal}, hooks) {
    hooks.onOwned(); const timer = setInterval(() => {}, 1000);
    console.log('fixture-ready');
    try { await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), {once:true})); }
    finally { await new Promise(resolve => setTimeout(resolve, 20)); clearInterval(timer); hooks.onClosed(); console.log('fixture-closed'); }
  }`);
  const child = spawn(process.execPath, [fileURLToPath(new URL('../../deploy/participant.mjs', import.meta.url)), '--session', sessionPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const closed = once(child, 'close');
  try {
    while (!stdout.includes('fixture-ready')) {
      await Promise.race([once(child.stdout, 'data'), closed.then(() => { throw Error('Launcher exited before readiness: ' + stderr); })]);
    }
    assert.equal(child.exitCode, null); child.kill('SIGTERM');
    const [code] = await closed;
    assert.equal(code, 0, stderr); assert.match(stdout, /fixture-closed/);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); rmSync(directory, { recursive: true, force: true }); }
});

test('templates share explicit launcher, actual private store and Node24 container', () => {
  const docker = template('Dockerfile');
  assert.match(docker, /FROM node:24-/); assert.match(docker, /VOLUME \["\/app\/\.tendriller"\]/);
  assert.match(docker, /CMD \["node", "deploy\/participant.mjs", "--session", "\/app\/session.mjs"\]/);
  assert.doesNotMatch(docker, /\/data\/\.tendriller/);
  assert.match(template('Dockerfile.dockerignore'), /^\.tendriller$/m);
  assert.match(template('Dockerfile.dockerignore'), /^\*\*\/\.tendriller$/m);
  for (const path of ['tendriller.service', 'dev.tendriller.participant.plist']) {
    assert.match(template(path), /deploy\/participant.mjs/); assert.match(template(path), /--session/);
  }
});

test('Windows installs a limited current-user logon task without SCM or overwrite', () => {
  const windows = template('install-windows-task.ps1');
  assert.match(windows, /-AtLogOn -User \$user/);
  assert.match(windows, /-LogonType Interactive -RunLevel Limited/);
  assert.match(windows, /-MultipleInstances IgnoreNew/);
  assert.match(windows, /ExecutionTimeLimit \(\[TimeSpan\]::Zero\)/);
  assert.match(windows, /-WorkingDirectory \$directory/);
  assert.match(windows, /SupportsShouldProcess/);
  assert.doesNotMatch(windows, /New-Service|BinaryPathName|-Force\b|LogonType Password/);
});
