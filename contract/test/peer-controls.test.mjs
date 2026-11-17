import test from 'node:test';
import assert from 'node:assert/strict';
import { createPeersClient } from '../peers.mjs';

test('peer control transport is explicit, carries exact transition bytes, and never submits a command', async () => {
  const calls = [], bundle = { descriptor: { payload: { profile: 'peer-generation-v1' } }, controls: [], generations: [] };
  const generation = { id: 'generation', payload: { profile: 'peer-generation-v1' }, signature: 'signed' };
  const client = createPeersClient({ base: 'https://host.test', request: async (path, options) => {
    calls.push({ path, options }); return path === 'peers/generations' ? generation : bundle;
  } });
  assert.equal(calls.length, 0);
  assert.equal(await client.application(), bundle);
  const config = { definitionDigest: 'definition' };
  assert.equal(await client.configureApplication(config), bundle);
  const request = { payload: { transitionId: 'same-transition' }, signature: 'original' }, control = { epoch: 1 };
  assert.equal(await client.selectGeneration(request, { control }), generation);
  assert.equal(await client.selectGeneration(request, { control }), generation);
  assert.deepEqual(calls[2], { path: 'peers/generations', options: { method: 'POST', body: { request, control } } });
  assert.deepEqual(calls[2], calls[3]);
});

test('peer control transport refuses malformed or foreign-profile authority responses', async () => {
  const client = createPeersClient({ base: 'https://host.test', request: async () => ({ descriptor: { payload: { profile: 'unknown' } }, controls: [], generations: [] }) });
  await assert.rejects(client.application(), { code: 'invalid_response' });
  await assert.rejects(client.selectGeneration({}), { code: 'invalid_response' });
});
