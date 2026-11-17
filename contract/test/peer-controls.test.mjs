import test from 'node:test';
import assert from 'node:assert/strict';
import { createPeersClient } from '../peers.mjs';
import { createClient } from '../client.mjs';

const applicationId = '11'.repeat(32);
const bundle = { descriptor: { payload: { applicationId, profile: 'peer-generation-v1', definitionDigest: 'digest' }, signature: 'signed' }, controls: [], generations: [] };
const definition = { descriptor: bundle.descriptor, definition: { id: 'test', version: '1', schema: null, commands: [], queries: [] }, schema: null };
const generation = { id: 'generation', payload: { profile: 'peer-generation-v1' }, signature: 'signed' };
const reply = (request, payload) => JSON.parse(JSON.stringify({ ...request, payload }));

test('domain control methods use one scoped participant boundary and preserve exact signed retry bytes', async () => {
  const calls = [];
  const client = createPeersClient({ applicationId, base: 'https://host.test', request: async (path, options) => {
    calls.push({ path, options });
    return reply(options.body, options.body.action === 'definition' ? definition : ['select', 'administer'].includes(options.body.action) ? generation : bundle);
  } });
  assert.equal(calls.length, 0);
  assert.deepEqual(await client.application(), bundle);
  const config = { historyId: 'history', executionManifestDigest: '12'.repeat(32), definition: definition.definition,
    schemaAdministrator: '34'.repeat(32), schema: null, epoch: 0, keyDigest: '56'.repeat(32), members: [{ publicKey: '34'.repeat(32) }] };
  assert.deepEqual(await client.configureApplication(config), bundle);
  assert.deepEqual(calls[1].options.body.payload, config);
  const request = { payload: { transitionId: 'same-transition' }, signature: 'original' }, control = { epoch: 1 };
  assert.deepEqual(await client.selectGeneration(request, { control }), generation);
  assert.deepEqual(await client.selectGeneration(request, { control }), generation);
  assert.deepEqual(calls[2].options.body.payload, { request, control });
  assert.deepEqual(calls[2].options.body.payload, calls[3].options.body.payload);
  const transition = { transitionId: 'owner-recovery', coordinator: 'real-peer', expectedGeneration: 'previous' };
  assert.deepEqual(await client.administerGeneration(transition, { control }), generation);
  assert.deepEqual(calls[4].options.body.payload, { transition, control });
  assert.deepEqual(await client.definition(), definition);
  assert.deepEqual(calls.map(({ path, options }) => [path, options.method, options.body.facet, options.body.action]), [
    ['peers/participant', 'POST', 'control', 'read'], ['peers/participant', 'POST', 'control', 'configure'],
    ['peers/participant', 'POST', 'control', 'select'], ['peers/participant', 'POST', 'control', 'select'],
    ['peers/participant', 'POST', 'control', 'administer'], ['peers/participant', 'POST', 'publication', 'definition'],
  ]);
  for (const { options } of calls) assert.equal(options.body.applicationId, applicationId);
});

test('missing or invalid participant scope and data interests fail before HTTP without breaking construction', async () => {
  let calls = 0;
  const client = createPeersClient({ base: 'https://host.test', request: async () => { calls++; } });
  await assert.rejects(client.application(), { code: 'PEER_PARTICIPANT_SCOPE_INVALID' });
  assert.throws(() => client.participant('not-a-generation-id'), { code: 'PEER_PARTICIPANT_SCOPE_INVALID' });
  await assert.rejects(client.participant(applicationId).request('database', 'submit', {}), { code: 'PEER_PARTICIPANT_FACET_FORBIDDEN' });
  assert.equal(calls, 0);
  assert.equal(typeof client.rendezvous, 'function');
  assert.equal(typeof client.listenInvitations, 'function');
});

test('rejects malformed authority and a response bound to a different request before exposing its payload', async () => {
  const client = createPeersClient({ applicationId, base: 'https://host.test', request: async (_path, options) =>
    reply(options.body, { descriptor: { payload: { profile: 'unknown' } }, controls: [], generations: [] }) });
  await assert.rejects(client.application(), { code: 'invalid_response' });
  await assert.rejects(client.definition(), { code: 'invalid_response' });
  await assert.rejects(client.selectGeneration({}), { code: 'invalid_response' });
  await assert.rejects(client.administerGeneration({}), { code: 'invalid_response' });
  const foreign = createPeersClient({ applicationId, base: 'https://host.test', request: async (_path, options) =>
    reply({ ...options.body, applicationId: '22'.repeat(32) }, bundle) });
  await assert.rejects(foreign.application(), { code: 'PEER_PARTICIPANT_RESPONSE_MISMATCH' });
});

test('definition reads stay explicit and reject missing immutable metadata', async () => {
  const calls = [];
  let response = definition;
  const client = createPeersClient({ applicationId, base: 'https://host.test', request: async (path, options) => {
    calls.push({ path, options }); return reply(options.body, response);
  } });
  assert.deepEqual(calls, []);
  assert.deepEqual(await client.definition(), definition);
  assert.equal(calls.length, 1);
  for (const invalid of [null, { ...definition, definition: null }, { ...definition, definition: { ...definition.definition, queries: null } },
    { ...definition, descriptor: { ...definition.descriptor, signature: undefined } }, { ...definition, schema: undefined }, { ...definition, schema: [] }]) {
    response = invalid;
    await assert.rejects(client.definition(), { code: 'invalid_response' });
  }
});

test('signed publication methods preserve manifest and assets through the participant port', async () => {
  const publication = { id: 'published', signature: 'signature', payload: { profile: 'peer-generation-v1' } }, assets = [{ hash: 'asset', bytes: 'YQ==' }];
  let selected = null;
  const calls = [];
  const client = createPeersClient({ applicationId, base: 'https://host.test', request: async (_path, options) => {
    calls.push(options.body);
    if (options.body.action === 'publish') selected = { publication: options.body.payload.publication, version: 1 };
    return reply(options.body, selected);
  } });
  assert.equal(await client.publication(), null);
  assert.deepEqual(await client.publishPublication(publication, assets), { publication, version: 1 });
  assert.deepEqual(await client.publication(), { publication, version: 1 });
  assert.deepEqual(calls[1].payload, { publication, assets });
});

test('the agent SDK binds its participant port to the creation handle without an identity preflight', async () => {
  const calls = [];
  const client = createClient({ api: 'https://host.test/api/t/page', token: 'private', application: { kind: 'peer', id: applicationId } }, {
    fetch: async (url, options) => {
      const envelope = JSON.parse(options.body); calls.push({ url, options, envelope });
      return Response.json(reply(envelope, bundle));
    },
  });
  assert.equal(calls.length, 0);
  assert.deepEqual(await client.peers.application(), bundle);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://host.test/api/t/page/peers/participant');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer private');
  assert.equal(calls[0].envelope.applicationId, applicationId);
});
