import { defineCommand, defineQuery } from '@chronolog/peer-session';

// Multi-agent Chronolog communication pipe.
// Use the authenticated event.author, never a claimed author in an input.
const str = (minLength, maxLength) => ({ type: 'string', minLength, maxLength });
const hex64 = { type: 'string', minLength: 64, maxLength: 64 };
const targetItem = { type: 'string', minLength: 1, maxLength: 64 };

export const agentRequestTopics = Object.freeze(['agent/message', 'agent/receipt']);
export const agentBusTopics = agentRequestTopics;

/** Normalize a 64-char hex or 32-byte base64url/base64 Ed25519 public key to lowercase 64-char hex. */
export function normalizePublicKeyHex(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (/^[a-f0-9]{64}$/iu.test(trimmed)) return trimmed.toLowerCase();
  if (/^[A-Za-z0-9+/_-]{43,44}={0,2}$/u.test(trimmed)) {
    try {
      const b64 = trimmed.replace(/-/g, '+').replace(/_/g, '/');
      const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
      let bytes;
      if (typeof Buffer === 'function') {
        bytes = Buffer.from(padded, 'base64');
      } else {
        const bin = atob(padded);
        bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      }
      if (bytes.length !== 32) return null;
      let hex = '';
      for (let i = 0; i < 32; i++) hex += bytes[i].toString(16).padStart(2, '0');
      return hex;
    } catch { return null; }
  }
  return null;
}

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
      return [{ topic: 'agent/message', input }];
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
      return [{ topic: 'agent/receipt', input }];
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
export async function readAgentFeed(view) {
  const messages = [];
  const activity = [];
  const receipts = {};
  let cursor;
  for (;;) {
    const batch = await view.readEvents({
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
    const key = normalizePublicKeyHex(agent.public_key ?? agent.publicKey);
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
  const selfHex = normalizePublicKeyHex(selfPublicKey);
  if (!message || !selfHex) return false;
  const authorHex = normalizePublicKeyHex(message.author) ?? message.author;
  if (authorHex === selfHex) return false;
  if (message.expectReply === false) return false;
  const hopCount = typeof message.hopCount === 'number' ? message.hopCount : 0;
  if (hopCount >= maxHops) return false;

  const to = Array.isArray(message.to) ? message.to : [];
  if (to.includes('*')) return true;
  if (to.length > 0) return to.some(entry => normalizePublicKeyHex(entry) === selfHex);

  // Unaddressed message: only primary responds, and only on the user-facing chat channel.
  if (message.channel === 'agents') return false;
  const agents = Array.isArray(roster) ? roster : (roster?.agents ?? []);
  const primaryId = Array.isArray(roster) ? null : (roster?.primary_agent_id ?? roster?.primaryId ?? null);
  const selfEntry = agents.find(a => {
    const entryHex = normalizePublicKeyHex(a.public_key ?? a.publicKey);
    return (entryHex !== null && entryHex === selfHex)
      || (selfHandle && String(a.handle ?? '').toLowerCase() === String(selfHandle).toLowerCase());
  });
  if (!selfEntry) return false;
  if (primaryId) return selfEntry.id === primaryId;
  return Boolean(selfEntry.is_primary ?? selfEntry.isPrimary);
}

/** Determine delivery status of a user message from receipts and replies. */
export function messageDelivery(message, feed) {
  if (!message) return 'delivered';
  // A signer cannot acknowledge or answer its own message on someone else's behalf.
  const replies = [...(feed?.messages ?? []), ...(feed?.activity ?? [])].filter(m => m.author !== message.author
    && m.inReplyTo?.author === message.author && m.inReplyTo?.operationId === message.operationId);
  if (replies.length > 0) return 'answered';
  const list = (feed?.receipts?.[refKey(message.author, message.operationId)] ?? []).filter(r => r.author !== message.author);
  if (list.some(r => r.state === 'done')) return 'answered';
  if (list.some(r => r.state === 'thinking')) return 'thinking';
  if (list.some(r => r.state === 'seen')) return 'seen';
  return 'delivered';
}

// ---------------------------------------------------------------- Ephemeral Agent Cards & Streams
// Live presence and streaming reply previews travel over session.signals and
// write ZERO durable Chronolog records, so idle agents never consume history.

const PRESENCE_TOPIC = 'agent/presence';
const PRESENCE_PING_TOPIC = 'agent/presence/ping';
const STREAM_TOPIC = 'agent/stream';

const presenceText = (value, limit = 128) => typeof value === 'string' && value.trim().length > 0 && value.length <= limit;
const presenceStates = new Set(['listening', 'busy', 'stopped']);
// Card fields are optional on the wire; a worker without a card still announces liveness.
const validCard = value => (value.handle === undefined || value.handle === '' || /^[a-z][a-z0-9_-]{1,31}$/u.test(value.handle))
  && (value.bio === undefined || (typeof value.bio === 'string' && value.bio.length <= 160))
  && (value.capabilities === undefined || (Array.isArray(value.capabilities) && value.capabilities.length <= 16
    && value.capabilities.every(item => presenceText(item, 64))))
  && (value.isPrimary === undefined || typeof value.isPrimary === 'boolean');
const cardOf = value => ({ handle: value.handle ?? '', bio: value.bio ?? '',
  capabilities: [...(value.capabilities ?? [])], isPrimary: value.isPrimary === true });
const validPresence = value => value && typeof value === 'object' && !Array.isArray(value)
  && presenceText(value.consumerId) && presenceText(value.runId) && presenceText(value.role)
  && presenceStates.has(value.state) && Array.isArray(value.topics)
  && value.topics.length > 0 && value.topics.length <= 32
  && value.topics.every(item => presenceText(item))
  && Number.isSafeInteger(value.startedAtMs) && value.startedAtMs >= 0
  && Number.isSafeInteger(value.atMs) && value.atMs >= value.startedAtMs
  && validCard(value);
const positiveMs = value => Number.isSafeInteger(value) && value > 0;

/**
 * Announce an Agent Card only from the actual message worker, after its first
 * successful read. Bind `signal` to that worker's lifetime, not the shared native
 * page owner: a connected owner alone does not mean anyone is handling messages.
 * Announcements are sent only while at least one peer is connected.
 */
export function announceAgentPresence(session, {
  consumerId = session?.identity?.publicKey,
  runId = crypto.randomUUID(),
  role = 'agent',
  topics = ['chat'],
  state = 'listening',
  handle = '',
  bio = '',
  capabilities = ['chat'],
  isPrimary = false,
  intervalMs = 15_000,
  ttlMs = 30_000,
  topic = PRESENCE_TOPIC,
  pingTopic = PRESENCE_PING_TOPIC,
  signal,
} = {}) {
  if (!session?.signals) throw Error('AGENT_PRESENCE_SESSION_REQUIRED');
  let card = { handle, bio, capabilities: Array.isArray(capabilities) ? [...capabilities] : capabilities, isPrimary };
  if (!presenceText(consumerId) || !presenceText(runId) || !presenceText(role)
    || !Array.isArray(topics) || !topics.length || topics.length > 32
    || !topics.every(item => presenceText(item)) || !presenceStates.has(state)
    || !validCard(card) || !positiveMs(intervalMs) || !positiveMs(ttlMs)) throw Error('AGENT_PRESENCE_OPTIONS_INVALID');
  const selectedTopics = [...new Set(topics)];
  const stop = new AbortController();
  const lifetime = AbortSignal.any([stop.signal, signal, session.signal].filter(Boolean));
  const startedAtMs = Date.now();
  let currentState = state, active = !lifetime.aborted, timer, closing;
  let offStatus = () => {};

  const hasPeer = () => (session.status?.connectedPeers ?? 0) > 0;
  const payload = next => ({ consumerId, runId, role, topics: selectedTopics, ...card,
    capabilities: [...card.capabilities], state: next, startedAtMs, atMs: Math.max(startedAtMs, Date.now()) });
  const publish = async () => {
    if (!active || lifetime.aborted || !hasPeer()) return;
    try { await session.signals.send(topic, payload(currentState), { ttlMs, signal: lifetime, stream: { streamId: consumerId } }); }
    catch { /* Signals are disposable; they do not acknowledge any message. */ }
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
    // Announce again whenever a new peer link appears, not on every status change.
    let announcedLink = null;
    offStatus = session.onStatus(status => {
      const link = (status?.connectedPeers ?? 0) > 0 ? JSON.stringify([status.connectionRevision ?? null]) : null;
      if (link !== null && link !== announcedLink) void publish();
      announcedLink = link;
    });
    lifetime.addEventListener('abort', onAbort, { once: true });
  }

  const pingLoop = (async () => {
    if (!active) return;
    try {
      for await (const frame of session.signals.subscribe({ topics: [pingTopic], mode: 'all', signal: lifetime })) {
        if (frame.authorId === session.identity.publicKey) continue;
        const request = frame.payload;
        if (request?.for && request.for !== session.identity.publicKey) continue;
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
    updateCard(patch) {
      const next = { ...card, ...patch };
      if (!validCard(next)) throw Error('AGENT_PRESENCE_OPTIONS_INVALID');
      card = { handle: next.handle, bio: next.bio, capabilities: [...next.capabilities], isPrimary: next.isPrimary };
      void publish();
    },
    ping: publish,
    done: pingLoop,
    close,
  });
}

// Accept one worker's frames in signed-session order; a restarted run must be newer.
function acceptPresence(previous, frame, value) {
  if (!previous) return true;
  if (previous.signalSession === frame.sessionId && frame.sequence <= previous.sequence) return false;
  if ((previous.signalSession !== frame.sessionId || previous.value.runId !== value.runId)
    && value.startedAtMs <= previous.value.startedAtMs) return false;
  if (previous.value.runId === value.runId && value.startedAtMs !== previous.value.startedAtMs) return false;
  return true;
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
  let latest = null, accepted = null, lastReceivedAtMs = 0, expiresAtMs = 0;
  let offStatus = () => {}, staleTimer;

  const snapshot = (now = Date.now()) => {
    if (lifetime.aborted || !latest) return { status: 'unknown', consumer: latest, ageMs: null };
    const ageMs = Math.max(0, now - lastReceivedAtMs);
    if (latest.state === 'stopped') return { status: 'stopped', consumer: latest, ageMs };
    if ((session.status?.connectedPeers ?? 0) === 0 || ageMs >= staleAfterMs || now >= expiresAtMs) {
      return { status: 'stale', consumer: latest, ageMs };
    }
    return { status: latest.state === 'busy' ? 'busy' : 'available', consumer: latest, ageMs };
  };
  const emitChange = () => { try { onChange?.(snapshot()); } catch { /* UI callback */ } };
  const requestPing = () => {
    if (lifetime.aborted) return;
    if ((session.status?.connectedPeers ?? 0) === 0) return;
    void session.signals.send(pingTopic, { for: peer ?? null, consumerId: consumerId ?? null,
      requestTopic: requestTopic ?? null, atMs: Date.now() },
    { ttlMs: 10_000, signal: lifetime }).catch(() => {});
  };
  const cleanup = () => { clearInterval(staleTimer); offStatus(); emitChange(); };
  if (!lifetime.aborted) {
    let watchedLink = null;
    offStatus = session.onStatus(status => {
      const link = (status?.connectedPeers ?? 0) > 0 ? JSON.stringify([status.connectionRevision ?? null]) : null;
      if (link !== null && link !== watchedLink) requestPing();
      else emitChange();
      watchedLink = link;
    });
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
        const sameWorker = accepted && latest.author === frame.authorId && latest.consumerId === value.consumerId;
        if (sameWorker && !acceptPresence(accepted, frame, value)) continue;
        accepted = { signalSession: frame.sessionId, sequence: frame.sequence, value };
        latest = { ...value, ...cardOf(value), topics: [...value.topics], author: frame.authorId };
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

/**
 * Watch every agent's validated cards on the page. Each signer may run several
 * workers; the agent is online while any of its workers is live, busy while any
 * live worker is busy, and stopped only when all known workers stopped.
 * Enrolled-but-silent signers are reported offline when authority is inspectable.
 */
export function watchAgentsPresence(session, {
  topic = PRESENCE_TOPIC,
  pingTopic = PRESENCE_PING_TOPIC,
  staleAfterMs = 30_000,
  onChange,
  signal,
} = {}) {
  if (!session?.signals) throw Error('AGENT_PRESENCE_SESSION_REQUIRED');
  if (!positiveMs(staleAfterMs)) throw Error('AGENT_PRESENCE_OPTIONS_INVALID');
  const stop = new AbortController();
  const lifetime = AbortSignal.any([stop.signal, signal, session.signal].filter(Boolean));
  const workers = new Map(); // JSON[author, consumerId] -> { author, value, receivedAtMs, expiresAtMs, accepted }
  let enrolledKeys = new Set();

  const refreshAuthority = async () => {
    try {
      const auth = typeof session.authority === 'function' ? await session.authority() : null;
      const members = auth?.bundle?.memberships?.at(-1)?.payload?.members ?? auth?.members ?? [];
      if (Array.isArray(members)) enrolledKeys = new Set(members.filter(m => m.reader || m.writer).map(m => m.publicKey));
    } catch { /* Optional authority inspection */ }
  };
  const snapshot = (now = Date.now()) => {
    const connected = !lifetime.aborted && (session.status?.connectedPeers ?? 0) > 0;
    const out = {};
    for (const key of enrolledKeys) out[key] = { enrolled: true, state: 'offline' };
    const byAuthor = new Map();
    for (const worker of workers.values()) {
      const list = byAuthor.get(worker.author) ?? [];
      list.push(worker); byAuthor.set(worker.author, list);
    }
    for (const [author, list] of byAuthor) {
      const live = list.filter(item => item.value.state !== 'stopped' && connected
        && now - item.receivedAtMs < staleAfterMs && now < item.expiresAtMs);
      const newest = list.reduce((a, b) => (b.value.atMs > a.value.atMs ? b : a));
      const card = cardOf((live.length ? live.reduce((a, b) => (b.value.atMs > a.value.atMs ? b : a)) : newest).value);
      const state = live.some(item => item.value.state === 'busy') ? 'busy' : live.length ? 'online'
        : list.every(item => item.value.state === 'stopped') ? 'stopped' : 'offline';
      out[author] = {
        enrolled: enrolledKeys.size > 0 ? enrolledKeys.has(author) : true,
        state,
        handle: card.handle || undefined,
        bio: card.bio || undefined,
        capabilities: [...card.capabilities],
        isPrimary: card.isPrimary,
        consumers: list.map(item => ({ consumerId: item.value.consumerId, role: item.value.role,
          topics: [...item.value.topics], state: item.value.state })),
        lastSeenAt: Math.max(...list.map(item => item.receivedAtMs)),
        stoppedAt: state === 'stopped' ? Math.max(...list.map(item => item.receivedAtMs)) : null,
      };
    }
    return out;
  };
  const emitChange = () => { try { onChange?.(snapshot()); } catch { /* UI callback */ } };
  const requestPing = () => {
    if (lifetime.aborted) return;
    if ((session.status?.connectedPeers ?? 0) === 0) return;
    void session.signals.send(pingTopic, { atMs: Date.now() }, { ttlMs: 10_000, signal: lifetime }).catch(() => {});
  };
  let offStatus = () => {}, staleTimer;
  if (!lifetime.aborted) {
    let watchedLink = null;
    offStatus = session.onStatus(status => {
      const link = (status?.connectedPeers ?? 0) > 0 ? JSON.stringify([status.connectionRevision ?? null]) : null;
      if (link !== null && link !== watchedLink) {
        void refreshAuthority().then(emitChange);
        requestPing();
      } else emitChange();
      watchedLink = link;
    });
    staleTimer = setInterval(emitChange, Math.max(2_000, Math.min(10_000, Math.floor(staleAfterMs / 3))));
    lifetime.addEventListener('abort', () => { clearInterval(staleTimer); offStatus(); emitChange(); }, { once: true });
  }
  const loop = (async () => {
    if (lifetime.aborted) return;
    try {
      // Latest mode keeps one slot per signer/session/worker stream and replays retained cards.
      for await (const frame of session.signals.subscribe({ topics: [topic], mode: 'latest', includeLatest: true, signal: lifetime })) {
        const value = frame.payload;
        if (!validPresence(value)) continue;
        const key = JSON.stringify([frame.authorId, value.consumerId]);
        const previous = workers.get(key);
        if (previous && !acceptPresence(previous.accepted, frame, value)) continue;
        workers.set(key, { author: frame.authorId, value, receivedAtMs: Date.now(),
          expiresAtMs: Number.isSafeInteger(frame.expiresAtMs) ? frame.expiresAtMs : 0,
          accepted: { signalSession: frame.sessionId, sequence: frame.sequence, value } });
        emitChange();
      }
    } catch { /* Observation failure is unknown, never a retained Live badge. */ }
    finally { stop.abort(); }
  })();
  void refreshAuthority().then(emitChange);
  requestPing();
  return Object.freeze({ snapshot, ping: requestPing, refreshAuthority, done: loop, close() { stop.abort(); } });
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
  if (!presenceText(messageAuthor) || !presenceText(messageOperationId, 512)) throw Error('AGENT_STREAM_REFERENCE_INVALID');
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

/**
 * Browser side: concurrent ephemeral reply previews, one per authenticated
 * author (optionally only `peer`). The frame author is authoritative; payload
 * fields never name who is speaking.
 */
export function watchAgentStreams(session, {
  peer,
  topic = STREAM_TOPIC,
  onChange,
  signal,
} = {}) {
  if (!session?.signals) throw Error('AGENT_STREAM_SESSION_REQUIRED');
  const stop = new AbortController();
  const lifetime = AbortSignal.any([stop.signal, signal, session.signal].filter(Boolean));
  const streams = new Map();
  const emitChange = () => { try { onChange?.([...streams.values()]); } catch { /* UI callback */ } };
  const loop = (async () => {
    try {
      for await (const frame of session.signals.subscribe({ topics: [topic], mode: 'all', signal: lifetime,
        ...(peer ? { streams: [{ authorId: peer }] } : {}) })) {
        if (peer && frame.authorId !== peer) continue;
        const value = frame.payload;
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        if (value.done || !String(value.text ?? '').trim()) streams.delete(frame.authorId);
        else {
          streams.set(frame.authorId, {
            id: frame.authorId,
            author: frame.authorId,
            senderHandle: typeof value.handle === 'string' && value.handle ? value.handle : undefined,
            messageAuthor: value.messageAuthor,
            messageOperationId: value.messageOperationId,
            text: String(value.text).slice(0, 8000),
            atMs: Number.isSafeInteger(value.atMs) ? value.atMs : Date.now(),
          });
        }
        emitChange();
      }
    } catch { /* Observation failure ends previews; durable replies remain. */ }
  })();
  return Object.freeze({ snapshot: () => [...streams.values()], done: loop, close() { stop.abort(); } });
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
