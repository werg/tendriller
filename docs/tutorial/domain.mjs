import { defineApplication, defineCommand, defineQuery, emit, program } from '@chronolog/peer-session';

// Change the declared version when changing the application's semantics.
// The initial descriptor binds this definition; it is not replaced by a UI release.
export const definition = defineApplication({
  id: 'shared-notes', version: '1',
  commands: {
    addNote: defineCommand({
      description: 'Retain one note with its authenticated author and operation identity.',
      input: { type: 'object', properties: { text: { type: 'string', minLength: 1, maxLength: 2000 } },
        required: ['text'], additionalProperties: false },
      prepare: ({ text }) => program(emit('note', { text })),
    }),
  },
  queries: {
    notes: defineQuery({
      description: 'Read the notes and their authors from one coherent selected history.',
      input: { type: 'null' },
      read(view) {
        const notes = [];
        let cursor;
        for (;;) {
          const batch = view.readEvents({ topics: ['note'], limit: 128, ...(cursor === undefined ? {} : { cursor }) });
          for (const event of batch.events) notes.push({ text: event.payload.text,
            author: event.author, operationId: event.operationId });
          if (!batch.hasMore) return notes;
          if (cursor === batch.cursor) throw Error('NOTES_CURSOR_STALLED');
          cursor = batch.cursor;
        }
      },
    }),
  },
});
