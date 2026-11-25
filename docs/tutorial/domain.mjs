import { defineApplication, defineCommand, defineQuery, emit, program } from '@chronolog/peer-session';
const noteId = { type: 'string', minLength: 1, maxLength: 128 };
export async function deriveNotes(view) {
  const notes = new Map(); let cursor;
  for (;;) {
    const batch = await view.readEvents({ topics: ['note.put', 'note.deleted'], limit: 128, ...(cursor ? { cursor } : {}) });
    for (const event of batch.events) {
      if (event.topic === 'note.deleted') notes.delete(event.payload.noteId);
      else notes.set(event.payload.noteId, { id: event.payload.noteId, text: event.payload.text, author: event.author,
        proposalId: event.proposalId, operationId: event.operationId, authorTimestampMs: event.authorTimestampMs });
    }
    if (!batch.hasMore) return [...notes.values()];
    if (cursor === batch.cursor) throw Error('NOTES_CURSOR_STALLED');
    cursor = batch.cursor;
  }
}
export const definition = defineApplication({ id: 'shared-notes', version: '3', commands: {
  putNote: defineCommand({ description: 'Create or edit a shared note; the current author-time projection is revisable.',
    input: { type: 'object', properties: { noteId, text: { type: 'string', minLength: 1, maxLength: 2000 } }, required: ['noteId', 'text'], additionalProperties: false },
    prepare: input => program(emit('note.put', input)) }),
  deleteNote: defineCommand({ description: 'Remove a shared note in the current projection.',
    input: { type: 'object', properties: { noteId }, required: ['noteId'], additionalProperties: false },
    prepare: input => program(emit('note.deleted', input)) }),
}, queries: { notes: defineQuery({ description: 'Derive the complete notes domain from one coherent materialized snapshot.', input: { type: 'null' }, read: deriveNotes }) } });
