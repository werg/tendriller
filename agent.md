# Build a Tendriller application

The deliverable is a working signed page, not a preview or an installed adapter. One **agent** (one `ta_` credential, one signing key and one X25519 wrap key) maintains many pages from one workspace and one optional local program; see [multi-page agents](docs/MULTI_PAGE_AGENTS.md) and [agent credentials and grants](docs/AGENT_BINDINGS.md). Start with [Build an app](docs/BUILD_AN_APP.md), [State models](docs/STATE_MODELS.md), [Capabilities](docs/CAPABILITIES.md), [Session bootstrap](docs/SESSION_BOOTSTRAP.md), and [Delivery](docs/AGENT_DELIVERY.md).

For account-linked tools, follow the [MCP agent guide](docs/MCP_AGENT_GUIDE.md).

## Service and release first

Use the exact service origin supplied by the person or account-linked connector, including staging. Read `/api/service`, `/.well-known/tendriller.json` (using its immutable `firstApp.release` composition route), and `/api/readiness` before downloading or installing packages. Continue only with verified same-origin readiness, `mode: "open"`, and `creation.available: true`. Install with `npm ci --ignore-scripts` on Node 22.15+.

**Resuming an existing or fallow workspace:** run `tendril status`, `tendril broadcasts`, and `tendril changelog --since YYYY-MM-DD` before modifying or redeploying.

## First-app route

1. **Register the agent once, then create the page with a real favicon.** With account-linked MCP, run `tendril workspace key --handle HANDLE`, call `register_agent` and retain with `tendril workspace adopt`. From a domain, run `tendril workspace init --owner EMAIL --handle HANDLE`; with a join code, `tendril workspace join`. Create pages with `npm run page:new -- <slug> --template notes|inventory|knowledge|call --name "My App" --icon 🍳` (choose a domain-fitting emoji, HTTPS icon URL, or custom `<link rel="icon">` in `index.html`, plus optional `--theme-color "#hex"` — **never leave a live page with the default green initial-letter fallback**). (Owners can also remix an existing page or import a portable `PageBlueprint` directly from `/dashboard`.)
2. **Choose your topic reducer(s).** Bind one or more SQL topics directly to built-in `chronolog/sql` (declarative SQL transactions + atomic preconditions + Postgres-style write RLS + user-owned dynamic tables, see `templates/inventory/domain.mjs`), use the `knowledge` starter (`templates/knowledge/domain.mjs` + `shared/helpers/hybrid-memory.mjs`) for local-first encrypted FTS5 + `sqlite-vec` hybrid AI memory with write RLS, OR write a pure JS/JSON ES Module reducer (like `templates/notes/domain.mjs`). All of them run identically in browser, Node 22.15+, and opt-in Hosted MCP directly from `$reducers`.
3. **Choose your authority model and initialize genesis.** By default, `npm run init -- <slug>` creates a private E2EE Chronolog `LogGenesis` with host-attested `attestedMembers` (`$permissions`), `$keys`, `$finality`, `$publications`, and `$reducers`. Pass `--authority multisig --signers <hex,hex> --threshold 2` for M-of-N quorum governance or `--authority open --open-read` / `--open-write` for zero-OAuth public pages (always pair non-private governance with `shared/helpers/governance.mjs` `mountGovernanceBanner` so users understand the privacy boundary!), or supply a custom `$permissions` reducer — Tendriller's blind host evaluates capabilities via `TopicKernel.query('$permissions', ...)` and only enforces host attestation when `admission !== null`!
4. **Publish, evolve live, and deliver.** `npm run deploy -- <slug>` signs a `$publications` public-control op and uploads the built UI assets to R2. Give the ready page URL to the owner and keep `npm run agent` running. Inspect any SQL topic's tables, columns, user-owned objects, and active RLS rules via `{ query: 'schema' }` or `shared/ui/schema-explorer.mjs`. Hot-publish new `$reducers` ES Modules (after local QuickJS-NG dry-run via `shared/helpers/live-evolution.mjs` or `tendril reducers publish`) and evolve SQL schemas live (`tendril sql migrate-file`) without redeploying peers. Store large media lazily over P2P via `session.content` (`shared/helpers/lazy-media.mjs` / `tendril content put|get`) and export portable secret-free blueprints via `@tendriller/core/blueprint` (`tendril blueprint export`) or one-click Remix on `/dashboard`.
5. **Admission.** On host-attested pages, the signed-in browser obtains a host-signed Ed25519 attestation (`signHostAttestationV2`). Any online administrator verifies it and calls `session.admitMember(...)`, which atomically updates `$permissions` AND seals historical + current epoch HPKE lockboxes into `$keys` in one public-control operation!
6. **Further devices, invites, and removal.** Owner-account devices join with the policy grant (`admin` by default; narrow with `tendril page owner-grant <slug> writer`); strict mode (`tendril page mode <slug> strict`) holds devices for approval; `session.removeMember(pk, { rotateEpoch: true })` removes a device and rotates the epoch key in one atomic op.
7. **Verify local authoring, offline reload, replication and signatures.**

## Chronolog reducer recipes (copy-paste patterns)

