import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BROWSER_RTC_PROTOCOL, checkRtcMessage, createTabRtcEndpoint,
  createWorkerRtcOpener, MAX_RTC_MESSAGE_BYTES, startTabRtcHost,
} from '../../session/browser-rtc.mjs';

test('opaque binary RTC messages enforce finite bounds and reject cycles/non-plain prototypes', () => {
  checkRtcMessage({ ok: true, bytes: new Uint8Array(1024), list: [1, 'two', null] });
  assert.throws(() => checkRtcMessage(new Uint8Array(MAX_RTC_MESSAGE_BYTES + 1)), /RTC_MESSAGE_LIMIT/);
  const cycle = {}; cycle.self = cycle;
  assert.throws(() => checkRtcMessage(cycle), /RTC_MESSAGE_INVALID/);
  assert.throws(() => checkRtcMessage(new Map()), /RTC_MESSAGE_INVALID/);
});

test('1:1 tab RTC host and worker RTC opener demultiplex isolated RTC messages and forward network changes', async () => {
  const left = new EventTarget(), right = new EventTarget();
  left.postMessage = data => queueMicrotask(() => right.dispatchEvent(new MessageEvent('message', { data })));
  right.postMessage = data => queueMicrotask(() => left.dispatchEvent(new MessageEvent('message', { data })));

  const stop = new AbortController();
  const leftEp = createTabRtcEndpoint(left, { signal: stop.signal });
  const rightEp = createTabRtcEndpoint(right, { signal: stop.signal });

  const received = [];
  rightEp.addEventListener('message', ({ data }) => received.push(data));
  leftEp.postMessage({ hello: 'rtc' });
  left.postMessage({ protocol: 'other-protocol', type: 'rtc', payload: { ignored: true } });
  await new Promise(r => setTimeout(r, 15));
  assert.deepEqual(received, [{ hello: 'rtc' }]);

  let networkChanges = 0;
  const opener = createWorkerRtcOpener(right, { signal: stop.signal, onNetworkChange: () => { networkChanges++; } });
  const host = startTabRtcHost(left, { signal: stop.signal });
  assert.equal(typeof opener.openDirectConnection, 'function');
  assert.deepEqual(host.peers(), []);
  left.postMessage({ protocol: BROWSER_RTC_PROTOCOL, type: 'network-change' });
  await new Promise(r => setTimeout(r, 15));
  assert.equal(networkChanges, 1);

  await host.close();
  opener.close();
  stop.abort();
});
