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

test('startTabRtcHost.closeNow synchronously closes tracked RTCPeerConnections on page unload', async () => {
  const left = new EventTarget(), right = new EventTarget();
  left.postMessage = data => queueMicrotask(() => right.dispatchEvent(new MessageEvent('message', { data })));
  right.postMessage = data => queueMicrotask(() => left.dispatchEvent(new MessageEvent('message', { data })));

  const created = [];
  const fakePeerConnection = () => {
    const pc = Object.assign(new EventTarget(), {
      closed: false,
      connectionState: 'connecting',
      signalingState: 'stable',
      iceGatheringState: 'new',
      localDescription: null,
      createDataChannel: (label, opts = {}) => Object.assign(new EventTarget(), {
        label,
        ordered: opts.ordered ?? true,
        maxRetransmits: opts.maxRetransmits ?? null,
        maxPacketLifeTime: opts.maxPacketLifeTime ?? null,
        readyState: 'connecting',
        bufferedAmount: 0,
        bufferedAmountLowThreshold: 0,
        binaryType: 'arraybuffer',
        send() {},
        close() {},
      }),
      createOffer: () => new Promise(() => {}),
      setLocalDescription: async desc => { pc.localDescription = desc; },
      setRemoteDescription: async () => {},
      addIceCandidate: async () => {},
      close() {
        pc.closed = true;
        pc.connectionState = 'closed';
        pc.signalingState = 'closed';
        pc.dispatchEvent(new Event('connectionstatechange'));
      },
    });
    created.push(pc);
    return pc;
  };

  const stop = new AbortController();
  const host = startTabRtcHost(left, { signal: stop.signal, createPeerConnection: fakePeerConnection });
  const opener = createWorkerRtcOpener(right, { signal: stop.signal });
  const openPromise = opener.openDirectConnection({
    role: 'offerer',
    signaling: { ready: Promise.resolve({ role: 'offerer' }), messages: { async *[Symbol.asyncIterator]() { await new Promise(() => {}); } }, send: async () => {}, close() {} },
    signal: stop.signal,
    timeoutMs: 5000,
  }).catch(() => {});

  const deadline = Date.now() + 2000;
  while (created.length === 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
  assert.equal(created.length, 1);
  assert.equal(created[0].closed, false);

  // Synchronous closeNow() must immediately call pc.close() before any microtask.
  host.closeNow();
  assert.equal(created[0].closed, true);

  stop.abort();
  await host.close();
  opener.close();
  await openPromise;
});
