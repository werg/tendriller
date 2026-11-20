import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);

for (const cleanupFailure of [false, true]) {
  test(`inference launcher closes its native supervisor${cleanupFailure ? ' even after service cleanup fails' : ''}`, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'inference-lifecycle-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await mkdir(join(directory, 'media'));
    await mkdir(join(directory, 'helpers'));
    await copyFile(new URL('../../docs/tutorial/helpers/cli-lifetime.mjs', import.meta.url), join(directory, 'helpers/cli-lifetime.mjs'));
    for (const name of ['inference-peer.mjs', 'inference-protocol.mjs']) {
      await copyFile(new URL(`../../docs/tutorial/media/${name}`, import.meta.url), join(directory, 'media', name));
    }
    // The real launcher owns a supervisor with a listening socket. Keep an
    // active handle here so closing only its inner session leaves the process
    // running, while owner cleanup allows a clean exit and subsequent reopen.
    await writeFile(join(directory, 'session.mjs'), `
export async function openSession() {
  const listener = setInterval(() => {}, 1000);
  return { session: { deviceId: 'test-device', close: async () => console.log('fixture:inner-session-only') },
    async close() { clearInterval(listener); console.log('fixture:supervisor-closed'); } };
}
`);
    await writeFile(join(directory, 'media/inference-service.mjs'), `
export function servePeerInference() {
  return { done: Promise.resolve(), async close() {
    console.log('fixture:service-closed');
    ${cleanupFailure ? "throw Error('fixture:service-cleanup-failed');" : ''}
  } };
}
`);
    await writeFile(join(directory, 'provider.mjs'), 'export const createInferenceProvider = async () => async () => ({ text: "unused" });\n');
    let outcome;
    try {
      outcome = await run(process.execPath, ['media/inference-peer.mjs', '--allow-device', 'a'.repeat(64),
        '--provider', './provider.mjs'], { cwd: directory, timeout: 5_000 });
      assert.equal(cleanupFailure, false);
    } catch (error) {
      assert.equal(cleanupFailure, true);
      assert.equal(error.killed, false, 'the native supervisor must release its active handle');
      assert.equal(error.code, 1);
      assert.match(error.stderr, /fixture:service-cleanup-failed/);
      outcome = error;
    }
    assert.match(outcome.stdout, /fixture:service-closed[\s\S]*fixture:supervisor-closed/);
    assert.doesNotMatch(outcome.stdout, /fixture:inner-session-only/);
  });
}
