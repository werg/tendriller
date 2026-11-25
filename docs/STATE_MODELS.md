# Choose retained state: events or SQL

Both choices use one device-owned authored operation-set session, signed intent journal, coherent materialized views, authority and peer reconciliation. Tendriller hosts authenticated immutable UI and signed control metadata, not application execution. Disposable presence/progress uses [signals](APPLICATION_SIGNALS.md) alongside either model.

| Requirement | Start with |
| --- | --- |
| Notes/messages/observations; derive a domain from retained facts | Event notes at the tutorial root |
| Relational constraints, guarded multi-row transfers, permissioned DDL and ownership | SQL inventory in `tutorial/sql/` |
| Device capture or inference | [Sensors](SENSORS.md)/reviewed content, then an explicit command in either model |

The descriptor pins deterministic execution semantics and chosen finality policy. It does **not** freeze application schema. Code/tool declarations may describe supported behavior but cannot reject otherwise authorized ordinary schema programs.

## Browser-first SQL setup

Follow [Build an app](BUILD_AN_APP.md) for readiness, immutable SDK/tools/authority/session installation and retained handle. Select the advertised immutable SQL kit and its exact SQL-capable session. The kit supplies the matching browser WASM graph; SQL setup verifies and copies its four package-public assets to `sql/engine/` without a supplemental download. Do not substitute a stock binary or a JS-only permission claim for the matching native/WASM authorization ABI.

The SQL setup verifies WASM bytes and derives the engine/platform execution manifest from the public browser metadata. It needs no running native participant or native addon to prepare/publish the browser app.

```sh
cd sql
npm run init
npm run deploy
```

The independent publisher signs code before the first browser root exists. The owner signs in and initializes local data keys. Additional browsers remain keyless until exact key proof, explicit crypto grants and recipient-bound wrapping/import. The owning SQL Worker uses the supported dedicated Worker/VFS mode with the same retained local profile.

## Schema is an ordinary transaction

On the fresh SQL page, **Create initial tables and rows** submits authorized CREATE plus initial INSERT and emits in one ordinary atomic program. It is not a special signed-schema bootstrap channel. **Add label column** submits ordinary ALTER, updates the schema-visible materialized snapshot, and exposes its form without code publication.

The exact factory is:

```js
await createApplicationSession({device,definition,authority,
  createMaterializer: async ({signal,rootPrincipal}) => {
    const {createSqlMaterializationRuntime} = await import('@chronolog/peer-session/sql');
    return createSqlMaterializationRuntime({engine,path:'/inventory.sqlite',rootPrincipal});
  },
});
```

Database DDL/DML and permission/platform operations share original-signer authorization, authored-time ordering and atomic rollback. Creation in a namespace, ALTER/DROP on existing objects, and index/trigger rights are distinct from ordinary row writing. Protected internal catalogs, owner/PK/FK invariants, invoker/trigger restrictions and forbidden extension/temporary/attached SQL remain protected. A writer/admin/finalizer crypto grant does not implicitly grant destruction of somebody else's objects.

The starter **Grant units updates and receipt inserts** action is an ordinary explicit permission program. It grants only the reviewed columns/operations for the signer's scope; a later label column does not silently join that grant. Crypto membership refresh never rewrites projected application collective permissions.

## Guarded transfers, not irreversible provisional claims

A transfer program checks reviewed source/destination balances at its canonical position, moves units atomically, inserts its receipt and emits. Failed guards/SQL/DDL roll back all application/schema/permission/effective-event changes. Missing engine/key/body/authority dependencies are not fabricated deterministic rejection.

Canonical order is solely `(signed authorTimestampMs, signing public-key bytes, stable proposal-ID bytes)`. An earlier operation received later can revise a transfer's previously displayed success/rejection, effective events and derived state. A late earlier CREATE/ALTER can similarly revise later DDL/DML outcomes. Never dependency-sort schema ahead of author time.

Submission resolves after exact local durable storage and stays available offline once keys/storage are ready. It does not wait for peers, a successful global/current query, a native process or finality. Retention is separate authenticated peer evidence. Ordinary apps default to no finality. Provisional reservations/claims are not global exclusivity or authority for irreversible external effects.

## Reactive views and honest schema errors

`deriveInventory(view)` introspects the catalog and queries bins/receipts from one captured materialized revision. The page recomputes rows, counts, selected details and label forms after schema-only or data changes. Drafts/reviewed guard values are separate local view state and are not overwritten by incoming snapshots.

A missing table or outdated query reports an explicit view error. Keep the last successful snapshot visible as **not current**, preserve selection/focus/deep links/unsent input, and leave unrelated local authoring available. Captured reader leases stay coherent and are released. Read revisions are digests of effective materialized input sets/execution/policy, never global sequence allocation.

The optional exact author-time field demonstrates late earlier work. Choose and retain that bigint value once; retries use the original signed proposal. Inspect stored/materialized/retained/finalized/excluded independently. A no-finality final wait fails explicitly as unsupported; a sealed frontier may exclude first-seen offline work behind it without rewriting its original intent.

## Qualification

Verify browser-only setup, offline CRUD/reload, separate-device key provisioning and convergence; ordinary authorized/denied DDL; mixed schema/data rollback; late earlier DDL revising later outcomes; schema-only reactive invalidation; stale query UI and preserved drafts/focus at desktop/320px. Native/WASM parity needs exact engine source/ABI/artifact evidence; a static or native-only test does not qualify browser SQL. Follow [delivery](AGENT_DELIVERY.md) and report exact tested boundaries.
