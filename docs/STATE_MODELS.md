# State models: `chronolog/sql`, JSON reducers & pluggable authority

In Chronolog v2, every Tendriller application is a single global deterministic reducer whose state is a map of topics. One topic (`$reducers`) maps each topic name to a hash-pinned QuickJS-NG ES Module (`cas:sha256-...`) stored in a Merkle-DAG Content-Addressed Store (CAS).

There are **no separate events-only vs. SQL engine builds**, **no native C/C++ addons**, and **no `domain.js` bundle to keep in sync**. Every browser tab, Node 22+ agent, and opt-in hosted MCP Worker runs the exact same QuickJS-NG + `sqlite-cas.wasm` runtime.

| Requirement | Start with |
| --- | --- |
| Relational tables, FTS5 full-text search, `sqlite-vec` vectors, atomic preconditions + rollback, write RLS, user-owned dynamic tables | Built-in `chronolog/sql` standard reducer (`templates/inventory/domain.mjs`) |
| Notes, messages, lightweight KV/document state, custom reducer logic | Pure JS/JSON ES Module reducer (`templates/notes/domain.mjs`) |
| Multiple independent SQL databases in one app | Bind multiple topics to `{ module: 'chronolog/sql' }` — each gets its own hash-addressed `dbRoot` |
| Custom governance / permissions (host-attested, M-of-N multisig, open public writers, custom capability reducer) | Override `$permissions` in genesis (`chronolog/permissions` or custom module answering `ctx.query('$permissions', ...)`) |
| Multi-participant tasks, claims, fan-in | Built-in collaboration reducer (`@tendriller/core/collaboration`) |
| Disposable presence, typing, telemetry | Ephemeral [signals](APPLICATION_SIGNALS.md) (anchored to `stateRoot`) |

## Model 1: First-class declarative SQL (`chronolog/sql`)

Bind any topic (or multiple topics) directly to the audited built-in `chronolog/sql` reducer — **zero custom JS reducer code required**:

```js
const created = await createChainGenesis({
  creator: { publicKey: identity.publicKey, wrapKey: wrapKey.publicKey, administrator: true, publisher: true },
  topics: {
    inventory: { module: 'chronolog/sql' },
    analytics: { module: 'chronolog/sql', config: { allowUserDdl: false } },
  },
});
```

### Supported operations on `chronolog/sql`

1. **`action: 'migrate'`** (administrator only): run DDL statements in `mode: 'admin'` and optionally install Postgres-style write RLS triggers atomically:
   ```js
   await session.submit({
     updates: [{
       topic: 'inventory',
       input: {
         action: 'migrate',
         statements: [
           'CREATE TABLE IF NOT EXISTS inventory (id TEXT PRIMARY KEY, units INTEGER NOT NULL CHECK (units >= 0), owner TEXT NOT NULL)',
           'CREATE TABLE IF NOT EXISTS bin_grants (grantee TEXT PRIMARY KEY NOT NULL)',
         ],
         policies: {
           inventory: {
             insert: 'NEW.owner = actor()',
             update: 'OLD.owner = actor() OR EXISTS (SELECT 1 FROM bin_grants WHERE grantee = actor())',
             delete: 'OLD.owner = actor()',
           },
         },
       },
     }],
   });
   ```
2. **`action: 'exec'`** (default when `action` is omitted; any authorized writer): run declarative SQL statements with optional atomic **preconditions**. If any precondition, constraint, or RLS trigger fails, the entire transaction rolls back atomically:
   ```js
   await session.submit({
     updates: [{
       topic: 'inventory',
       input: {
         preconditions: [{
           sql: 'SELECT units >= ? FROM inventory WHERE id = ?',
           params: [3, 'source'],
           code: 'insufficient_stock',
         }],
         statements: [
           { sql: 'UPDATE inventory SET units = units - ? WHERE id = ?', params: [3, 'source'] },
           { sql: 'UPDATE inventory SET units = units + ? WHERE id = ?', params: [3, 'destination'] },
         ],
         events: [{ topic: 'inventory.transferred', payload: { units: 3 } }],
       },
     }],
   });
   ```
   Non-admin writers can also run `CREATE TABLE` / `CREATE INDEX` / `ALTER TABLE` / `DROP TABLE` on their own personal tables (when `allowUserDdl !== false`) — table ownership is enforced automatically via `_rls_table_owners`.
