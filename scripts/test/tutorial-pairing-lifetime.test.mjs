import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { superviseParticipant } from '../../docs/tutorial/shared/participant-lifecycle.mjs';
import { createAgentClient } from '../../contract/client.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const built = await build({ entryPoints: [root + 'docs/tutorial/shared/pairing-native.mjs'], bundle: true,
  write: false, platform: 'node', format: 'esm', logLevel: 'silent', plugins: [{ name: 'retained-fixture', setup(builder) {
    builder.onResolve({ filter: /^\.\/local\.mjs$/ }, () => ({ path: 'private', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents:
      'export const readPrivate=()=>{throw Error("Unexpected private read")};export const savePrivate=readPrivate;' }));
    builder.onResolve({ filter: /^@tendriller\/core\/pairing$/ }, () => ({ path: root + 'contract/pairing.mjs' }));
  } }] });
const native = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));

for (const ending of ['close', 'abort']) test(`pairing ${ending} cancels its blocked authority HTTP read and preserves the durable pause`, { timeout: 3_000 }, async () => {
  const applicationId = '11'.repeat(32), pairingId = '22'.repeat(32);
  const base = 'https://service.example/api/agent/pages/aaaaaaaaaaaa';
  const expiresAt = Date.now() + 600_000;
  const status = { pairingId, requestId: 'retained-browser-request', state: 'pending', expiresAt, nextAction: 'Review the exact proposal',
    challenge: { pairingId, requestId: 'retained-browser-request', applicationId, serviceOrigin: 'https://service.example',
      pageOrigin: 'https://aaaaaaaaaaaa.pages.example', rights: { reader: true, writer: true }, expiresAt } };
  const pause = { operationId: 'pairing:' + pairingId, generation: '33'.repeat(32), base: { retained: true } };
  const entered = Promise.withResolvers(), response = Promise.withResolvers();
  let requestSignal, aborted = false, requests = 0, pendingRequests = 0, resumed = 0;
  const host = createAgentClient({ service: 'https://service.example', token: 'ta_' + 'a'.repeat(32) }, { fetch: async (url, { signal }) => {
    assert.equal(url, base + '/peers/participant');
    requests++; requestSignal = signal;
    const abort = () => { aborted = true; response.reject(signal.reason); };
    signal?.addEventListener('abort', abort, { once: true });
    // AbortSignal.timeout deliberately does not keep Node alive. Model the
    // reference owned by blocked HTTP I/O, with a bounded fixture watchdog.
    const watchdog = setTimeout(() => response.reject(Error('Authority request was not cancelled')), 1_000);
    pendingRequests++;
    entered.resolve();
    try { return await response.promise; }
    finally { clearTimeout(watchdog); signal?.removeEventListener('abort', abort); pendingRequests--; }
  } }).page('aaaaaaaaaaaa', { applicationId });
  const session = {
    orderingPause: async () => structuredClone(pause),
    pauseOrdering: async () => { throw Error('The original pause already exists'); },
    resumeOrdering: async () => { resumed++; },
  };
  const pairing = { applicationId, serviceOrigin: 'https://service.example', pageOrigin: 'https://aaaaaaaaaaaa.pages.example',
    descriptor: {}, authority: options => host.peers.application(options), signTransition: () => { throw Error('No signature expected'); },
    client: { inspect: async () => structuredClone(status) } };
  const process = native.createReviewedPairingProcessor({ session, pairing,
    store: { load: async () => { throw Error('No authority result was received'); },
      save: async () => { throw Error('No private evidence may be changed'); } } });
  const stop = new AbortController(), channelClosed = Promise.withResolvers();
  const loop = superviseParticipant({ owned: { session, processPairings: process }, signal: stop.signal,
    watch({onChange}) { queueMicrotask(() => onChange({type:'setup',version:1,assistant:{proposalId:null,approved:false,revision:null}}));
      return {closed:channelClosed.promise, close(){channelClosed.resolve();}}; } });
  try {
    await entered.promise;
    assert.ok(requestSignal instanceof AbortSignal, 'the helper signal reaches the public host fetch');
    if (ending === 'close') await loop.close(); else { stop.abort(); await loop.done; }
    assert.equal(aborted, true);
    assert.equal(requestSignal.reason.name, 'AbortError');
    assert.equal(pendingRequests, 0, 'the cancelled request releases its fixture-owned timer and listener');
    assert.equal(requests, 1, 'the ended window does not start another authority read');
    assert.equal(resumed, 0, 'cancelling inspection cannot release uncertain ordering');
    assert.deepEqual(await session.orderingPause(), pause);
  } finally {
    response.reject(Error('Fixture cleanup'));
    await loop.close();
  }
});
