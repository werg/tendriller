import test from 'node:test';
import assert from 'node:assert/strict';
import { validate, assertValid, CONTRACT_VERSION } from '../index.mjs';
import { createPage, createClient, describeService, requireService } from '../client.mjs';
const application = { id: '12'.repeat(32) };
const handle = { id: 'page', api: 'https://host.test/api/tendrils/page', token: 'secret', page_url: 'https://page.test/p/key/', application };
test('creation accepts only application identity and validates owner and explicit fields', () => {
  assertValid('create', { owner: 'owner@example.test', application });
  for (const body of [{ owner: 'bad' }, { owner: 'a b@example.test' }, { owner: 'owner@example.test', state: {} },
    { owner: 'owner@example.test', application: { kind: 'peer', ...application } }]) assert.ok(validate('create', body).length);
});
test('the host SDK starts no traffic and exposes only explicit host and participant services', async () => {
  const calls = [], fetch = async (url, options) => { calls.push({ url, options }); return Response.json({ id: 'page' }); };
  const client = createClient(handle, { fetch, applicationId: application.id });
  assert.equal(calls.length, 0);
  assert.deepEqual(Object.keys(client).sort(), ['info', 'peers', 'request', 'service']);
  assert.deepEqual(await client.info(), { id: 'page' });
  assert.equal(calls[0].options.headers.Authorization, 'Bearer secret');
  assert.equal(calls[0].url, handle.api);
});
test('creation validates both directions and returns the stable application identity', async () => {
  const calls = [];
  assert.deepEqual(await createPage('https://host.test/', { owner: 'owner@example.test' }, { fetch: async (...args) => { calls.push(args); return Response.json(handle, { status: 201 }); } }), handle);
  assert.equal(calls[0][0], 'https://host.test/api/tendrils');
  await assert.rejects(createPage('https://host.test', { owner: 'owner@example.test' }, { fetch: async () => Response.json({ ...handle, application: undefined }) }), { code: 'invalid_response' });
  await assert.rejects(createPage('https://host.test', { owner: 'bad' }, { fetch: async () => { throw Error('must not send'); } }), { name: 'ContractError' });
});
test('service metadata and structured failures are checked without inventing application capabilities', async () => {
  const descriptor = { contract: CONTRACT_VERSION, core_release: 'test', limits: {} };
  assert.deepEqual(await describeService('https://host.test', { fetch: async () => Response.json(descriptor) }), descriptor);
  assert.equal(requireService(descriptor), descriptor);
  assert.throws(() => requireService({ ...descriptor, contract: -1 }), { code: 'contract_mismatch' });
  const denied = createClient(handle, { fetch: async () => Response.json({ error: { code: 'forbidden', message: 'No access' } }, { status: 403 }) });
  await assert.rejects(denied.info(), { status: 403, code: 'forbidden', message: 'No access' });
  const broken = createClient(handle, { fetch: async () => new Response('not json') });
  await assert.rejects(broken.info(), { code: 'invalid_response' });
});
