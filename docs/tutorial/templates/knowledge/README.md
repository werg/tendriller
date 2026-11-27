# Knowledge & AI Memory starter (`knowledge`)

A local-first, end-to-end encrypted AI knowledge base and memory store powered by **Chronolog v2 `chronolog-db`** (`chronolog/sql` with built-in **FTS5** full-text search, **`sqlite-vec`** vector similarity, and Postgres-style write RLS via `chronolog/rls`).

## What it demonstrates

- **Zero external vector database:** Both `memories_fts` (`fts5`) and `memories_vec` (`vec0(embedding float[64])`) live directly inside Merkle-paged 4 KiB CAS pages synced peer-to-peer across browsers, local agents, and opt-in Hosted MCP.
- **100% offline hybrid search:** Built-in deterministic local feature-hashing embeddings (`embedTextLocal`) + Reciprocal Rank Fusion (RRF) combine BM25 lexical hits and vector nearest neighbors with zero API keys.
- **Pluggable agent embeddings:** An online local or hosted MCP agent can enrich any note with higher-quality embeddings via `upsertEmbedding`.
- **Write RLS:** Only the author (or explicitly granted peers in `memory_grants`) can update or delete a memory row.

## Quick start

```sh
npm run new -- my-memory --template knowledge
npm run init -- my-memory
npm run deploy -- my-memory
```
