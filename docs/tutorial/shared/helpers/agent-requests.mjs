import { defineCommand, defineQuery, emit, program } from '@chronolog/peer-session';

// Application-owned facts. These do not alter the journal's operation states.
// Use the authenticated event author, never a claimed author in an input.
const text = maxLength => ({ type: 'string', minLength: 1, maxLength });
const object = properties => ({ type: 'object', properties,
  required: Object.keys(properties), additionalProperties: false });
const identity = { type: 'string', minLength: 64, maxLength: 64 };
const reference = { requestAuthor: identity, requestOperationId: text(512) };
const consumer = { consumerId: text(128), runId: text(128) };
export const agentRequestTopics = Object.freeze([
  'agent/request', 'agent/receipt', 'agent/answer', 'agent/heartbeat',
]);
const eventCommand = (description, topic, properties) => defineCommand({
  description, input: object(properties),
  prepare(input) {
    for (const field of ['recipient', 'requestAuthor']) {
      if (input[field] !== undefined && !/^[a-f0-9]{64}$/u.test(input[field])) {
        throw Error('AGENT_REQUEST_IDENTITY_INVALID');
      }
    }
    return program(emit(topic, input));
  },
});

export const agentRequestCommands = Object.freeze({
  agentRequest: eventCommand('Ask a particular enrolled native participant for a reply.',
    'agent/request', { recipient: identity, topic: text(128), text: text(8000) }),
  agentReceipt: eventCommand('Acknowledge a request actually read by this consumer.',
    'agent/receipt', { ...reference, ...consumer }),
  agentAnswer: eventCommand('Retain an answer addressed to the full request identity.',
    'agent/answer', { ...reference, ...consumer, text: text(8000) }),
  agentHeartbeat: eventCommand('Report a successful consumer read or an explicit stop.',
    'agent/heartbeat', { ...consumer, role: text(128),
      topics: { type: 'array', items: text(128), minItems: 1, maxItems: 32 },
      startedAtMs: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      state: { type: 'string', enum: ['listening', 'stopped'] } }),
});

const key = (...parts) => JSON.stringify(parts);
function timestamp(value) {
  // Signed author time is useful display evidence, not a server-certified clock.
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const result = Number(value);
  return Number.isSafeInteger(result) ? result : null;
}

/** One coherent selected-history read; rebuilding also removes abandoned facts. */
export function readAgentInbox(view) {
  const requests = new Map(), consumers = new Map();
  let cursor;
  for (;;) {
    const batch = view.readEvents({ topics: agentRequestTopics, limit: 128,
      ...(cursor === undefined ? {} : { cursor }) });
    for (const event of batch.events) {
      const input = event.payload, atMs = timestamp(event.authorTimestampMs);
      if (event.topic === 'agent/request') {
        requests.set(key(event.author, event.operationId), {
          requestAuthor: event.author, requestOperationId: event.operationId,
          recipient: input.recipient, topic: input.topic, text: input.text,
          sentAtMs: atMs, receipts: [], answers: [],
        });
      } else if (event.topic === 'agent/heartbeat') {
        consumers.set(key(event.author, input.consumerId), {
          author: event.author, consumerId: input.consumerId, runId: input.runId,
          role: input.role, topics: input.topics, state: input.state,
          startedAtMs: input.startedAtMs, lastSeenAtMs: atMs,
        });
      } else {
        const request = requests.get(key(input.requestAuthor, input.requestOperationId));
        // Another member may emit a fact, but cannot impersonate the recipient.
        // Orphan references (including facts excluded by recovery) change no item.
        if (!request || event.author !== request.recipient) continue;
        const fact = { author: event.author, consumerId: input.consumerId,
          runId: input.runId, operationId: event.operationId, eventId: event.id, atMs };
        if (event.topic === 'agent/receipt') {
          if (!request.receipts.some(item => item.author === fact.author
            && item.consumerId === fact.consumerId && item.runId === fact.runId)) {
            request.receipts.push(fact);
          }
        } else if (event.topic === 'agent/answer') {
          request.answers.push({ ...fact, text: input.text });
        }
      }
    }
    if (!batch.hasMore) return { requests: [...requests.values()], consumers: [...consumers.values()] };
    if (batch.cursor === cursor) throw Error('AGENT_INBOX_CURSOR_STALLED');
    cursor = batch.cursor;
  }
}

