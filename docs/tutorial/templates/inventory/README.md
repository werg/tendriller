# Inventory workspace page (Chronolog v2 SQLite-CAS + RLS)

Create with `npm run page:new -- stock --template inventory`, initialize with `npm run init -- stock`, and publish with `npm run deploy -- stock`.

## Why this template is so simple in Chronolog v2

- **Zero native C/C++ builds & zero separate WASM copying:** `sqlite-cas.wasm` (stock SQLite + FTS5 + `sqlite-vec` over a 4 KiB Merkle-paged CAS VFS) ships directly inside `@chronolog/peer-session` and runs identically in browsers, Node 22+, and opt-in hosted MCP Workers.
- **No separate `domain.js` bundle:** `INVENTORY_REDUCER_SOURCE` in `domain.mjs` is hash-pinned right into `$reducers` in genesis.
- **Postgres-style write RLS (`chronolog/rls`):** `applyRls(db, { inventory: { insert: 'NEW.owner = actor()', update: 'OLD.owner = actor() OR EXISTS (SELECT 1 FROM bin_grants WHERE grantee = actor())', delete: 'OLD.owner = actor()' } })` enforces expressive SQL write guards using kernel-bound `actor()`, `op_id()`, and `op_time()`.
- **Dynamic schema & user-owned tables:** `addLabels` runs `ALTER TABLE inventory ADD COLUMN label TEXT` as an ordinary signed transaction, and `runUserDdl` lets any non-admin writer safely `CREATE TABLE`, `CREATE INDEX`, `ALTER TABLE`, and `DROP TABLE` on their own personal tables tracked via `ensureTableOwners` / `getOwnedTables` / `recordTableOwners`!

## Local durability & revisable snapshots

Canonical order is solely `(authorTimestampMs, author, opId)`. Local Save resolves immediately after durable local storage, offline, without waiting for peers or finality (`finality: none` by default). Late earlier operations can revise transfer outcomes, rows, and schema; `deriveInventory(view)` rederives from one coherent snapshot while local drafts, selection, and focus stay independent.
