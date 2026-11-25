import {
  TOPICS, MAX_AGE_MS, deviceId, validFix, validReply, validRequest, fresh, connected, observeConnection,
} from './protocol.mjs';

/** Standard APIs plus cooperative lifecycle; remote requests only display a prompt. */
export function createObservationSource({
  session, runtime, nativeDeviceId, onState = () => {},
  coalesceMs = 500, now = Date.now,
  navigator = globalThis.navigator, document = globalThis.document, window = globalThis.window,
}) {
  if (!deviceId(nativeDeviceId) || !Number.isSafeInteger(coalesceMs) || coalesceMs < 100 || coalesceMs > 2000) {
    throw Error('Invalid observation source options.');
  }
  const owner = new AbortController();
  const lifetime = AbortSignal.any([owner.signal, session.signal]);
  lifetime.throwIfAborted();

  let run = null, closed = false, request = null, latestAccepted = null;
  let state = { phase: 'stopped', sharing: false, receiver: 'waiting', error: null, sample: null };
  const sent = new Map();

  const snapshot = () => structuredClone({ ...state, request });
  const notify = () => { if (!closed) onState(snapshot()); };
  const stop = () => run?.handle?.unregister();
  const visible = () => { if (document.visibilityState !== 'visible') stop(); };

  const connection = () => {
    if (!connected(session, nativeDeviceId)) {
      stop();
      sent.clear();
      state.receiver = 'disconnected';
      notify();
    } else if (state.receiver === 'disconnected') {
      state.receiver = 'waiting';
      notify();
    }
  };

  const offConnection = observeConnection(session, connection);
  const offStop = runtime.on('sensors_stopped', stop);
  document.addEventListener('visibilitychange', visible);
  window.addEventListener('pagehide', stop);

  const expiry = setInterval(() => {
    if (request && request.expiresAtMs <= now()) {
      request = null;
      notify();
    }
    if (state.receiver === 'accepted' && latestAccepted && !fresh(latestAccepted.fix, now())) {
      state.receiver = 'stale';
      notify();
    }
  }, 250);

  const done = (async () => {
    try {
      for await (const envelope of session.signals.subscribe({
        topics: [TOPICS.reply, TOPICS.request], mode: 'all', signal: lifetime,
      })) {
        if (lifetime.aborted) break;
        if (envelope.scope !== session.applicationId
          || envelope.authorId !== nativeDeviceId
          || envelope.stream?.target !== session.identity.publicKey) continue;

        const value = envelope.payload;
        if (value?.recipient !== session.identity.publicKey) continue;

        if (envelope.topic === TOPICS.request) {
          if (validRequest(value, now())) {
            request = structuredClone(value);
            notify();
          }
          continue; // Never start capture in a message handler.
        }

        if (!validReply(value)) continue;
        const sample = sent.get(`${value.streamId}/${value.sequence}`);
        if (!sample || value.requestId !== sample.requestId || value.sampledAtMs !== sample.fix.sampledAtMs) continue;

        if (value.status === 'accepted') {
          if (latestAccepted && sample.fix.sampledAtMs < latestAccepted.fix.sampledAtMs) continue;
          latestAccepted = sample;
          state.receiver = fresh(sample.fix, now()) ? 'accepted' : 'stale';
          state.sample = structuredClone(sample);
          notify();
        } else if (latestAccepted
          && latestAccepted.streamId === sample.streamId
          && latestAccepted.sequence === sample.sequence) {
          state.receiver = 'stale';
          notify();
        } else if (!latestAccepted) {
          state.receiver = 'stale';
          notify();
        }
      }
      if (!lifetime.aborted) {
        stop();
        state.receiver = 'disconnected';
        notify();
      }
    } catch (error) {
      if (!lifetime.aborted) {
        stop();
        state.receiver = 'disconnected';
        state.error = error.message;
        notify();
        throw error;
      }
    }
  })();
  // Consumers may await done for diagnostics; closure always observes failure.
  done.catch(() => {});

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    clearInterval(expiry);
    offConnection();
    offStop();
    document.removeEventListener('visibilitychange', visible);
    window.removeEventListener('pagehide', stop);
  };
  const abort = () => {
    stop();
    release();
    state.receiver = 'disconnected';
    notify();
  };
  lifetime.addEventListener('abort', abort, { once: true });
  connection();
  notify();

  return {
    done,
    snapshot,
    stop,
    reviewedSample: () => (latestAccepted ? structuredClone(latestAccepted) : null),
    decline() {
      request = null;
      notify();
    },
    start(event, source = 'simulated') {
      lifetime.throwIfAborted();
      if (closed || event?.isTrusted !== true) {
        throw Error('Start sharing from a deliberate local button or keyboard action.');
      }
      if (document.visibilityState !== 'visible') throw Error('Open this page before sharing.');
      if (!['simulated', 'location'].includes(source)) throw Error('Choose the simulator or browser location.');
      if (source === 'location' && !navigator?.geolocation) {
        throw Error('Location is unavailable. The simulator remains available.');
      }

      stop();
      sent.clear();
      latestAccepted = null;

      const current = {
        handle: null,
        queued: null,
        watch: undefined,
        producer: null,
        timer: null,
        sending: false,
        lastSendAt: -Infinity,
        streamId: crypto.randomUUID(),
        sequence: 0,
        requestId: request?.source === source && request.expiresAtMs > now() ? request.requestId : null,
      };

      // Register before the permission request. stop invalidates signal first.
      current.handle = runtime.sensors.register({
        kind: source === 'location' ? 'location' : 'observation-simulation',
        label: source === 'location' ? 'Shared location observation' : 'Simulated observation',
        state: 'pending',
        stop() {
          clearInterval(current.producer);
          clearTimeout(current.timer);
          current.timer = null;
          if (current.watch !== undefined) navigator.geolocation.clearWatch(current.watch);
          current.queued = null;
          if (run === current) {
            run = null;
            sent.clear();
            state.phase = 'stopped';
            state.sharing = false;
            notify();
          }
          // An ephemeral stop marker speeds up UI feedback; expiry is the
          // correctness fallback when this signal is lost or reordered.
          if (!lifetime.aborted) {
            void session.signals.send(
              TOPICS.stop,
              { recipient: nativeDeviceId, streamId: current.streamId },
              {
                ttlMs: 2000,
                signal: AbortSignal.timeout(2000),
                stream: { streamId: current.streamId, target: nativeDeviceId },
              },
            ).catch(() => {});
          }
        },
      });

      // A synchronous Stop sensors observer can cancel registration before it returns.
      if (current.handle.signal.aborted) return snapshot();

      run = current;
      state = {
        phase: 'pending',
        sharing: true,
        receiver: connected(session, nativeDeviceId) ? 'waiting' : 'disconnected',
        error: null,
        sample: null,
      };
      request = null;
      notify();

      const scheduleFlush = () => {
        if (current.sending || !current.queued || current.handle.signal.aborted || current.timer !== null) return;
        const delay = Math.max(0, current.lastSendAt + coalesceMs - now());
        if (delay === 0) void flush();
        else {
          current.timer = setTimeout(() => {
            current.timer = null;
            void flush();
          }, delay);
        }
      };

      const flush = async () => {
        if (current.sending || !current.queued || current.handle.signal.aborted) return;
        const fix = current.queued;
        current.queued = null;
        if (!fresh(fix, now()) || !connected(session, nativeDeviceId)) return;

        const sample = {
          recipient: nativeDeviceId,
          streamId: current.streamId,
          sequence: ++current.sequence,
          requestId: current.requestId,
          fix,
        };
        if (sent.size >= 16) sent.delete(sent.keys().next().value);
        sent.set(`${sample.streamId}/${sample.sequence}`, sample);
        current.sending = true;
        current.lastSendAt = now();
        try {
          await session.signals.send(TOPICS.sample, sample, {
            ttlMs: Math.min(MAX_AGE_MS, 2000),
            stream: { streamId: current.streamId, target: nativeDeviceId },
            signal: AbortSignal.any([current.handle.signal, lifetime, AbortSignal.timeout(2000)]),
          });
        } catch (error) {
          if (!current.handle.signal.aborted && run === current) {
            state.error = error.message;
            state.receiver = 'disconnected';
            notify();
          }
        } finally {
          current.sending = false;
          scheduleFlush();
        }
      };

      const capture = fix => {
        if (current.handle.signal.aborted || run !== current) return;
        if (!validFix(fix) || !fresh(fix, now())) {
          state.error = 'Ignoring an inaccurate, invalid, or stale fix.';
          notify();
          return;
        }
        current.queued = connected(session, nativeDeviceId) ? structuredClone(fix) : null;
        current.handle.setState('active');
        state.phase = 'sharing';
        state.error = null;
        notify();
        scheduleFlush();
      };

      if (source === 'simulated') {
        let index = 0;
        const sample = () => capture({
          source,
          sampledAtMs: now(),
          latitude: 52.52 + (++index % 100) / 100_000,
          longitude: 13.405,
          accuracyM: 4,
        });
        sample();
        current.producer = setInterval(sample, 50);
      } else {
        try {
          const watch = navigator.geolocation.watchPosition(
            position => capture({
              source,
              sampledAtMs: Math.round(position.timestamp),
              latitude: position.coords.latitude,
              longitude: position.coords.longitude,
              accuracyM: position.coords.accuracy,
            }),
            error => {
              if (current.handle.signal.aborted) return;
              state.error = error.message || 'Location unavailable. Use the simulator or type a note.';
              current.handle.unregister();
            },
            { enableHighAccuracy: false, maximumAge: 0, timeout: 10_000 },
          );
          current.watch = watch;
          if (current.handle.signal.aborted) navigator.geolocation.clearWatch(watch);
        } catch (error) {
          state.error = error.message;
          current.handle.unregister();
          throw error;
        }
      }
      return snapshot();
    },
    async close() {
      if (closed) return;
      stop();
      closed = true;
      owner.abort();
      release();
      lifetime.removeEventListener('abort', abort);
      await done.catch(() => {});
    },
  };
}
