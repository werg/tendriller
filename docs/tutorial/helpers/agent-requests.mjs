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
