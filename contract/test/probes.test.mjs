import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, ApiError } from '../client.mjs';
import { ContractError } from '../index.mjs';

test('probe client recovers current diagnostics and validates nonces and response envelopes', async () => {
  const nonce = 'a'.repeat(20), api = 'https://example.test/api/t/example', calls = [];
  const probe = { nonce, seq: 2, created_at: 1, ack_at: null, status_url: `${api}/wake/probe/${nonce}`, ack_url: `${api}/wake/probe/${nonce}/ack` };
  const client = createClient({ api, token: 'private' }, { fetch: async (url, options) => {
    calls.push({ url, options }); return Response.json(probe);
  } });
  assert.deepEqual(await client.probeDelivery(), probe);
  assert.deepEqual(await client.checkDeliveryProbe(), probe);
  assert.deepEqual(await client.checkDeliveryProbe(nonce), probe);
  assert.deepEqual(await client.acknowledgeDeliveryProbe(nonce), probe);
  assert.deepEqual(calls.map(call => [call.options.method, call.url.slice(api.length)]), [
    ['POST', '/wake/probe'], ['GET', '/wake/probe'], ['GET', `/wake/probe/${nonce}`], ['POST', `/wake/probe/${nonce}/ack`],
  ]);
  for (const value of ['', null, '../tokens', 'a'.repeat(19)]) {
    assert.throws(() => client.checkDeliveryProbe(value), ContractError);
    assert.throws(() => client.acknowledgeDeliveryProbe(value), ContractError);
  }
  assert.equal(calls.length, 4);
  const malformed = createClient({ api, token: 'private' }, { fetch: async () => Response.json({ nonce }) });
  await assert.rejects(malformed.checkDeliveryProbe(), error => error instanceof ApiError && error.code === 'invalid_response');
});
