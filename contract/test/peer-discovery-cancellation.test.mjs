import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentClient } from '../client.mjs';
import { createPeersClient } from '../peers.mjs';
const applicationId = 'ab'.repeat(32), metadata = { selection: { id: applicationId }, configuration: null, publicationAuthority: null, authority: null };
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
test('explicit host metadata cancellation aborts only that caller and a later read remains usable', async () => {
  const entered = Promise.withResolvers(), caller = new AbortController(), reason = Error('this view ended'); let requests = 0, observed;
  const host = createAgentClient({ service: 'https://host.test', token: 'ta_' + 'a'.repeat(32) }, { fetch: async (url, options) => {
    assert.equal(url, 'https://host.test/api/agent/pages/aaaaaaaaaaaa/application'); requests++;
    if (requests > 1) return json(metadata);
    observed = options.signal; entered.resolve(); return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  } }).page('aaaaaaaaaaaa');
  const rejected = assert.rejects(host.peers.application({ signal: caller.signal }), error => error === reason); await entered.promise; caller.abort(reason); await rejected; assert.equal(observed.aborted, true);
  assert.deepEqual(await host.peers.application(), metadata); assert.equal(requests, 2);
});
test('independent explicit metadata reads do not share or poison cancellation state', async () => {
  const first = new AbortController(), second = Promise.withResolvers(), entered = Promise.withResolvers(); let calls = 0;
  const peers = createPeersClient({ base: 'https://host.test', request: async (path, options) => {
    assert.equal(path, 'application'); if (++calls === 1) { entered.resolve(); return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })); }
    return second.promise;
  } });
  const rejected = assert.rejects(peers.application({ signal: first.signal }), /cancelled/); await entered.promise;
  const survivor = peers.application(); first.abort(Error('cancelled')); await rejected; second.resolve(metadata); assert.equal(await survivor, metadata); assert.equal(calls, 2);
});
test('client construction and initial bootstrap inspection perform no eager host fetch', () => {
  let calls = 0; const peers = createPeersClient({ base: 'https://host.test', initialBootstrap: { version: 2, endpoints: [] }, request() { calls++; throw Error('unexpected host read'); } });
  assert.deepEqual(peers.initialBootstrap, { version: 2, endpoints: [] }); assert.equal(calls, 0);
});
test('introduction routing and signed authority records never trigger a hidden application-scope lookup', async () => {
  const calls = [], peers = createPeersClient({ base: 'https://host.test', request: async (path, options) => { calls.push({ path, options }); return path === 'peers/discovery' ? { applicationId, peers: [] } : { record: '00' }; } });
  await peers.discover(); assert.deepEqual(calls[0], { path: 'peers/discovery', options: { method: 'POST', body: { action: 'read' }, signal: undefined } });
  const record = { record: '7b7d' }; await peers.participant(record); assert.deepEqual(calls[1], { path: 'peers/participant', options: { method: 'POST', body: record } });
  assert.equal(calls.some(call => call.path === 'application'), false);
});
