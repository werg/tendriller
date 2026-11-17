import test from 'node:test';
import assert from 'node:assert/strict';
import { createPeersClient, peerAccountBindingsContext } from '../peers.mjs';

test('device transition context binds canonical account additions without interpreting authority', () => {
  const a = { publicKey: '11'.repeat(32), accountId: 'owner' }, b = { publicKey: '22'.repeat(32), accountId: 'guest' };
  assert.equal(peerAccountBindingsContext(), null);
  assert.equal(peerAccountBindingsContext([]), null);
  assert.deepEqual(peerAccountBindingsContext([b, a]), { kind: 'tendriller-account-bindings/v1', accounts: [a, b] });
  assert.deepEqual(peerAccountBindingsContext([b, a]), peerAccountBindingsContext([a, b]));
  assert.notDeepEqual(peerAccountBindingsContext([a]), peerAccountBindingsContext([{ ...a, accountId: 'another-account' }]));
  for (const input of [null, [a, a], [{ ...a, administrator: true }], [{ publicKey: a.publicKey }], [{ ...a, accountId: '' }]])
    assert.throws(() => peerAccountBindingsContext(input), { code: 'invalid_account_bindings' });
});

test('peer control transport is explicit, carries exact transition bytes, and never submits a command', async () => {
  const calls = [], bundle = { descriptor: { payload: { profile: 'peer-generation-v1' } }, controls: [], generations: [] };
  const generation = { id: 'generation', payload: { profile: 'peer-generation-v1' }, signature: 'signed' };
  const client = createPeersClient({ base: 'https://host.test', request: async (path, options) => {
    calls.push({ path, options }); return ['peers/generations', 'peers/administration'].includes(path) ? generation : bundle;
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
  const transition = { transitionId: 'owner-recovery', coordinator: 'real-peer', expectedGeneration: 'previous' };
  assert.equal(await client.administerGeneration(transition, { control }), generation);
  assert.deepEqual(calls[4], { path: 'peers/administration', options: { method: 'POST', body: { transition, control } } });
});

test('peer control transport refuses malformed or foreign-profile authority responses', async () => {
  const client = createPeersClient({ base: 'https://host.test', request: async () => ({ descriptor: { payload: { profile: 'unknown' } }, controls: [], generations: [] }) });
  await assert.rejects(client.application(), { code: 'invalid_response' });
  await assert.rejects(client.selectGeneration({}), { code: 'invalid_response' });
  await assert.rejects(client.administerGeneration({}), { code: 'invalid_response' });
});
