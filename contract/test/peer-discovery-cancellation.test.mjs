import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { createClient } from '../client.mjs';
import { createPeersClient, createParticipantResponse } from '../peers.mjs';

const applicationId = 'ab'.repeat(32);
const bundle = { descriptor: { payload: { profile: 'peer-generation-v1' } }, controls: [], generations: [] };
const selection = { selection: { id: applicationId } };
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

test('unpinned application cancellation aborts its HTTP discovery and a later call can retry', { timeout: 2_000 }, async () => {
  const entered = Promise.withResolvers(), caller = new AbortController(), reason = Error('window closed');
  let discoverySignal, lookups = 0, reads = 0;
  const host = createClient({ api: 'https://host.test/api/t/aaaaaaaaaaaa', token: 'synthetic-test-token' }, {
    fetch: async (url, options) => {
      if (url.endsWith('/application')) {
        lookups++;
        if (lookups > 1) return json(selection);
        discoverySignal = options.signal;
        entered.resolve();
        return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
      }
      assert.equal(url, 'https://host.test/api/t/aaaaaaaaaaaa/peers/participant');
      reads++;
      return json(createParticipantResponse(JSON.parse(options.body), bundle));
    },
  });
  const rejected = assert.rejects(host.peers.application({ signal: caller.signal }), error => error === reason);
  await entered.promise;
  assert.ok(discoverySignal instanceof AbortSignal);
  assert.notEqual(discoverySignal, caller.signal, 'the shared lookup owns an independent cancellation signal');
  caller.abort(reason);
  await rejected;
  assert.equal(discoverySignal.aborted, true);
  assert.equal(reads, 0);
  assert.deepEqual(await host.peers.application(), bundle);
  assert.deepEqual(await host.peers.application(), bundle);
  assert.equal(lookups, 2, 'abandoned lookup is retried once, then the successful scope is cached');
  assert.equal(reads, 2);
});

test('one cancelled caller leaves a concurrent unsignalled caller and its shared lookup intact', { timeout: 2_000 }, async () => {
  const entered = Promise.withResolvers(), discovery = Promise.withResolvers(), caller = new AbortController();
  const reason = Error('only this caller stopped');
  let discoverySignal, lookups = 0, reads = 0;
  const client = createPeersClient({ base: 'https://host.test', request: async (path, options) => {
    if (path === 'application') {
      lookups++; discoverySignal = options.signal; entered.resolve(); return discovery.promise;
    }
    reads++; return createParticipantResponse(options.body, bundle);
  } });
  const rejected = assert.rejects(client.application({ signal: caller.signal }), error => error === reason);
  const survivor = client.application();
  await entered.promise;
  caller.abort(reason);
  await rejected;
  assert.equal(discoverySignal.aborted, false);
  assert.equal(reads, 0);
  discovery.resolve(selection);
  assert.deepEqual(await survivor, bundle);
  assert.deepEqual(await client.application(), bundle);
  assert.equal(lookups, 1);
  assert.equal(reads, 2, 'only the remaining caller and later cached read reach authority transport');
});

test('discovery is cancelled only after its final waiting caller aborts', { timeout: 2_000 }, async () => {
  const entered = Promise.withResolvers(), first = new AbortController(), second = new AbortController();
  const firstReason = Error('first ended'), secondReason = Error('last ended');
  let discoverySignal, reads = 0;
  const client = createPeersClient({ base: 'https://host.test', request: async (path, options) => {
    if (path !== 'application') { reads++; throw Error('Unexpected authority request'); }
    discoverySignal = options.signal; entered.resolve();
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  } });
  const rejectedFirst = assert.rejects(client.application({ signal: first.signal }), error => error === firstReason);
  const rejectedSecond = assert.rejects(client.application({ signal: second.signal }), error => error === secondReason);
  await entered.promise;
  first.abort(firstReason); await rejectedFirst;
  assert.equal(discoverySignal.aborted, false);
  second.abort(secondReason); await rejectedSecond;
  assert.equal(discoverySignal.aborted, true);
  assert.equal(discoverySignal.reason, secondReason);
  assert.equal(reads, 0);
});

test('late completion of an abandoned custom resolver cannot replace or clear a newer scope lookup', { timeout: 2_000 }, async () => {
  const old = Promise.withResolvers(), current = Promise.withResolvers();
  const oldEntered = Promise.withResolvers(), currentEntered = Promise.withResolvers(), caller = new AbortController();
  let lookups = 0;
  const scopes = [];
  const client = createPeersClient({ base: 'https://host.test', applicationId: () => {
    lookups++;
    if (lookups === 1) { oldEntered.resolve(); return old.promise; }
    currentEntered.resolve(); return current.promise;
  }, request: async (path, options) => {
    assert.equal(path, 'peers/participant');
    scopes.push(options.body.applicationId);
    return createParticipantResponse(options.body, bundle);
  } });
  const reason = Error('first resolver no longer needed');
  const rejected = assert.rejects(client.application({ signal: caller.signal }), error => error === reason);
  await oldEntered.promise;
  caller.abort(reason); await rejected;
  const replacement = client.application();
  await currentEntered.promise;
  old.resolve('cd'.repeat(32));
  await setImmediate();
  assert.deepEqual(scopes, [], 'abandoned discovery cannot start an authority read');
  current.resolve(applicationId);
  assert.deepEqual(await replacement, bundle);
  assert.deepEqual(await client.application(), bundle);
  assert.equal(lookups, 2);
  assert.deepEqual(scopes, [applicationId, applicationId]);
});

test('a shared discovery failure rejects its callers and leaves the next lookup usable', { timeout: 2_000 }, async () => {
  const entered = Promise.withResolvers(), discovery = Promise.withResolvers(), reason = Error('discovery unavailable');
  let lookups = 0;
  const client = createPeersClient({ base: 'https://host.test', request: async (path, options) => {
    if (path === 'application') {
      lookups++;
      if (lookups > 1) return selection;
      entered.resolve(); return discovery.promise;
    }
    return createParticipantResponse(options.body, bundle);
  } });
  const first = assert.rejects(client.application(), error => error === reason);
  const second = assert.rejects(client.application(), error => error === reason);
  await entered.promise;
  discovery.reject(reason);
  await Promise.all([first, second]);
  assert.deepEqual(await client.application(), bundle);
  assert.equal(lookups, 2);
});