### Pattern A: First-class declarative SQL (`chronolog/sql`) — zero custom JS reducer!
```js
// In domain.mjs: bind one or more topics directly to chronolog/sql!
export const imports = Object.freeze({});
export const topics = Object.freeze({
  tasks: Object.freeze({ module: 'chronolog/sql' }),
});

// 1. Admin initializes schema + Postgres-style write RLS atomically:
await session.submit({
  updates: [{
    topic: 'tasks',
    input: {
      action: 'migrate',
      statements: ['CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, owner TEXT NOT NULL)'],
      policies: {
        tasks: {
          insert: 'NEW.owner = actor()',
          update: 'OLD.owner = actor() AND NEW.owner = actor()',
          delete: 'OLD.owner = actor()',
        },
      },
    },
  }],
});

// 2. Any writer submits SQL transactions with atomic preconditions (rolls back on failure):
await session.submit({
  updates: [{
    topic: 'tasks',
    input: {
      preconditions: [{ sql: 'SELECT COUNT(*) = 0 FROM tasks WHERE id = ?', params: ['t1'], code: 'already_exists' }],
      statements: [{ sql: 'INSERT INTO tasks(id, title, owner) VALUES (?, ?, actor())', params: ['t1', 'Ship v2'] }],
    },
  }],
});

// 3. Query read-only snapshots:
const { value } = await session.query('tasks', { sql: 'SELECT id, title, owner FROM tasks ORDER BY id', format: 'objects' });
```

### Pattern B: Plain JSON / KV ES Module reducer (pluggable permissions via `ctx.query`)
```js
export const REDUCER_SOURCE = `
export default {
  reduce(state, tx, ctx) {
    if (!ctx.query('$permissions', { check: 'writer', actor: tx.author })) {
      return { ok: false, code: 'writer_required' };
    }
    const items = { ...(state?.items || {}) };
    if (tx.payload?.action === 'put') items[tx.payload.id] = { text: tx.payload.text, author: tx.author };
    if (tx.payload?.action === 'delete') delete items[tx.payload.id];
    return { ok: true, state: { items }, events: [{ topic: 'item.changed', payload: tx.payload }] };
  },
  query(state) {
    return Object.entries(state?.items || {}).sort(([a], [b]) => (a < b ? -1 : 1));
  },
};
`;
```

### Pattern C: Custom SQLite-CAS reducer (`chronolog:sqlite` + `chronolog/rls`)
```js
export const CUSTOM_SQL_REDUCER = `
import { openDb } from 'chronolog:sqlite';
import { applyRls, getOwnedTables, recordTableOwners } from 'chronolog/rls';

export default {
  reduce(state, tx, ctx) {
    if (!ctx.query('$permissions', { check: 'writer', actor: tx.author })) {
      return { ok: false, code: 'writer_required' };
    }
    const db = openDb(state?.dbRoot ?? null);
    try {
      const owned = getOwnedTables(db, tx.author);
      const res = db.exec(tx.payload.sql, tx.payload.params || [], {
        mode: 'user',
        ddl: { createTable: true, alterTable: owned, dropTable: owned, indexOn: owned, createView: true, dropView: owned },
      });
      recordTableOwners(db, res.createdTables, res.droppedTables, tx.author);
      return { ok: true, state: { dbRoot: db.commit() } };
    } finally {
      db.close();
    }
  },
  query(state, input) {
    if (!state?.dbRoot) return { columns: [], rows: [] };
    const db = openDb(state.dbRoot);
    try { return db.query(input.sql, input.params || []); } finally { db.close(); }
  },
};
`;
```

## Data contract

Chronolog merges flat, immutable, Ed25519-signed operation sets. Canonical order is solely `(signed authorTimestampMs, author public key, stable opId)`. No host, peer, or finalizer assigns operation order.

```js
const op = await session.command('addTask', { id: 't1', title: 'Ship v2' }, { operationId });
// Resolved: exact signed intent is durable locally, even offline.
const current = await op.materialized(); // coherent, revisable local outcome
const inspection = op.inspect();
// inspection.stored / materialized / retained / finalized / excluded are independent facts.
```

Preserve `operationId` across uncertain replies; `session.operations.retry(id)` retries the exact retained bytes and timestamp. Render coherent snapshots (`createLiveView` / `session.query`) plus separate local drafts (`createViewStore`). Late earlier operations can revise SQL outcomes, rows, and schema — invalidate and rederive rather than accumulating arrival events as UI truth.

## Boundaries

- `@chronolog/peer-session`: devices, `node:sqlite` / IndexedDB CAS, `TopicKernel` (QuickJS-NG + `sqlite-cas.wasm` + `chronolog/sql`), operations, signals, and WebRTC/WS replication.
- `@chronolog/authority`: portable CBOR/hash codecs, input schema validation, `$finality` checkpoint verification, and `signHostAttestationV2`.
- Tendriller Worker (`server/`): blind public-control participant (`TopicKernel({ blindHostMode: true })`), pluggable `$permissions` evaluation, account/OAuth auth, immutable R2 signed UI releases, introductions/relay, and opt-in RAM-only hosted MCP. Never holds plaintext epoch keys or application data at rest.
- Finality is optional (`$finality` schedule, default `none`). Missing finality never blocks local authoring. On active finality policies, hosted code releases wait for finality; on `finality: none`, a late revocation immediately rolls back an invalidated provisional release.

See [patterns](docs/APP_PATTERNS.md), [state models](docs/STATE_MODELS.md), [multi-participant composition](docs/MULTIPARTICIPANT.md), [CLI](docs/tools/CLI.md), [sensors](docs/SENSORS.md), [pricing](docs/PRICING.md), [self-hosting](docs/SELF_HOSTING.md), and [troubleshooting](docs/TROUBLESHOOTING.md).
