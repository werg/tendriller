import { defineApplication, defineCommand, defineQuery, emit, program } from '@chronolog/peer-session';

export const sampleItems = [
  { id: 'check-labels', label: 'Check labels' },
  { id: 'check-links', label: 'Check links' },
];

export const definition = defineApplication({
  id: 'tendriller-review-checklist', version: '1',
  commands: {
    completeItem: defineCommand({
      description: 'Mark one sample checklist item complete.',
      input: { type: 'object', properties: { id: { type: 'string', enum: sampleItems.map(item => item.id) } },
        required: ['id'], additionalProperties: false },
      prepare: ({ id }) => program(emit('completed', { id })),
    }),
  },
  queries: {
    checklist: defineQuery({
      description: 'Read the two sample items and their current completion status.',
      input: { type: 'null' },
      read(view) {
        const completed = new Set();
        let cursor;
        for (;;) {
          const batch = view.readEvents({ topics: ['completed'], limit: 128,
            ...(cursor === undefined ? {} : { cursor }) });
          for (const event of batch.events) completed.add(event.payload.id);
          if (!batch.hasMore) return sampleItems.map(item => ({ ...item, complete: completed.has(item.id) }));
          if (cursor === batch.cursor) throw Error('REVIEW_CHECKLIST_CURSOR_STALLED');
          cursor = batch.cursor;
        }
      },
    }),
  },
});
