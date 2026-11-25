import { defineApplication, defineCommand, defineQuery, program, emit } from '@chronolog/peer-session';
import { validFix, id } from './protocol.mjs';

// Version command/query behavior deliberately; no immutable definition or schema lock orders data.
// Every query derives from one coherent materialized snapshot, with revisable outcomes.
export const definition = defineApplication({ id: 'reviewed-observations', version: '1', commands: {
  retainObservation: defineCommand({
    description: 'Retain only a person-reviewed observation, with sample time, source, and stream correlation.',
    input: { type: 'object', properties: {
      text: { type: 'string', minLength: 1, maxLength: 2000 },
      streamId: { type: 'string', minLength: 1, maxLength: 128 }, sequence: { type: 'integer', minimum: 1 },
      requestId: { anyOf: [{ type: 'null' }, { type: 'string', minLength: 1, maxLength: 128 }] },
      fix: { type: 'object', properties: {
        source: { type: 'string', enum: ['simulated', 'location'] }, sampledAtMs: { type: 'integer', minimum: 1 },
        latitude: { type: 'number', minimum: -90, maximum: 90 }, longitude: { type: 'number', minimum: -180, maximum: 180 },
        accuracyM: { type: 'number', minimum: 0, maximum: 100 },
      }, required: ['source', 'sampledAtMs', 'latitude', 'longitude', 'accuracyM'], additionalProperties: false },
    }, required: ['text', 'streamId', 'sequence', 'requestId', 'fix'], additionalProperties: false },
    prepare(input) {
      if (!validFix(input.fix) || !id(input.streamId) || !(input.requestId === null || id(input.requestId)) || !input.text.trim()) throw Error('INVALID_REVIEWED_OBSERVATION');
      // Deterministic history records the review; it does not certify hardware
      // truth or consult the wall clock during replay.
      return program(emit('reviewed-observation', input));
    },
  }),
}, queries: {
  observations: defineQuery({ description: 'Read retained observations from one coherent view.', input: { type: 'null' },
    read(view) {
      const observations = []; let cursor;
      for (;;) {
        const batch = view.readEvents({ topics: ['reviewed-observation'], limit: 128, ...(cursor === undefined ? {} : { cursor }) });
        for (const event of batch.events) observations.push({ ...event.payload, author: event.author, operationId: event.operationId, proposalId: event.proposalId });
        if (!batch.hasMore) return observations;
        if (cursor === batch.cursor) throw Error('OBSERVATION_CURSOR_STALLED');
        cursor = batch.cursor;
      }
    },
  }),
} });
