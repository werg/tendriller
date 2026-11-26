import { defineApplication, defineCommand, defineQuery } from '@chronolog/peer-session';

const reference = {
  type: 'object',
  properties: {
    profile: { type: 'string', enum: ['authored-content-v1'] },
    applicationId: { type: 'string', minLength: 64, maxLength: 64 },
    id: { type: 'string', minLength: 64, maxLength: 64 },
    epoch: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    bytes: { type: 'integer', minimum: 1, maximum: 8388608 },
    mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp'] },
  },
  required: ['profile', 'applicationId', 'id', 'epoch', 'bytes', 'mediaType'],
  additionalProperties: false,
};
const evidenceSource = {
  type: 'object',
  properties: { candidateId: { type: 'string', minLength: 1, maxLength: 128 }, sha256: { type: 'string', minLength: 64, maxLength: 64 }, reference },
  required: ['candidateId', 'sha256', 'reference'],
  additionalProperties: false,
};
const noteId = { type: 'string', minLength: 1, maxLength: 128 };

/**
 * Pure deterministic Chronolog v2 ES Module reducer for shared notes.
 * Hash-pinned in `$reducers.imports['app/notes']` and executed inside QuickJS-NG
 * on every replica (browser, native agent, and opt-in hosted MCP — no separate `domain.js`).
 */
export const NOTES_REDUCER_SOURCE = `
export default {
  reduce(state, tx, ctx) {
    const perms = ctx.topic('$permissions');
    const writer = perms && Array.isArray(perms.members) && perms.members.some(m => m.publicKey === tx.author && m.writer === true);
    if (!writer) return { ok: false, code: 'writer_required' };
    const notes = state && typeof state === 'object' && state.notes ? { ...state.notes } : {};
    const input = tx.payload;
    if (!input || typeof input !== 'object') return { ok: false, code: 'invalid_input' };
    if (input.action === 'putNote' || input.action === 'addEvidence') {
      if (typeof input.noteId !== 'string' || !input.noteId || typeof input.text !== 'string' || !input.text) {
        return { ok: false, code: 'invalid_note' };
      }
      notes[input.noteId] = {
        id: input.noteId,
        text: input.text,
        author: tx.author,
        proposalId: tx.opId,
        operationId: tx.operationId,
        authorTimestampMs: String(tx.authorTimestampMs),
        ...(input.source ? { source: input.source, capturedRevision: input.capturedRevision } : {}),
      };
      return { ok: true, state: { notes }, events: [{ topic: 'note.put', payload: input }] };
    }
    if (input.action === 'deleteNote') {
      if (typeof input.noteId !== 'string' || !input.noteId) return { ok: false, code: 'invalid_note' };
      delete notes[input.noteId];
      return { ok: true, state: { notes }, events: [{ topic: 'note.deleted', payload: { noteId: input.noteId } }] };
    }
    return { ok: false, code: 'unknown_action' };
  },

  query(state) {
    const notes = state && state.notes ? Object.values(state.notes) : [];
    notes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return notes;
  },

  describe() {
    return {
      id: 'shared-notes',
      version: '4',
      commands: [
        { name: 'putNote', description: 'Create or edit a shared note', input: { type: 'object', properties: { noteId: { type: 'string', minLength: 1, maxLength: 128 }, text: { type: 'string', minLength: 1, maxLength: 2000 } }, required: ['noteId', 'text'], additionalProperties: false } },
        { name: 'deleteNote', description: 'Remove a shared note', input: { type: 'object', properties: { noteId: { type: 'string', minLength: 1, maxLength: 128 } }, required: ['noteId'], additionalProperties: false } },
      ],
      queries: [
        { name: 'notes', description: 'Read all shared notes from a coherent snapshot', input: { type: 'null' } },
      ],
    };
  },
};
`.trimStart();

export const imports = Object.freeze({ 'app/notes': NOTES_REDUCER_SOURCE });
export const topics = Object.freeze({ notes: Object.freeze({ module: 'app/notes', initialState: { notes: {} } }) });

export async function deriveNotes(view) {
  return view.query('notes', null);
}

export const definition = defineApplication({
  id: 'shared-notes',
  version: '4',
  commands: {
    putNote: defineCommand({
      description: 'Create or edit a shared note; the current author-time projection is revisable.',
      input: { type: 'object', properties: { noteId, text: { type: 'string', minLength: 1, maxLength: 2000 } }, required: ['noteId', 'text'], additionalProperties: false },
      prepare: input => [{ topic: 'notes', input: { action: 'putNote', ...input } }],
    }),
    addEvidence: defineCommand({
      description: 'Retain a deliberately reviewed observation and authorized encrypted content reference.',
      input: { type: 'object', properties: { noteId, text: { type: 'string', minLength: 1, maxLength: 2000 }, source: evidenceSource, capturedRevision: { type: 'string', maxLength: 16384 } }, required: ['noteId', 'text', 'source', 'capturedRevision'], additionalProperties: false },
      prepare: input => {
        if (![input.source.sha256, input.source.reference.applicationId, input.source.reference.id].every(value => /^[a-f0-9]{64}$/.test(value))) {
          throw Error('EVIDENCE_SOURCE_INVALID');
        }
        return [{ topic: 'notes', input: { action: 'addEvidence', ...input } }];
      },
    }),
    deleteNote: defineCommand({
      description: 'Remove a shared note in the current projection.',
      input: { type: 'object', properties: { noteId }, required: ['noteId'], additionalProperties: false },
      prepare: input => [{ topic: 'notes', input: { action: 'deleteNote', ...input } }],
    }),
  },
  queries: {
    notes: defineQuery({
      description: 'Derive the complete notes domain from one coherent materialized snapshot.',
      input: { type: 'null' },
      read: deriveNotes,
    }),
  },
});
