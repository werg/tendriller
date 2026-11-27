import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSharedSigner, openWrapKey, reenrollWorkspace } from '../lib/workspace.mjs';

test('reenrollWorkspace preserves existing signing/wrap keys, archives old credential and page refs, and never deletes local device stores', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ws-reenroll-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const agentDir = join(dir, '.tendriller/agent');
  const pageDir = join(dir, '.tendriller/pages/aaaaaaaaaaaa');
  await mkdir(agentDir, { recursive: true });
  await mkdir(pageDir, { recursive: true });
  const signer = await openSharedSigner(join(agentDir, 'identity.sqlite'), { create: true });
  const wrap = await openWrapKey(join(agentDir, 'wrap-key.json'), { create: true });

  await writeFile(join(dir, 'tendriller.json'), JSON.stringify({
    schemaVersion: 1,
    service: 'https://service.example',
    agent: { id: 'ag_' + 'a'.repeat(26), handle: 'atlas', bio: 'Old bio' },
    pages: { notes: { id: 'aaaaaaaaaaaa' } },
  }, null, 2));
  await writeFile(join(agentDir, 'credential.json'), JSON.stringify({
    schemaVersion: 1,
    service: 'https://service.example',
    agent: { id: 'ag_' + 'a'.repeat(26), handle: 'atlas', bio: 'Old bio' },
    token: 'ta_' + 'a'.repeat(32),
    publicKey: signer.publicKey,
    wrapKey: wrap.publicKey,
  }, null, 2));
  await writeFile(join(pageDir, 'device.sqlite'), 'retained-local-v1-bytes');

  const newCredFile = join(dir, '.tendriller/new-cred.json');
  const newAgentId = 'ag_' + 'b'.repeat(26);
  const newToken = 'ta_' + 'b'.repeat(32);
  await writeFile(newCredFile, JSON.stringify({
    id: newAgentId,
    handle: 'atlas',
    bio: 'New bio',
    token: newToken,
  }));

  const fakeFetch = async (url, init) => {
    if (String(url).endsWith('/api/agent') && init?.headers?.Authorization === `Bearer ${newToken}`) {
      return new Response(JSON.stringify({ id: newAgentId, handle: 'atlas', bio: 'New bio' }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: { code: 'unauthorized' } }), { status: 401 });
  };

  const result = await reenrollWorkspace(dir, {
    service: 'https://service.example',
    credential: newCredFile,
    fetch: fakeFetch,
  });

  assert.equal(result.reenrolled, true);
  assert.equal(result.publicKey, signer.publicKey, 'Ed25519 signing key must be preserved');
  assert.equal(result.wrapKey, wrap.publicKey, 'X25519 wrap key must be preserved');
  assert.deepEqual(result.archivedPageSlugs, ['notes']);
  assert.ok(result.archivedCredential);
  assert.ok(result.archivedPagesFile);

  // Local device store must remain untouched and never silently deleted or replaced.
  assert.equal(await readFile(join(pageDir, 'device.sqlite'), 'utf8'), 'retained-local-v1-bytes');

  // New credential and cleared page map saved cleanly; old page map archived for explicit migration.
  const nextCfg = JSON.parse(await readFile(join(dir, 'tendriller.json'), 'utf8'));
  assert.equal(nextCfg.agent.id, newAgentId);
  assert.deepEqual(nextCfg.pages, {});
  const archivedPages = JSON.parse(await readFile(result.archivedPagesFile, 'utf8'));
  assert.deepEqual(archivedPages.pages, { notes: { id: 'aaaaaaaaaaaa' } });
});
