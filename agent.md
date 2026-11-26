# Build a Tendriller application (Chronolog v2)

The deliverable is a working signed page, not a preview or an installed adapter. One **agent** (one `ta_` credential, one signing key and one X25519 wrap key) maintains many pages from one workspace and one optional local program; see [multi-page agents](docs/MULTI_PAGE_AGENTS.md) and [agent credentials and grants](docs/AGENT_BINDINGS.md). Start with [Build an app](docs/BUILD_AN_APP.md), [State models](docs/STATE_MODELS.md), [Capabilities](docs/CAPABILITIES.md), [Session bootstrap](docs/SESSION_BOOTSTRAP.md), and [Delivery](docs/AGENT_DELIVERY.md).

For account-linked tools, follow the [MCP agent guide](docs/MCP_AGENT_GUIDE.md).

## Service and release first

Use the exact service origin supplied by the person or account-linked connector, including staging. Read `/api/service`, `/.well-known/tendriller.json` (using its immutable `firstApp.release` composition route), and `/api/readiness` before downloading or installing packages. Continue only with verified same-origin readiness, `mode: "open"`, and `creation.available: true`. Install with `npm ci --ignore-scripts` (Chronolog v2 requires **zero native C/C++ builds**).

**Resuming an existing or fallow workspace:** run `tendril status`, `tendril broadcasts`, and `tendril changelog --since YYYY-MM-DD` before modifying or redeploying.

## First-app route

1. **Register the agent once, then create the page.** With account-linked MCP, run `tendril workspace key --handle HANDLE`, call `register_agent` and retain with `tendril workspace adopt`. From a domain, run `tendril workspace init --owner EMAIL --handle HANDLE`; with a join code, `tendril workspace join`. Create pages with `npm run page:new -- <slug> --template notes|inventory|call`.
2. **Author your ES Module reducer.** Write a pure JS/JSON reducer (like `templates/notes/domain.mjs`) OR a relational SQL reducer using `chronolog:sqlite` + Postgres-style `chronolog/rls` (like `templates/inventory/domain.mjs`). Both run identically in browser, Node 22+, and opt-in hosted MCP with zero separate `domain.js` bundle!
3. **Initialize genesis and publish.** `npm run init -- <slug>` prepares host metadata and creates the Chronolog v2 `GenesisBlock` (pinning `$reducers` ES Modules in CAS, `$permissions`, `$keys`, `$finality`, `$publications`, and the host attestation key) plus epoch 0 key locally. `npm run deploy -- <slug>` signs a `$publications` public-control op and uploads the built UI assets to R2.
4. **Give the ready page URL to the owner** and keep `npm run agent` running. They complete sign-in.
5. **Admission.** The signed-in browser obtains a host-signed Ed25519 attestation (`signHostAttestationV2`). Any online administrator verifies it and calls `session.admitMember(...)`, which atomically updates `$permissions` AND seals historical + current epoch HPKE lockboxes into `$keys` in one public-control operation!
6. **Further devices, invites, and removal.** Owner-account devices join with the policy grant (`admin` by default; narrow with `tendril page owner-grant <slug> writer`); strict mode (`tendril page mode <slug> strict`) holds devices for approval; `session.removeMember(pk, { rotate: true })` removes a device and rotates the epoch key in one atomic op.
7. **Verify local authoring, offline reload, replication and signatures.**

## Chronolog v2 reducer recipes (copy-paste patterns)

### Pattern A: Plain JSON / KV reducer
```js
export const REDUCER_SOURCE = `
export function reduce(state, tx, ctx) {
  const perms = ctx.topic('$permissions');
  const writer = perms?.members?.some(m => m.publicKey === tx.author && m.writer);
  if (!writer) return { ok: false, code: 'writer_required' };
  const items = { ...(state?.items || {}) };
  if (tx.payload?.action === 'put') items[tx.payload.id] = { text: tx.payload.text, author: tx.author };
  if (tx.payload?.action === 'delete') delete items[tx.payload.id];
  return { ok: true, state: { items }, events: [{ topic: 'item.changed', payload: tx.payload }] };
}
export function query(state) {
  return Object.entries(state?.items || {}).sort(([a], [b]) => (a < b ? -1 : 1));
}
`;
```

