// Transport-agnostic WebRTC video/audio + custom binary data streaming + on-device
// per-person transcription controller for Tendriller browser pages.
import { callSignalTopics, mergeUtterances } from '../helpers/call-domain.mjs';

/**
 * Default MediaTransport: binds directly to Chronolog's tab-owned direct RTCPeerConnections
 * (`attachment.rtc`). Swap this for an SFU transport (e.g. Cloudflare Realtime / LiveKit)
 * on a premium tier without changing room, UI, or agent code.
 */
export function createChronologDirectTransport(attachment) {
  if (!attachment?.rtc) throw Error('DIRECT_MEDIA_TRANSPORT_REQUIRES_ATTACHMENT_RTC');
  return Object.freeze({
    kind: 'chronolog-direct',
    peers: () => attachment.rtc.peers(),
    getPeer: peerId => attachment.rtc.getPeer(peerId),
    onPeer: listener => attachment.rtc.onPeer(listener),
  });
}

function adaptiveVideoConstraints(peerCount) {
  if (peerCount <= 2) return { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } };
  if (peerCount <= 4) return { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24 } };
  return { width: { ideal: 480 }, height: { ideal: 360 }, frameRate: { ideal: 15 } };
}

export function createMediaRoom({
  runtime = globalThis.window?.tendril,
  session,
  attachment,
  callId = 'main',
  transport = attachment?.rtc ? createChronologDirectTransport(attachment) : null,
  transcription = 'model', // 'model' | 'off' | custom transcribe fn
  language,
  persistTranscript = false,
  agentAudio = 'ask', // 'ask' | 'allow' | 'deny'
  allowSyntheticGesture = false,
  loadVoice = () => import(runtime.assetUrl('voice.mjs')),
  onChange,
  onUtterance,
  onAgentAudioRequest,
  onWaitingKnock,
} = {}) {
  if (!session) throw Error('createMediaRoom requires a Chronolog session');
  const stop = new AbortController();
  const lifetime = AbortSignal.any([stop.signal, session.signal].filter(Boolean));
  const myKey = session.identity?.publicKey ?? '';

  let joined = false;
  let displayName = '';
  let audioEnabled = false;
  let videoEnabled = false;
  let screenSharing = false;
  let savingTranscript = Boolean(persistTranscript);
  let speakingLevel = 0;
  let seq = 0;

  let localStream = null;
  let screenStream = null;
  let transcriber = null;
  let micSensorHandle = null;
  let camSensorHandle = null;
  let screenSensorHandle = null;
  let wakeLockLease = null;

  const peerSenders = new Map(); // peerId -> { audio?: sender, video?: sender, screen?: sender }
  const remoteStreams = new Map(); // peerId -> MediaStream
  const remotePresence = new Map(); // peerId -> presence card
  const approvedAudioAgents = new Set();
  const deniedAudioAgents = new Set();
  const liveUtterances = [];
  let durableUtterances = [];
  const listeners = new Set();
  const dataStreamSpecs = new Map(); // label -> { options, listeners, channels: Map<peerId, PeerDataStream> }
  let presenceTimer = null;

  const emitChange = () => {
    const snap = snapshot();
    try { onChange?.(snap); } catch {}
    for (const fn of listeners) { try { fn(snap); } catch {} }
  };

  const directPeerIds = () => new Set((transport?.peers() ?? []).map(p => p.peerId));

  const isAgentMode = (peerId, mode) => remotePresence.get(peerId)?.kind === 'agent' && remotePresence.get(peerId)?.mode === mode;

  const shouldSendAudioTo = peerId => {
    const info = remotePresence.get(peerId);
    if (!info || info.kind !== 'agent') return true;
    if (info.mode === 'transcript') return false;
    if (info.mode === 'audio' || info.mode === 'av') {
      if (agentAudio === 'allow' || approvedAudioAgents.has(peerId)) return true;
      if (agentAudio === 'deny' || deniedAudioAgents.has(peerId)) return false;
      return false;
    }
    return false;
  };

  const shouldSendVideoTo = peerId => {
    const info = remotePresence.get(peerId);
    if (info?.kind === 'agent' && info.mode !== 'av') return false;
    return true;
  };

  const syncTracksToPeer = peer => {
    if (!joined || !peer?.media?.available) return;
    let entry = peerSenders.get(peer.peerId);
    if (!entry) peerSenders.set(peer.peerId, entry = {});

    const audioTrack = localStream?.getAudioTracks()[0] ?? null;
    const videoTrack = localStream?.getVideoTracks()[0] ?? null;
    const screenTrack = screenStream?.getVideoTracks()[0] ?? null;

    if (audioTrack && shouldSendAudioTo(peer.peerId)) {
      if (!entry.audio) {
        try { entry.audio = peer.media.addTrack(audioTrack, localStream); } catch {}
      }
    } else if (entry.audio) {
      try { peer.media.removeTrack(entry.audio); } catch {}
      entry.audio = undefined;
    }

    if (videoTrack && shouldSendVideoTo(peer.peerId)) {
      if (!entry.video) {
        try { entry.video = peer.media.addTrack(videoTrack, localStream); } catch {}
      }
    } else if (entry.video) {
      try { peer.media.removeTrack(entry.video); } catch {}
      entry.video = undefined;
    }

    if (screenTrack && shouldSendVideoTo(peer.peerId)) {
      if (!entry.screen) {
        try { entry.screen = peer.media.addTrack(screenTrack, screenStream); } catch {}
      }
    } else if (entry.screen) {
      try { peer.media.removeTrack(entry.screen); } catch {}
      entry.screen = undefined;
    }
  };

  const syncAllPeers = () => {
    const peers = transport?.peers() ?? [];
    // Adapt outbound camera quality to peer count.
    const camTrack = localStream?.getVideoTracks()[0];
    if (camTrack && typeof camTrack.applyConstraints === 'function') {
      void camTrack.applyConstraints(adaptiveVideoConstraints(peers.length + 1)).catch(() => {});
    }
    for (const peer of peers) syncTracksToPeer(peer);
  };

  const attachIncomingPeer = peer => {
    if (!peer) return;
    if (peer.media?.available) {
      peer.media.onTrack(({ track }) => {
        let stream = remoteStreams.get(peer.peerId);
        if (!stream) {
          stream = new MediaStream();
          remoteStreams.set(peer.peerId, stream);
        }
        if (!stream.getTracks().includes(track)) stream.addTrack(track);
        track.addEventListener?.('ended', () => {
          stream.removeTrack(track);
          emitChange();
        }, { once: true });
        emitChange();
      });
    }
    if (peer.streams?.available) {
      peer.streams.onStream(stream => {
        const spec = dataStreamSpecs.get(stream.label);
        if (!spec) return;
        spec.channels.set(peer.peerId, stream);
        void (async () => {
          try {
            for await (const data of stream.messages(lifetime)) {
              for (const fn of spec.listeners) {
                try { fn({ peerId: peer.peerId, data }); } catch {}
              }
            }
          } finally {
            if (spec.channels.get(peer.peerId) === stream) spec.channels.delete(peer.peerId);
          }
        })();
      });
      // Open any already-registered room data streams to this peer.
      for (const [label, spec] of dataStreamSpecs) {
        if (!spec.channels.has(peer.peerId) && myKey < peer.peerId) {
          try {
            const ch = peer.streams.open(label, spec.options);
            spec.channels.set(peer.peerId, ch);
            void (async () => {
              try {
                for await (const data of ch.messages(lifetime)) {
                  for (const fn of spec.listeners) { try { fn({ peerId: peer.peerId, data }); } catch {} }
                }
              } finally {
                if (spec.channels.get(peer.peerId) === ch) spec.channels.delete(peer.peerId);
              }
            })();
          } catch {}
        }
      }
    }
    syncTracksToPeer(peer);
    emitChange();
  };

  const offTransport = transport?.onPeer(({ type, peer }) => {
    if (type === 'connected') attachIncomingPeer(peer);
    else {
      peerSenders.delete(peer.peerId);
      remoteStreams.delete(peer.peerId);
      for (const spec of dataStreamSpecs.values()) spec.channels.delete(peer.peerId);
      emitChange();
    }
  });

  const publishPresence = async (override = {}) => {
    if (lifetime.aborted || !session.signals) return;
    try {
      await session.signals.send(callSignalTopics.presence, {
        callId,
        displayName: displayName || myKey.slice(0, 8),
        kind: 'human',
        mode: joined ? 'av' : 'lobby',
        joined,
        muted: !audioEnabled,
        cameraOn: videoEnabled,
        screenSharing,
        speaking: speakingLevel > 0.08,
        savingTranscript,
        atMs: Date.now(),
        ...override,
      }, { ttlMs: 30_000, signal: lifetime });
    } catch { /* Ephemeral presence drops cleanly when offline. */ }
  };

  // Subscribe to call presence, live transcripts, and waiting-room knocks over session.signals.
  const signalLoop = (async () => {
    if (!session.signals) return;
    try {
      for await (const frame of session.signals.subscribe({
        topics: [callSignalTopics.presence, callSignalTopics.final, callSignalTopics.waitingRoomKnock],
        mode: 'all',
        signal: lifetime,
      })) {
        const payload = frame.payload;
        if (!payload || typeof payload !== 'object') continue;
        if (frame.topic === callSignalTopics.presence) {
          if (payload.callId !== callId) continue;
          const prev = remotePresence.get(frame.authorId);
          remotePresence.set(frame.authorId, { ...payload, authorId: frame.authorId, receivedAtMs: Date.now() });
          if (payload.kind === 'agent' && (payload.mode === 'audio' || payload.mode === 'av')) {
            if (agentAudio === 'ask' && !approvedAudioAgents.has(frame.authorId) && !deniedAudioAgents.has(frame.authorId) && prev?.mode !== payload.mode) {
              try { onAgentAudioRequest?.({ agentKey: frame.authorId, handle: payload.handle, bio: payload.bio, mode: payload.mode }); } catch {}
            }
            const peer = transport?.getPeer(frame.authorId);
            if (peer) syncTracksToPeer(peer);
          }
          emitChange();
        } else if (frame.topic === callSignalTopics.final) {
          if (payload.callId !== callId || !payload.text) continue;
          const utterance = {
            utteranceId: String(payload.utteranceId ?? crypto.randomUUID()),
            callId,
            author: frame.authorId,
            displayName: remotePresence.get(frame.authorId)?.displayName ?? frame.authorId.slice(0, 8),
            seq: typeof payload.seq === 'number' ? payload.seq : 0,
            text: String(payload.text),
            startedAtMs: Number(payload.startedAtMs) || Date.now(),
            endedAtMs: Number(payload.endedAtMs) || Date.now(),
            language: payload.language,
            persisted: false,
          };
          liveUtterances.push(utterance);
          if (liveUtterances.length > 500) liveUtterances.shift();
          try { onUtterance?.(utterance); } catch {}
          emitChange();
        } else if (frame.topic === callSignalTopics.waitingRoomKnock) {
          if (payload.callId !== callId) continue;
          try { onWaitingKnock?.({ authorId: frame.authorId, ...payload }); } catch {}
        }
      }
    } catch { /* Closed. */ }
  })();

  const handleLocalSegment = async segment => {
    const utterance = {
      utteranceId: segment.utteranceId,
      callId,
      author: myKey,
      displayName: displayName || myKey.slice(0, 8),
      seq: ++seq,
      text: segment.text,
      startedAtMs: segment.startedAtMs,
      endedAtMs: segment.endedAtMs,
      language: segment.language,
      persisted: savingTranscript,
    };
    liveUtterances.push(utterance);
    if (liveUtterances.length > 500) liveUtterances.shift();
    try { onUtterance?.(utterance); } catch {}
    emitChange();

    // Always broadcast low-latency live caption signal.
    if (session.signals) {
      void session.signals.send(callSignalTopics.final, {
        callId,
        utteranceId: utterance.utteranceId,
        seq: utterance.seq,
        text: utterance.text,
        startedAtMs: utterance.startedAtMs,
        endedAtMs: utterance.endedAtMs,
        language: utterance.language,
      }, { ttlMs: 30_000, signal: lifetime }).catch(() => {});
    }

    // Persist to durable Chronolog history only when opt-in transcript saving is enabled.
    if (savingTranscript && typeof session.command === 'function') {
      void session.command('callTranscriptAppend', {
        callId,
        utteranceId: utterance.utteranceId,
        seq: utterance.seq,
        text: utterance.text,
        startedAtMs: utterance.startedAtMs,
        endedAtMs: utterance.endedAtMs,
        ...(utterance.language ? { language: utterance.language } : {}),
      }, { operationId: `utterance:${utterance.utteranceId}` }).catch(() => {});
    }
  };

  const stopHardware = async () => {
    try { transcriber?.dispose(); } catch {}
    transcriber = null;
    for (const [peerId, entry] of peerSenders) {
      const peer = transport?.getPeer(peerId);
      if (peer?.media?.available) {
        if (entry.audio) try { peer.media.removeTrack(entry.audio); } catch {}
        if (entry.video) try { peer.media.removeTrack(entry.video); } catch {}
        if (entry.screen) try { peer.media.removeTrack(entry.screen); } catch {}
      }
    }
    peerSenders.clear();
    for (const track of localStream?.getTracks() ?? []) { try { track.stop(); } catch {} }
    for (const track of screenStream?.getTracks() ?? []) { try { track.stop(); } catch {} }
    localStream = null;
    screenStream = null;
    audioEnabled = false;
    videoEnabled = false;
    screenSharing = false;
    speakingLevel = 0;
    try { micSensorHandle?.unregister(); } catch {}
    try { camSensorHandle?.unregister(); } catch {}
    try { screenSensorHandle?.unregister(); } catch {}
    micSensorHandle = camSensorHandle = screenSensorHandle = null;
    if (wakeLockLease) { try { await wakeLockLease.release(); } catch {} wakeLockLease = null; }
  };

  const leave = async () => {
    if (!joined) return;
    joined = false;
    if (presenceTimer) { clearInterval(presenceTimer); presenceTimer = null; }
    await stopHardware();
    await publishPresence({ joined: false, mode: 'left', muted: true, cameraOn: false, screenSharing: false });
    emitChange();
  };

  const offSensors = runtime?.on?.('sensors_stopped', () => { void leave(); });
  const onPageHide = () => { void leave(); };
  globalThis.window?.addEventListener?.('pagehide', onPageHide);

  const join = async (event, { audio = true, video = true, displayName: name, deviceIds } = {}) => {
    if (!allowSyntheticGesture && event && event.isTrusted !== true) {
      throw Error('Joining a call with camera/microphone requires a trusted user gesture.');
    }
    if (joined) return snapshot();
    if (name) displayName = String(name).trim().slice(0, 80);

    // Register sensors BEFORE calling getUserMedia so Stop sensors cancels pending prompts.
    if (audio && runtime?.sensors?.register) {
      micSensorHandle = runtime.sensors.register({ kind: 'microphone', label: 'Call microphone', state: 'pending', stop: () => leave() });
    }
    if (video && runtime?.sensors?.register) {
      camSensorHandle = runtime.sensors.register({ kind: 'camera', label: 'Call camera', state: 'pending', stop: () => leave() });
    }

    try {
      if (audio || video) {
        const constraints = {
          audio: audio ? {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            ...(deviceIds?.audio ? { deviceId: { exact: deviceIds.audio } } : {}),
          } : false,
          video: video ? {
            ...adaptiveVideoConstraints((transport?.peers().length ?? 0) + 1),
            ...(deviceIds?.video ? { deviceId: { exact: deviceIds.video } } : {}),
          } : false,
        };
        localStream = await navigator.mediaDevices.getUserMedia(constraints);
        if (micSensorHandle?.signal?.aborted || camSensorHandle?.signal?.aborted) {
          await stopHardware();
          throw Error('Call media cancelled');
        }
        audioEnabled = localStream.getAudioTracks().length > 0;
        videoEnabled = localStream.getVideoTracks().length > 0;
        if (audioEnabled) micSensorHandle?.setState('active'); else micSensorHandle?.unregister();
        if (videoEnabled) camSensorHandle?.setState('active'); else camSensorHandle?.unregister();
      }
      if (runtime?.sensors?.wakeLock) {
        wakeLockLease = await runtime.sensors.wakeLock({ label: 'Active video call', autoReacquire: true }).catch(() => null);
      }

      joined = true;
      if (displayName && typeof session.command === 'function') {
        void session.command('callProfileSet', { displayName }, { operationId: `profile:${myKey}:${displayName}` }).catch(() => {});
      }
      syncAllPeers();
      await publishPresence();
      presenceTimer = setInterval(() => { void publishPresence(); }, 10_000);

      // Start continuous on-device per-person transcription on the local AEC mic track.
      if (audioEnabled && transcription !== 'off' && localStream) {
        try {
          const voiceMod = await loadVoice();
          if (typeof voiceMod?.createStreamTranscriber === 'function' && joined) {
            transcriber = voiceMod.createStreamTranscriber(runtime, {
              stream: localStream,
              language,
              ...(typeof transcription === 'function' ? { transcribe: transcription } : {}),
              onSegment: segment => { void handleLocalSegment(segment); },
              onLevel: level => {
                const wasSpeaking = speakingLevel > 0.08;
                speakingLevel = level;
                if ((level > 0.08) !== wasSpeaking) emitChange();
              },
            });
            void transcriber.start().catch(() => {});
          }
        } catch { /* Transcription stays optional; call audio/video keeps working. */ }
      }

      emitChange();
      return snapshot();
    } catch (error) {
      await stopHardware();
      emitChange();
      throw error;
    }
  };

  const setAudioEnabled = enabled => {
    audioEnabled = Boolean(enabled);
    for (const track of localStream?.getAudioTracks() ?? []) track.enabled = audioEnabled;
    if (audioEnabled) transcriber?.resume(); else transcriber?.pause();
    void publishPresence();
    emitChange();
  };

  const setVideoEnabled = enabled => {
    videoEnabled = Boolean(enabled);
    for (const track of localStream?.getVideoTracks() ?? []) track.enabled = videoEnabled;
    void publishPresence();
    emitChange();
  };

  const startScreenShare = async event => {
    if (!allowSyntheticGesture && event && event.isTrusted !== true) {
      throw Error('Screen sharing requires a trusted user gesture.');
    }
    if (!joined || screenSharing) return;
    if (runtime?.sensors?.register) {
      screenSensorHandle = runtime.sensors.register({ kind: 'screen', label: 'Screen share', state: 'pending', stop: () => stopScreenShare() });
    }
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      if (screenSensorHandle?.signal?.aborted) { stopScreenShare(); return; }
      screenSharing = true;
      screenSensorHandle?.setState('active');
      screenStream.getVideoTracks()[0]?.addEventListener('ended', () => { stopScreenShare(); }, { once: true });
      syncAllPeers();
      void publishPresence();
      emitChange();
    } catch (error) {
      screenSensorHandle?.unregister(); screenSensorHandle = null;
      throw error;
    }
  };

  const stopScreenShare = () => {
    if (!screenStream) return;
    for (const track of screenStream.getTracks()) { try { track.stop(); } catch {} }
    screenStream = null;
    screenSharing = false;
    try { screenSensorHandle?.unregister(); } catch {}
    screenSensorHandle = null;
    syncAllPeers();
    void publishPresence();
    emitChange();
  };

  const approveAgentAudio = (agentKey, allow) => {
    if (allow) { approvedAudioAgents.add(agentKey); deniedAudioAgents.delete(agentKey); }
    else { deniedAudioAgents.add(agentKey); approvedAudioAgents.delete(agentKey); }
    const peer = transport?.getPeer(agentKey);
    if (peer) syncTracksToPeer(peer);
    emitChange();
  };

  const setPersistTranscript = enabled => {
    savingTranscript = Boolean(enabled);
    void publishPresence();
    emitChange();
  };

  const sendOnChannel = (ch, data) => {
    if (ch.readyState === 'open') {
      try { ch.send(data); } catch {}
      return;
    }
    if (ch.readyState !== 'connecting') return;
    // Newly created DCEP DataChannels spend a few ms in 'connecting' before SCTP opens them.
    let pending = ch._pendingOutgoing;
    if (!pending) {
      pending = ch._pendingOutgoing = [];
      const flush = () => {
        if (ch.readyState === 'open') {
          for (const item of pending.splice(0)) { try { ch.send(item); } catch {} }
          return;
        }
        if (ch.readyState === 'connecting' && !lifetime.aborted) setTimeout(flush, 10);
      };
      setTimeout(flush, 10);
    }
    if (pending.length < 32) pending.push(data);
  };

  const dataStream = (label, options = {}) => {
    let spec = dataStreamSpecs.get(label);
    if (!spec) {
      spec = { options, listeners: new Set(), channels: new Map() };
      dataStreamSpecs.set(label, spec);
      for (const peer of transport?.peers() ?? []) {
        if (!peer.streams?.available) continue;
        try {
          const ch = peer.streams.open(label, options);
          spec.channels.set(peer.peerId, ch);
          void (async () => {
            try {
              for await (const data of ch.messages(lifetime)) {
                for (const fn of spec.listeners) { try { fn({ peerId: peer.peerId, data }); } catch {} }
              }
            } finally {
              if (spec.channels.get(peer.peerId) === ch) spec.channels.delete(peer.peerId);
            }
          })();
        } catch {}
      }
    }
    return Object.freeze({
      label,
      directPeers: () => [...spec.channels.keys()],
      send(data, targetPeerId = null) {
        if (targetPeerId) {
          const target = spec.channels.get(targetPeerId);
          if (target) sendOnChannel(target, data);
          return;
        }
        for (const ch of spec.channels.values()) sendOnChannel(ch, data);
      },
      onMessage(listener) {
        spec.listeners.add(listener);
        return () => { spec.listeners.delete(listener); };
      },
      close() {
        for (const ch of spec.channels.values()) { try { ch.close(); } catch {} }
        spec.channels.clear();
        spec.listeners.clear();
        dataStreamSpecs.delete(label);
      },
    });
  };

  function snapshot() {
    const direct = directPeerIds();
    const now = Date.now();
    const participants = [];
    for (const [peerId, info] of remotePresence) {
      if (now - info.receivedAtMs > 45_000) continue;
      participants.push({
        peerId,
        displayName: info.displayName || info.handle || peerId.slice(0, 8),
        kind: info.kind || 'human',
        handle: info.handle,
        mode: info.mode,
        joined: info.joined !== false,
        muted: Boolean(info.muted),
        cameraOn: Boolean(info.cameraOn),
        screenSharing: Boolean(info.screenSharing),
        speaking: Boolean(info.speaking),
        transportKind: direct.has(peerId) ? 'direct' : 'relay',
        mediaAvailable: direct.has(peerId),
        stream: remoteStreams.get(peerId) ?? null,
        audioApproved: info.kind === 'agent' ? (agentAudio === 'allow' || approvedAudioAgents.has(peerId)) : true,
      });
    }
    return Object.freeze({
      callId,
      joined,
      displayName: displayName || myKey.slice(0, 8),
      audioEnabled,
      videoEnabled,
      screenSharing,
      speakingLevel,
      savingTranscript,
      localStream,
      screenStream,
      participants,
      agents: participants.filter(p => p.kind === 'agent'),
      humans: participants.filter(p => p.kind !== 'agent'),
      transcript: mergeUtterances(durableUtterances, liveUtterances),
    });
  }

  const setDurableUtterances = items => {
    durableUtterances = Array.isArray(items) ? items : [];
    emitChange();
  };

  const dispose = async () => {
    await leave();
    stop.abort(new Error('MEDIA_ROOM_DISPOSED'));
    offTransport?.();
    offSensors?.();
    globalThis.window?.removeEventListener?.('pagehide', onPageHide);
    for (const spec of dataStreamSpecs.values()) {
      for (const ch of spec.channels.values()) { try { ch.close(); } catch {} }
    }
    dataStreamSpecs.clear();
    listeners.clear();
    await signalLoop;
  };

  return Object.freeze({
    snapshot,
    join,
    leave,
    setAudioEnabled,
    setVideoEnabled,
    startScreenShare,
    stopScreenShare,
    approveAgentAudio,
    setPersistTranscript,
    setDurableUtterances,
    dataStream,
    subscribe(listener) {
      listeners.add(listener);
      try { listener(snapshot()); } catch {}
      return () => { listeners.delete(listener); };
    },
    dispose,
  });
}
