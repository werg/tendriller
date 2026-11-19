import { defineApplication, defineCommand, defineQuery, emit, program } from '@chronolog/peer-session';
import { projectKitchen, summarizeKitchen, boundAssistance } from './projection.mjs';

const id = { type: 'string', minLength: 1, maxLength: 128 };
const revision = { type: 'string', minLength: 1, maxLength: 16384 };
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const command = (description, input, type) => defineCommand({ description, input,
  prepare(value) { return program(emit('assistant', { type, ...value })); } });

function readKitchen(view) {
  const events = [];
  let cursor;
  for (;;) {
    const batch = view.readEvents({ topics: ['assistant'], limit: 128, ...(cursor === undefined ? {} : { cursor }) });
    events.push(...batch.events);
    if (!batch.hasMore) return projectKitchen(events);
    if (cursor === batch.cursor) throw Error('ASSISTANCE_CURSOR_STALLED');
    cursor = batch.cursor;
  }
}

// This is a NEW application definition. A UI release cannot replace the
// immutable definition of an already configured kitchen application.
export const definition = defineApplication({ id: 'kitchen-assistance', version: '2',
  commands: {
    setCookingStep: command('Select the current cooking step; previous answers remain visible as stale.',
      object({ stepId: id, text: { type: 'string', minLength: 1, maxLength: 1000 } }), 'step.selected'),
    requestAssistance: command('Retain one explicit request for help. Preserve operationId on uncertain replies.', object({
      requestId: id, kind: { type: 'string', enum: ['recipe_help', 'inventory_review', 'general'] },
      question: { type: 'string', minLength: 1, maxLength: 4000 }, cookingStepId: id, contextRevision: revision,
      cookingStepEventId: { type: 'string', minLength: 1, maxLength: 256 },
      expiresAtMs: { type: 'integer', minimum: 1, maximum: 8640000000000000 },
    }), 'help.requested'),
    replyToAssistance: command('Retain a response tied to an immutable request event; the query labels stale or conflicting facts.', object({
      requestId: id, requestEventId: { type: 'string', minLength: 1, maxLength: 256 },
      answer: { type: 'string', minLength: 1, maxLength: 8000 },
      suggestedSteps: { type: 'array', maxItems: 12, items: { type: 'string', minLength: 1, maxLength: 500 } },
      basedOnContextRevision: revision, cookingStepId: id,
    }), 'help.answered'),
    cancelAssistance: command('Record a cancellation; only the original requesting author is honored by the projection.',
      object({ requestId: id }), 'help.cancelled'),
  },
  queries: {
    kitchenContext: defineQuery({ description: 'Read the current step and at most 20 compact recent-request summaries; use assistanceStatus for details.',
      input: { type: 'null' }, read(view) { return summarizeKitchen(readKitchen(view)); } }),
    assistanceStatus: defineQuery({ description: 'Read one request, canonical response, bounded recent replies/conflicts, total counts and expiry timestamp.',
      input: object({ requestId: id }), read(view, { requestId }) {
        return boundAssistance(readKitchen(view).requests.find(request => request.requestId === requestId));
      } }),
  },
});
