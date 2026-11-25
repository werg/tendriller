// Optional application convention, not a Tendriller or Chronolog protocol.
export const TOPICS = Object.freeze({
  sample: 'sensing-reference/location',
  reply: 'sensing-reference/reply',
  request: 'sensing-reference/request',
  stop: 'sensing-reference/stop',
});

export const MAX_AGE_MS = 5000;
export const MAX_FUTURE_MS = 1000;
export const MAX_ACCURACY_M = 100;

export const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
export const deviceId = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);

const exactKeys = (value, expected) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...expected].sort().join(',');

export function validFix(value) {
  return exactKeys(value, ['source', 'sampledAtMs', 'latitude', 'longitude', 'accuracyM'])
    && ['simulated', 'location'].includes(value.source)
    && Number.isSafeInteger(value.sampledAtMs) && value.sampledAtMs > 0
    && Number.isFinite(value.latitude) && Math.abs(value.latitude) <= 90
    && Number.isFinite(value.longitude) && Math.abs(value.longitude) <= 180
    && Number.isFinite(value.accuracyM) && value.accuracyM >= 0 && value.accuracyM <= MAX_ACCURACY_M;
}

export function validSample(value) {
  return exactKeys(value, ['recipient', 'streamId', 'sequence', 'requestId', 'fix'])
    && deviceId(value.recipient)
    && id(value.streamId)
    && Number.isSafeInteger(value.sequence) && value.sequence > 0
    && (value.requestId === null || id(value.requestId))
    && validFix(value.fix);
}

export function validStop(value) {
  return exactKeys(value, ['recipient', 'streamId'])
    && deviceId(value.recipient)
    && id(value.streamId);
}

export function validReply(value) {
  return exactKeys(value, ['recipient', 'streamId', 'sequence', 'requestId', 'sampledAtMs', 'status'])
    && deviceId(value.recipient)
    && id(value.streamId)
    && Number.isSafeInteger(value.sequence) && value.sequence > 0
    && (value.requestId === null || id(value.requestId))
    && Number.isSafeInteger(value.sampledAtMs) && value.sampledAtMs > 0
    && ['accepted', 'stale'].includes(value.status);
}

export function fresh(fix, now = Date.now(), maxAgeMs = MAX_AGE_MS) {
  return validFix(fix) && now - fix.sampledAtMs <= maxAgeMs && fix.sampledAtMs - now <= MAX_FUTURE_MS;
}

export function validRequest(value, now = Date.now()) {
  return exactKeys(value, ['recipient', 'requestId', 'source', 'expiresAtMs'])
    && deviceId(value.recipient)
    && id(value.requestId)
    && ['simulated', 'location'].includes(value.source)
    && Number.isSafeInteger(value.expiresAtMs) && value.expiresAtMs > now && value.expiresAtMs <= now + 30_000;
}

export function connected(session, peer) {
  // Canonical participation gives exact authenticated peer IDs. The direct
  // single-link integration fixture uses the public session connection count.
  return session.participation
    ? session.participation.status.connectedPeers.includes(peer)
    : session.status.connectedPeers > 0;
}

export function observeConnection(session, callback) {
  return session.participation ? session.participation.onStatus(callback) : session.onStatus(callback);
}

export function validRetentionInput(value) {
  return exactKeys(value, ['text', 'streamId', 'sequence', 'requestId', 'fix'])
    && typeof value.text === 'string' && value.text.trim().length > 0 && value.text.length <= 2000
    && id(value.streamId)
    && Number.isSafeInteger(value.sequence) && value.sequence > 0
    && (value.requestId === null || id(value.requestId))
    && validFix(value.fix);
}

export function retentionInput(sample, text) {
  if (!validSample(sample) || typeof text !== 'string' || !text.trim() || text.length > 2000) {
    throw Error('Review a bounded observation before retaining it.');
  }
  return {
    text: text.trim(),
    streamId: sample.streamId,
    sequence: sample.sequence,
    requestId: sample.requestId,
    fix: structuredClone(sample.fix),
  };
}

// Endpoint fields are signer-attested by a session owner, never copied from a
// sample payload. Include both endpoint ID and incarnation to separate tabs.
export function streamIdentity(envelope) {
  const stream = envelope?.stream;
  if (!deviceId(envelope?.authorId) || !id(envelope?.sessionId) || !id(stream?.streamId)
    || (stream.endpointId !== undefined && !id(stream.endpointId))
    || (stream.endpointIncarnation !== undefined && !id(stream.endpointIncarnation))) {
    return null;
  }
  return JSON.stringify([
    envelope.authorId,
    envelope.sessionId,
    stream.streamId,
    stream.endpointId ?? null,
    stream.endpointIncarnation ?? null,
  ]);
}
