import { defineCommand, defineQuery } from '@chronolog/peer-session';

const str = (minLength, maxLength) => ({ type: 'string', minLength, maxLength });

export const callTopics = Object.freeze(['call/profile', 'call/utterance', 'call/note']);

export const callSignalTopics = Object.freeze({
  presence: 'call/presence',
  interim: 'call/transcript.interim',
  final: 'call/transcript.final',
  frameRequest: 'call/frame.request',
  frameReply: 'call/frame.reply',
  waitingRoomKnock: 'call/waiting.knock',
  waitingRoomAdmit: 'call/waiting.admit',
});

export const callCommands = Object.freeze({
  callProfileSet: defineCommand({
    description: 'Set the authenticated participant display name for this call page.',
    input: {
      type: 'object',
      properties: {
        displayName: str(1, 80),
        avatar: str(0, 200),
      },
      required: ['displayName'],
      additionalProperties: false,
    },
    prepare(input) {
      return [{ topic: 'call/profile', input: {
        displayName: input.displayName.trim(),
        ...(input.avatar ? { avatar: input.avatar } : {}),
      } }];
    },
  }),
  callTranscriptAppend: defineCommand({
    description: 'Persist a speaker-attributed meeting transcript utterance (opt-in transcript saving).',
    input: {
      type: 'object',
      properties: {
        callId: str(1, 64),
        utteranceId: str(1, 128),
        seq: { type: 'integer', minimum: 0, maximum: 1_000_000 },
        text: str(1, 4000),
        startedAtMs: { type: 'integer', minimum: 0 },
        endedAtMs: { type: 'integer', minimum: 0 },
        language: str(2, 16),
      },
      required: ['callId', 'utteranceId', 'seq', 'text', 'startedAtMs', 'endedAtMs'],
      additionalProperties: false,
    },
    prepare(input) {
      const text = input.text.trim();
      if (!text) throw Error('CALL_UTTERANCE_EMPTY');
      return [{ topic: 'call/utterance', input: { ...input, text } }];
    },
  }),
  callNoteAdd: defineCommand({
    description: 'Add a shared meeting note, decision, or action item.',
    input: {
      type: 'object',
      properties: {
        callId: str(1, 64),
        kind: { type: 'string', enum: ['note', 'decision', 'action'] },
        text: str(1, 4000),
        refUtteranceId: str(1, 128),
      },
      required: ['callId', 'kind', 'text'],
      additionalProperties: false,
    },
    prepare(input) {
      const text = input.text.trim();
      if (!text) throw Error('CALL_NOTE_EMPTY');
      return [{ topic: 'call/note', input: { ...input, text } }];
    },
  }),
});

function parseMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return 0;
}

export function compareUtterances(a, b) {
  if (a.startedAtMs !== b.startedAtMs) return a.startedAtMs - b.startedAtMs;
  if (a.author !== b.author) return a.author < b.author ? -1 : 1;
  return (a.seq ?? 0) - (b.seq ?? 0);
}

/** Merge durable utterances with ephemeral live utterances, deduplicating by utteranceId. */
export function mergeUtterances(durable = [], live = []) {
  const byId = new Map();
  for (const item of durable) byId.set(item.utteranceId, { ...item, persisted: true });
  for (const item of live) {
    if (!byId.has(item.utteranceId)) byId.set(item.utteranceId, { ...item, persisted: false });
  }
  return [...byId.values()].sort(compareUtterances);
}

/** Read one coherent materialized snapshot of call profiles, persisted utterances, and shared notes. */
export function readCallState(view, input = null) {
  const callId = input?.callId || null;
  const sinceMs = typeof input?.sinceMs === 'number' ? input.sinceMs : null;
  const limit = typeof input?.limit === 'number' && input.limit > 0 ? Math.min(2000, input.limit) : null;
  const profiles = {};
  const utterancesById = new Map();
  const notes = [];
  let cursor;
  for (;;) {
    const batch = view.readEvents({
      topics: callTopics,
      limit: 128,
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const event of batch.events) {
      const payload = event.payload ?? {};
      const atMs = parseMs(event.authorTimestampMs);
      if (event.topic === 'call/profile') {
        profiles[event.author] = {
          author: event.author,
          displayName: String(payload.displayName ?? '').trim() || event.author.slice(0, 8),
          ...(payload.avatar ? { avatar: String(payload.avatar) } : {}),
          updatedAtMs: atMs,
        };
      } else if (event.topic === 'call/utterance') {
        if (callId && payload.callId !== callId) continue;
        const startedAtMs = parseMs(payload.startedAtMs) || atMs;
        if (sinceMs !== null && startedAtMs < sinceMs) continue;
        const utteranceId = String(payload.utteranceId ?? event.operationId);
        utterancesById.set(utteranceId, {
          utteranceId,
          callId: String(payload.callId ?? 'main'),
          author: event.author,
          seq: typeof payload.seq === 'number' ? payload.seq : 0,
          text: String(payload.text ?? ''),
          startedAtMs,
          endedAtMs: parseMs(payload.endedAtMs) || startedAtMs,
          language: payload.language ? String(payload.language) : undefined,
          operationId: event.operationId,
          persisted: true,
        });
      } else if (event.topic === 'call/note') {
        if (callId && payload.callId !== callId) continue;
        notes.push({
          id: event.operationId,
          callId: String(payload.callId ?? 'main'),
          author: event.author,
          kind: ['note', 'decision', 'action'].includes(payload.kind) ? payload.kind : 'note',
          text: String(payload.text ?? ''),
          ...(payload.refUtteranceId ? { refUtteranceId: String(payload.refUtteranceId) } : {}),
          atMs,
        });
      }
    }
    if (!batch.hasMore) break;
    if (batch.cursor === cursor) throw Error('CALL_STATE_CURSOR_STALLED');
    cursor = batch.cursor;
  }
  let utterances = [...utterancesById.values()]
    .map(u => ({ ...u, displayName: profiles[u.author]?.displayName ?? u.author.slice(0, 8) }))
    .sort(compareUtterances);
  if (limit !== null && utterances.length > limit) {
    utterances = utterances.slice(-limit);
  }
  const enrichedNotes = notes.map(n => ({ ...n, displayName: profiles[n.author]?.displayName ?? n.author.slice(0, 8) }));
  return { profiles, utterances, notes: enrichedNotes };
}

export const callQueries = Object.freeze({
  callState: defineQuery({
    description: 'Read participant profiles, persisted per-person transcript, and meeting notes.',
    input: {
      type: 'object',
      properties: {
        callId: str(1, 64),
        sinceMs: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 2000 },
      },
      additionalProperties: false,
    },
    read: readCallState,
  }),
  callTranscript: defineQuery({
    description: 'Read ordered per-person transcript utterances for a call (usable by browsers, native agents, and hosted MCP).',
    input: {
      type: 'object',
      properties: {
        callId: str(1, 64),
        sinceMs: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 2000 },
      },
      additionalProperties: false,
    },
    read(view, input) {
      return readCallState(view, input).utterances;
    },
  }),
});
