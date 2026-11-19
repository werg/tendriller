import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { callbackUrl, publicAddress, publicLookup, webhookKey, signedHeaders, verifyCallback, deliveryDisposition } from '../webhooks.mjs';

const secret = 'whsec_' + Buffer.alloc(32, 7).toString('base64');
test('HTTPS callbacks reject credentials, private and special IPv4/IPv6 destinations', () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '100.64.0.2', '192.0.2.1', '203.0.113.1', '224.1.1.1',
    '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '2001:db8::1', '2002:7f00:1::1', '3fff::1']) assert.equal(publicAddress(address), false, address);
  assert.equal(publicAddress('8.8.8.8'), true);
  assert.equal(publicAddress('2606:4700:4700::1111'), true);
  for (const url of ['http://example.com', 'https://name:secret@example.com', 'https://example.com/#fragment', 'https://127.1', 'https://[::1]/'])
    assert.throws(() => callbackUrl(url));
});

test('socket lookup validates every DNS answer and returns exact checked addresses', async () => {
  const invoke = (lookup, all = false) => new Promise((resolve, reject) => lookup('callback.example', { all }, (error, address, family) => error ? reject(error) : resolve({ address, family })));
  const addresses = [{ address: '8.8.8.8', family: 4 }];
  assert.deepEqual(await invoke(publicLookup(async () => addresses)), { address: '8.8.8.8', family: 4 });
  assert.deepEqual((await invoke(publicLookup(async () => addresses), true)).address, addresses);
  await assert.rejects(invoke(publicLookup(async () => [...addresses, { address: '10.0.0.1', family: 4 }])), /public/);
  await assert.rejects(invoke(publicLookup(async () => [])), /public/);
});

test('Standard Webhooks signs exact bytes and preserves multi-key rotation', () => {
  const body = '{"question":"soup?"}', options = { id: 'evt_1', subscriptionId: 'sub_1', body, secrets: [secret], now: 1700000000000 };
  const headers = signedHeaders(options);
  const signature = createHmac('sha256', Buffer.alloc(32, 7)).update('evt_1.1700000000.' + body).digest('base64');
  assert.equal(headers['webhook-signature'], 'v1,' + signature);
  assert.equal(headers['webhook-id'], 'evt_1');
  assert.equal(signedHeaders({ ...options, secrets: [secret, 'whsec_' + Buffer.alloc(24).toString('base64')] })['webhook-signature'].split(' ').length, 2);
  for (const invalid of ['bad', 'whsec_Zg==', 'whsec_' + Buffer.alloc(65).toString('base64'), secret + 'junk']) assert.throws(() => webhookKey(invalid));
});

test('challenge verification requires signed request, successful status and exact echo', async () => {
  const common = { subscriptionId: 'sub_1', url: 'https://callback.example', secret };
  await verifyCallback({ ...common, send: async (_url, { body, headers }) => {
    assert.ok(headers['webhook-signature'].startsWith('v1,'));
    assert.ok(headers['webhook-id'].startsWith('verify_'));
    return { status: 200, body: JSON.stringify({ challenge: JSON.parse(body).challenge }) };
  } });
  await assert.rejects(verifyCallback({ ...common, send: async () => ({ status: 200, body: '{"challenge":"wrong"}' }) }), error => error.rpcCode === -32015 && error.data.reason === 'challenge_failed');
  assert.equal(deliveryDisposition(204), 'accepted');
  assert.equal(deliveryDisposition(410), 'gone');
  assert.equal(deliveryDisposition(413), 'failed');
  assert.equal(deliveryDisposition(503), 'retry');
});
