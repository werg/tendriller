import { defineApplication, defineCommand, defineQuery, emit, program } from '@chronolog/peer-session';

const reference = { type: 'object', properties: {
  profile: { type: 'string', enum: ['peer-content-v1'] },
  applicationId: { type: 'string', minLength: 64, maxLength: 64 },
  historyId: { type: 'string', minLength: 64, maxLength: 64 },
  id: { type: 'string', minLength: 64, maxLength: 64 },
  epoch: { type: 'integer', minimum: 0 }, bytes: { type: 'integer', minimum: 1, maximum: 8388608 },
  mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp'] },
}, required: ['profile', 'applicationId', 'historyId', 'id', 'epoch', 'bytes', 'mediaType'], additionalProperties: false };

// Change the declared version when changing the application's semantics.
// The initial descriptor binds this definition; it is not replaced by a UI release.
export const definition = defineApplication({
  id: 'shared-notes', version: '2',
  commands: {
    addNote: defineCommand({
      description: 'Retain one note with its authenticated author and operation identity.',
      input: { type: 'object', properties: { text: { type: 'string', minLength: 1, maxLength: 2000 } },
        required: ['text'], additionalProperties: false },
      prepare: ({ text }) => program(emit('note', { text })),
    }),
    addEvidence: defineCommand({
      description: 'Retain explicitly reviewed text and its immutable photo source in this notes collection.',
      input: { type: 'object', properties: {
        text: { type: 'string', minLength: 1, maxLength: 2000 },
        source: { type: 'object', properties: {
          candidateId: { type: 'string', minLength: 1, maxLength: 128 },
          sha256: { type: 'string', minLength: 64, maxLength: 64 }, reference,
        }, required: ['candidateId', 'sha256', 'reference'], additionalProperties: false },
        capturedRevision: { type: 'string', minLength: 1, maxLength: 16384 },
      }, required: ['text', 'source', 'capturedRevision'], additionalProperties: false },
      // Inference is outside deterministic execution. This command records the
      // person's reviewed observation; it does not certify a model's conclusion.
      // Mutable task/question domains additionally need their own version guard.
      prepare({ text, source, capturedRevision }) {
        // The public input schema supports bounded strings, not arbitrary JSON
        // Schema regular expressions. Validate the digest format explicitly.
        if (![source.sha256, source.reference.applicationId, source.reference.historyId, source.reference.id]
          .every(value => /^[a-f0-9]{64}$/.test(value))) throw Error('EVIDENCE_SOURCE_INVALID');
        return program(emit('note', { text, source, capturedRevision }));
      },
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
            author: event.author, operationId: event.operationId,
            ...(event.payload.source ? { source: event.payload.source, capturedRevision: event.payload.capturedRevision } : {}),
          });
          if (!batch.hasMore) return notes;
          if (cursor === batch.cursor) throw Error('NOTES_CURSOR_STALLED');
          cursor = batch.cursor;
        }
      },
    }),
  },
});
