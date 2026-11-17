import test from 'node:test';
import assert from 'node:assert/strict';
import { createPeersClient } from '../peers.mjs';

test('peer control transport is explicit, carries exact transition bytes, and never submits a command', async () => {
  const calls = [], bundle = { descriptor: { payload: { profile: 'peer-generation-v1' } }, controls: [], generations: [] };
  const publication = { descriptor: bundle.descriptor, definition: { id: 'test', version: '1', schema: null, commands: [], queries: [] }, schema: null };
  const generation = { id: 'generation', payload: { profile: 'peer-generation-v1' }, signature: 'signed' };
  const client = createPeersClient({ base: 'https://host.test', request: async (path, options) => {
    calls.push({ path, options }); return path === 'peers/definition' ? publication : ['peers/generations', 'peers/administration'].includes(path) ? generation : bundle;
  } });
  assert.equal(calls.length, 0);
  assert.equal(await client.application(), bundle);
  const config = { historyId: 'history', executionManifestDigest: '12'.repeat(32), definition: publication.definition,
    schemaAdministrator: '34'.repeat(32), schema: null, epoch: 0, keyDigest: '56'.repeat(32), members: [{ publicKey: '34'.repeat(32) }] };
  assert.equal(await client.configureApplication(config), bundle);
  assert.deepEqual(calls[1], { path: 'peers/application', options: { method: 'PUT', body: config } });
  const request = { payload: { transitionId: 'same-transition' }, signature: 'original' }, control = { epoch: 1 };
  assert.equal(await client.selectGeneration(request, { control }), generation);
  assert.equal(await client.selectGeneration(request, { control }), generation);
  assert.deepEqual(calls[2], { path: 'peers/generations', options: { method: 'POST', body: { request, control } } });
  assert.deepEqual(calls[2], calls[3]);
  const transition = { transitionId: 'owner-recovery', coordinator: 'real-peer', expectedGeneration: 'previous' };
  assert.equal(await client.administerGeneration(transition, { control }), generation);
  assert.deepEqual(calls[4], { path: 'peers/administration', options: { method: 'POST', body: { transition, control } } });
  assert.equal(await client.definition(), publication);
  assert.deepEqual(calls[5], { path: 'peers/definition', options: undefined });
});

test('peer control transport refuses malformed or foreign-profile authority responses', async () => {
  const client = createPeersClient({ base: 'https://host.test', request: async () => ({ descriptor: { payload: { profile: 'unknown' } }, controls: [], generations: [] }) });
  await assert.rejects(client.application(), { code: 'invalid_response' });
  await assert.rejects(client.selectGeneration({}), { code: 'invalid_response' });
  await assert.rejects(client.administerGeneration({}), { code: 'invalid_response' });
  await assert.rejects(client.definition(), { code: 'invalid_response' });
});
