import test from 'node:test';
import assert from 'node:assert/strict';
import { createPeersClient, createPeerParticipantClient, createParticipantRequest, createParticipantResponse } from '../peers.mjs';
const applicationId = 'ab'.repeat(32);
const bundle = { descriptor: { payload: { profile: 'peer-generation-v1', definitionDigest: 'digest' }, signature: 'signed' }, controls: [], generations: [] };
const publication = { descriptor: bundle.descriptor, definition: { id: 'test', version: '1', schema: null, commands: [], queries: [] }, schema: null };
const generation = { id: 'generation', payload: { profile: 'peer-generation-v1' }, signature: 'signed' };

test('all controls use the filtered participant transport and preserve exact signed transition payloads', async () => {
  const calls = [];
  const client = createPeersClient({ base: 'https://host.test', applicationId, request: async (path, options) => {
    calls.push({ path, message: options.body });
    const message = options.body, result = message.facet === 'publication' ? publication
      : ['select', 'administer'].includes(message.action) ? generation : bundle;
    return createParticipantResponse(message, result);
  } });
  assert.equal(calls.length, 0);
  assert.deepEqual(await client.application(), bundle);
  const configuration = { historyId: 'history', definition: publication.definition };
  assert.deepEqual(await client.configureApplication(configuration), bundle);
  const request = { payload: { transitionId: 'same-transition' }, signature: 'original' }, control = { epoch: 1 };
  assert.deepEqual(await client.selectGeneration(request, { control }), generation);
  assert.deepEqual(await client.selectGeneration(request, { control }), generation);
  const transition = { transitionId: 'owner-recovery', coordinator: 'real-peer', expectedGeneration: 'previous' };
  assert.deepEqual(await client.administerGeneration(transition, { control }), generation);
  assert.deepEqual(await client.definition(), publication);
  assert.ok(calls.every(call => call.path === 'peers/participant' && call.message.applicationId === applicationId));
  assert.deepEqual(calls.map(({ message }) => [message.facet, message.action, message.payload]), [
    ['control', 'read', {}], ['control', 'configure', configuration],
    ['control', 'select', { request, control }], ['control', 'select', { request, control }],
    ['control', 'administer', { transition, control }], ['publication', 'definition', {}],
  ]);
});

test('peer control methods reject malformed evidence after transport correlation checks', async () => {
  const client = createPeersClient({ base: 'https://host.test', applicationId,
    request: async (_path, options) => createParticipantResponse(options.body, { descriptor: { payload: { profile: 'unknown' } }, controls: [], generations: [] }) });
  for (const call of [() => client.application(), () => client.definition(), () => client.selectGeneration({}), () => client.administerGeneration({})])
    await assert.rejects(call(), { code: 'invalid_response' });
});

test('unwanted facets fail before HTTP or application-scope discovery, and responses bind exact requests', async () => {
  let requests = 0;
  const client = createPeersClient({ base: 'https://host.test', request: async (_path, options) => {
    requests++; return { ...createParticipantResponse(options.body, bundle), requestId: 'wrong-request' };
  } });
  for (const [facet, action] of [['database', 'submit'], ['content', 'chunk'], ['ephemeral', 'signal']])
    await assert.rejects(client.exchange({ protocol: 'chronolog-participant-v1', applicationId, requestId: 'blocked', facet, action, payload: {} }), { code: 'PEER_PARTICIPANT_FACET_FORBIDDEN' });
  assert.equal(requests, 0);
  await assert.rejects(client.exchange(createParticipantRequest({ applicationId, facet: 'control', action: 'read', payload: {} })), { code: 'PEER_PARTICIPANT_RESPONSE_MISMATCH' });
  assert.equal(requests, 1);
});

test('immutable scope is discovered once for explicit convenience calls and the signed page release remains separate', async () => {
  const calls = [], receipt = { publication: { id: 'code-release' }, version: 4 };
  const client = createPeersClient({ base: 'https://host.test', request: async (path, options) => {
    calls.push(path);
    if (path === 'application') return { selection: { id: applicationId } };
    return createParticipantResponse(options.body, options.body.facet === 'publication' ? receipt : bundle);
  } });
  assert.deepEqual(calls, []);
  await client.application();
  assert.deepEqual(await client.publication(), receipt);
  assert.deepEqual(await client.publish({ id: 'code-release' }, []), receipt);
  assert.deepEqual(calls, ['application', 'peers/participant', 'peers/participant', 'peers/participant']);
});

test('cancelled calls and forbidden convenience facets never resolve scope or contact the host', async () => {
  let lookups = 0, requests = 0;
  const request = async () => { requests++; throw Error('Unexpected host request'); };
  for (const applicationId of [undefined, async () => { lookups++; return 'ab'.repeat(32); }]) {
    const client = createPeerParticipantClient({ applicationId, request });
    for (const [facet, action] of [['database', 'submit'], ['content', 'chunk'], ['ephemeral', 'signal']])
      await assert.rejects(client.request(facet, action, {}), { code: 'PEER_PARTICIPANT_FACET_FORBIDDEN' });
    const cancelled = new AbortController(); cancelled.abort(Error('session closed'));
    await assert.rejects(client.request('control', 'read', {}, { signal: cancelled.signal }), /session closed/);
    await assert.rejects(client.exchange(createParticipantRequest({ applicationId: 'ab'.repeat(32), facet: 'control', action: 'read', payload: {} }),
      { signal: cancelled.signal }), /session closed/);
  }
  assert.equal(lookups, 0); assert.equal(requests, 0);
});