export const agentRequestQueries = Object.freeze({
  agentInbox: defineQuery({ description: 'Read addressed requests, receipts, answers and last consumer announcements.',
    input: { type: 'null' }, read: readAgentInbox }),
});

/** Call again as the wall clock advances, even when there are no new events. */
export function consumerPresence(consumer, {
  now = Date.now(), staleAfterMs = 90_000, observationCurrent = false,
} = {}) {
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(staleAfterMs) || staleAfterMs < 1) {
    throw Error('AGENT_PRESENCE_OPTIONS_INVALID');
  }
  if (!consumer || !observationCurrent) return { status: 'unknown', consumer: consumer ?? null };
  if (consumer.state === 'stopped') return { status: 'stopped', consumer };
  const ageMs = consumer.lastSeenAtMs === null ? null : now - consumer.lastSeenAtMs;
  if (ageMs === null || ageMs < 0 || consumer.startedAtMs > consumer.lastSeenAtMs) {
    return { status: 'clock-skew', consumer };
  }
  return { status: ageMs < staleAfterMs ? 'available' : 'stale', consumer, ageMs };
}

/** The durable request phase is separate from the caller's saved/applied state. */
export function requestDelivery(request) {
  if (!request) return 'unknown';
  return request.answers.length ? 'answered' : request.receipts.length ? 'seen' : 'awaiting-receipt';
}

// Ephemeral live presence & streaming reply previews over session.signals.
// Writes ZERO durable Chronolog records so idle agents never consume journal history.

const PRESENCE_TOPIC = 'agent/presence';
const PRESENCE_PING_TOPIC = 'agent/presence/ping';
const STREAM_TOPIC = 'agent/stream';

const presenceText = (value, limit = 128) => typeof value === 'string' && value.trim().length > 0 && value.length <= limit;
const presenceStates = new Set(['listening', 'busy', 'stopped']);
const validPresence = value => value && typeof value === 'object' && !Array.isArray(value)
  && presenceText(value.consumerId) && presenceText(value.runId) && presenceText(value.role)
  && presenceStates.has(value.state) && Array.isArray(value.topics)
  && value.topics.length > 0 && value.topics.length <= 32
  && value.topics.every(item => presenceText(item))
  && Number.isSafeInteger(value.startedAtMs) && value.startedAtMs >= 0
  && Number.isSafeInteger(value.atMs) && value.atMs >= value.startedAtMs;
const positiveMs = value => Number.isSafeInteger(value) && value > 0;

/**
 * Announce only from the actual request worker, after its first successful read.
 * Bind signal to that worker's lifetime, not the shared native page owner.
 */
