import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

for (const cleanupFailure of [false, true]) {
  test(`inference peer detaches from the agent program${cleanupFailure ? ' even after service cleanup fails' : ''}`, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'inference-lifecycle-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await mkdir(join(directory, 'media'));
    await copyFile(new URL('../../docs/tutorial/shared/cli-lifetime.mjs', import.meta.url), join(directory, 'cli-lifetime.mjs'));
    for (const name of ['inference-peer.mjs', 'inference-protocol.mjs'])
      await copyFile(new URL(`../../docs/tutorial/shared/media/${name}`, import.meta.url), join(directory, 'media', name));
    const events = [];
    globalThis.inferenceEvents = events;
    await writeFile(join(directory, 'media/inference-service.mjs'), `
export function servePeerInference() {
  return { done: Promise.resolve(), async close() {
    globalThis.inferenceEvents.push('service-closed');
    ${cleanupFailure ? "throw Error('fixture:service-cleanup-failed');" : ''}
  } };
}
`);
    await writeFile(join(directory, 'provider.mjs'), 'export const createInferenceProvider = async () => async () => ({ text: "unused" });\n');
    const { runInference } = await import(pathToFileURL(join(directory, 'media/inference-peer.mjs')).href);
    const attach = async (page, { signal }) => {
      assert.equal(page, 'notes'); assert(signal === undefined || signal instanceof AbortSignal);
      return { session: { deviceId: 'test-device', close() { throw Error('must not close the agent-owned session'); } },
        async detach() { events.push('detached'); } };
    };
    const running = runInference({ attach, args: ['--page', 'notes', '--allow-device', 'a'.repeat(64), '--provider', join(directory, 'provider.mjs')] });
    if (cleanupFailure) await assert.rejects(running, /fixture:service-cleanup-failed/); else await running;
    assert.deepEqual(events, ['service-closed', 'detached']);
  });
}
