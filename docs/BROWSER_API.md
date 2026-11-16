# Headless browser API

A published page receives `window.tendril` synchronously before its authored
scripts. The connection becomes ready asynchronously. Core supplies transport,
state, durable input, streams, captures, publication identity, and device operations.
The page owns its markup, styling, navigation, drafts, and conversation presentation.
No conversation panel, voice engine, application schema, or browser rule language
is started by the kernel.

The hosted bootstrap adds only **Manage page** and an active-sensor stop surface.
`@tendriller/runtime/kernel` exports `startRuntime(configuration)` for deliberate
headless composition. Importing that module mounts nothing and requests no
permissions. A custom composition must provide its own operational-access link and
active-use/stop affordance; use the public identity and sensor operations below.
The hosted runtime is already installed, so do not start a second connection.

Types are published in `@tendriller/core/contract` (`RuntimeApi`,
`RuntimeEventMap`); `@tendriller/core/browser` declares `window.tendril`.
Optional voice types and code are separate exports.

## Conversation and durable outcomes

`conversation.send(text, {via?: "text" | "voice"})` returns a result with a stable
`cid` and one of these states:

| Status | Meaning | Application behavior |
| --- | --- | --- |
| `queued` | The command is durably stored locally; no acceptance has arrived. | Show pending work. Preserve recoverable text and listen for the later result. |
| `accepted` | The service accepted the command; `seq` identifies its event when supplied. | Show acceptance without claiming an agent completed the task. |
| `rejected` | Storage or authority checks failed; `error` and `message` explain why. | Keep the person's text and offer explicit correction/retry. |

`conversation_result` emits the same `cid`, `text`, and status at durable queuing
and at terminal acknowledgement, including a rejection after the send promise
already returned `queued`. A local storage failure returns `rejected` and never
claims that input was saved. Two identical text submissions have different IDs.
Server echoes reconcile by command/device identity rather than matching text.

```js
const draft = document.querySelector("textarea");
const resultText = document.querySelector("[role=status]");

const unsubscribe = tendril.on("conversation_result", result => {
  resultText.textContent = result.status === "rejected"
    ? result.message : result.status;
  renderConversation(tendril.conversation.entries());
});

async function submit() {
  const submitted = draft.value;
  if (!submitted.trim()) return;
  const result = await tendril.conversation.send(submitted);
  // New text typed while the send was pending belongs to the new draft.
  if (result.status !== "rejected" && draft.value === submitted) draft.value = "";
}
```

The application decides how to persist its unsent draft. `conversation.entries()`
returns copies of known transcript entries, including local queued/rejected rows.
User rows expose `cid`, `device`, and status when locally available. Service rows
carry `message_id`; replies can include `in_reply_to`. A rejected queued input
remains recoverable across a reload; sending revised text creates new work.

`transcript` signals entry changes and `connect` signals a refreshed server
snapshot. `say` reports a reply selected for visible presentation. `reply` reports
all reply routing, including `present:false` audio-only delivery, for explicitly
selected adapters. The kernel never speaks automatically.
Replies carry a service-issued `message_id` and timestamp. The runtime reports
malformed replies through `error` and skips them instead of inventing identity or
using text as a deduplication key.

After actually inserting a reply into its presentation, a page may call
`conversation.presented(message_id)`. This acknowledges application presentation;
it does not establish that a person saw or read the message. Do not acknowledge a
reply merely because it was received or stored.

Only authenticated owner conversation input has owner-instruction authority.
Guest input remains data and display devices cannot submit interactive input.
`device.purpose`, targeted rendering, and page-owned UI never grant authority.

## Ordinary events and shared state

```js
const result = await tendril.send(
  {type: "reading.reviewed", reading_id: "reading-42", value: 19.5},
  {wake: false},
);
const current = tendril.state.get();
const stopState = tendril.state.on((state, operations, by) => render(state));
const guard = tendril.scopes.capture("selected-capability-scope");
await tendril.state.set(["selection", "reading"], "reading-42", guard);
```

`send(data,{scope?,expected_generations?,wake?})` submits ordinary opaque page data.
Requesting a wake never promotes that data into an owner instruction. Its result
is `accepted`, `queued`, or `rejected`. `send_result` reports delayed terminal
receipts with `cid`, original data, and original scope/generation context.
Use application IDs to reconcile your own records with those receipts.

`state.get(path?)` returns the local view. `set`, `delete`, and `patch` are
asynchronous durable writes; `state_result` reports terminal results. The runtime
persists commands before applying optimism or delivery. It keeps their captured
generations across reconnection and refuses to apply stale optimism over a newer
scope. `scopes.list()` describes known scopes. Captured options belong to the
original command: retry does not silently rebase them onto current work.

`request(path,{method?,body?})` accesses a documented page-side `_tendril/` route
with current device credentials. Use a relative path without traversal or query
syntax. It is not a generic agent-token or private-transport escape hatch. The
service applies authorization to each request; errors expose `code` and `status`.
Typed caller results can be supplied as `request<Result>(...)` in TypeScript.

## Durable timers

