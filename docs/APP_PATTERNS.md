# Reuse the application helpers

Start with [setup](BUILD_AN_APP.md), [ownership/bootstrap](SESSION_BOOTSTRAP.md), and [capabilities](CAPABILITIES.md). A rich application needs domain views, not a JSON editor or a form mirroring storage fields.

## Connect the browser

`worker.mjs` opens retained identity/authority/keys locally, then `createApplicationSession`. `page.mjs` uses `openBrowserOwner` and installs `createApplicationBackend(session)` into the runtime. `shared/helpers/browser-profile.mjs` supplies the same stable profile for every document. Never gate Save on network/discovery/native-provider/finalizer reachability.

`worker.mjs` also starts the one admission controller (`admitBrowserSession`) and returns its `extensions` with the session. A signed-in browser waits until an online member admits it and wraps its keys; mount `shared/helpers/devices-view.mjs` (`mountDevices({root, session, pageUrl})`) for the waiting banner, devices and agents list, New device notices, Remove device, pending Approve, the strict-mode switch, invites and invite-link redemption. It re-renders each coherent `{topic:'admission', state}` notice; actions run in the owner. No ordering pause exists. SQL permission grants remain ordinary transactions, separate from crypto membership.

### Match an application-owned palette

Set the connection card's color properties on its mount container or `:root`.
Inherited authored values survive the helper's stylesheet injection and later
state renders. For an app-selected dark palette even while the system prefers
light:

```css
#connection-slot {
  color-scheme: dark;
  --tc-bg: #171b2a;
  --tc-fg: #f3f4ff;
  --tc-muted: #b8bfd9;
  --tc-border: #596581;
  --tc-accent: #c4b5fd;
  --tc-accent-fg: #211942;
  --tc-accent-hover: #ddd6fe;
}
```

The roles cover the surface, title, muted text, borders, spinner/focus accent,
action text and action hover. Omit `--tc-accent-hover` to reuse an overridden
`--tc-accent` on hover. Without overrides the card retains its light and
system-dark defaults. The application owns theme choice: `color-scheme: dark`
alone does not activate a `prefers-color-scheme` media query. These hooks change
colors only; connection actions, accessibility and reduced motion are unchanged.

## Domain views you can import

- **List/detail with stable IDs:** the event notes page derives complete rows from one captured materialized event snapshot. Links select `#note=ID`; the detail is an inspector, while the editor owns separate local drafts per entity. Reordered snapshots do not overwrite textarea values.
- **Relational list/detail/catalog:** the SQL page derives inventory balances, transfer receipts and schema introspection from one captured view. It recomputes counts and detail text; incoming ALTER exposes current fields without publishing code. Missing tables/columns leave the last successful snapshot visible and explicitly **not current**.
- **Reviewed comparison/edit:** use `shared/ui/` list/detail, inspector and reviewed-edit examples for long domain content. Put previous/current/reviewed values beside one another. Submission captures the reviewed guard values; a new snapshot never silently edits the person's pending guard/draft.
- **View-state persistence:** `createViewStore({storage,applicationId,profileId,viewId})` stores independent drafts and original operation references. Wrap unavailable/quota-failing browser storage with an honest visible fallback; do not claim a volatile draft survives reload.

The first-app archive includes `shared/ui/patterns.mjs` and a complete, dependency-free
`shared/ui/showcase.html` / `shared/ui/showcase.mjs` example. Serve the extracted starter over
local HTTP and open `/shared/ui/showcase.html`; it uses synthetic training episodes to
show useful actions before long system context, named related links and reviewed
inline changes. It is a UI specimen, not a connected or persistent application.

```js
import {
  mountListDetail, mountInspector, mountComparison, mountInlineReview, mountViewState,
} from '../../shared/ui/patterns.mjs';
```

