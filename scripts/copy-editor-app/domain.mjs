import { defineApplication, defineCommand, defineQuery } from '@chronolog/peer-session';

/**
 * Pure deterministic Chronolog v2 ES Module reducer for the Tendriller Copy Editor.
 * Hash-pinned in `$reducers.imports['app/copy-editor']` and executed identically
 * inside QuickJS-NG on every replica (browser, native agent, and opt-in hosted MCP).
 */
export const COPY_EDITOR_REDUCER_SOURCE = `
function isWriter(ctx, author) {
  const checked = ctx.query('$permissions', { check: 'writer', actor: author });
  if (typeof checked === 'boolean') return checked;
  const perms = ctx.topic('$permissions');
  return Boolean(
    perms &&
      Array.isArray(perms.members) &&
      perms.members.some(m => m.publicKey === author && (m.writer === true || m.administrator === true)),
  );
}

export default {
  reduce(state, tx, ctx) {
    if (!isWriter(ctx, tx.author)) return { ok: false, code: 'writer_required' };
    const input = tx.payload;
    if (!input || typeof input !== 'object') return { ok: false, code: 'invalid_input' };

    const edits = state && state.edits ? { ...state.edits } : {};
    const submitted = state && state.submitted ? { ...state.submitted } : {};
    const batches = state && Array.isArray(state.batches) ? [...state.batches] : [];

    if (input.action === 'putEdit') {
      if (typeof input.key !== 'string' || !input.key || typeof input.after !== 'string' || typeof input.before !== 'string') {
        return { ok: false, code: 'invalid_edit' };
      }
      delete submitted[input.key];
      edits[input.key] = {
        key: input.key,
        before: input.before,
        after: input.after,
        author: tx.author,
        proposalId: tx.opId,
        operationId: tx.operationId,
        authorTimestampMs: String(tx.authorTimestampMs),
      };
      return {
        ok: true,
        state: { edits, submitted, batches },
        events: [{ topic: 'copy.edit', payload: { key: input.key, before: input.before, after: input.after } }],
      };
    }

    if (input.action === 'undoEdit') {
      if (typeof input.key !== 'string' || !input.key) return { ok: false, code: 'invalid_key' };
      delete edits[input.key];
      delete submitted[input.key];
      return {
        ok: true,
        state: { edits, submitted, batches },
        events: [{ topic: 'copy.undo', payload: { key: input.key } }],
      };
    }

    if (input.action === 'submitBatch') {
      if (typeof input.batchId !== 'string' || !input.batchId || typeof input.page !== 'string' || !Array.isArray(input.edits)) {
        return { ok: false, code: 'invalid_batch' };
      }
      const batch = {
        batchId: input.batchId,
        page: input.page,
        note: typeof input.note === 'string' ? input.note : '',
        edits: input.edits,
        author: tx.author,
        proposalId: tx.opId,
        operationId: tx.operationId,
        authorTimestampMs: String(tx.authorTimestampMs),
      };
      batches.push(batch);
      for (const item of input.edits) {
        if (!item || typeof item.key !== 'string') continue;
        delete edits[item.key];
        submitted[item.key] = {
          key: item.key,
          before: item.before,
          after: item.after,
          batchId: input.batchId,
        };
      }
      return {
        ok: true,
        state: { edits, submitted, batches },
        events: [{ topic: 'copy.submit', payload: { batchId: input.batchId, page: input.page, note: batch.note, edits: input.edits } }],
      };
    }

    if (input.action === 'markApplied') {
      if (typeof input.batchId !== 'string' || !input.batchId || !Array.isArray(input.keys)) {
        return { ok: false, code: 'invalid_apply' };
      }
      for (const key of input.keys) {
        if (typeof key !== 'string') continue;
        delete edits[key];
        delete submitted[key];
      }
      return {
        ok: true,
        state: { edits, submitted, batches },
        events: [{ topic: 'copy.applied', payload: { batchId: input.batchId, keys: input.keys } }],
      };
    }

    return { ok: false, code: 'unknown_action' };
  },

  query(state) {
    const edits = state && state.edits
      ? Object.values(state.edits).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      : [];
    const submitted = state && state.submitted
      ? Object.values(state.submitted).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      : [];
    const batches = state && Array.isArray(state.batches) ? state.batches : [];
    return { edits, submitted, batches };
  },

  describe() {
    return {
      id: 'tendriller-copy-editor',
      version: '4',
      commands: [
        { name: 'putEdit', description: 'Store a revisable inline copy edit in the shared Chronolog session.' },
        { name: 'undoEdit', description: 'Revert a pending inline copy edit.' },
        { name: 'submitBatch', description: 'Submit pending copy edits and an optional note to the repo agent.' },
        { name: 'markApplied', description: 'Record that the agent applied submitted keys into server/src/site-copy.json.' },
      ],
      queries: [
        { name: 'state', description: 'Read current pending copy edits, submitted edits, and sent batches.' },
      ],
    };
  },
};
`.trimStart();

export const imports = Object.freeze({ 'app/copy-editor': COPY_EDITOR_REDUCER_SOURCE });
export const topics = Object.freeze({
  copy: Object.freeze({
    module: 'app/copy-editor',
    initialState: Object.freeze({ edits: {}, submitted: {}, batches: [] }),
  }),
});

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
  return view.query('copy', null);
}

export const definition = defineApplication({
  id: 'tendriller-copy-editor',
  version: '4',
  commands: {
    putEdit: defineCommand({
      description: 'Store a revisable inline copy edit in the shared Chronolog session.',
      input: editItem,
      prepare: (input) => [{ topic: 'copy', input: { action: 'putEdit', ...input } }],
    }),
    undoEdit: defineCommand({
      description: 'Revert a pending inline copy edit.',
      input: { type: 'object', properties: { key: copyKey }, required: ['key'], additionalProperties: false },
      prepare: (input) => [{ topic: 'copy', input: { action: 'undoEdit', ...input } }],
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
      prepare: (input) => [{ topic: 'copy', input: { action: 'submitBatch', ...input } }],
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
      prepare: (input) => [{ topic: 'copy', input: { action: 'markApplied', ...input } }],
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
