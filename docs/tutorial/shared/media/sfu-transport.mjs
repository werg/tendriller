/**
 * Cloudflare Realtime SFU & Hybrid MediaTransport for Tendriller call rooms.
 *
 * Implements the exact `MediaTransport` interface expected by `createMediaRoom`
 * (`kind`, `peers()`, `getPeer(peerId)`, `onPeer(listener)`, plus `status()` and `dispose()`).
 *
 * Strategy:
 * - Starts on direct peer-to-peer WebRTC (`attachment.rtc`) for zero host media bandwidth.
 * - Fetches short-lived TURN/SFU entitlement metadata from `_tendril/peers/ice`.
 * - Automatically promotes to Cloudflare Realtime SFU when:
 *   1. Direct media is unavailable (strict NAT / corporate firewall fallback to relay), OR
 *   2. Active video peers exceed `sfuPeerThreshold` (default 4),
 *   provided `sfuAvailable` is true for the page owner's plan (Pro / Team / Self-Hosted).
 * - Reports periodic WebRTC `RTCStatsReport` `bytesReceived` deltas to `_tendril/peers/sfu/usage`
 *   and falls back gracefully to direct P2P / audio-only if the monthly media quota is exhausted.
 */

const SFU_SIGNAL_TOPIC = 'call/sfu-tracks';
const USAGE_REPORT_INTERVAL_MS = 15_000;

async function pageApiJson(base, path, { method = 'POST', body } = {}) {
  const url = `${base.replace(/\/?$/, '/')}_tendril/${path.replace(/^\/+/, '')}`;
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.message || `Realtime API error (${res.status})`);
    err.status = res.status;
    err.code = data?.error?.code || 'realtime_error';
    err.details = data?.error || null;
    throw err;
  }
  return data;
}

/** Query the host for TURN ICE servers, SFU availability, and current media quota. */
export async function fetchHostMediaConfig({ base = globalThis.window?.tendril?.base ?? './' } = {}) {
  try {
    return await pageApiJson(base, 'peers/ice', { method: 'POST', body: {} });
  } catch {
    return {
      iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
      turnEnabled: false,
      sfuAvailable: false,
      sfuConfigured: false,
      sfuLimits: { maxPeers: 0, maxHeight: 0 },
      mediaQuota: null,
    };
  }
}

/**
 * Cloudflare Realtime SFU MediaTransport.
 * Publishes local MediaStreamTracks once into Cloudflare's Anycast SFU and pulls each
 * remote participant's announced tracks on demand.
 */