export function announceAgentPresence(session, {
  consumerId = session?.deviceId,
  runId = crypto.randomUUID(),
  role = 'agent',
  topics = ['chat'],
  state = 'listening',
  intervalMs = 15_000,
  ttlMs = 30_000,
  topic = PRESENCE_TOPIC,
  pingTopic = PRESENCE_PING_TOPIC,
  signal,
} = {}) {
  if (!session?.signals) throw Error('AGENT_PRESENCE_SESSION_REQUIRED');
  if (!presenceText(consumerId) || !presenceText(runId) || !presenceText(role)
    || !Array.isArray(topics) || !topics.length || topics.length > 32
    || !topics.every(item => presenceText(item)) || !presenceStates.has(state)
    || !positiveMs(intervalMs) || !positiveMs(ttlMs)) throw Error('AGENT_PRESENCE_OPTIONS_INVALID');
  const selectedTopics = [...new Set(topics)];
  const stop = new AbortController();
  const lifetime = AbortSignal.any([stop.signal, signal, session.signal].filter(Boolean));
  const startedAtMs = Date.now();
  let currentState = state, active = !lifetime.aborted, timer, closing;
  let offStatus = () => {};

  const hasPeer = () => {
    const peers = session.participation?.status?.connectedPeers;
    return Array.isArray(peers) ? peers.length > 0 : true;
  };
  const payload = next => ({ consumerId, runId, role, topics: selectedTopics,
    state: next, startedAtMs, atMs: Math.max(startedAtMs, Date.now()) });
  const publish = async () => {
    if (!active || lifetime.aborted || !hasPeer()) return;
    try { await session.signals.send(topic, payload(currentState), { ttlMs, signal: lifetime, stream: { streamId: consumerId } }); }
    catch { /* Signals are disposable; they do not acknowledge any request. */ }
  };
  const close = () => {
    if (closing) return closing;
    active = false;
    clearInterval(timer);
    offStatus();
    lifetime.removeEventListener('abort', onAbort);
    // Stop the subscription immediately. The final best-effort signal has its
    // own bounded lifetime because the worker signal may already be aborted.
    stop.abort();
    closing = (async () => {
      if (session.signal?.aborted) return;
      try {
        await session.signals.send(topic, payload('stopped'), {
          ttlMs, signal: AbortSignal.any([AbortSignal.timeout(1000), session.signal].filter(Boolean)),
          stream: { streamId: consumerId },
        });
      } catch { /* Abrupt loss is represented by expiry on observers. */ }
    })();
    return closing;
  };
  const onAbort = () => { void close(); };
  if (active) {
    timer = setInterval(() => { void publish(); }, intervalMs);
    offStatus = session.participation?.onStatus?.(status => {
      if ((status?.connectedPeers?.length ?? 0) > 0) void publish();
    }) ?? (() => {});
    lifetime.addEventListener('abort', onAbort, { once: true });
  }

  const pingLoop = (async () => {
    if (!active) return;
    try {
      for await (const frame of session.signals.subscribe({ topics: [pingTopic], mode: 'all', signal: lifetime })) {
        if (frame.authorId === session.deviceId) continue;
        const request = frame.payload;
        if (request?.for && request.for !== session.deviceId) continue;
        if (request?.consumerId && request.consumerId !== consumerId) continue;
        if (request?.requestTopic && !selectedTopics.includes(request.requestTopic)) continue;
        void publish();
      }
    } catch { /* Loss of the presence subscription also ends this announcement. */ }
    finally { await close(); }
  })();
  void publish();

  return Object.freeze({
    setState(next) {
      if (!presenceStates.has(next)) throw Error('AGENT_PRESENCE_STATE_INVALID');
      if (!active) return;
      currentState = next;
      void publish();
    },
    ping: publish,
    done: pingLoop,
    close,
  });
}

/** Observe one actual worker/topic; a connected peer alone is not availability. */
export function watchAgentPresence(session, {
  peer,
  consumerId,
  requestTopic,
  topic = PRESENCE_TOPIC,
  pingTopic = PRESENCE_PING_TOPIC,
  staleAfterMs = 30_000,
  onChange,
  signal,
} = {}) {
  if (!session?.signals) throw Error('AGENT_PRESENCE_SESSION_REQUIRED');
  if (!positiveMs(staleAfterMs)
    || (consumerId !== undefined && !presenceText(consumerId))
    || (requestTopic !== undefined && !presenceText(requestTopic))) throw Error('AGENT_PRESENCE_OPTIONS_INVALID');
  const stop = new AbortController();
  const lifetime = AbortSignal.any([stop.signal, signal, session.signal].filter(Boolean));
  let latest = null, lastReceivedAtMs = 0, expiresAtMs = 0, lastSignalSession, lastSequence = -1;
  let offStatus = () => {}, staleTimer;

  const snapshot = (now = Date.now()) => {
    if (lifetime.aborted || !latest) return { status: 'unknown', consumer: latest, ageMs: null };
    const ageMs = Math.max(0, now - lastReceivedAtMs);
    if (latest.state === 'stopped') return { status: 'stopped', consumer: latest, ageMs };
    const peers = session.participation?.status?.connectedPeers;
    if ((Array.isArray(peers) && !peers.includes(peer ?? latest.author)) || ageMs >= staleAfterMs || now >= expiresAtMs) {
      return { status: 'stale', consumer: latest, ageMs };
    }
    return { status: latest.state === 'busy' ? 'busy' : 'available', consumer: latest, ageMs };
  };
  const emitChange = () => { try { onChange?.(snapshot()); } catch { /* UI callback */ } };
  const requestPing = () => {
    if (lifetime.aborted) return;
    const peers = session.participation?.status?.connectedPeers;
    if (Array.isArray(peers) && peer && !peers.includes(peer)) return;
    void session.signals.send(pingTopic, { for: peer ?? null, consumerId: consumerId ?? null,
      requestTopic: requestTopic ?? null, atMs: Date.now() },
    { ttlMs: 10_000, signal: lifetime }).catch(() => {});
  };
  const cleanup = () => { clearInterval(staleTimer); offStatus(); emitChange(); };
  if (!lifetime.aborted) {
    offStatus = session.participation?.onStatus?.(status => {
      if (!peer || (status?.connectedPeers ?? []).includes(peer)) requestPing();
      emitChange();
    }) ?? (() => {});
    staleTimer = setInterval(emitChange, Math.max(2_000, Math.min(10_000, Math.floor(staleAfterMs / 3))));
    lifetime.addEventListener('abort', cleanup, { once: true });
  }
  const loop = (async () => {
    if (lifetime.aborted) return;
    try {
      // Stream selectors run before latest coalescing. Separate workers keep
      // separate slots; native signal sequence checks reject delayed older states.
      for await (const frame of session.signals.subscribe({
        topics: [topic], mode: 'latest', includeLatest: true, signal: lifetime,
        ...((peer || consumerId !== undefined) ? {
          streams: [{ ...(peer ? { authorId: peer } : {}),
            ...(consumerId !== undefined ? { streamId: consumerId } : {}) }],
        } : {}),
      })) {
        if (peer && frame.authorId !== peer) continue;
        const value = frame.payload;
        if (!validPresence(value)) continue;
        if (consumerId !== undefined && value.consumerId !== consumerId) continue;
        if (requestTopic !== undefined && !value.topics.includes(requestTopic)) continue;
        if (latest?.author === frame.authorId && latest.consumerId === value.consumerId) {
          // An attachment incarnation creates a different signal stream slot,
          // but the native owner's sequence remains global within its session.
          if (lastSignalSession === frame.sessionId && frame.sequence <= lastSequence) continue;
          if ((lastSignalSession !== frame.sessionId || latest.runId !== value.runId)
            && value.startedAtMs <= latest.startedAtMs) continue;
          if (latest.runId === value.runId && value.startedAtMs !== latest.startedAtMs) continue;
        }
        lastSignalSession = frame.sessionId;
        lastSequence = frame.sequence;
        latest = { ...value, topics: [...value.topics], author: frame.authorId };
        lastReceivedAtMs = Date.now();
        expiresAtMs = Number.isSafeInteger(frame.expiresAtMs) ? frame.expiresAtMs : 0;
        emitChange();
      }
    } catch { /* Observation failure is unknown, never a retained Live badge. */ }
    finally { stop.abort(); }
  })();
  requestPing();
  return Object.freeze({ snapshot, ping: requestPing, done: loop, close() { stop.abort(); } });
}

