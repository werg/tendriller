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

/** One coherent materialized snapshot; rederiving also removes retracted facts. */
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
        // Orphan references (including excluded or retracted facts) change no item.
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

/** The durable request phase is separate from the caller's stored/materialized observations. */
export function requestDelivery(request) {
  if (!request) return 'unknown';
  return request.answers.length ? 'answered' : request.receipts.length ? 'seen' : 'awaiting-receipt';
}

// Ephemeral live presence & streaming reply previews over session.signals.
// Writes ZERO durable Chronolog records so idle agents never consume journal history.

const PRESENCE_TOPIC = 'agent/presence';
const PRESENCE_PING_TOPIC = 'agent/presence/ping';
const STREAM_TOPIC = 'agent/stream';

/**
 * Native side: announces agent presence ephemerally over session.signals ONLY while
 * at least one peer is connected, and responds immediately to on-demand presence pings.
 */
export function announceAgentPresence(session, {
  consumerId,
  runId = crypto.randomUUID(),
  role = 'agent',
  topics = ['chat'],
  state = 'listening',
  intervalMs = 15_000,
  ttlMs = 45_000,
  topic = PRESENCE_TOPIC,
  pingTopic = PRESENCE_PING_TOPIC,
  signal,
} = {}) {
  if (!session?.signals) throw Error('AGENT_PRESENCE_SESSION_REQUIRED');
  const stop = new AbortController();
  const lifetime = AbortSignal.any([stop.signal, signal, session.signal].filter(Boolean));
  const startedAtMs = Date.now();
  let currentState = state;

  const hasPeer = () => (session.status?.connectedPeers ?? 0) > 0;

  const publish = async (overrideState = currentState) => {
    if (lifetime.aborted) return;
    if (overrideState !== 'stopped' && !hasPeer()) return;
    try {
      await session.signals.send(topic, {
        consumerId: consumerId || session.identity.publicKey,
        runId,
        role,
        topics,
        state: overrideState,
        startedAtMs,
        atMs: Date.now(),
      }, { ttlMs, signal: lifetime });
    } catch { /* Ephemeral presence drops cleanly when offline. */ }
  };

  const timer = setInterval(() => { void publish(); }, intervalMs);
  let announcedLink = null;
  const offStatus = session.onStatus(status => {
    const link = (status?.connectedPeers ?? 0) > 0 ? JSON.stringify([status.connectionRevision ?? null]) : null;
    if (link !== null && link !== announcedLink) void publish();
    announcedLink = link;
  });

  const pingLoop = (async () => {
    try {
      for await (const frame of session.signals.subscribe({ topics: [pingTopic], mode: 'all', signal: lifetime })) {
        if (frame.authorId === session.identity.publicKey) continue;
        void publish();
      }
    } catch { /* closed */ }
  })();

  lifetime.addEventListener('abort', () => { clearInterval(timer); offStatus(); }, { once: true });
  void publish();

  return Object.freeze({
    setState(next) { currentState = next; void publish(next); },
    ping: () => publish(),
    done: pingLoop,
    async close() {
      currentState = 'stopped';
      await publish('stopped');
      stop.abort();
    },
  });
}

/**
 * Browser side: watches ephemeral agent presence signals (with `includeLatest: true`
 * plus an immediate ping on connect) so the UI reflects live agent availability with
 * zero durable Chronolog reads or writes.
 */
export function watchAgentPresence(session, {
  peer,
  topic = PRESENCE_TOPIC,
  pingTopic = PRESENCE_PING_TOPIC,
  staleAfterMs = 45_000,
  onChange,
  signal,
} = {}) {
  if (!session?.signals) throw Error('AGENT_PRESENCE_SESSION_REQUIRED');
  const stop = new AbortController();
  const lifetime = AbortSignal.any([stop.signal, signal, session.signal].filter(Boolean));
  let latest = null;
  let lastReceivedAtMs = 0;

  const snapshot = (now = Date.now()) => {
    if (!latest) return { status: 'unknown', consumer: null, ageMs: null };
    if (latest.state === 'stopped') return { status: 'stopped', consumer: latest, ageMs: now - lastReceivedAtMs };
    const ageMs = Math.max(0, now - lastReceivedAtMs);
    if ((session.status?.connectedPeers ?? 0) === 0) return { status: 'stale', consumer: latest, ageMs };
    if (ageMs >= staleAfterMs) return { status: 'stale', consumer: latest, ageMs };
    return { status: latest.state === 'busy' ? 'busy' : 'available', consumer: latest, ageMs };
  };
  const emitChange = () => { try { onChange?.(snapshot()); } catch { /* ignore */ } };

  const requestPing = () => {
    if (lifetime.aborted) return;
    if ((session.status?.connectedPeers ?? 0) === 0) return;
    void session.signals.send(pingTopic, { for: peer ?? null, atMs: Date.now() }, { ttlMs: 10_000, signal: lifetime }).catch(() => {});
  };

  let watchedLink = null;
  const offStatus = session.onStatus(status => {
    const link = (status?.connectedPeers ?? 0) > 0 ? JSON.stringify([status.connectionRevision ?? null]) : null;
    if (link !== null && link !== watchedLink) requestPing();
    else emitChange();
    watchedLink = link;
  });

  const staleTimer = setInterval(emitChange, Math.max(2_000, Math.min(10_000, Math.floor(staleAfterMs / 3))));
  lifetime.addEventListener('abort', () => { clearInterval(staleTimer); offStatus(); }, { once: true });

  const loop = (async () => {
    try {
      for await (const frame of session.signals.subscribe({ topics: [topic], mode: 'latest', includeLatest: true, signal: lifetime })) {
        if (peer && frame.authorId !== peer) continue;
        if (!frame.payload || typeof frame.payload !== 'object') continue;
        latest = { author: frame.authorId, ...frame.payload };
        lastReceivedAtMs = Date.now();
        emitChange();
      }
    } catch { /* closed */ }
  })();

  requestPing();

  return Object.freeze({
    snapshot,
    ping: requestPing,
    done: loop,
    close() { stop.abort(); },
  });
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
        try { onChunk?.({ author: frame.authorId, ...frame.payload }); } catch { /* ignore */ }
      }
    } catch { /* closed */ }
  })();
  return Object.freeze({ done: loop, close() { stop.abort(); } });
}