export function createCloudflareSfuTransport({
  session,
  callId = 'main',
  base = globalThis.window?.tendril?.base ?? './',
  iceServers = [{ urls: 'stun:stun.cloudflare.com:3478' }],
  maxHeight = 720,
  onQuotaExhausted,
  onStatusChange,
} = {}) {
  if (!session) throw Error('SFU_TRANSPORT_REQUIRES_SESSION');
  const myKey = session.identity?.publicKey ?? '';
  let pc = null;
  let sessionId = null;
  let disposed = false;
  let lastBytesReceived = 0;
  let usageTimer = null;
  let unsubSignal = null;

  const localTracks = new Map(); // trackId -> { track, trackName, transceiver }
  const remotePeers = new Map(); // peerId -> { peerId, sessionId, tracks, trackListeners, pulled }
  const peerListeners = new Set();
  let sdpQueue = Promise.resolve();
  const withSdpLock = fn => {
    const next = sdpQueue.then(fn, fn);
    sdpQueue = next.then(() => undefined, () => undefined);
    return next;
  };

  const emitStatus = (extra = {}) => {
    try { onStatusChange?.({ kind: 'cloudflare-sfu', connected: Boolean(sessionId), sessionId, maxHeight, ...extra }); } catch {}
  };

  async function ensureSession() {
    if (sessionId && pc) return sessionId;
    if (disposed) throw Error('SFU_TRANSPORT_DISPOSED');
    pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' });
    pc.addEventListener('track', event => {
      const mid = event.transceiver?.mid;
      for (const entry of remotePeers.values()) {
        const match = entry.pulled.get(mid);
        if (match) {
          for (const fn of entry.trackListeners) {
            try { fn({ track: event.track, streams: event.streams }); } catch {}
          }
          break;
        }
      }
    });
    const created = await pageApiJson(base, 'peers/sfu/sessions', {
      method: 'POST',
      body: { callId, peerId: myKey },
    });
    sessionId = created.sessionId;
    startUsageLoop();
    emitStatus();
    void syncRoomPeers();
    return sessionId;
  }

  async function syncRoomPeers() {
    if (disposed || !sessionId) return;
    try {
      const room = await pageApiJson(base, `peers/sfu/room?callId=${encodeURIComponent(callId)}`, { method: 'GET' });
      for (const remote of room.peers ?? []) {
        if (!remote.peerId || remote.peerId === myKey || !remote.sessionId) continue;
        await registerRemoteAnnouncement(remote.peerId, remote.sessionId, remote.tracks ?? []);
      }
    } catch { /* non-fatal */ }
  }

  function makePeerHandle(peerId) {
    let entry = remotePeers.get(peerId);
    if (!entry) {
      entry = {
        peerId,
        sessionId: null,
        tracks: [],
        trackListeners: new Set(),
        pulled: new Map(), // mid -> trackName
      };
      remotePeers.set(peerId, entry);
    }
    return {
      peerId,
      media: {
        available: true,
        addTrack(track) {
          void publishLocalTrack(track);
          return { track, _sfuTrackId: track.id };
        },
        removeTrack(sender) {
          if (sender?._sfuTrackId) void unpublishLocalTrack(sender._sfuTrackId);
        },
        onTrack(fn) {
          entry.trackListeners.add(fn);
          return () => entry.trackListeners.delete(fn);
        },
      },
    };
  }

  function publishLocalTrack(track) {
    return withSdpLock(async () => {
      if (disposed || localTracks.has(track.id)) return;
      await ensureSession();
      const trackName = `${callId}-${myKey.slice(0, 12)}-${track.kind}-${track.id.slice(0, 8)}`;
      const transceiver = pc.addTransceiver(track, { direction: 'sendonly' });
      localTracks.set(track.id, { track, trackName, transceiver });
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const res = await pageApiJson(base, 'peers/sfu/tracks', {
        method: 'POST',
        body: {
          sessionId,
          sessionDescription: { type: offer.type, sdp: offer.sdp },
          tracks: [{ location: 'local', mid: transceiver.mid, trackName, kind: track.kind }],
        },
      });
      if (res?.sessionDescription) {
        await pc.setRemoteDescription(new RTCSessionDescription(res.sessionDescription));
      }
      announceLocalTracks();
    });
  }

  function unpublishLocalTrack(trackId) {
    return withSdpLock(async () => {
      const item = localTracks.get(trackId);
      if (!item || !sessionId || !pc) return;
      localTracks.delete(trackId);
      try { item.transceiver.direction = 'inactive'; } catch {}
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        const res = await pageApiJson(base, 'peers/sfu/close', {
          method: 'PUT',
          body: {
            sessionId,
            endSession: false,
            tracks: [{ mid: item.transceiver.mid }],
            sessionDescription: { type: offer.type, sdp: offer.sdp },
          },
        });
        if (res?.sessionDescription) {
          await pc.setRemoteDescription(new RTCSessionDescription(res.sessionDescription));
        }
      } catch { /* non-fatal */ }
      announceLocalTracks();
    });
  }

  function announceLocalTracks() {
    if (!sessionId || !session.signals?.publish) return;
    const tracks = [...localTracks.values()].map(item => ({
      trackName: item.trackName,
      kind: item.track.kind,
    }));
    void session.signals.publish(SFU_SIGNAL_TOPIC, {
      callId,
      peerId: myKey,
      sessionId,
      tracks,
    }, { ttlMs: 30_000 }).catch(() => {});
  }

  function registerRemoteAnnouncement(peerId, remoteSessionId, tracks) {
    return withSdpLock(async () => {
      if (disposed || !peerId || peerId === myKey || !remoteSessionId) return;
      const isNew = !remotePeers.has(peerId);
      const handle = makePeerHandle(peerId);
      const entry = remotePeers.get(peerId);
      entry.sessionId = remoteSessionId;
      entry.tracks = tracks;
      if (isNew) {
        for (const fn of peerListeners) {
          try { fn(handle); } catch {}
        }
      }
      if (!tracks.length) return;
      await ensureSession();
      const unpulled = tracks.filter(t => ![...entry.pulled.values()].includes(t.trackName));
      if (!unpulled.length) return;
      const res = await pageApiJson(base, 'peers/sfu/tracks', {
        method: 'POST',
        body: {
          sessionId,
          tracks: unpulled.map(t => ({
            location: 'remote',
            sessionId: remoteSessionId,
            trackName: t.trackName,
          })),
        },
      });
      if (Array.isArray(res?.tracks)) {
        for (const tr of res.tracks) {
          if (tr.mid && tr.trackName) entry.pulled.set(tr.mid, tr.trackName);
        }
      }
      if (res?.requiresImmediateRenegotiation && res?.sessionDescription) {
        await pc.setRemoteDescription(new RTCSessionDescription(res.sessionDescription));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await pageApiJson(base, 'peers/sfu/renegotiate', {
          method: 'PUT',
          body: { sessionId, sessionDescription: { type: answer.type, sdp: answer.sdp } },
        });
      }
    });
  }

  async function reportUsageOnce() {
    if (disposed || !pc || !sessionId || typeof pc.getStats !== 'function') return;
    try {
      const stats = await pc.getStats();
      let totalReceived = 0;
      for (const report of stats.values()) {
        if (report.type === 'inbound-rtp' && typeof report.bytesReceived === 'number') {
          totalReceived += report.bytesReceived;
        }
      }
      const delta = Math.max(0, totalReceived - lastBytesReceived);
      lastBytesReceived = Math.max(lastBytesReceived, totalReceived);
      if (delta === 0) return;
      const res = await pageApiJson(base, 'peers/sfu/usage', {
        method: 'POST',
        body: { sessionId, bytesReceivedDelta: delta },
      });
      if (res?.continueSfu === false) {
        onQuotaExhausted?.(res);
      }
    } catch { /* non-fatal */ }
  }

  function startUsageLoop() {
    if (usageTimer) return;
    usageTimer = setInterval(() => { void reportUsageOnce(); }, USAGE_REPORT_INTERVAL_MS);
  }

  if (session.signals?.subscribe) {
    unsubSignal = session.signals.subscribe(SFU_SIGNAL_TOPIC, msg => {
      const payload = msg?.payload;
      if (!payload || payload.callId !== callId) return;
      void registerRemoteAnnouncement(payload.peerId, payload.sessionId, Array.isArray(payload.tracks) ? payload.tracks : []);
    });
  }

  return Object.freeze({
    kind: 'cloudflare-sfu',
    peers: () => [...remotePeers.keys()].map(makePeerHandle),
    getPeer: peerId => (remotePeers.has(peerId) ? makePeerHandle(peerId) : null),
    onPeer(listener) {
      peerListeners.add(listener);
      return () => peerListeners.delete(listener);
    },
    status: () => ({ kind: 'cloudflare-sfu', connected: Boolean(sessionId), sessionId, maxHeight }),
    async dispose() {
      if (disposed) return;
      disposed = true;
      if (usageTimer) { clearInterval(usageTimer); usageTimer = null; }
      try { unsubSignal?.(); } catch {}
      await reportUsageOnce();
      if (sessionId) {
        await pageApiJson(base, 'peers/sfu/close', {
          method: 'PUT',
          body: { sessionId, endSession: true, tracks: [] },
        }).catch(() => {});
      }
      try { pc?.close(); } catch {}
      pc = null;
      sessionId = null;
      localTracks.clear();
      remotePeers.clear();
      peerListeners.clear();
    },
  });
}