/** Native side: send an ephemeral streaming preview for an in-progress reply. */
export async function streamAgentReply(session, {
  requestAuthor,
  requestOperationId,
  text,
  done = false,
  topic = STREAM_TOPIC,
  signal,
}) {
  if (!session?.signals) throw Error('AGENT_STREAM_SESSION_REQUIRED');
  const payload = {
    requestAuthor,
    requestOperationId,
    text: String(text ?? '').slice(0, 8000),
    done: Boolean(done),
    atMs: Date.now(),
  };
  // The complete signed frame has a 16 KiB ceiling; escaped JSON and Unicode
  // can make an 8,000-character preview much larger than that.
  const encoder = new TextEncoder();
  while (encoder.encode(JSON.stringify(payload)).length > 12 * 1024) {
    if (!payload.text.length) throw Error('AGENT_STREAM_TOO_LARGE');
    payload.text = Array.from(payload.text).slice(0, Math.floor(Array.from(payload.text).length * .8)).join('');
  }
  await session.signals.send(topic, payload, { ttlMs: 20_000, signal });
}

/** Browser side: subscribe to ephemeral streaming previews from a peer. */
export function watchAgentStream(session, {
  peer,
  topic = STREAM_TOPIC,
  onChunk,
  signal,
} = {}) {
  if (!session?.signals) throw Error('AGENT_STREAM_SESSION_REQUIRED');
  const stop = new AbortController();
  const lifetime = AbortSignal.any([stop.signal, signal, session.signal].filter(Boolean));
  const loop = (async () => {
    try {
      for await (const frame of session.signals.subscribe({ topics: [topic], mode: 'latest', signal: lifetime })) {
        if (peer && frame.authorId !== peer) continue;
        if (!frame.payload || typeof frame.payload !== 'object') continue;
        try { onChunk?.({ ...frame.payload, author: frame.authorId }); } catch { /* ignore */ }
      }
    } catch { /* closed */ }
  })();
  return Object.freeze({ done: loop, close() { stop.abort(); } });
}