3. **`action: 'setRls'`** / **`action: 'setConfig'`** (administrator only): update RLS policies or toggle `allowUserDdl`.
4. **Queries:** `view.query('inventory', { sql: 'SELECT * FROM inventory ORDER BY id', params: [], format: 'objects' })`, `{ kind: 'tables' }`, or `{ kind: 'schema' }`.

### Deterministic guarantees
Every SQLite invocation inside `TopicKernel` is 100% deterministic across browsers, Node, and Cloudflare Workers regardless of host OS or timezone:
- **`actor()`**, **`op_id()`**, and **`op_time()`** are bound by the host kernel from the verified signed operation.
- **`datetime('now')`** and **`'localtime'`** are pinned to the operation's UTC `authorTimestampMs`.
- **`random()` / `randomblob()`** are disabled.
- **3-mode authorizer:** `readonly` (pure queries), `user` (DML under RLS triggers + optional scoped DDL `{ createTable, alterTable, dropTable, indexOn, createView, dropView }`), and `admin` (full DDL/DML + `applyRls()`).

## Model 2: Custom ES Module reducers (JSON / KV or direct `chronolog:sqlite`)

When you want domain-specific reducer logic, write a plain ES Module exporting a default object `{ reduce(state, tx, ctx), query(state, input, ctx), describe() }` and check permissions via `ctx.query('$permissions', { check: 'writer', actor: tx.author })` so your reducer stays decoupled from how `$permissions` is structured:

```js
export const NOTES_REDUCER_SOURCE = `
export default {
  reduce(state, tx, ctx) {
    if (!ctx.query('$permissions', { check: 'writer', actor: tx.author })) {
      return { ok: false, code: 'writer_required' };
    }
    const notes = { ...(state?.notes || {}) };
    const input = tx.payload;
    if (input.action === 'putNote') {
      notes[input.noteId] = { id: input.noteId, text: input.text, author: tx.author, at: tx.authorTimestampMs };
    } else if (input.action === 'deleteNote') {
      delete notes[input.noteId];
    }
    return { ok: true, state: { notes }, events: [{ topic: 'note.changed', payload: input }] };
  },
  query(state) {
    return Object.values(state?.notes || {}).sort((a, b) => a.id.localeCompare(b.id));
  },
};
`;
```

Custom SQL reducers can also import `{ openDb } from 'chronolog:sqlite'` and `{ applyRls, ensureTableOwners, getOwnedTables, recordTableOwners } from 'chronolog/rls'` directly.

## Model 3: Pluggable `$permissions` & self-evolving or frozen `$reducers`

Neither Chronolog nor Tendriller forces a single membership model. Tendriller's blind host evaluates `$permissions` via `TopicKernel.query()` and only enforces host-attested admission when the genesis opts in (`admission !== null`). You can pick any built-in authority preset from `chronolog/permissions` or write your own:

- **`attestedMembers`** (default for Tendriller pages): host-attested device admission + admin role management.
- **`multisigMembers`**: M-of-N threshold quorum governance (`{ threshold, signers, members, proposals }`) with zero host attestation (`admission: null`).
- **`openMembers`**: open public writers/readers with administrator governance over `$reducers` and `$publications` (`admission: null`).
- **Frozen vs. self-evolving `$reducers`**: pass `frozenReducers: true` to omit the `$reducers` reducer and freeze rules forever, or leave `$reducers` bound so administrators can upgrade reducers or add topics via signed operations without migration scripts.

## Guarded operations & reactive views

Canonical order is solely `(signed authorTimestampMs, author, opId)`. A late earlier operation can revise later SQL outcomes, balances, or schema. Always render from coherent snapshots (`createLiveView` / `session.query`) and keep local drafts separate (`createViewStore`).
