import { defineApplication, defineCommand, defineQuery } from '@chronolog/peer-session';

export const sampleItems = [
  { id: 'check-labels', label: 'Check labels' },
  { id: 'check-links', label: 'Check links' },
];

export const reducerSource = `
const ITEMS = ${JSON.stringify(sampleItems)};
export default {
  reduce(state, tx) {
    const done = new Set(Array.isArray(state && state.completed) ? state.completed : []);
    const id = tx.payload && tx.payload.id;
    if (!ITEMS.some(item => item.id === id)) return { ok: false, code: 'ITEM_UNKNOWN' };
    done.add(id);
    return { ok: true, state: { completed: [...done].sort() }, events: [{ topic: 'completed', payload: { id } }] };
  },
  query(state) {
    const done = new Set(Array.isArray(state && state.completed) ? state.completed : []);
    return ITEMS.map(item => ({ ...item, complete: done.has(item.id) }));
  },
  describe() {
    return {
      commands: [{ name: 'completeItem', description: 'Mark one sample checklist item complete.', input: { type: 'object', properties: { id: { type: 'string', enum: ITEMS.map(i => i.id) } }, required: ['id'], additionalProperties: false } }],
      queries: [{ name: 'checklist', description: 'Read the two sample items and their current completion status.', input: { type: 'null' } }],
    };
  },
};
`;

export const imports = { 'app/review': reducerSource };
export const topics = { checklist: { module: 'app/review' } };

/** One coherent derivation, shared by the native query and the signed browser page's live view. */
export async function deriveChecklist(view) {
  const completed = new Set();
  let cursor;
  for (;;) {
    const batch = await view.readEvents({ topics: ['completed'], limit: 128, ...(cursor === undefined ? {} : { cursor }) });
    for (const event of batch.events) completed.add(event.payload.id);
    if (!batch.hasMore) return sampleItems.map(item => ({ ...item, complete: completed.has(item.id) }));
    if (cursor === batch.cursor) throw Error('REVIEW_CHECKLIST_CURSOR_STALLED');
    cursor = batch.cursor;
  }
}

export const definition = defineApplication({
  id: 'tendriller-review-checklist',
  version: '1',
  commands: {
    completeItem: defineCommand({
      description: 'Mark one sample checklist item complete.',
      input: {
        type: 'object',
        properties: { id: { type: 'string', enum: sampleItems.map(item => item.id) } },
        required: ['id'],
        additionalProperties: false,
      },
      prepare: ({ id }) => [{ topic: 'checklist', input: { id } }],
    }),
  },
  queries: {
    checklist: defineQuery({
      description: 'Read the two sample items and their current completion status.',
      input: { type: 'null' },
      read: deriveChecklist,
    }),
  },
});