| Pattern | Interface | Behavior and application responsibility |
| --- | --- | --- |
| Searchable list/detail | `mountListDetail(container, { records, filters, renderDetail, routeKey?, searchLabel? })` | Records contain `id`, `title`, optional `subtitle`, `status` and `searchText`. Filters are `[value, label]` pairs. Search, filter and selected record are URL-addressable; Back and reload restore them. `setRecords(records)` accepts the next coherent query value; `close()` disposes listeners and the active detail. Filtering is over that authorized value, not a second backend query. |
| Inspector | `mountInspector(container, { onClose })` | `show(title, { focus })`, `content`, `hide()` and `close()` support a desktop side panel and narrow detail view. The list/detail composition provides Back to list and restores focus. A standalone inspector supplies its own navigation callback. |
| Compare | `mountComparison(container, { before, after, label? })` | Readable before/after text with explicit headings. Authored values are inserted as text. `close()` removes it. Adapt the presentation for domain fields or line-level code diffs. |
| Inline edit, review and undo | `mountInlineReview(container, { label, value, onSave, onUndo? })` | Keeps an editable draft, previews exact before/after values, saves only reviewed text and offers undo only with an injected callback. The callbacks receive `{ before, after }`; confirm local durable storage (the signed operation exists) before returning `{ confirmed: true, value }`. `observe(value)` handles live values without resolving operations. Failure or uncertainty locks the editor until explicit `reconcile(confirmedValue)`; it does not resubmit or pretend a failed write was cancelled. `close()` stops rendering, not a dispatched command. |
| Empty/loading/error | `mountViewState(container)` then `render({ phase, title, detail?, action? })` | `loading` exposes busy status, `error` exposes an alert, `empty` explains the next action, and `ready` hides the card. An optional action is `{ label, run }`; wire it to a real operation. `close()` removes the view. |
| Connection | `mountConnectionView(container)` from `connect-view.mjs` | Use the real connection state and action. The specimen renders the same component; [the connection route](#connect-the-browser) stays authoritative. |

`renderDetail(record, container)` can return **`{ update(record), close() }`**.
The detail stays mounted while the selected ID is unchanged; fresh coherent
snapshots call `update`, including when their objects have new identities.
Selection changes, record removal and `close()` dispose that detail once. A
renderer returning only a cleanup function (or nothing) still remounts for a
replacement object so a static detail cannot silently show stale data.

A stateful detail updates its display and observes its edited value separately:

```js
function renderSummaryDetail(record, container) {
  const summary = document.createElement('p');
  summary.textContent = record.summary; container.append(summary);
  const editor = mountInlineReview(container, {
    label: 'Summary', value: record.summary,
    // Application handlers capture guards/revision and the original operation ID.
    onSave: change => saveSummary(record.id, change),
    onUndo: change => saveSummary(record.id, change),
  });
  return {
    update(next) {
      record = next;
      summary.textContent = next.summary;
      editor.observe(next.summary);
    },
    close() { editor.close(); },
  };
}
// Pass renderDetail: renderSummaryDetail when mounting the list/detail.
```

`observe(value)` accepts the edited field from the same coherent live view.
Unchanged values preserve draft, confirmation and Undo. A changed value refreshes
a pristine editor; with a draft or saved Undo it keeps that local work, disables
stale Save/Undo, and asks for an explicit review against the latest value or
Discard draft. A background refresh never steals focus or dispatches a command.
The application's command must still guard the exact reviewed baseline.

During a save, observation records the latest value without settling the pending
operation. A matching snapshot can arrive before or after its accepted callback.
A differing concurrent value remains visible as a conflict. A failed or uncertain
callback stays locked even when a later snapshot matches the draft: inspect the
original operation, then deliberately call `reconcile(confirmedValue)`. That
method clears draft/review/Undo; it is not a live-refresh method.

Keep retained drafts and uncertain operation references in the app's existing
draft/submission controller when navigation closes a detail. Closing a renderer
does not cancel a dispatched command. Give independent list/detail instances
distinct `routeKey` values; the helper preserves unrelated URL parameters.

### Compose a map or another companion view

These helpers are application-owned source, not a general component framework.
For a map/list application, adapt the existing `mountListDetail` render path:
compute `route` and filtered `visible` records once, then pass those same values
to the companion. For example, add this call after the existing list rendering:

```js
// paintMap is this application's view adapter, not a Tendriller API.
paintMap(visible, {
  selectedId: route.id,
  onSelect: id => navigate({ item: id }, false, true),
});
```

Keep `locationState()` and `navigate()` as that adapted helper's single route
owner. Its initial render, search/filter changes, `popstate` and `setRecords()`
then update both views without reading private DOM nodes, another backend query
or a second synchronized selection store. The companion must not change route
state while merely rendering it. An application with its own list/router can
instead compose the lower-level `mountInspector`. The shared helper does not
need map-specific options, a state subscription API or another router.

A connected app feeds one declared query through `createLiveView`, adapts those
records for the list, and injects existing command handlers into the editor. Capture
the coherent revision and original operation ID before dispatch. Save and undo
must both use guarded domain commands; an undo is new reviewed work, not deletion
of a journal event. Use the operation/submission helpers below for uncertainty and
recovery. Application content never becomes `innerHTML` in these components.

### Desktop: search, inspector and reviewed comparison

Use keyed entity nodes and explicit selected IDs, not arrival indexes. Reconcile text/rows and order from each snapshot; preserve the active node, focus and scroll. Keep the draft editor separate from inspector rendering. Display changed/retracted outcomes and provenance in the operation inspector rather than incrementing counters from event arrivals.

### Phone: a focused detail with a route back

At 320px use a 16px side gutter with no page horizontal scroll. Stable-ID fragments/deep links and Back must preserve draft state. Keep labels, keyboard focus, long text and cancel/save actions reachable. Hiding an optional agent/media panel must not hide ordinary domain editing.

### Empty, loading, error and connection states

Keep draft fields editable during opening. Enable durable Save when `status.canAuthor` confirms local signing/storage prerequisites, even with zero peers or SQL still materializing. A query error is a view error, not loss of the local intent or a reason to block unrelated offline submissions. Display loading, never-initialized schema, empty domain and stale-last-snapshot states distinctly.

## Durable agent requests and worker presence

For work an agent must consume, use the executable
[request, receipt, answer and worker-presence pattern](AGENT_REQUESTS.md). It retains
full operation references, author timestamps, durable receipts and answers.
Ephemeral presence belongs to the actual handler's lifetime and implemented topics;
optional durable startup/stop checkpoints remain separate. Match the intended
consumer/topic as well as peer identity when several workers share a signer.

Show stored/materialized operation state separately from seen/answered work, and keep
stopped/stale worker status visible. Verify that stopping only the worker removes
its availability while the native participant stays connected. After a release or owner
replacement, follow the [consumer restart checklist](AGENT_RESTART.md). If the
existing conversation must receive requests while working or after its turn
ends, additionally qualify the actual host through
[same-conversation delivery](CONVERSATION_DELIVERY.md). For Codex this includes
injection into the active turn as well as idle wake; deferred queue admission
alone does not satisfy the active case.

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

### Keep every action control reactive

Use `createSubmissionState(onChange)` for every write control, including cards
and a persistent detail editor. Eligibility changes when an operation finishes
even if no new data snapshot arrives. Keep record rendering subscribed to the
live view and eligibility subscribed to submission state. Adapt the starter's
existing submission instance and callback with this small multi-control pattern;
do not add a second coordinator alongside it:

```js
// submission-controls-example
import { createSubmissionState } from '../../shared/helpers/submission-state.mjs';

export function createWriteControls(root) {
  const eligibility = { submit: 'canSubmit', retry: 'canRetry' };
  function render(state) {
    for (const button of root.querySelectorAll('[data-write-action]')) {
      button.disabled = !state[eligibility[button.dataset.writeAction]]
        || button.dataset.domainBlocked === 'true';
      button.setAttribute('aria-busy', String(state.working));
    }
    const status = root.querySelector('[data-submission-status]');
    if (status) status.textContent = state.message;
  }
  const submission = createSubmissionState(render);
  const sync = () => render(submission.snapshot);
  sync();
  return { submission, sync };
}
```

For example, both a card's **Save** and the detail editor's **Save** use
`data-write-action="submit"`; retained-operation buttons use `retry` (exact original signed bytes, never a new operation).
Keep a domain-invalid or unauthorized control blocked with
`data-domain-blocked="true"`, and preserve domain checks in its handler too.
After inserting a new card or changing its domain eligibility, call `sync()` to
initialize it from the current snapshot. The callback only updates disabled/busy
state and status text; it does not replace cards, inputs, focus or selection. Use
the [preserved editor lifecycle](#domain-views-you-can-import) for data renders.

Keep the starter's existing local-readiness and operation updates wired to this same
`submission` instance: `submission.update({ attached: true })` once the session is
attached, `submission.application(session.status)` from `session.onStatus` (it sets
`keyReady` from `canAuthor` and `storageReady` from the phase), and
`submission.update({ selected, pending, observed })` from the operation observer. A
view read error is a view error, not a submission gate: `canSubmit` never depends on
peers, a current read or finality. Continue to acquire `release = submission.begin()`
inside the handler's `try` (it throws the current `message` when Save is not
available), retain the signed-operation reference, await local durable storage, and
finish the view refresh before calling `release?.()` exactly once in `finally`. That
final callback re-enables all eligible controls without another query or data
notification. `canRetry` is true only for a selected operation that the journal
actually stored (or that this page saved), and never for an excluded one. Disconnection
does not block **Save**: with no peer reachable, the signed attempt is stored locally
and materialized locally at once; peers receive it when the agent program or another
peer returns, so never gate Save on retention. Retry of an uncertain operation stays
available for its exact retained original.

Do not move release ahead of refresh to force a data render. The current release
closure is not an operation token: an early call followed by a second call in
`finally` can clear another submission's working state. On errors preserve the
original operation; finishing this UI lifecycle does not cancel, retry or declare
the command accepted. Materialized outcomes remain revisable.

`shared/helpers/submission-state.mjs` deliberately has no peer, current-global-read or finalizer gate. Use `shared/cli-lifetime.mjs`/owned signals for optional native process cleanup. Detaching a view cancels observation, not the durable proposal.

## 4. Ordinary schema and permission edits

The SQL starter's `initialize`, `addLabels`, and `grantBinWrites` commands submit the same canonical programs as data edits. Authorized DDL/DML/platform grants share author-time replay and atomic rollback. There is no static schema digest, special initialization channel or mandatory code publication.

A late earlier DDL transaction can revise an already displayed SQL outcome. Do not dependency-sort DDL ahead of author time. Query the current catalog from each captured snapshot and adapt the next form/query. Existing column grants and approved tool schemas do not silently expand when columns appear. Keep creation-namespace/object ALTER/DROP/index/trigger permissions distinct from ordinary data writing and finalizer rights.

## 5. Optional finality, providers and reviewed media

`shared/helpers/finality-view.mjs` exposes an explicit local browser provider action, not an automatic write gate. Warn before closing author time: unseen genuine offline work behind the frontier may be excluded. Fixed-validator quorums require actual votes. Configuration alone is not qualified provider availability.

Camera/file preview and analysis are separate stages. Keep explicit consent before sharing content with a named inference provider, permit cancellation, and let the person edit suggestions before a declared domain command. Missing agents disable only their tools/analysis. Session signals are disposable previews/progress; they do not persist domain state or establish exclusivity. Provisional claims are not authority for irreversible effects. See [reviewed input](AI_INPUT.md), [sensors](SENSORS.md), [signals](APPLICATION_SIGNALS.md), and optional `shared/ui/`/`shared/media/` modules.

## Full-duplex dashboards and data feeds

For dashboards where an agent runs on a cloud server or home server and the user
opens the page on a phone, tablet or laptop, compose `shared/ui/dashboard.mjs`,
`shared/helpers/data-feed.mjs`, `shared/ui/chat-session.mjs`, and `shared/helpers/dev-telemetry.mjs`:

```js
// Agent program (secrets & local API access stay strictly native; optional for ordinary browser Save):
import { serveDataFeeds } from '../../shared/helpers/data-feed.mjs';
const feeds = serveDataFeeds(session, {
  cpu: { pollMs: 5_000, fetch: async () => readHostMetrics() },
  orders: { maxAgeMs: 10_000, fetch: async (query) => fetchPrivateApi(query) },
});

// Browser page:
import { useDataFeed } from '../../shared/helpers/data-feed.mjs';
import { mountDashboardShell, mountMetricCard, mountFeedbackCard } from '../../shared/ui/dashboard.mjs';
import { mountDevTelemetry } from '../../shared/helpers/dev-telemetry.mjs';

const shell = mountDashboardShell(document.querySelector('#app'), {
  title: 'Home Server', session,
  onRefresh: () => cpuFeed.refresh(),
});
const cpuCard = mountMetricCard(shell.grid, {
  title: 'CPU Load', unit: '%',
  onAskAgent: ({ title, latest }) => { chat.setContext({ label: title, data: latest }); chat.open(); },
});
const cpuFeed = useDataFeed(session, {
  peer: configuration.nativeDeviceId, feed: 'cpu',
  onUpdate: state => state.data && cpuCard.update({ value: state.data.pct, fetchedAtMs: state.fetchedAtMs }),
});
const telemetry = mountDevTelemetry({ session, runtime: window.tendril });
```

`serveDataFeeds` polls only while a peer is connected, skips unchanged snapshots,
caches in RAM, broadcasts deltas over `session.signals` (`feed/<name>`), and serves
on-demand or large (>10 KiB, up to 4 MiB) pulls via `shared/helpers/signal-request.mjs`—all
with **zero durable Chronolog writes**. Reserve Chronolog commands for durable user
decisions, chat turns, and retained observations.

These are optional presentation/live-signal consumers, not a second persistence framework. Bind them to current coherent snapshots and explicitly approved agent scopes. No agent program is necessary for independent browser authoring.
