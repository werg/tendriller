# Inventory workspace page (`chronolog/sql` + Write RLS)

Create with `npm run page:new -- stock --template inventory`, initialize with `npm run init -- stock`, and publish with `npm run deploy -- stock`.

## How this template works

- **First-class `chronolog/sql` topic reducer:** `domain.mjs` binds `{ inventory: { module: 'chronolog/sql' } }` directly in `$reducers` — no custom JS reducer code required.
- **Declarative SQL transactions + atomic preconditions:** `transfer`, `setUnits`, and `deleteBin` submit `{ preconditions, statements, events }` directly; if any precondition, CHECK constraint, or RLS trigger fails, the transaction rolls back atomically.
- **Portable deterministic SQLite (`sqlite-cas.wasm`):** Stock SQLite + FTS5 + `sqlite-vec` over a 4 KiB Merkle-paged CAS VFS ships directly inside `@chronolog/peer-session` and runs identically in browsers, Node 22.15+, and opt-in Hosted MCP Workers.
- **Postgres-style write RLS (`chronolog/rls`):** `initialize` runs `action: 'migrate'` to create tables and install validated `BEFORE INSERT/UPDATE/DELETE` RLS triggers using kernel-bound `actor()`, `op_id()`, and `op_time()`.
- **Dynamic schema & user-owned tables:** `addLabels` runs `ALTER TABLE inventory ADD COLUMN label TEXT` (`mode: 'admin'`) as an ordinary signed transaction, and `runUserDdl` lets any non-admin writer safely `CREATE TABLE`, `CREATE INDEX`, `ALTER TABLE`, and `DROP TABLE` on their own personal tables automatically tracked in `_rls_table_owners`!

## Local durability & revisable snapshots

Canonical order is solely `(authorTimestampMs, author, opId)`. Local Save resolves immediately after durable local storage, offline, without waiting for peers or finality (`finality: none` by default). Late earlier operations can revise transfer outcomes, rows, and schema; `deriveInventory(view)` rederives from one coherent snapshot while local drafts, selection, and focus stay independent.