### Pattern B: Deterministic SQLite-CAS + Postgres-style write RLS + user tables
```js
export const SQL_REDUCER_SOURCE = `
import { open } from 'chronolog:sqlite';
import { applyRls, ensureTableOwners, getOwnedTables, recordTableOwners } from 'chronolog/rls';

export function reduce(state, tx, ctx) {
  const db = open(state?.dbRoot ?? null);
  if (tx.payload?.action === 'init') {
    db.exec('CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, owner TEXT NOT NULL)', [], { mode: 'admin' });
    ensureTableOwners(db);
    applyRls(db, {
      tasks: {
        insert: 'NEW.owner = actor()',
        update: 'OLD.owner = actor()',
        delete: 'OLD.owner = actor()',
      },
    });
    return { ok: true, state: { dbRoot: db.commit() } };
  }
  if (tx.payload?.action === 'addTask') {
    // Runs in mode:'user' — RLS triggers enforce NEW.owner = actor() automatically!
    db.exec('INSERT INTO tasks(id, title, owner) VALUES (?, ?, actor())', [tx.payload.id, tx.payload.title], { mode: 'user' });
    return { ok: true, state: { dbRoot: db.commit() } };
  }
  if (tx.payload?.action === 'userDdl') {
    // Non-admin users can safely create/alter/drop their own personal tables!
    const owned = getOwnedTables(db, tx.author);
    const res = db.exec(tx.payload.sql, [], {
      mode: 'user',
      ddl: { allowCreateTable: true, allowCreateIndex: true, allowAlterOwnedTables: true, allowDropOwnedTables: true, ownedTables: owned },
    });
    recordTableOwners(db, res.createdTables, res.droppedTables, tx.author);
    return { ok: true, state: { dbRoot: db.commit() } };
  }
  return { ok: false, code: 'unknown_action' };
}
export function query(state) {
  if (!state?.dbRoot) return [];
  const db = open(state.dbRoot);
  return db.query('SELECT id, title, owner FROM tasks ORDER BY id').rows;
}
`;
```

Register reducers in genesis via `createChainGenesis({ creator, imports: { 'app/main': SQL_REDUCER_SOURCE }, topics: { main: { module: 'app/main', initialState: { dbRoot: null } } } })` — zero DoltLite, zero native builds, and full hosted MCP support automatically!

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

- `@chronolog/peer-session`: devices, `node:sqlite` / IndexedDB CAS, `TopicKernel` (QuickJS-NG + `sqlite-cas.wasm`), operations, signals, and WebRTC/WS replication.
- `@chronolog/authority`: portable CBOR/hash codecs, input schema validation, `$finality` checkpoint verification, and `signHostAttestationV2`.
- Tendriller Worker (`server/`): blind public-control participant (`TopicKernel({ blindHostMode: true })`), account/OAuth auth, immutable R2 signed UI releases, introductions/relay, and opt-in RAM-only hosted MCP. Never holds plaintext epoch keys or application data at rest.
- Finality is optional (`$finality` schedule, default `none`). Missing finality never blocks local authoring. On active finality policies, hosted code releases wait for finality; on `finality: none`, a late revocation immediately rolls back an invalidated provisional release.

See [patterns](docs/APP_PATTERNS.md), [state models](docs/STATE_MODELS.md), [multi-participant composition](docs/MULTIPARTICIPANT.md), [CLI](docs/tools/CLI.md), [sensors](docs/SENSORS.md), [pricing](docs/PRICING.md), [self-hosting](docs/SELF_HOSTING.md), and [troubleshooting](docs/TROUBLESHOOTING.md).
