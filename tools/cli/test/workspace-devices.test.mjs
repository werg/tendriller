import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NativeBytesStore } from '@chronolog/peer-session/native';
import { openPageDevice, openSharedSigner } from '../lib/workspace.mjs';

test('page devices share the agent signer and one pooled store worker', async t => {
  const root = await mkdtemp(join(tmpdir(), 'workspace-devices-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const signer = await openSharedSigner(join(root, 'agent', 'identity.sqlite'), { create: true });
  const before = NativeBytesStore.poolStatus().stores;
  const devices = [];
  for (const id of ['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'cccccccccccc'])
    devices.push(await openPageDevice({ path: join(root, 'pages', id, 'device.sqlite'), signer, create: true }));
  for (const device of devices) assert.equal(device.identity.publicKey, signer.publicKey);
  const pool = NativeBytesStore.poolStatus();
  assert.equal(pool.stores, before + 3, 'every page store is served by the one pooled worker');
  assert.notEqual(pool.threadId, null);
  for (const device of devices) await device.close();
  assert.equal(NativeBytesStore.poolStatus().stores, before);

  const other = await openSharedSigner(join(root, 'other', 'identity.sqlite'), { create: true });
  await assert.rejects(openPageDevice({ path: join(root, 'pages', 'aaaaaaaaaaaa', 'device.sqlite'), signer: other }),
    'a page device resumes only with the agent signer it was created with');
  const resumed = await openPageDevice({ path: join(root, 'pages', 'aaaaaaaaaaaa', 'device.sqlite'), signer });
  assert.equal(resumed.identity.publicKey, signer.publicKey);
  await resumed.close();
});