/**
 * Hybrid MediaTransport: prefers direct P2P WebRTC (zero host bandwidth) and automatically
 * promotes to Cloudflare Realtime SFU when NAT blocks direct media or participant count exceeds
 * `sfuPeerThreshold` (default 4) on Pro / Team / Self-Hosted accounts.
 */
export function createHybridMediaTransport({
  attachment,
  session,
  callId = 'main',
  base = globalThis.window?.tendril?.base ?? './',
  sfuPeerThreshold = 4,
  fetchConfig = fetchHostMediaConfig,
  onStateChange,
} = {}) {
  let hostConfig = null;
  let activeSfu = null;
  let mode = 'direct'; // 'direct' | 'sfu' | 'relay-only'
  let fallbackReason = null; // null | 'nat_blocked' | 'mesh_large' | 'quota_exhausted'
  const peerListeners = new Set();

  const directPeers = () => attachment?.rtc?.peers?.() ?? [];

  const emitState = () => {
    try { onStateChange?.(state()); } catch {}
  };

  function state() {
    return {
      mode,
      fallbackReason,
      turnEnabled: Boolean(hostConfig?.turnEnabled),
      sfuAvailable: Boolean(hostConfig?.sfuAvailable),
      sfuLimits: hostConfig?.sfuLimits ?? { maxPeers: 0, maxHeight: 0 },
      mediaQuota: hostConfig?.mediaQuota ?? null,
    };
  }

  async function evaluate({ peerCount = directPeers().length, hasRelayOnlyPeer = false } = {}) {
    if (!hostConfig) hostConfig = await fetchConfig({ base });
    const needsSfu = hasRelayOnlyPeer || peerCount > sfuPeerThreshold;
    if (needsSfu && hostConfig.sfuAvailable && !activeSfu) {
      activeSfu = createCloudflareSfuTransport({
        session,
        callId,
        base,
        iceServers: hostConfig.iceServers,
        maxHeight: hostConfig.sfuLimits?.maxHeight || 720,
        onQuotaExhausted: () => {
          fallbackReason = 'quota_exhausted';
          mode = hasRelayOnlyPeer ? 'relay-only' : 'direct';
          void activeSfu?.dispose();
          activeSfu = null;
          emitState();
        },
      });
      activeSfu.onPeer(peer => {
        for (const fn of peerListeners) { try { fn(peer); } catch {} }
      });
      mode = 'sfu';
      fallbackReason = null;
      emitState();
      return state();
    }
    if (!activeSfu) {
      if (hasRelayOnlyPeer) {
        mode = 'relay-only';
        fallbackReason = hostConfig?.mediaQuota?.exhausted ? 'quota_exhausted' : 'nat_blocked';
      } else if (peerCount > sfuPeerThreshold) {
        mode = 'direct';
        fallbackReason = 'mesh_large';
      } else {
        mode = 'direct';
        fallbackReason = null;
      }
      emitState();
    }
    return state();
  }

  const offDirect = attachment?.rtc?.onPeer?.(peer => {
    if (!activeSfu) {
      for (const fn of peerListeners) { try { fn(peer); } catch {} }
    }
  });

  return Object.freeze({
    get kind() { return activeSfu ? 'cloudflare-sfu' : 'chronolog-direct'; },
    peers: () => (activeSfu ? activeSfu.peers() : directPeers()),
    getPeer: peerId => (activeSfu ? activeSfu.getPeer(peerId) : attachment?.rtc?.getPeer?.(peerId) ?? null),
    onPeer(listener) {
      peerListeners.add(listener);
      return () => peerListeners.delete(listener);
    },
    evaluate,
    state,
    async dispose() {
      try { offDirect?.(); } catch {}
      if (activeSfu) {
        await activeSfu.dispose();
        activeSfu = null;
      }
      peerListeners.clear();
    },
  });
}
