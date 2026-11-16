# Devices, timers, saved context, and portable pages

Tendriller can hold a task across devices, browser closures, and agent sessions.
This guide covers the generic platform capabilities and their limits. Optional
application policies and interaction choices are explained in cookbooks in
[contrib](https://github.com/werg/tendriller-contrib). The engine has no workflow
module installed by default.
`A` means the private handle’s API base. Agent calls use its bearer token. Page
routes are relative to the page and use the existing signed-in page session and
same-origin checks. A page never needs an agent token.

## Device purpose and attention

Access roles remain `owner`, `guest`, and `display`. A device’s **purpose** is a
separate presentation preference: `general`, `camera`, `controller`, `display`,
or `speaker`. A camera-purpose guest is still a guest; changing a purpose never
grants owner access. Purposes persist through reconnects. Page-authored owner controls can rename devices, choose their purpose, and move focus through the public APIs.

| Operation | Agent API | Owner page API |
|---|---|---|
| Inspect devices and focus | `GET A/devices` | `GET _tendril/devices` |
| Rename or set purpose | `PATCH A/devices/<id>` with `{name?,purpose?}` | `PATCH _tendril/devices` with `{id,name?,purpose?}` |
| Read focus | `GET A/focus` | `GET _tendril/focus` |
| Move focus | `POST A/focus` | `POST _tendril/focus` |

Focus is `{device,expires_at}` or null. To set it, send
`{device:"d_…",ttl_seconds:900}`. The device must be a connected owner device;
the lease accepts 30–86400 seconds. `{device:null}` releases focus.
`device_config` messages update connected clients after changes.

`POST A/say` accepts optional `device` and `speak_on`. `device` selects the device
that presents a reply (`"all"` or an ID); it is **not a privacy boundary**. The
conversation transcript remains shared. `speak_on` is a device ID, `"primary"`,
or `"none"`. Without an explicit speaker, selection prefers active focus, an
owner device with speaker purpose, the originating device, then the primary
device. Only one socket speaks, even if the device has several tabs. An explicit
offline speaker does not silently redirect speech to another device.

The explicitly loaded voice adapter can use browser speech where supported. Neural speech is an optional preparation/download, enabled by the person. Muting and stopping speech
remain local choices; an agent cannot override them.

## Timers that survive a closed page

Timers live in the Tendril Durable Object, not in a browser `setTimeout` or device
rule. A server alarm records an occurrence and schedules the next one without an
open page. The owner must claim the page before scheduling. Use a resident page
for a task that must outlive the ad-hoc idle period; a timer does not keep an
expired page alive. A first occurrence beyond the current expiration is refused
with `lifetime_required`.

```json
{
  "cid": "review-measurements-1",
  "expected_generations": {},
  "title": "Review the latest measurements",
  "due_at": 1794810000000,
  "timezone": "Europe/Berlin",
  "repeat": { "every_minutes": 30 },
  "missed": "fire_once",
  "notify": true
}
```

| Operation | Endpoint |
|---|---|
| List and lifetime information | `GET A/timers` |
| Add | `POST A/timers` with settings, `cid`, `expected_generations`, and optional `scope` |
| Change or cancel | `PATCH A/timers/<id>` with changes, `expected_revision`, and command metadata; cancellation sets `state:"cancelled"` |
| Remove | `DELETE A/timers/<id>` with `expected_revision` and command metadata in the JSON body |
| Execution history | `GET A/timers/history` |

The owner page has the same operations under `_tendril/timers`; it authors its own creation, cancellation and history controls. At most 32 timers can be stored.

### Reviewed changes and safe retries

Every timer includes a `revision`, starting at 1. An accepted edit increments it;
an alarm also increments it when it advances a recurring schedule or completes a
one-shot timer. Read the timer and retain that revision with the decision being
reviewed. To cancel the revision the person saw, send:

```json
{
  "cid": "cancel-reviewed-timer-1",
  "expected_generations": {},
  "expected_revision": 1,
  "state": "cancelled"
}
```

A different current revision returns `409 timer_conflict` with `error.current`.
The timer and its pending notifications remain unchanged. Refresh the display,
explain what changed, and compose a new command after reviewing the new state.
The service never silently upgrades an old revision or interprets cancellation
as permission to cancel a later schedule.

Use the same `cid`, payload, reviewed revision, and captured generations when a
response is lost. Creation retries return the same assigned timer ID; updates
and deletion replay their accepted results without applying again. Creation and
updates return the complete timer. Deletion returns
`{id,revision,deleted:true}`, with the revision advanced once. A new deletion
command for a missing timer returns `404`; the accepted deletion's exact retry
still succeeds. Changing an accepted command's content, target, or operation
under its ID returns `409 command_conflict`.

A recovered receipt is the original operation's result, even if the timer has
since fired, changed, or disappeared. Refresh `GET A/timers` before presenting
that receipt as current schedule status. Command identities are scoped by the
authenticated agent or owner account; another device signed in as the same owner
can recover the same command.

Scopes can bind the `timer.write` operation. Supply all required original tokens
in `expected_generations`; include `scope` when the command belongs to a selected
workflow scope. Missing guards return `428 generation_required`, and changed or
retired scopes return `409 stale_generation`. An already accepted retry still
returns its receipt after rotation. Empty `{}` in these examples is appropriate
only when no bound or selected scope requires a guard. See
[scope rules](PROTOCOL.md#authoritative-scopes-and-generations).

### Recurrence, execution, and notification

Omit `repeat` for a one-shot timer. Use `{every_minutes:N}` for an interval or
`{at:"09:00",days:[1,2,3,4,5]}` for a calendar recurrence in the supplied IANA time
zone (0 is Sunday). For a calendar timer, omitting `due_at` computes the next
occurrence. Nonexistent spring DST times are skipped; repeated autumn wall times
run at their first occurrence, once on that date. An explicitly supplied first
time takes precedence; the calendar rule determines later runs.

`missed:"fire_once"` coalesces missed repeats into one run and advances to the
next future occurrence. `missed:"skip"` records an occurrence as skipped when it
is more than two minutes late. Timers pause while service writes are paused and
do not run for held/suspended/deleting accounts. Restarting a completed occurrence
requires a new first-run time.

Each fired occurrence atomically stores its event, unique run ID, next schedule,
new timer revision, and notification intent when requested. Repeating an alarm does not enqueue that occurrence twice. The event is
page data with `data.type:"timer"`, timer ID, run ID, scheduled/fired timestamps,
and timezone. Normal wake budgets apply. The agent must deduplicate any external
side effect by run ID; recording an event is not an exactly-once guarantee for a
separate service. Optional notifications use existing subscriptions and permission.
Their durable outbox recovers interrupted attempts, retries transient failures
with bounded backoff, and remembers successful devices. History includes delivery
state, attempts, retry time, and last error. Editing or removing a timer cancels
its pending notification retries. Provider acceptance is at least once and cannot
prove that a person saw a notification; failure never erases the event. See
[Unattended work](DURABILITY.md) for exact retry limits, gates, and receipts.

## Resume a task with explicit context

`PUT A/session` stores a compact brief:

```json
{
  "purpose": "Observe changes in the garden",
  "current_task": "Compare the last two leaf photographs",
  "completed": ["Photographed the north bed"],
  "decisions": ["Return to the same viewpoint"],
  "open_questions": ["Has the pale patch expanded?"],
  "last_handled_seq": 12
}
```

`GET A/session` returns the brief and its `revision` plus current version, pending input count,
available-history gap information, devices, timers, recent activity, and whether
a bundle is staged. The owner page uses `_tendril/session` and may offer an editor or continuation prompt without including credentials. Supply `expected_revision` on PUT to reject
stale edits. An authored editor should preserve agent checkpoints and decisions when editing other fields, and ask for review if the same field changed concurrently.

The brief is a checkpoint, not a replacement for the event log. Write its cursor
only after actually handling those events; updating it does not advance the
agent’s event-read cursor. History retains its existing bounds. When a gap is
reported, use the saved context and ask for any missing evidence instead of
claiming that expired inputs were processed. A new agent still needs a private
handle through the service-owned recovery page and an active host receiver.

An unattended worker can additionally use a named [event consumer](DURABILITY.md#named-event-consumers)
for a server-stored handled checkpoint and leased failover. Reading does not
acknowledge handling. Same-name workers share one checkpoint; different names
are independent subscriptions. The brief, transport-read position, and consumer checkpoint are independent
records with distinct purposes.

## Portable bundles and independent remixes

`GET A/bundle` returns the served page's complete file graph, declared HTML
entry, and purpose. `?include_data=true` also includes shared state, the session
brief, active shared-file heads, and selected immutable media. The exporter captures
these logical records before reading bytes. Publication-only handles are excluded
from media unless state or an active shared file explicitly refers to them, so
copying a page repeatedly does not accumulate duplicate code as application media.

A template without data starts from the page's code defaults. Credentials, account
sessions, device identities, timers, scope bindings/generations, workflow records,
consumers, delivery jobs, and shared-file revision history are never imported.
Anything deliberately embedded in authored page bytes remains file content;
inspect those files before sharing a template.

The sole bundle format is `format:"tendriller-bundle", version:3`. It requires the
actual HTML `entry`, a name, a complete `files` array with MIME types and base64
bytes, and a `media` array. Optional `state`, `session`, and
`shared_files:[{path,blob_id,name?,type?}]` carry application data. Every shared-file
reference must name media included in that bundle. No historical format is accepted.
Restoration allocates new immutable IDs and rewrites their references in authored
text files and state keys/values. It copies current heads, creating new destination
revision records, rather than replaying the source file history.

Validation rejects unsafe, noncanonical or ill-formed Unicode paths, duplicate
paths/IDs, missing or non-HTML entries, invalid shared-file references, and exceeded
file/state/storage limits before writing bytes. The complete encoded transfer is
bounded to 36 MiB, even when many logical names share one physical object. Export
and publication check both byte length and digest. Staged references retain their
prepared media while the copy is being reviewed.

Restoring is explicitly staged:

1. `PUT A/bundle` validates and prepares the copy. Its response gives file/media
   counts and `expected_head_revision`, captured before asynchronous preparation.
   Destination shared-file revisions are captured at the same stage boundary.
2. Review the copy and current scope generations. `POST A/bundle/publish` accepts
   `{cid,expected_generations,expected_head_revision:N}` with optional `scope`.
   It guards the `publications` namespace and both `publication.publish` and
   `bundle.publish` operations. Imported shared files additionally require
   `file.write` and their `files` path guards; included state requires its normal
   state-path guards. Publication, imported heads, state/context, and the command
   receipt commit in one transaction. A concurrent destination-file edit rejects
   the entire import without partially replacing the page or state.
3. Retry a lost acknowledgement using that exact original command. The monotonic
   head revision detects a rollback that returns to the same version number.
   An accepted retry returns its original `{version,head_revision,restored:true}`
   receipt. A conflict requires another deliberate review; never substitute a
   fresh guard automatically. Connected clients receive restored state before reload.
4. `DELETE A/bundle` discards prepared assets that no live reference uses. Only one
   stage/publish/discard operation runs at a time.

An owner page can offer the same operations through its authenticated page APIs. Publishing the first version still
requires an active agent socket, held poll, or configured receiver. Preparing a
copy does not bypass that gate. Earlier page versions remain available, but their
history does not roll back shared state; export current data before replacing it
if it is important.

`POST A/remix` accepts `{owner,name?,include_data?}` and creates a new independent
tendril with a new private handle and a staged bundle. Its response explains how
to connect the receiver and publish. The owner page’s `POST _tendril/remix` uses
the signed-in owner and returns only the copy’s page link and setup instructions.
Open that link, claim it, then connect its agent. The original is untouched.

## Protected application state

Applications register explicit scopes through the generic scope API. Each scope
has a server-owned generation, state-path bindings, and operation bindings.
A write to an ancestor or to the whole document overlaps any protected
descendants. The server derives required scopes from those bindings for every
writer, including HTTP, MCP, browser commands, trusted workflow operations, and
bundle publication.

Capture the generation map when an operation is composed. Keep it with its
command ID and payload through asynchronous work, offline storage, retries, and
reconnects. A rejected generation means the meaning of that work changed; review
the original draft before intentionally creating a new command. Changing a field
in application JSON does not register, rotate, retire, or satisfy a scope.

`GET A/service` and `GET P_tendril/service` report installed workflow interfaces,
core contract/release, resource policies, and effective page limits. The WebSocket
welcome carries the same descriptor. Tools check their requirements before they
write. The public deployment descriptor at `/api/service` reports installation
capabilities without page-specific allowances.

Each page permits 128 active scopes and 4,096 lifetime scope bindings, including
retired bindings. Accepted command receipts are retained without time-based
eviction, up to 20,000 receipts or 32 MiB of serialized receipt content. These
limits are defined in the public resource policy and exposed by the descriptor.
The server checks usage in the mutation transaction. At `resource_quota`, a new
mutation rolls back completely while exact retries of accepted commands still
return their saved results. Export the work and continue on a fresh page when a
lifetime allowance is exhausted. Reusing an existing retired scope ID requires
explicit registration and produces a new generation.

## Publication identity and retained assets

Each publication records its complete file graph and runtime artifact. Relative
assets resolve inside that immutable publication, including lazy modules loaded
after another version is published. Current navigation selects the current
publication; an existing tab retains its original graph until it accepts an
update. A manifest lists file hashes, media types, sizes, and the runtime lock.

Pruning preserves recent/current publications, active sockets, and unexpired
offline leases. Content storage serializes writes and deletion per hash. A
transaction reserves deletion only after checking durable references; publication
and staging transactions accept ready content only. A concurrent cleanup cannot
commit a publication pointing at bytes being removed.

The service worker caches complete verified graphs for offline use. Browser
storage remains subject to device policy and eviction. See [protocol](PROTOCOL.md)
for publication and concurrency contracts, [captures](CAPTURES.md) for durable
media, and [durability](DURABILITY.md) for timer delivery and processing leases.

## Verification

Core tests cover authenticated roles, device focus, timer recurrence and delivery,
saved context revisions, scope admission across all writers, atomic bundle
publication, immutable asset graphs, and independent remixes. Cookbook checks own application-specific reference scenarios and page adaptations. They consume exact public core artifacts through the documented engine/host interface.
See [E2E testing](E2E_TESTING.md) for the corresponding gates and fixture limits.
