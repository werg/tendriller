import { defineApplication, defineCommand, defineQuery } from '@chronolog/peer-session';

const COPY_TOPICS = Object.freeze(['copy.edit', 'copy.undo', 'copy.submit', 'copy.applied']);

export const reducerSource = `
export default {
  reduce(state, tx, ctx) {
    if (!ctx.query('$permissions', { check: 'writer', actor: tx.author })) {
      return { ok: false, code: 'writer_required' };
    }
    const eventTopic = ctx.config && typeof ctx.config.eventTopic === 'string' ? ctx.config.eventTopic : 'copy.edit';
    const count = (state && typeof state.count === 'number' ? state.count : 0) + 1;
    return {
      ok: true,
      state: { count, lastAuthor: tx.author },
      events: [{ topic: eventTopic, payload: tx.payload }],
    };
  },
  query(state) {
    return state || { count: 0 };
  },
};
`;

export const imports = Object.freeze({ 'app/copy-editor': reducerSource });
export const topics = Object.freeze(
  Object.fromEntries(
    COPY_TOPICS.map(name => [
      name,
      Object.freeze({ module: 'app/copy-editor', config: Object.freeze({ eventTopic: name }) }),
    ]),
  ),
);

const copyKey = { type: 'string', minLength: 1, maxLength: 160 };
const copyText = { type: 'string', maxLength: 4000 };
const editItem = {
  type: 'object',
  properties: { key: copyKey, before: copyText, after: copyText },
  required: ['key', 'before', 'after'],
  additionalProperties: false,
};

/** Derives current pending copy edits, submitted-but-unapplied edits, and batches from one coherent Chronolog snapshot. */
export async function deriveCopyState(view) {
  const edits = new Map();
  const submitted = new Map();
  const batches = [];
  let cursor;
  for (;;) {
    const batch = await view.readEvents({
      topics: ['copy.edit', 'copy.undo', 'copy.submit', 'copy.applied'],
      limit: 128,
      ...(cursor ? { cursor } : {}),
    });
    for (const event of batch.events) {
      if (event.topic === 'copy.edit') {
        submitted.delete(event.payload.key);
        edits.set(event.payload.key, {
          key: event.payload.key,
          before: event.payload.before,
          after: event.payload.after,
          author: event.author,
          proposalId: event.proposalId,
          operationId: event.operationId,
          authorTimestampMs: String(event.authorTimestampMs),
        });
      } else if (event.topic === 'copy.undo') {
        edits.delete(event.payload.key);
        submitted.delete(event.payload.key);
      } else if (event.topic === 'copy.submit') {
        batches.push({
          batchId: event.payload.batchId,
          page: event.payload.page,
          note: event.payload.note,
          edits: event.payload.edits,
          author: event.author,
          proposalId: event.proposalId,
          operationId: event.operationId,
          authorTimestampMs: String(event.authorTimestampMs),
        });
        for (const item of event.payload.edits) {
          edits.delete(item.key);
          submitted.set(item.key, {
            key: item.key,
            before: item.before,
            after: item.after,
            batchId: event.payload.batchId,
          });
        }
      } else if (event.topic === 'copy.applied') {
        for (const key of event.payload.keys ?? []) {
          edits.delete(key);
          submitted.delete(key);
        }
      }
    }
    if (!batch.hasMore) return { edits: [...edits.values()], submitted: [...submitted.values()], batches };
    if (cursor === batch.cursor) throw Error('COPY_EDITOR_CURSOR_STALLED');
    cursor = batch.cursor;
  }
}

export const definition = defineApplication({
  id: 'tendriller-copy-editor',
  version: '3',
  commands: {
    putEdit: defineCommand({
      description: 'Store a revisable inline copy edit in the shared Chronolog session.',
      input: editItem,
      prepare: (input) => [{ topic: 'copy.edit', input }],
    }),
    undoEdit: defineCommand({
      description: 'Revert a pending inline copy edit.',
      input: { type: 'object', properties: { key: copyKey }, required: ['key'], additionalProperties: false },
      prepare: (input) => [{ topic: 'copy.undo', input }],
    }),
    submitBatch: defineCommand({
      description: 'Submit pending copy edits and an optional note to the repo agent.',
      input: {
        type: 'object',
        properties: {
          batchId: { type: 'string', minLength: 1, maxLength: 128 },
          page: { type: 'string', minLength: 1, maxLength: 128 },
          note: { type: 'string', maxLength: 2000 },
          edits: { type: 'array', maxItems: 200, items: editItem },
        },
        required: ['batchId', 'page', 'note', 'edits'],
        additionalProperties: false,
      },
      prepare: (input) => [{ topic: 'copy.submit', input }],
    }),
    markApplied: defineCommand({
      description: 'Record that the agent applied submitted keys into server/src/site-copy.json.',
      input: {
        type: 'object',
        properties: {
          batchId: { type: 'string', minLength: 1, maxLength: 128 },
          keys: { type: 'array', maxItems: 200, items: copyKey },
        },
        required: ['batchId', 'keys'],
        additionalProperties: false,
      },
      prepare: (input) => [{ topic: 'copy.applied', input }],
    }),
  },
  queries: {
    state: defineQuery({
      description: 'Derive pending inline copy edits and submitted batches from one coherent snapshot.',
      input: { type: 'null' },
      read: deriveCopyState,
    }),
  },
});
