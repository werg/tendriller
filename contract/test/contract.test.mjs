import test from 'node:test';
import assert from 'node:assert/strict';
import { validate, assertValid, CONTRACT_VERSION } from '../index.mjs';
import { createAgentClient, describeService, requireService } from '../client.mjs';
const application = { id: '12'.repeat(32) };
const credential = { service: 'https://host.test', token: 'ta_' + 'a'.repeat(32) };
test('agent registration and page creation schemas reject unknown or malformed fields', () => {
  assertValid('agentRegistration', { owner: 'owner@example.test', handle: 'laptop', bio: 'Dev agent', publicKey: 'A'.repeat(43) });
  assertValid('agentPageCreate', { name: 'Notes' }); assertValid('agentPageCreate', {});
  assertValid('agentPageCreate', { name: 'Board', mode: 'dashboard', application: { id: 'ab'.repeat(32) } });
  for (const body of [{ mode: 'hosted' }, { application: { id: 'AB'.repeat(32) } }, { application: { id: 'ab'.repeat(32), extra: true } }])
    assert.ok(validate('agentPageCreate', body).length);
  for (const body of [{ owner: 'bad', handle: 'ab', publicKey: 'A'.repeat(43) }, { owner: 'owner@example.test', handle: 'Bad!', publicKey: 'A'.repeat(43) },
    { owner: 'owner@example.test', handle: 'ab', publicKey: 'ab'.repeat(32) },
    { owner: 'owner@example.test', handle: 'ab', publicKey: 'A'.repeat(43), token: 'ta_' }]) assert.ok(validate('agentRegistration', body).length);
  assert.ok(validate('agentPageCreate', { name: 'x', owner: 'owner@example.test' }).length);
});
test('the host SDK starts no traffic and exposes only explicit host and participant services', async () => {
  const calls = [], fetch = async (url, options) => { calls.push({ url, options }); return Response.json({ id: 'page' }); };
  const client = createAgentClient(credential, { fetch }).page('aaaaaaaaaaaa', { applicationId: application.id });
  assert.equal(calls.length, 0);
  assert.deepEqual(Object.keys(client).sort(), ['base', 'fetch', 'id', 'info', 'peers', 'request', 'service', 'socket']);
  assert.deepEqual(await client.info(), { id: 'page' });
  assert.equal(calls[0].options.headers.Authorization, 'Bearer ' + credential.token);
  assert.equal(calls[0].url, 'https://host.test/api/agent/pages/aaaaaaaaaaaa');
});
test('service metadata and structured failures are checked without inventing application capabilities', async () => {
  const descriptor = { contract: CONTRACT_VERSION, core_release: 'test', limits: {} };
  assert.deepEqual(await describeService('https://host.test', { fetch: async () => Response.json(descriptor) }), descriptor);
  assert.equal(requireService(descriptor), descriptor);
  assert.throws(() => requireService({ ...descriptor, contract: -1 }), { code: 'contract_mismatch' });
  const denied = createAgentClient(credential, { fetch: async () => Response.json({ error: { code: 'forbidden', message: 'No access' } }, { status: 403 }) }).page('aaaaaaaaaaaa');
  await assert.rejects(denied.info(), { status: 403, code: 'forbidden', message: 'No access' });
  const broken = createAgentClient(credential, { fetch: async () => new Response('not json') }).page('aaaaaaaaaaaa');
  await assert.rejects(broken.info(), { code: 'invalid_response' });
});
