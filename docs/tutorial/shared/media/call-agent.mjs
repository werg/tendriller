// High-level native agent API for following a Tendriller video/audio call:
// - mode: 'transcript' (default) -> zero RTP tracks, exact per-person speaker attribution,
//   works over direct WebRTC, relay fallback, offline catchup, and multi-agent @handles.
// - mode: 'audio' (opt-in) -> opens audio-only recv tracks on direct Werift Chronolog links,
//   exposing per-speaker `.rtp`, `.pcm({ sampleRate })`, `.utterances({ vad })`, plus `publishAudio()`.
import { callSignalTopics, mergeUtterances } from '../helpers/call-domain.mjs';
import { parseAddressing, shouldAgentRespond } from '../helpers/agent-requests.mjs';
import { createRtpAudioPublisher, createRtpAudioReceiver } from './native-audio.mjs';

export function followCall(session, {
  callId = 'main',
  handle = '',
  bio = '',
  mode = 'transcript', // 'transcript' | 'audio'
  roster = null,
  decodeOpus,
  defaultSampleRate = 16_000,
  onUtterance,
  onAudioTrack,
  onRosterChange,
  onDataStream,
  signal,
} = {}) {
  if (!session) throw Error('followCall requires an opened Chronolog session');
  if (!['transcript', 'audio'].includes(mode)) throw Error('followCall mode must be "transcript" or "audio"');

  const stop = new AbortController();
  const lifetime = AbortSignal.any([stop.signal, signal, session.signal].filter(Boolean));
  const myKey = session.identity?.publicKey ?? '';

  const participants = new Map();
  const seenUtterances = new Set();
  const liveUtterances = [];
  const audioReceivers = new Map(); // peerId -> receiver
  const directLinks = new Map();    // peerId -> ApplicationPeerLink
  let durableUtterances = [];
  let presenceTimer = null;
  let offPeerLinks = null;

  const speakerName = authorId => participants.get(authorId)?.displayName || participants.get(authorId)?.handle || authorId.slice(0, 8);

  const deliverUtterance = (utterance) => {
    if (seenUtterances.has(utterance.utteranceId)) return;
    seenUtterances.add(utterance.utteranceId);
    const addressing = parseAddressing(utterance.text, roster);
    const syntheticMessage = {
      author: utterance.author,
      channel: 'chat',
      to: addressing.to,
      text: utterance.text,
      expectReply: true,
      hopCount: 0,
    };
    const shouldRespond = roster
      ? shouldAgentRespond(syntheticMessage, { selfPublicKey: myKey, selfHandle: handle, roster })
      : addressing.explicit && addressing.handles.some(h => h === '*' || h.toLowerCase() === handle.toLowerCase());
    const enriched = Object.freeze({
      ...utterance,
      speakerId: utterance.author,
      displayName: utterance.displayName || speakerName(utterance.author),
      addressedTo: addressing.handles,
      shouldRespond,
    });
    liveUtterances.push(enriched);
    if (liveUtterances.length > 500) liveUtterances.shift();
    try { onUtterance?.(enriched); } catch {}
  };

  const publishPresence = async (override = {}) => {
    if (lifetime.aborted || !session.signals) return;
    if ((session.status?.connectedPeers ?? 0) === 0 && !override.force) return;
    try {
      await session.signals.send(callSignalTopics.presence, {
        callId,
        kind: 'agent',
        handle,
        displayName: handle ? `@${handle}` : myKey.slice(0, 8),
        bio,
        mode,
        joined: true,
        muted: true,
        cameraOn: false,
        screenSharing: false,
        atMs: Date.now(),
        ...override,
      }, { ttlMs: 30_000, signal: lifetime });
    } catch {}
  };

  const offStatus = session.onStatus(status => {
    if ((status?.connectedPeers ?? 0) > 0) void publishPresence();
  });
  presenceTimer = setInterval(() => { void publishPresence(); }, 12_000);
  presenceTimer.unref?.();
  void publishPresence();

  // Observe live signals (presence + live utterances).
  const signalLoop = (async () => {
    if (!session.signals) return;
    try {
      for await (const frame of session.signals.subscribe({
        topics: [callSignalTopics.presence, callSignalTopics.final],
        mode: 'all',
        signal: lifetime,
      })) {
        const payload = frame.payload;
        if (!payload || typeof payload !== 'object' || payload.callId !== callId) continue;
        if (frame.topic === callSignalTopics.presence) {
          participants.set(frame.authorId, { ...payload, peerId: frame.authorId, receivedAtMs: Date.now() });
          try { onRosterChange?.([...participants.values()]); } catch {}
        } else if (frame.topic === callSignalTopics.final && payload.text) {
          deliverUtterance({
            utteranceId: String(payload.utteranceId ?? crypto.randomUUID()),
            callId,
            author: frame.authorId,
            displayName: speakerName(frame.authorId),
            seq: typeof payload.seq === 'number' ? payload.seq : 0,
            text: String(payload.text),
            startedAtMs: Number(payload.startedAtMs) || Date.now(),
            endedAtMs: Number(payload.endedAtMs) || Date.now(),
            language: payload.language,
            isFinal: true,
            persisted: false,
          });
        }
      }
    } catch {}
  })();

  // Observe durable persisted utterances (catches up late joins & offline restarts).
  const refreshDurable = async () => {
    if (lifetime.aborted || typeof session.query !== 'function') return;
    try {
      const state = await session.query('callState', { callId });
      if (!state) return;
      for (const [author, profile] of Object.entries(state.profiles ?? {})) {
        const existing = participants.get(author) ?? { peerId: author, kind: 'human' };
        participants.set(author, { ...existing, displayName: profile.displayName });
      }
      durableUtterances = state.utterances ?? [];
      for (const u of durableUtterances) {
        deliverUtterance({ ...u, isFinal: true, persisted: true });
      }
    } catch { /* App may not define callState query if using ephemeral signals only. */ }
  };
  const offChanges = typeof session.onChange === 'function'
    ? session.onChange(() => { void refreshDurable(); })
    : () => {};
  void refreshDurable();

  // Observe direct peer links for custom data streams and (when mode === 'audio') Werift RTP audio tracks!
  const attachLink = link => {
    if (link.transportKind !== 'direct') return;
    directLinks.set(link.peerIdentity, link);
    if (link.streams?.available && onDataStream) {
      link.streams.onStream(stream => {
        try { onDataStream({ peerId: link.peerIdentity, displayName: speakerName(link.peerIdentity), stream }); } catch {}
      });
    }
    if (mode === 'audio' && link.media?.available) {
      link.media.onTrack(({ track }) => {
        if (track?.kind !== 'audio') return;
        audioReceivers.get(link.peerIdentity)?.close();
        const receiver = createRtpAudioReceiver(track, { signal: link.signal, decodeOpus, defaultSampleRate });
        audioReceivers.set(link.peerIdentity, receiver);
        const speaker = Object.freeze({
          speakerId: link.peerIdentity,
          displayName: speakerName(link.peerIdentity),
          peerId: link.peerIdentity,
        });
        try { onAudioTrack?.(speaker, receiver); } catch {}
      });
    }
  };

  if (typeof session.onPeerLink === 'function') {
    void session.onPeerLink(({ type, link }) => {
      if (type === 'connected') attachLink(link);
      else {
        directLinks.delete(link.peerIdentity);
        audioReceivers.get(link.peerIdentity)?.close();
        audioReceivers.delete(link.peerIdentity);
      }
    }).then(off => { offPeerLinks = off; if (lifetime.aborted) off(); }).catch(() => {});
  }

  return Object.freeze({
    mode,
    participants: () => [...participants.values()],
    transcript: () => mergeUtterances(durableUtterances, liveUtterances),
    async postNote({ kind = 'note', text, refUtteranceId }) {
      return session.command('callNoteAdd', {
        callId, kind, text, ...(refUtteranceId ? { refUtteranceId } : {}),
      }, { operationId: crypto.randomUUID() });
    },
    async reply(text, { to = [], inReplyTo } = {}) {
      return session.command('agentMessage', {
        channel: 'chat', to, text, expectReply: false,
        ...(inReplyTo ? { inReplyTo } : {}),
      }, { operationId: crypto.randomUUID() });
    },
    openDataStream(peerId, label, options) {
      const link = directLinks.get(peerId);
      if (!link?.streams?.available) throw Error('PEER_DIRECT_STREAM_UNAVAILABLE');
      return link.streams.open(label, options);
    },
    async publishAudio({ sampleRate = 24_000, encodeOpus } = {}) {
      const { createNativeAudioTrack } = await import('@chronolog/peer-session/webrtc-native');
      const track = createNativeAudioTrack();
      for (const link of directLinks.values()) {
        if (link.media?.available) {
          try { link.media.addTrack(track.raw); } catch {}
        }
      }
      return createRtpAudioPublisher(track, { sampleRate, encodeOpus });
    },
    done: signalLoop,
    async close() {
      if (presenceTimer) { clearInterval(presenceTimer); presenceTimer = null; }
      await publishPresence({ force: true, joined: false, mode: 'left' });
      stop.abort(new Error('CALL_FOLLOWER_CLOSED'));
      offStatus?.();
      offChanges?.();
      offPeerLinks?.();
      for (const r of audioReceivers.values()) r.close();
      audioReceivers.clear();
      directLinks.clear();
    },
  });
}
