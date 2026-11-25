import {
  TOPICS, MAX_AGE_MS, deviceId, validSample, validStop, fresh, connected, observeConnection, streamIdentity,
} from './protocol.mjs';

/** Native-side live observer. No durable write or sensor acquisition occurs here. */
export function serveObservations({
  session, allowedDevices, maxAgeMs = MAX_AGE_MS, onState = () => {}, signal, now = Date.now,
}) {
  if (!Array.isArray(allowedDevices) || !allowedDevices.length || allowedDevices.length > 32
    || allowedDevices.some(value => !deviceId(value))
    || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 100 || maxAgeMs > 30_000) {
    throw Error('Invalid observation receiver options.');
  }

  const allowed = new Set(allowedDevices);
  const owner = new AbortController();
  const lifetime = AbortSignal.any([owner.signal, session.signal, ...[signal].filter(Boolean)]);
  const states = new Map(), streams = new Map(), requests = new Map();

  const publish = (authorId, state) => {
    states.set(authorId, state);
    onState({ authorId, ...structuredClone(state) });
  };

  const reply = async (authorId, sample, status) => {
    if (lifetime.aborted) return;
    try {
      await session.signals.send(
        TOPICS.reply,
        {
          recipient: authorId,
          streamId: sample.streamId,
          sequence: sample.sequence,
          requestId: sample.requestId,
          sampledAtMs: sample.fix.sampledAtMs,
          status,
        },
        { ttlMs: 2000, signal: lifetime, stream: { streamId: 'observation-replies', target: authorId } },
      );
    } catch { /* Lost live replies are observed as stale, never retried as a command. */ }
  };

  function expire() {
    const currentTime = now();
    for (const [key, request] of requests) {
      if (request.expiresAtMs <= currentTime) requests.delete(key);
    }
    for (const authorId of allowed) {
      const previous = states.get(authorId);
      if (!connected(session)) {
        if (previous?.phase !== 'disconnected') publish(authorId, { phase: 'disconnected', sample: null });
      } else if (previous?.phase === 'fresh' && !fresh(previous.sample.fix, currentTime, maxAgeMs)) {
        publish(authorId, { ...previous, phase: 'stale' });
        void reply(authorId, previous.sample, 'stale');
      } else if (!previous || previous.phase === 'disconnected') {
        publish(authorId, { phase: 'waiting', sample: null });
      }
    }
  }

  const offConnection = observeConnection(session, expire);
  const timer = setInterval(expire, Math.min(250, maxAgeMs));
  expire();

  const done = (async () => {
    try {
      for await (const envelope of session.signals.subscribe({
        topics: [TOPICS.sample, TOPICS.stop], mode: 'all', signal: lifetime,
      })) {
        if (lifetime.aborted) break;
        const key = streamIdentity(envelope);
        if (envelope.scope !== session.applicationId
          || !allowed.has(envelope.authorId)
          || !key
          || envelope.stream.target !== session.identity.publicKey
          || !connected(session)) continue;

        const input = envelope.payload;
        if (envelope.topic === TOPICS.stop) {
          if (validStop(input) && input.recipient === session.identity.publicKey && envelope.stream.streamId === input.streamId) {
            if (!streams.has(key) && streams.size >= 128) streams.delete(streams.keys().next().value);
            streams.set(key, { sequence: Infinity }); // Also fences Stop before the first sample.
            const current = states.get(envelope.authorId);
            if (input.streamId === current?.sample?.streamId && current.streamKey === key) {
              publish(envelope.authorId, { ...current, phase: 'stopped' });
            }
          }
          continue;
        }

        if (!validSample(input) || input.recipient !== session.identity.publicKey || envelope.stream.streamId !== input.streamId) continue;

        const previous = streams.get(key);
        if (previous && (input.sequence <= previous.sequence
          || input.requestId !== previous.requestId
          || input.fix.source !== previous.source)) continue;

        const currentTime = now();
        const current = states.get(envelope.authorId);
        if (input.requestId !== null) {
          const entry = requests.get(`${envelope.authorId}/${input.requestId}`);
          const requested = entry && entry.expiresAtMs > currentTime ? entry : null;
          const continuing = current?.streamKey === key && current.sample?.requestId === input.requestId;
          if ((!requested && !continuing) || input.fix.source !== (requested?.source ?? current?.sample?.fix.source)) continue;
        }

        // A new transport timestamp or delayed old stream cannot refresh the
        // measurement. Sample time belongs to the acquisition adapter.
        if (current?.sample && input.fix.sampledAtMs < current.sample.fix.sampledAtMs) continue;
        if (!fresh(input.fix, currentTime, maxAgeMs)) {
          await reply(envelope.authorId, input, 'stale');
          continue;
        }

        if (!previous && streams.size >= 128) streams.delete(streams.keys().next().value);
        streams.set(key, { sequence: input.sequence, source: input.fix.source, requestId: input.requestId });
        publish(envelope.authorId, {
          phase: 'fresh',
          sessionId: envelope.sessionId,
          streamKey: key,
          sample: structuredClone(input),
        });
        await reply(envelope.authorId, input, 'accepted');
      }
    } catch (error) {
      if (!lifetime.aborted) throw error;
    } finally {
      clearInterval(timer);
      offConnection();
      owner.abort();
    }
  })();

  return {
    done,
    snapshot: () => Object.fromEntries([...states].map(([key, value]) => [key, structuredClone(value)])),
    async requestObservation(recipient, source = 'location') {
      lifetime.throwIfAborted();
      if (!allowed.has(recipient) || !['simulated', 'location'].includes(source)) {
        throw Error('Select an authorized device and source.');
      }
      expire();
      if (requests.size >= 32) throw Error('Too many pending observation requests.');
      const request = { recipient, requestId: crypto.randomUUID(), source, expiresAtMs: now() + 30_000 };
      requests.set(`${recipient}/${request.requestId}`, request);
      await session.signals.send(TOPICS.request, request, {
        ttlMs: 30_000,
        signal: lifetime,
        stream: { streamId: 'observation-requests', target: recipient },
      });
      return structuredClone(request);
    },
    async close() {
      owner.abort();
      await done;
    },
  };
}