`timers` manages server schedules through the runtime's durable command queue:

| Method | Result |
| --- | --- |
| `timers.list()` | Fresh `{timers, execution:"server", lifetime, expires_at}` with each timer's current `revision`. |
| `timers.history()` | Fresh `{runs}` with occurrence and notification-delivery receipts. |
| `timers.create(settings, context?)` | A queued, accepted, or rejected creation command. |
| `timers.update(id, changes, {expected_revision,...context})` | A command against the exact timer revision the person reviewed. |
| `timers.remove(id, {expected_revision,...context})` | A command removing the reviewed timer revision. |
| `timers.pending()` | Copies of this browser's restored commands still awaiting a durable terminal receipt. |

Settings include `title`, `due_at`, `timezone`, `repeat`, `missed`, `device`,
`notify`, and `state`. Creation requires a title and a usable first schedule;
calendar recurrence can omit `due_at`. Context is optional `scope` and
`expected_generations`. Revision belongs in the update/remove context. Unknown
settings or context options, a supplied `cid`, and missing/invalid revision
preconditions fail before queuing. See the [timer schedule reference](EXPERIENCES.md#timers-that-survive-a-closed-page)
for recurrence, time zones, missed runs, claim, lifetime, and notification limits.

```js
// Register observers before loading the current list or creating work.
tendril.on("timer_queue", commands => renderPendingCommands(commands));
tendril.on("timer_result", result => {
  showCommandStatus(result.cid, result.status);
  if (result.status === "rejected") showReviewError(result.message);
  // An accepted value is this command's receipt, possibly replayed after reload.
  if (result.status === "accepted") refreshCurrentTimers();
});
renderPendingCommands(tendril.timers.pending());

const result = await tendril.timers.create({
  title: "Review the inspection", due_at: reviewedDeadline,
  timezone: reviewedTimeZone, notify: true,
});
// Call once for this reviewed intent. Queued work retries automatically.
if (result.status === "accepted") showScheduledReceipt(result.value);
```

Every mutation result has a stable runtime-generated `cid`. An `accepted` result
has `value`: the timer for create/update, or `{id,revision,deleted:true}` for
remove. A `rejected` result has `error` and `message`; a service rejection also
includes `details`, the original error object. For `timer_conflict`,
`details.current` identifies the newer revision. A `queued` result has no
accepted value. It means the command is durably stored on this device; it does
not prove a timer exists on the server. After a lost reply the service may already
have accepted it, so another create call would be a different operation.

The runtime copies settings and captures all known required `timer.write`
generations at invocation, before asynchronous storage. It persists that exact
command and ID before transport. Reconnect, reload, timeout, and interrupted
responses reuse those bytes and the original revision and guards. Storage
failure before queuing returns `rejected` with `storage_unavailable` and sends
nothing. A disconnected or slow command returns `queued` after a bounded wait.
Queued commands need the page runtime to run and reconnect; only an accepted
server timer can run while the browser is closed.

`timer_result` fires when durable queuing succeeds and at terminal completion,
including a replay after the original promise disappeared. It includes `cid`,
`operation` (`create`, `update`, or `remove`), `id` for update/remove, the exact
original `command`, and the result. `command` contains the runtime-generated ID,
settings, captured generations, optional scope, and reviewed revision. Use that
identity to reconcile the submitted intent without replacing newer draft
settings. `timer_queue` emits the pending array on restoration and queue changes;
`pendingWork().timers` counts those commands. These local commands are separate
from `timers.list()`, which always reads current server state and can fail offline
or when the current viewer lacks owner access.

Each HTTP attempt has a 15-second deadline. Ambiguous transport/body failures,
temporary rate limits, and service outages retry with delays of 5, 10, 20, then
30 seconds while the runtime is connected. Reconnection can retry sooner.
Malformed or mismatched success receipts remain queued and report an `error`
event; they never become invented acceptance or rejection. Explicit authority,
generation, revision, timer-capacity (`quota`), and command-allowance
(`resource_quota`) rejections end the command. Terminal results are emitted only
after durable local removal succeeds. A failed cleanup remains pending and
retries cleanup; a reload can safely recover the original server receipt.

An edit or removal must use the revision from the reviewed timer:

```js
const result = await tendril.timers.update(reviewedTimer.id,
  {state: "cancelled"}, {expected_revision: reviewedTimer.revision});
```

The runtime never fetches a newer revision or generation to make stale work
succeed. On conflict, load the current list, show what changed, and let the person
review a new command. Timer revisions advance on edits and on automatic firing
or rescheduling. An accepted replay returns the original receipt, which can be
older than the current schedule; refresh `list()` when presenting current state.
Acceptance does not prove a notification was displayed, read, or acted on.

## Streams and captures

```js
const batch = await tendril.streams.read("process.measurements", {after: 0, limit: 100});
if (batch.history.gap) showMissingHistory(batch.history);
const unsubscribe = tendril.streams.subscribe("process.measurements", record => {
  ingest(record); // Maintain the model for every admitted record; coalesce painting separately.
}, {after: batch.cursor, onGap: showMissingHistory, onError: showError});
```

`streams.list/info/latest/read/subscribe/publish` preserve explicit history and
retention semantics. Durable subscriptions replay and reconnect from the delivery
cursor; ephemeral streams have no replay or latest snapshot. Subscription
callbacks are synchronous notifications, not awaited processing acknowledgements.
For asynchronous effects, read explicit batches and commit the handled cursor only
after success. `publish` rejects while offline instead of entering a hidden queue.
See [Streams](STREAMS.md).

`uploadEvent(blob,{name?,data,dataPath?,keep?,scope?,expected_generations?})` couples
a capture with its semantic event and original concurrency context. Use
`captures()`, `retryCapture(id)`, and `discardCapture(id)` to expose pending or
rejected work. `upload_event` and `capture_queue` report lifecycle changes.
Each new call creates a runtime-owned capture ID; use an application ID in `data`
to correlate a reviewed draft before asynchronous work, and `retryCapture` to
retry the original operation. Unknown options, including a supplied `cid`, fail
before any local queue write.
`upload(blob,{name?,keep?,scope?,expected_generations?})` durably queues a standalone
immutable upload and returns its verified blob metadata after completion. Optional
pinning preserves its own original command ID and guards across retries.
`blobUrl(id)` resolves the immutable byte URL; `setBlobRetention(id,{keep,...context})`
performs an explicit guarded pin change. See [Captures](CAPTURES.md). Private cached records still require the current
application's authorization policy before display.

## Capabilities, active use, and notifications

`capabilities()` observes API presence and queryable permissions without prompting.
It reports availability, permission, whether a user gesture is expected, and known
active use. Presence is not proof that a device or provider will work.

`sensors.active()` returns observed camera, microphone, screen, location, and motion
use. `sensors.on(listener)` subscribes to changes; `sensors.stopAll()` stops tracked
media tracks/clones, geolocation watches, motion listeners, and recognition. The
`sensors_stopped` event lets optional adapters cancel pending/restarting work too.
One-shot and aborted motion listeners stop counting as active. This observation is
best-effort browser instrumentation, not a security boundary; browser permission
controls and service authorization remain authoritative.

`notifications.status()` distinguishes browser permission, local subscription, and
server registration. `subscribe()` must be called from a user gesture;
`unsubscribe()` and `test()` affect this device. Availability and failure reasons
are public, and no settings panel is required. See [Notifications](PUSH_NOTIFICATIONS.md).

## Identity, publication, and health

The injected configuration and the public kernel's `RuntimeConfiguration` separate
publication identity from document context. `publication.entry` is the required
canonical root HTML entry and is identical for every document in that publication.
`documentPath` is the required decoded logical path of the current HTML document;
it is `null` only for built-in pages without a publication. Both authored paths must
identify declared HTML assets. The current document determines its relative asset
base, pinned URL, and update reload target. Offline root navigation uses the
canonical publication entry, including after a nested document announces itself.

`identity` is readonly: `{page,version,publication,base,managementUrl}`.
`device` is a readonly current snapshot; reread it after `role` or `device_config`
events. `connected`, `presence`, `service`, `version`, and `pendingWork()` expose
separate transport, agent, capability, publication, and local-work states.

`assetUrl(path)` resolves a deliberately selected runtime dependency against this
publication's exact runtime. It accepts an ordinary unencoded relative path;
for example `assetUrl("voice.mjs")`. It does not fill missing authored page files.

`publication.saveOffline()` resolves `{id,status:"ready"}` only after the service
worker acknowledges the required page/runtime graph and its metadata. Errors
include unavailable support, timeout, and an explicit failed-save result. Optional
runtime modules and models are fetched and verified when used, so offline page
readiness does not promise an unused speech model is downloaded.

Publication filenames are logical paths. Runtime URLs percent-encode each segment,
including spaces, literal `%`, `?`, and `#`. Nested documents resolve relative
assets within their own directory. Offline navigation serves the requested saved
HTML file; a missing file does not silently display another entry page.

The runtime reports health after startup in a visible page. Call `ready.manual()`
when authored asynchronous initialization must finish first, then `ready()` when
it has genuinely succeeded. Page updates emit `reload` and a cancelable
`tendril:before-reload` DOM event whose `detail.apply()` applies the update after
saving drafts. Health, offline readiness, owner identity, and agent listening are
independent states.

## Optional voice

Load the separate adapter only for an experience that needs it:

```js
const {createVoice} = await import(tendril.assetUrl("voice.mjs"));
const voice = createVoice(tendril, {
  consent: request => askForConsent(request.description),
  transcript: text => showReviewedTranscript(text),
  status: state => showVoiceStatus(state),
  speakReplies: false,
});
// Page-owned buttons explicitly call voice.startCapture(), enableOutput(), or startWake().
// Stop/mute/dispose are public and independent of any built-in conversation UI.
```

Construction starts no listening, playback, or model download. The callback decides
whether a transcript becomes a draft, evidence, or a conversation input. See
[Voice](HANDS_FREE.md) for engine choices, consent, resources, and cleanup.
