import { defineCommand, defineQuery, emit, program } from '@chronolog/peer-session';

// Multi-agent Chronolog communication pipe.
// Use the authenticated event.author, never a claimed author in an input.
const str = (minLength, maxLength) => ({ type: 'string', minLength, maxLength });
const hex64 = { type: 'string', minLength: 64, maxLength: 64 };
const targetItem = { type: 'string', minLength: 1, maxLength: 64 };

export const agentRequestTopics = Object.freeze(['agent/message', 'agent/receipt']);
export const agentBusTopics = agentRequestTopics;

const validRecipient = value => value === '*' || (typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value));

export const agentRequestCommands = Object.freeze({
  agentMessage: defineCommand({
    description: 'Post a durable message to the page chat or agent backchannel.',
    input: {
      type: 'object',
      properties: {
        channel: { type: 'string', enum: ['chat', 'agents'] },
        to: { type: 'array', items: targetItem, maxItems: 32 },
        text: str(1, 8000),
        data: { type: 'string', maxLength: 16384 },
        attachments: {
          type: 'array',
          maxItems: 16,
          items: {
            type: 'object',
            properties: {
              contentId: str(1, 128),
              name: str(1, 200),
              mime: str(1, 128),
              size: { type: 'integer', minimum: 0, maximum: 500_000_000 },
            },
            required: ['contentId', 'name', 'mime'],
            additionalProperties: false,
          },
        },
        inReplyTo: {
          type: 'object',
          properties: { author: hex64, operationId: str(1, 512) },
          required: ['author', 'operationId'],
          additionalProperties: false,
        },
        hopCount: { type: 'integer', minimum: 0, maximum: 16 },
        expectReply: { type: 'boolean' },
        replyToUser: { type: 'boolean' },
      },
      required: ['channel', 'to', 'text'],
      additionalProperties: false,
    },
    prepare(input) {
      if (!Array.isArray(input.to) || input.to.some(item => !validRecipient(item))) {
        throw Error('AGENT_MESSAGE_RECIPIENT_INVALID');
      }
      if (input.inReplyTo && !/^[a-f0-9]{64}$/u.test(input.inReplyTo.author)) {
        throw Error('AGENT_MESSAGE_REPLY_AUTHOR_INVALID');
      }
      return program(emit('agent/message', input));
    },
  }),
  agentReceipt: defineCommand({
    description: 'Record a durable seen/thinking/done receipt for an agent message.',
    input: {
      type: 'object',
      properties: {
        messageAuthor: hex64,
        messageOperationId: str(1, 512),
        runId: str(1, 128),
        state: { type: 'string', enum: ['seen', 'thinking', 'done', 'error'] },
      },
      required: ['messageAuthor', 'messageOperationId', 'runId', 'state'],
      additionalProperties: false,
    },
    prepare(input) {
      if (!/^[a-f0-9]{64}$/u.test(input.messageAuthor)) {
        throw Error('AGENT_RECEIPT_AUTHOR_INVALID');
      }
      return program(emit('agent/receipt', input));
    },
  }),
});

export const agentBusCommands = agentRequestCommands;

const refKey = (author, operationId) => `${author}:${operationId}`;

function parseTimestamp(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const result = Number(value);
  return Number.isSafeInteger(result) ? result : null;
}

