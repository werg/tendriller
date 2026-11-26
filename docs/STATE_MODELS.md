# State models: JSON reducers & deterministic SQLite-CAS + RLS

In Chronolog v2, every Tendriller application uses one unified session (`@chronolog/peer-session`) backed by a **Merkle-DAG Content-Addressed Store (CAS)** and **QuickJS-NG ES Module reducers** hash-pinned in `$reducers`.

There are **no separate events-only vs. SQL engine builds**, **no native C/C++ addons**, and **no `domain.js` bundle to keep in sync**. Every browser tab, Node 22+ agent, and opt-in hosted MCP Worker runs the exact same QuickJS-NG + `sqlite-cas.wasm` runtime.

| Requirement | Start with |
| --- | --- |
| Notes, messages, simple KV/document state | Pure JS/JSON reducer (`templates/notes/domain.mjs`) |
| Relational tables, FTS5 full-text search, `sqlite-vec` vectors, atomic transfers, write RLS, user-owned dynamic tables | SQLite-CAS + `chronolog/rls` reducer (`templates/inventory/domain.mjs`) |
| Multi-participant tasks, claims, fan-in | Built-in collaboration reducer (`@tendriller/core/collaboration`) |
| Disposable presence, typing, telemetry | Ephemeral [signals](APPLICATION_SIGNALS.md) (anchored to `stateRoot`) |

## Model 1: Pure JSON / KV ES Module reducer

For lightweight document/event apps, write a pure ES Module exporting a default object with `reduce(state, tx, ctx)`, `query(state, input, ctx)`, and optional `describe()`:

```js
export const NOTES_REDUCER_SOURCE = `
export default {
  reduce(state, tx, ctx) {
    const perms = ctx.topic('$permissions');
    if (!perms?.members?.some(m => m.publicKey === tx.author && m.writer)) {
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

## Model 2: Deterministic SQLite-CAS (`chronolog:sqlite`) + Postgres-style write RLS (`chronolog/rls`)

Any reducer can import `{ openDb } from 'chronolog:sqlite'` and store its entire SQLite database as a Merkle-paged CAS root hash (`state.dbRoot`) — with **stock SQLite + FTS5 + `sqlite-vec`**, 4 KiB content-addressed pages, and structural sharing across snapshots!

### Deterministic guarantees
Every SQLite invocation inside `TopicKernel` is 100% deterministic across browsers, Node, and Cloudflare Workers regardless of host OS or timezone:
- **`actor()`**, **`op_id()`**, and **`op_time()`** are bound by the kernel from the verified signed operation (never spoofable by reducer arguments).
- **`datetime('now')`** and **`'localtime'`** are pinned to the operation's UTC `authorTimestampMs` (immune to host timezone differences).
- **`random()` / `randomblob()`** are denied (or deterministic via `chronolog:crypto`).
- **3-mode authorizer:**
  - `mode: 'readonly'` (default for `query()`): pure SELECT/PRAGMA reads only.
  - `mode: 'user'`: DML (`INSERT`/`UPDATE`/`DELETE`) subject to RLS triggers, plus optional scoped DDL (`allowCreateTable`, `allowCreateIndex`, `allowAlterOwnedTables`, `allowDropOwnedTables`, `ownedTables`). Protected `_rls_*` and `sqlite_*` tables/triggers cannot be tampered with!
  - `mode: 'admin'`: full DDL/DML for admin-authorized migrations and installing RLS policies via `applyRls()`.

### Postgres-style write RLS (`chronolog/rls`)
Instead of rigid, bureaucratic SQL catalog grants, express row-level write authorization in clean, arbitrary SQL using `applyRls(db, policies)`:

```js
import { openDb } from 'chronolog:sqlite';
import { applyRls, ensureTableOwners, getOwnedTables, recordTableOwners } from 'chronolog/rls';

export default {
  reduce(state, tx, ctx) {
    const db = openDb(state?.dbRoot ?? null);

  if (tx.payload.action === 'init') {
    db.exec(`
      CREATE TABLE IF NOT EXISTS inventory (
        id TEXT PRIMARY KEY,
        units INTEGER NOT NULL CHECK (units >= 0),
        owner TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS bin_grants (
        grantee TEXT PRIMARY KEY NOT NULL
      );
    `, [], { mode: 'admin' });

    // Each predicate is parsed & validated in readonly mode before wrapping in a BEFORE trigger!
    applyRls(db, {
      inventory: {
        insert: 'NEW.owner = actor()',
        update: 'OLD.owner = actor() OR EXISTS (SELECT 1 FROM bin_grants WHERE grantee = actor())',
        delete: 'OLD.owner = actor()',
      },
    });
    ensureTableOwners(db);
    return { ok: true, state: { dbRoot: db.commit() } };
  }

  if (tx.payload.action === 'addBin') {
    db.exec('INSERT INTO inventory(id, units, owner) VALUES (?, ?, actor())', [tx.payload.id, tx.payload.units], { mode: 'user' });
    return { ok: true, state: { dbRoot: db.commit() } };
  }

  // Schema is NOT static! Even non-admin users can create/alter/drop their own tables safely:
  if (tx.payload.action === 'userDdl') {
    const owned = getOwnedTables(db, tx.author);
    const res = db.exec(tx.payload.sql, [], {
      mode: 'user',
      ddl: {
        allowCreateTable: true,
        allowCreateIndex: true,
        allowAlterOwnedTables: true,
        allowDropOwnedTables: true,
        ownedTables: owned,
      },
    });
    recordTableOwners(db, res.createdTables, res.droppedTables, tx.author);
    return { ok: true, state: { dbRoot: db.commit() } };
  }

  return { ok: false, code: 'unknown_action' };
}
```

### Registering reducers in genesis & upgrading later
Pin your reducers in genesis with `createChainGenesis`:

```js
const created = await createChainGenesis({
  creator: { publicKey: identity.publicKey, wrapKey: wrapKey.publicKey, administrator: true, publisher: true },
  imports: { 'app/inventory': INVENTORY_REDUCER_SOURCE },
  topics: { inventory: { module: 'app/inventory', initialState: { dbRoot: null } } },
});
```

Unless `frozenReducers: true` is set, administrators can upgrade reducers or add new topics at any time via ordinary signed `$reducers` public-control operations (`session.updateReducers(...)`) — with zero database migration scripts because old operations replay under the exact reducer hash active at their authored timestamp!

## Guarded operations & reactive views

Canonical order is solely `(signed authorTimestampMs, author, opId)`. A late earlier operation can revise later SQL outcomes, balances, or schema. Always render from coherent snapshots (`createLiveView` / `session.query`) and keep local drafts separate (`createViewStore`).
