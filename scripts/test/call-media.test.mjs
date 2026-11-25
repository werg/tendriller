import test from 'node:test';
import assert from 'node:assert/strict';
import { callCommands, callQueries, callSignalTopics, mergeUtterances } from '../../docs/tutorial/shared/helpers/call-domain.mjs';
import { createRtpAudioPublisher, createRtpAudioReceiver, encodeWavPcm16, resampleInt16 } from '../../docs/tutorial/shared/media/native-audio.mjs';
import { followCall } from '../../docs/tutorial/shared/media/call-agent.mjs';
import { createMediaRoom } from '../../docs/tutorial/shared/media/call-room.mjs';

function makeSignalBus() {
  const subs = new Set();
  return {
    createPort(authorId) {
      return {
        async send(topic, payload) {
          const frame = { authorId, topic, payload };
          for (const sub of subs) {
            if (!sub.topics || sub.topics.includes(topic)) sub.push(frame);
          }
        },
        subscribe({ topics, signal } = {}) {
          const queue = [];
          let wake = null;
          let closed = false;
          const entry = {
            topics,
            push(item) { if (!closed) { queue.push(item); wake?.(); wake = null; } },
          };
          subs.add(entry);
          const stop = () => { closed = true; subs.delete(entry); wake?.(); wake = null; };
          signal?.addEventListener('abort', stop, { once: true });
          return {
            async *[Symbol.asyncIterator]() {
              try {
                while (true) {
                  if (queue.length > 0) { yield queue.shift(); continue; }
                  if (closed || signal?.aborted) return;
                  await new Promise(resolve => { wake = resolve; });
                }
              } finally { stop(); }
            },
          };
        },
      };
    },
  };
}

test('call-domain merges durable and live utterances deterministically and deduplicates by utteranceId', () => {
  const alice = 'a'.repeat(64), bob = 'b'.repeat(64);
  const durable = [
    { utteranceId: 'u1', author: alice, seq: 1, startedAtMs: 1000, text: 'Hello everyone' },
    { utteranceId: 'u2', author: bob, seq: 1, startedAtMs: 1200, text: 'Hi Alice' },
  ];
  const live = [
    { utteranceId: 'u2', author: bob, seq: 1, startedAtMs: 1200, text: 'Hi Alice' }, // duplicate
    { utteranceId: 'u3', author: alice, seq: 2, startedAtMs: 1500, text: 'Hey @scribe, summarize this' },
  ];
  const merged = mergeUtterances(durable, live);
  assert.deepEqual(merged.map(u => [u.utteranceId, u.persisted]), [
    ['u1', true],
    ['u2', true],
    ['u3', false],
  ]);
  assert.equal(typeof callCommands.callProfileSet.prepare, 'function');
  assert.equal(typeof callCommands.callTranscriptAppend.prepare, 'function');
  assert.equal(typeof callCommands.callNoteAdd.prepare, 'function');
  assert.equal(typeof callQueries.callTranscript.read, 'function');
});