/** One coherent materialized snapshot of chat messages, agent backchannel activity, and receipts. */
export function readAgentFeed(view) {
  const messages = [];
  const activity = [];
  const receipts = {};
  let cursor;
  for (;;) {
    const batch = view.readEvents({
      topics: agentRequestTopics,
      limit: 128,
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const event of batch.events) {
      const payload = event.payload ?? {};
      const atMs = parseTimestamp(event.authorTimestampMs);
      if (event.topic === 'agent/message') {
        const entry = {
          author: event.author,
          operationId: event.operationId,
          eventId: event.id,
          atMs,
          channel: payload.channel === 'agents' ? 'agents' : 'chat',
          to: Array.isArray(payload.to) ? payload.to : [],
          text: String(payload.text ?? ''),
          ...(payload.data !== undefined ? { data: payload.data } : {}),
          ...(Array.isArray(payload.attachments) ? { attachments: payload.attachments } : {}),
          ...(payload.inReplyTo ? { inReplyTo: payload.inReplyTo } : {}),
          hopCount: typeof payload.hopCount === 'number' ? payload.hopCount : 0,
          expectReply: payload.expectReply !== false,
          replyToUser: payload.replyToUser === true,
        };
        if (entry.channel === 'agents') activity.push(entry);
        else messages.push(entry);
      } else if (event.topic === 'agent/receipt') {
        const key = refKey(payload.messageAuthor, payload.messageOperationId);
        const list = (receipts[key] ??= []);
        const item = {
          author: event.author,
          operationId: event.operationId,
          eventId: event.id,
          runId: payload.runId,
          state: payload.state ?? 'seen',
          atMs,
        };
        const existingIdx = list.findIndex(r => r.author === item.author && r.runId === item.runId);
        if (existingIdx >= 0) list[existingIdx] = item;
        else list.push(item);
      }
    }
    if (!batch.hasMore) return { messages, activity, receipts };
    if (batch.cursor === cursor) throw Error('AGENT_FEED_CURSOR_STALLED');
    cursor = batch.cursor;
  }
}

export const agentRequestQueries = Object.freeze({
  agentFeed: defineQuery({
    description: 'Read materialized chat messages, agent backchannel activity, and receipts.',
    input: { type: 'null' },
    read: readAgentFeed,
  }),
});

export const agentBusQueries = agentRequestQueries;

/** Parse @handle, @all, and spoken prefixes ("Hey <handle>, ...") against the page roster. */
export function parseAddressing(text, roster) {
  const source = String(text ?? '');
  const agents = Array.isArray(roster) ? roster : (roster?.agents ?? []);
  const byHandle = new Map(agents.map(a => [String(a.handle ?? '').toLowerCase(), a]));
  const to = [];
  const handles = [];
  let broadcast = false;

  const addHandle = raw => {
    const h = String(raw ?? '').toLowerCase();
    if (!h) return;
    if (h === 'all' || h === 'everyone') {
      broadcast = true;
      return;
    }
    const agent = byHandle.get(h);
    if (!agent) return;
    const key = agent.public_key ?? agent.publicKey;
    if (key && !to.includes(key)) {
      to.push(key);
      handles.push(agent.handle);
    }
  };

  for (const match of source.matchAll(/(?:^|[\s([{"'])@([a-z][a-z0-9_-]{1,31})\b/gi)) {
    addHandle(match[1]);
  }
  const voiceLead = /^(?:hey|hi|ok|okay|ask|tell|yo)\s+([a-z][a-z0-9_-]{1,31})(?:[,:\s]|$)/i.exec(source.trim());
  if (voiceLead) addHandle(voiceLead[1]);

  if (broadcast) {
    return { to: ['*'], handles: ['*'], explicit: true, broadcast: true };
  }
  return { to, handles, explicit: to.length > 0, broadcast: false };
}

/**
 * Deterministic multi-agent response policy:
 * - Never reply to own messages.
 * - Stop when expectReply === false or hopCount >= maxHops.
 * - Broadcast (`*`) triggers every agent.
 * - Explicit `to` list triggers ONLY listed agents (primary steps back when a secondary is addressed).
 * - General `chat` message (`to.length === 0`) triggers ONLY the primary agent (non-primary stays silent).
 * - General `agents` backchannel message (`to.length === 0`) does not trigger automatic replies.
 */
export function shouldAgentRespond(message, { selfPublicKey, selfHandle, roster, maxHops = 5 } = {}) {
  if (!message || !selfPublicKey) return false;
  if (message.author === selfPublicKey) return false;
  if (message.expectReply === false) return false;
  const hopCount = typeof message.hopCount === 'number' ? message.hopCount : 0;
  if (hopCount >= maxHops) return false;

  const to = Array.isArray(message.to) ? message.to : [];
  if (to.includes('*')) return true;
  if (to.length > 0) return to.includes(selfPublicKey);

  // Unaddressed message: only primary responds, and only on the user-facing chat channel.
  if (message.channel === 'agents') return false;
  const agents = Array.isArray(roster) ? roster : (roster?.agents ?? []);
  const primaryId = Array.isArray(roster) ? null : (roster?.primary_agent_id ?? roster?.primaryId ?? null);
  const selfEntry = agents.find(a =>
    (a.public_key ?? a.publicKey) === selfPublicKey ||
    (selfHandle && String(a.handle ?? '').toLowerCase() === String(selfHandle).toLowerCase()),
  );
  if (!selfEntry) return false;
  if (primaryId) return selfEntry.id === primaryId;
  return Boolean(selfEntry.is_primary ?? selfEntry.isPrimary);
}

/** Determine delivery status of a user message from receipts and replies. */
export function messageDelivery(message, feed) {
  if (!message) return 'delivered';
  const replies = (feed?.messages ?? []).filter(m =>
    m.inReplyTo?.author === message.author && m.inReplyTo?.operationId === message.operationId,
  );
  if (replies.length > 0) return 'answered';
  const list = feed?.receipts?.[refKey(message.author, message.operationId)] ?? [];
  if (list.some(r => r.state === 'done')) return 'answered';
  if (list.some(r => r.state === 'thinking')) return 'thinking';
  if (list.some(r => r.state === 'seen')) return 'seen';
  return 'delivered';
}

// ---------------------------------------------------------------- Ephemeral Agent Cards & Streams

const PRESENCE_TOPIC = 'agent/presence';
const PRESENCE_PING_TOPIC = 'agent/presence/ping';
const STREAM_TOPIC = 'agent/stream';

/**
 * Native agent side: announces an ephemeral Agent Card over session.signals ONLY while
 * at least one peer is connected, and answers presence pings immediately.
 * Writes ZERO durable Chronolog operations.
 */
export function announceAgentPresence(session, {
  handle = '',
  bio = '',
  capabilities = ['chat'],
  isPrimary = false,
  runId = crypto.randomUUID(),
  state = 'online',
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
  let card = { handle, bio, capabilities, isPrimary, state };

  const hasPeer = () => (session.status?.connectedPeers ?? 0) > 0;

  const publish = async (overrideState = card.state) => {
    if (lifetime.aborted) return;
    if (overrideState !== 'stopped' && !hasPeer()) return;
    try {
      await session.signals.send(topic, {
        handle: card.handle,
        bio: card.bio,
        capabilities: card.capabilities,
        isPrimary: Boolean(card.isPrimary),
        runId,
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
    setState(next) { card = { ...card, state: next }; void publish(next); },
    updateCard(patch) { card = { ...card, ...patch }; void publish(); },
    ping: () => publish(),
    done: pingLoop,
    async close() {
      card = { ...card, state: 'stopped' };
      await publish('stopped');
      stop.abort();
    },
  });
}

/**
 * Browser/agent side: watches ephemeral Agent Cards for ALL agents on the page,
 * cross-checking Chronolog authority membership so UI status is always honest.
 */
export function watchAgentsPresence(session, {
  topic = PRESENCE_TOPIC,
  pingTopic = PRESENCE_PING_TOPIC,
  staleAfterMs = 45_000,
  onChange,
  signal,
} = {}) {
  if (!session?.signals) throw Error('AGENT_PRESENCE_SESSION_REQUIRED');
  const stop = new AbortController();
  const lifetime = AbortSignal.any([stop.signal, signal, session.signal].filter(Boolean));
  const cards = new Map();
  let enrolledKeys = new Set();

  const refreshAuthority = async () => {
    try {
      const auth = typeof session.authority === 'function' ? await session.authority() : null;
      const members = auth?.bundle?.memberships?.at(-1)?.payload?.members ?? auth?.members ?? [];
      if (Array.isArray(members)) {
        enrolledKeys = new Set(members.filter(m => m.reader || m.writer).map(m => m.publicKey));
      }
    } catch { /* Optional authority inspection */ }
  };

  const snapshot = (now = Date.now()) => {
    const connected = (session.status?.connectedPeers ?? 0) > 0;
    const out = {};
    for (const key of enrolledKeys) {
      out[key] = { enrolled: true, state: 'offline' };
    }
    for (const [author, entry] of cards) {
      const ageMs = Math.max(0, now - entry.receivedAtMs);
      const enrolled = enrolledKeys.size > 0 ? enrolledKeys.has(author) : true;
      let state = 'offline';
      if (entry.card.state === 'stopped') state = 'stopped';
      else if (connected && ageMs < staleAfterMs) {
        state = entry.card.state === 'busy' ? 'busy' : 'online';
      }
      out[author] = {
        enrolled,
        state,
        handle: entry.card.handle || undefined,
        bio: entry.card.bio || undefined,
        capabilities: Array.isArray(entry.card.capabilities) ? entry.card.capabilities : undefined,
        lastSeenAt: entry.receivedAtMs,
        stoppedAt: entry.stoppedAtMs ?? null,
      };
    }
    return out;
  };

  const emitChange = () => { try { onChange?.(snapshot()); } catch { /* ignore */ } };

  const requestPing = () => {
    if (lifetime.aborted) return;
    if ((session.status?.connectedPeers ?? 0) === 0) return;
    void session.signals.send(pingTopic, { atMs: Date.now() }, { ttlMs: 10_000, signal: lifetime }).catch(() => {});
  };

  let watchedLink = null;
  const offStatus = session.onStatus(status => {
    const link = (status?.connectedPeers ?? 0) > 0 ? JSON.stringify([status.connectionRevision ?? null]) : null;
    if (link !== null && link !== watchedLink) {
      void refreshAuthority().then(emitChange);
      requestPing();
    } else emitChange();
    watchedLink = link;
  });

  const staleTimer = setInterval(emitChange, Math.max(2_000, Math.min(10_000, Math.floor(staleAfterMs / 3))));
  lifetime.addEventListener('abort', () => { clearInterval(staleTimer); offStatus(); }, { once: true });

  const loop = (async () => {
    try {
      for await (const frame of session.signals.subscribe({ topics: [topic], mode: 'all', includeLatest: true, signal: lifetime })) {
        if (!frame.payload || typeof frame.payload !== 'object') continue;
        const now = Date.now();
        cards.set(frame.authorId, {
          card: frame.payload,
          receivedAtMs: now,
          stoppedAtMs: frame.payload.state === 'stopped' ? now : null,
        });
        emitChange();
      }
    } catch { /* closed */ }
  })();

  void refreshAuthority().then(emitChange);
  requestPing();

  return Object.freeze({
    snapshot,
    ping: requestPing,
    refreshAuthority,
    done: loop,
    close() { stop.abort(); },
  });
}

/** Native side: send an ephemeral streaming preview for an in-progress reply. */
export async function streamAgentReply(session, {
  messageAuthor,
  messageOperationId,
  handle = '',
  text,
  done = false,
  topic = STREAM_TOPIC,
  signal,
}) {
  if (!session?.signals) throw Error('AGENT_STREAM_SESSION_REQUIRED');
  const payload = {
    messageAuthor,
    messageOperationId,
    handle,
    text: String(text ?? '').slice(0, 8000),
    done: Boolean(done),
    atMs: Date.now(),
  };
  const encoder = new TextEncoder();
  while (encoder.encode(JSON.stringify(payload)).length > 12 * 1024) {
    if (!payload.text.length) throw Error('AGENT_STREAM_TOO_LARGE');
    payload.text = Array.from(payload.text).slice(0, Math.floor(Array.from(payload.text).length * 0.8)).join('');
  }
  await session.signals.send(topic, payload, { ttlMs: 20_000, signal });
}

/** Browser side: subscribe to concurrent ephemeral streaming previews across all agents. */
export function watchAgentStreams(session, {
  topic = STREAM_TOPIC,
  onChange,
  signal,
} = {}) {
  if (!session?.signals) throw Error('AGENT_STREAM_SESSION_REQUIRED');
  const stop = new AbortController();
  const lifetime = AbortSignal.any([stop.signal, signal, session.signal].filter(Boolean));
  const streams = new Map();

  const emitChange = () => {
    try { onChange?.([...streams.values()]); } catch { /* ignore */ }
  };

  const loop = (async () => {
    try {
      for await (const frame of session.signals.subscribe({ topics: [topic], mode: 'all', signal: lifetime })) {
        if (!frame.payload || typeof frame.payload !== 'object') continue;
        if (frame.payload.done || !String(frame.payload.text ?? '').trim()) {
          streams.delete(frame.authorId);
        } else {
          streams.set(frame.authorId, {
            id: frame.authorId,
            author: frame.authorId,
            senderHandle: frame.payload.handle || undefined,
            messageAuthor: frame.payload.messageAuthor,
            messageOperationId: frame.payload.messageOperationId,
            text: String(frame.payload.text),
            atMs: frame.payload.atMs ?? Date.now(),
          });
        }
        emitChange();
      }
    } catch { /* closed */ }
  })();

  return Object.freeze({
    snapshot: () => [...streams.values()],
    done: loop,
    close() { stop.abort(); },
  });
}

/**
 * Pure failover detector for primary agent unavailability.
 * Returns null when suppressed (offline, no primary, healthy primary, or no healthy backup).
 */
export function evaluateFailover({
  roster,
  liveMap = {},
  online = true,
  lastPendingUserMessage = null,
  primaryOfflineSinceMs = null,
  now = Date.now(),
  offlineThresholdMs = 30_000,
  unackThresholdMs = 12_000,
} = {}) {
  if (!online) return null;
  const agents = roster?.agents ?? [];
  const primary = agents.find(a => a.id === roster?.primary_agent_id || a.is_primary) ?? null;
  if (!primary || primary.kind === 'hosted-mcp') return null;

  const primaryKey = primary.public_key ?? primary.publicKey;
  const primaryLive = liveMap[primaryKey] ?? liveMap[primary.id];
  const primaryHealthy = primaryLive?.state === 'online' || primaryLive?.state === 'busy';
  if (primaryHealthy) return null;

  const backups = agents.filter(a => {
    if (a.id === primary.id) return false;
    if (a.kind === 'hosted-mcp') return true;
    const key = a.public_key ?? a.publicKey;
    const st = liveMap[key] ?? liveMap[a.id];
    return st?.state === 'online' || st?.state === 'busy';
  });
  if (backups.length === 0) return null;

  const backup = backups[0];
  if (primaryLive?.state === 'stopped') {
    return { reason: 'stopped', primary, backup, backups, lastPendingUserMessage };
  }
  if (lastPendingUserMessage && lastPendingUserMessage.sentAtMs && (now - lastPendingUserMessage.sentAtMs) >= unackThresholdMs) {
    return { reason: 'unacknowledged', primary, backup, backups, lastPendingUserMessage };
  }
  if (primaryOfflineSinceMs !== null && (now - primaryOfflineSinceMs) >= offlineThresholdMs) {
    return { reason: 'offline', primary, backup, backups, lastPendingUserMessage };
  }
  return null;
}
