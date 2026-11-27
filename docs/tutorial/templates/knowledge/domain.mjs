import { defineApplication, defineCommand, defineQuery } from '@chronolog/peer-session';
import {
  DEFAULT_EMBED_DIMS,
  HYBRID_MEMORY_REDUCER_SOURCE,
} from '../../shared/helpers/hybrid-memory.mjs';

const idSchema = { type: 'string', minLength: 1, maxLength: 128 };
const dims = DEFAULT_EMBED_DIMS;

/**
 * Local-first encrypted AI Knowledge & Memory base backed by a hash-pinned Chronolog v2
 * `chronolog:sqlite` ES Module reducer (`@app/memory` in `$reducers`) using FTS5 + `sqlite-vec` + `chronolog/rls`.
 * Zero external vector DB, zero native C/C++ builds — identical across browser, Node, and Hosted MCP.
 */
export const imports = Object.freeze({
  '@app/memory': HYBRID_MEMORY_REDUCER_SOURCE,
});
export const topics = Object.freeze({
  memory: Object.freeze({ module: '@app/memory' }),
});

export async function deriveKnowledge(view, params = {}) {
  return view.query('memory', {
    query: params?.query ?? '',
    tag: params?.tag ?? '',
    mode: params?.mode ?? 'hybrid',
    limit: params?.limit ?? 30,
    ...(params?.queryEmbedding ? { queryEmbedding: params.queryEmbedding } : {}),
  });
}

export const definition = defineApplication({
  id: 'shared-knowledge',
  version: '1',
  commands: {
    initialize: defineCommand({
      description: 'Create memories, FTS5 full-text index, sqlite-vec vector index, and write RLS triggers.',
      input: { type: 'null' },
      prepare: () => [{
        topic: 'memory',
        input: { action: 'initialize' },
      }],
    }),
    upsertMemory: defineCommand({
      description: 'Add or update a knowledge note with automatic FTS5 and sqlite-vec indexing.',
      input: {
        type: 'object',
        properties: {
          id: idSchema,
          title: { type: 'string', minLength: 1, maxLength: 240 },
          body: { type: 'string', minLength: 1, maxLength: 16384 },
          tags: { type: 'array', items: { type: 'string', maxLength: 48 }, maxItems: 24 },
          source: { type: 'string', maxLength: 64 },
          embedding: { type: 'array', items: { type: 'number' }, minItems: dims, maxItems: dims },
          embedModel: { type: 'string', maxLength: 64 },
        },
        required: ['id', 'title', 'body'],
        additionalProperties: false,
      },
      prepare: input => [{
        topic: 'memory',
        input: { action: 'upsertMemory', ...input },
      }],
    }),
    upsertEmbedding: defineCommand({
      description: 'Attach or upgrade a semantic embedding vector for an existing memory (e.g. from an agent).',
      input: {
        type: 'object',
        properties: {
          id: idSchema,
          embedding: { type: 'array', items: { type: 'number' }, minItems: dims, maxItems: dims },
          embedModel: { type: 'string', maxLength: 64 },
        },
        required: ['id', 'embedding'],
        additionalProperties: false,
      },
      prepare: input => [{
        topic: 'memory',
        input: { action: 'upsertEmbedding', ...input },
      }],
    }),
    deleteMemory: defineCommand({
      description: 'Delete a permitted memory and remove its FTS5 and vector entries atomically.',
      input: { type: 'object', properties: { id: idSchema }, required: ['id'], additionalProperties: false },
      prepare: ({ id }) => [{
        topic: 'memory',
        input: { action: 'deleteMemory', id },
      }],
    }),
    grantMemoryWrites: defineCommand({
      description: 'Grant another peer update/delete rights over memories via memory_grants RLS table.',
      input: { type: 'object', properties: { publicKey: { type: 'string', minLength: 64, maxLength: 64 } }, required: ['publicKey'], additionalProperties: false },
      prepare: ({ publicKey }) => {
        if (!/^[0-9a-f]{64}$/.test(publicKey)) throw Error('Invalid recipient public key');
        return [{
          topic: 'memory',
          input: { action: 'grantMemoryWrites', publicKey },
        }];
      },
    }),
  },
  queries: {
    overview: defineQuery({
      description: 'List memories and tag counts from one coherent local snapshot.',
      input: { type: 'null' },
      read: view => deriveKnowledge(view, {}),
    }),
    search: defineQuery({
      description: 'Run hybrid (FTS5 + sqlite-vec RRF), keyword-only, or semantic vector search.',
      input: {
        type: 'object',
        properties: {
          query: { type: 'string', maxLength: 500 },
          tag: { type: 'string', maxLength: 48 },
          mode: { type: 'string', enum: ['hybrid', 'keyword', 'semantic'] },
          limit: { type: 'integer', minimum: 1, maximum: 100 },
          queryEmbedding: { type: 'array', items: { type: 'number' }, minItems: dims, maxItems: dims },
        },
        additionalProperties: false,
      },
      read: (view, input) => deriveKnowledge(view, input ?? {}),
    }),
    schema: defineQuery({
      description: 'Inspect chronolog-db tables and dbRoot.',
      input: { type: 'null' },
      read: view => view.query('memory', { kind: 'schema' }),
    }),
    sql: defineQuery({
      description: 'Execute a read-only SQL query against the deterministic knowledge database.',
      input: {
        type: 'object',
        properties: { sql: { type: 'string', minLength: 1, maxLength: 4096 } },
        required: ['sql'],
        additionalProperties: false,
      },
      read: (view, { sql }) => view.query('memory', { sql, format: 'objects' }),
    }),
  },
});
