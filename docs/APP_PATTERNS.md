# Reuse the application helpers

Start with [browser-first setup](BUILD_AN_APP.md), [ownership/bootstrap](SESSION_BOOTSTRAP.md), and [capabilities](CAPABILITIES.md). A rich application needs domain views, not a JSON editor or a form mirroring storage fields.

## Connect the browser

`worker.mjs` opens retained identity/authority/keys locally, then `createApplicationSession`. `page.mjs` uses `openBrowserOwner` and installs `createApplicationBackend(session)` into the runtime. `helpers/browser-profile.mjs` supplies the same stable profile for every document. Never gate Save on network/discovery/native-provider/finalizer reachability.

The first owner browser initializes local data keys after actual sign-in/key proof. A fresh second browser stays keyless until explicit reviewed crypto membership and recipient-bound wrapped-key transfer. Use `helpers/provisioning-view.mjs`; no ordering pause or native-prepared prefix exists. SQL permission grants remain ordinary transactions, separate from crypto membership.

## Domain views you can import

- **List/detail with stable IDs:** the event notes page derives complete rows from one captured materialized event snapshot. Links select `#note=ID`; the detail is an inspector, while the editor owns separate local drafts per entity. Reordered snapshots do not overwrite textarea values.
- **Relational list/detail/catalog:** the SQL page derives inventory balances, transfer receipts and schema introspection from one captured view. It recomputes counts and detail text; incoming ALTER exposes current fields without publishing code. Missing tables/columns leave the last successful snapshot visible and explicitly **not current**.
- **Reviewed comparison/edit:** use `ui/` list/detail, inspector and reviewed-edit examples for long domain content. Put previous/current/reviewed values beside one another. Submission captures the reviewed guard values; a new snapshot never silently edits the person's pending guard/draft.
- **View-state persistence:** `createViewStore({storage,applicationId,profileId,viewId})` stores independent drafts and original operation references. Wrap unavailable/quota-failing browser storage with an honest visible fallback; do not claim a volatile draft survives reload.

### Desktop: search, inspector and reviewed comparison

Use keyed entity nodes and explicit selected IDs, not arrival indexes. Reconcile text/rows and order from each snapshot; preserve the active node, focus and scroll. Keep the draft editor separate from inspector rendering. Display changed/retracted outcomes and provenance in the operation inspector rather than incrementing counters from event arrivals.

### Phone: a focused detail with a route back

At 320px use a 16px side gutter with no page horizontal scroll. Stable-ID fragments/deep links and Back must preserve draft state. Keep labels, keyboard focus, long text and cancel/save actions reachable. Hiding an optional agent/media panel must not hide ordinary domain editing.

### Empty, loading, error and connection states

Keep draft fields editable during opening. Enable durable Save when `status.canAuthor` confirms local signing/storage prerequisites, even with zero peers or SQL still materializing. A query error is a view error, not loss of the local intent or a reason to block unrelated offline submissions. Display loading, never-initialized schema, empty domain and stale-last-snapshot states distinctly.

## 1. A coherent reactive query

```js
const live = createLiveView(session, async view => {
  const rows = await view.query('SELECT id,units FROM inventory ORDER BY id');
  return rows.rows.map(([id,units]) => ({id,units}));
}, {onError(error) {
  showLastSnapshotAsNotCurrent(error); // keep drafts untouched
}});
live.subscribe(({value,revision}) => renderDomain(value, revision));
```

A notification invalidates/rederives. It does not append a network arrival to a second mutable UI store. Materialized revisions bind exact effective operation/execution/policy inputs; they are not globally allocated sequences. Provisional event cursors are snapshot-scoped; restart a coherent derivation when the projection changes. Captured reads remain coherent and must be released.

## 2. Independent operation facts

```js
const operation = await session.submit({program,operationId});
showStoredLocally(operation.id); // exact signed intent is durable
const observation = await operation.inspect();
// stored, pending, materialized, retained, finalized, excluded
for await (const next of session.operations.subscribe({operationId,signal})) {
  renderOperationFacts(next); // later materialized outcomes can revise
}
```

`materialized()` is current local execution, not irrevocable success. `retained()` is authenticated availability evidence from named peers, not execution/finality. `finalized()` requires the chosen proof policy and complete replay; on policy `none` it explicitly rejects as unsupported. Optional finalizers never control ordinary Save.

## 3. Preserve uncertain intent before dispatch

Retain the chosen semantic operation ID and reviewed inputs before the first RPC. After an uncertain response, inspect that original ID. If signed work exists, `session.operations.retry(id)` retries its exact bytes/time/identity and wakes dependencies/replication; it never mints work. If preparation was never stored, only repeat the exact retained command/input/ID. Clear an editor draft only after local durable acknowledgment, and only if it is still the exact text/context that was sent. Keep rejected/excluded originals inspectable. There is no automatic new-identity retimestamping path.

`helpers/submission-state.mjs` deliberately has no peer, current-global-read or finalizer gate. Use `helpers/cli-lifetime.mjs`/owned signals for optional native process cleanup. Detaching a view cancels observation, not the durable proposal.

## 4. Ordinary schema and permission edits

The SQL starter's `initialize`, `addLabels`, and `grantBinWrites` commands submit the same canonical programs as data edits. Authorized DDL/DML/platform grants share author-time replay and atomic rollback. There is no static schema digest, special initialization channel or mandatory code publication.

A late earlier DDL transaction can revise an already displayed SQL outcome. Do not dependency-sort DDL ahead of author time. Query the current catalog from each captured snapshot and adapt the next form/query. Existing column grants and approved tool schemas do not silently expand when columns appear. Keep creation-namespace/object ALTER/DROP/index/trigger permissions distinct from ordinary data writing and finalizer rights.

## 5. Optional finality, providers and reviewed media

`helpers/finality-view.mjs` exposes an explicit local browser provider action, not an automatic write gate. Warn before closing author time: unseen genuine offline work behind the frontier may be excluded. Fixed-validator quorums require actual votes. Configuration alone is not qualified provider availability.

Camera/file preview and analysis are separate stages. Keep explicit consent before sharing content with a named inference provider, permit cancellation, and let the person edit suggestions before a declared domain command. Missing agents disable only their tools/analysis. Session signals are disposable previews/progress; they do not persist domain state or establish exclusivity. Provisional claims are not authority for irreversible effects. See [reviewed input](AI_INPUT.md), [sensors](SENSORS.md), [signals](APPLICATION_SIGNALS.md), and optional `ui/`/`media/` modules.

## Full-duplex presentation and feeds

Existing `ui/dashboard.mjs`, `ui/chat-session.mjs`, and `helpers/data-feed.mjs` are optional presentation/live-signal consumers, not a second persistence framework. Bind them to current coherent snapshots and explicitly approved agent scopes. No native process is necessary for independent browser authoring. Verify their actual supported APIs against the matching package composition and [delivery flow matrix](AGENT_DELIVERY.md#the-user-experience-is-part-of-the-deliverable).