test('native-audio encodes WAV, resamples 48k->16k, decodes RTP to VAD utterances, and supports barge-in clear', async () => {
  const sample48k = new Int16Array(960);
  for (let i = 0; i < 960; i++) sample48k[i] = Math.round(12000 * Math.sin((2 * Math.PI * 440 * i) / 48000));
  const sample16k = resampleInt16(sample48k, 48000, 16000);
  assert.equal(sample16k.length, 320);
  const wav = encodeWavPcm16(sample16k, 16000, 1);
  assert.equal(new TextDecoder().decode(wav.subarray(0, 4)), 'RIFF');
  assert.equal(new TextDecoder().decode(wav.subarray(8, 12)), 'WAVE');
  assert.equal(wav.byteLength, 44 + sample16k.byteLength);

  // Simulate RTP track receiving voiced + silent frames -> VAD utterance turn.
  const listeners = new Set();
  const fakeTrack = {
    kind: 'audio',
    onRtp(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
  const receiver = createRtpAudioReceiver(fakeTrack, {
    defaultSampleRate: 16000,
    decodeOpus: payload => new Int16Array(payload.buffer, payload.byteOffset, payload.byteLength / 2),
  });
  const iter = receiver.utterances({ sampleRate: 16000, silenceMs: 200, minVoicedMs: 100 })[Symbol.asyncIterator]();
  const voicedBytes = new Uint8Array(sample48k.buffer, sample48k.byteOffset, sample48k.byteLength);
  const silentBytes = new Uint8Array(960 * 2);
  let seq = 0;
  const emit = bytes => {
    for (const fn of listeners) fn({ payload: bytes, sequenceNumber: ++seq, timestamp: seq * 960, payloadType: 111, ssrc: 1 });
  };
  for (let i = 0; i < 12; i++) emit(voicedBytes); // 240 ms voiced
  for (let i = 0; i < 12; i++) emit(silentBytes); // 240 ms silence -> closes turn
  const turn = (await iter.next()).value;
  assert.ok(turn.pcm.length > 1600);
  assert.equal(new TextDecoder().decode(turn.wav.subarray(0, 4)), 'RIFF');
  receiver.close();

  // Outbound publisher + barge-in clear().
  const written = [];
  const pubTrack = { writeRtp(pkt) { written.push(pkt); }, stop() {} };
  const pub = createRtpAudioPublisher(pubTrack, {
    sampleRate: 24000,
    encodeOpus: frame => new Uint8Array(frame.buffer, frame.byteOffset, 16),
  });
  pub.write(new Int16Array(24000)); // 1 second queued
  pub.clear();
  pub.close();
  assert.equal(written.length, 0);
});

test('followCall attributes per-person transcripts, detects @handle addressing, and attaches audio only when mode=audio', async () => {
  const bus = makeSignalBus();
  const aliceKey = '1'.repeat(64);
  const bobKey = '2'.repeat(64);
  const agentKey = '3'.repeat(64);
  const stop = new AbortController();

  const peerListeners = new Set();
  const agentSession = {
    identity: { publicKey: agentKey },
    signal: stop.signal,
    status: { connectedPeers: 2 },
    onStatus: () => () => {},
    signals: bus.createPort(agentKey),
    async onPeerLink(fn) { peerListeners.add(fn); return () => peerListeners.delete(fn); },
  };
  const alicePort = bus.createPort(aliceKey);
  const bobPort = bus.createPort(bobKey);

  const utterances = [];
  const audioTracks = [];
  const roster = [{ id: 'ag_1', handle: 'scribe', public_key: agentKey, is_primary: true }];

  const call = followCall(agentSession, {
    handle: 'scribe',
    mode: 'audio',
    roster,
    decodeOpus: payload => new Int16Array(payload.buffer, payload.byteOffset, payload.byteLength / 2),
    onUtterance: u => utterances.push(u),
    onAudioTrack: (speaker, stream) => audioTracks.push({ speaker, stream }),
  });

  await alicePort.send(callSignalTopics.presence, { callId: 'main', kind: 'human', displayName: 'Alice', joined: true });
  await bobPort.send(callSignalTopics.presence, { callId: 'main', kind: 'human', displayName: 'Bob', joined: true });
  await alicePort.send(callSignalTopics.final, { callId: 'main', utteranceId: 'u-a1', seq: 1, text: 'Let us review the Q3 numbers', startedAtMs: 1000, endedAtMs: 2000 });
  await bobPort.send(callSignalTopics.final, { callId: 'main', utteranceId: 'u-b1', seq: 1, text: 'Hey @scribe, capture that as an action item', startedAtMs: 2100, endedAtMs: 3000 });

  await new Promise(r => setTimeout(r, 30));
  assert.equal(utterances.length, 2);
  assert.equal(utterances[0].displayName, 'Alice');
  assert.equal(utterances[0].speakerId, aliceKey);
  assert.equal(utterances[1].displayName, 'Bob');
  assert.deepEqual(utterances[1].addressedTo, ['scribe']);
  assert.equal(utterances[1].shouldRespond, true);

  // Verify direct Werift audio track attaches per speaker with verified identity.
  const trackCallbacks = new Set();
  const fakeLink = {
    peerIdentity: aliceKey,
    transportKind: 'direct',
    signal: stop.signal,
    media: {
      available: true,
      onTrack(fn) { trackCallbacks.add(fn); return () => trackCallbacks.delete(fn); },
    },
    streams: { available: false },
  };
  for (const fn of peerListeners) fn({ type: 'connected', link: fakeLink });
  for (const fn of trackCallbacks) fn({ track: { kind: 'audio', onRtp: () => () => {} } });

  assert.equal(audioTracks.length, 1);
  assert.equal(audioTracks[0].speaker.speakerId, aliceKey);
  assert.equal(audioTracks[0].speaker.displayName, 'Alice');
  await call.close();
});

test('createMediaRoom gates agent audio on explicit approval and fans out custom data streams to direct peers', async () => {
  const bus = makeSignalBus();
  const humanKey = '4'.repeat(64);
  const agentKey = '5'.repeat(64);
  const stop = new AbortController();

  const addedTracks = [];
  const removedSenders = [];
  const openedStreams = [];
  const agentPeer = {
    peerId: agentKey,
    media: {
      available: true,
      addTrack(track) { const s = { track }; addedTracks.push(s); return s; },
      removeTrack(sender) { removedSenders.push(sender); },
      onTrack: () => () => {},
    },
    streams: {
      available: true,
      open(label, opts) {
        const ch = { label, opts, readyState: 'open', sent: [], send(d) { this.sent.push(d); }, messages: async function* () {}, close() {} };
        openedStreams.push(ch);
        return ch;
      },
      onStream: () => () => {},
    },
  };

  const transport = {
    peers: () => [agentPeer],
    getPeer: id => (id === agentKey ? agentPeer : undefined),
    onPeer: fn => { fn({ type: 'connected', peer: agentPeer }); return () => {}; },
  };
  const session = {
    identity: { publicKey: humanKey },
    signal: stop.signal,
    signals: bus.createPort(humanKey),
  };

  // Mock minimal navigator.mediaDevices.getUserMedia for Node unit test.
  const origNav = globalThis.navigator;
  const fakeAudioTrack = { kind: 'audio', enabled: true, readyState: 'live', stop() {} };
  const fakeStream = { getAudioTracks: () => [fakeAudioTrack], getVideoTracks: () => [], getTracks: () => [fakeAudioTrack] };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { mediaDevices: { async getUserMedia() { return fakeStream; } } },
  });

  try {
    const audioRequests = [];
    const room = createMediaRoom({
      runtime: { on: () => () => {} },
      session,
      transport,
      transcription: 'off',
      agentAudio: 'ask',
      allowSyntheticGesture: true,
      onAgentAudioRequest: req => audioRequests.push(req),
    });

    // Agent announces mode: 'audio' -> room asks for consent and does NOT send audio yet.
    await bus.createPort(agentKey).send(callSignalTopics.presence, {
      callId: 'main', kind: 'agent', handle: 'coach', mode: 'audio', joined: true,
    });
    await new Promise(r => setTimeout(r, 20));
    assert.equal(audioRequests.length, 1);
    assert.equal(audioRequests[0].handle, 'coach');

    await room.join({ isTrusted: true }, { audio: true, video: false, displayName: 'Alice' });
    assert.equal(addedTracks.length, 0, 'Audio must NOT be sent to agent before explicit approval');

    room.approveAgentAudio(agentKey, true);
    assert.equal(addedTracks.length, 1, 'Audio track attached immediately after explicit approval');

    room.approveAgentAudio(agentKey, false);
    assert.equal(removedSenders.length, 1, 'Audio track removed when revoked');

    const stream = room.dataStream('whiteboard', { ordered: false, maxRetransmits: 0 });
    stream.send(new Uint8Array([1, 2, 3]));
    assert.equal(openedStreams.length, 1);
    assert.deepEqual(openedStreams[0].sent, [new Uint8Array([1, 2, 3])]);

    await room.dispose();
  } finally {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: origNav });
  }
});
