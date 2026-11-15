# Devices, timers, saved context, and portable pages

Tendriller can hold a task across devices, browser closures, and agent sessions.
This guide covers the generic platform capabilities and their limits. Optional
application workflows, components, and recipes are documented in
[contrib](https://github.com/werg/tendriller-contrib). The engine has no workflow
module installed by default.
`A` means the private handle’s API base. Agent calls use its bearer token. Page
routes are relative to the page and use the existing signed-in page session and
same-origin checks. A page never needs an agent token.

## Device purpose and attention

Access roles remain `owner`, `guest`, and `display`. A device’s **purpose** is a
separate presentation preference: `general`, `camera`, `controller`, `display`,
or `speaker`. A camera-purpose guest is still a guest; changing a purpose never
grants owner access. Purposes persist through reconnects. The owner can rename
devices, choose their purpose, and select **Continue here** in the control.

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

Browser speech is immediately available where supported. Neural speech is an
optional preparation/download, enabled by the person. Muting and stopping speech
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
| Add | `POST A/timers` |
| Change or cancel | `PATCH A/timers/<id>`; cancel with `{state:"cancelled"}` |
| Remove | `DELETE A/timers/<id>` |
| Execution history | `GET A/timers/history` |

The owner page has the same operations under `_tendril/timers`. Settings exposes
creation, cancellation, removal, and recent runs. At most 32 timers can be stored.

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
and notification intent when requested. Repeating an alarm does not enqueue that occurrence twice. The event is
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
a bundle is staged. The owner page uses `_tendril/session`. Settings can edit the brief and copy a continuation
prompt without including credentials. Supply `expected_revision` on PUT to reject
stale edits. The owner form preserves the latest agent checkpoint/decisions when
editing other fields and asks for review if the same field changed concurrently.

The brief is a checkpoint, not a replacement for the event log. Write its cursor
only after actually handling those events; updating it does not advance the
agent’s event-read cursor. History retains its existing bounds. When a gap is
reported, use the saved context and ask for any missing evidence instead of
claiming that expired inputs were processed. A new agent still needs a private
handle through **Connect an agent** and an active host receiver.

An unattended worker can additionally use a named [event consumer](DURABILITY.md#named-event-consumers)
for a server-stored handled checkpoint and leased failover. Reading does not
acknowledge handling. Same-name workers share one checkpoint; different names
are independent subscriptions. The brief, transport-read position, and consumer checkpoint are independent
records with distinct purposes.

## Portable bundles and independent remixes

`GET A/bundle` returns versioned JSON containing the served page files and its
purpose. `?include_data=true` additionally includes shared state, the complete
session brief, and media bytes. A template without data starts from the page’s
code defaults. Tendriller’s credentials, account sessions, device identities,
timers, scope bindings/generations, workflow records, consumers, and delivery
jobs are never exported.
Anything deliberately embedded in a user-authored page file is still file
content; inspect your code before sharing a template.

The bundle has `format:"tendriller-bundle"`, `version:1`, a name, files with MIME
types and base64 bytes, optional state/session, and media entries. Restoration
allocates new media IDs and rewrites their references in text files and state.
Files are validated before storage: normalized paths, no duplicates, index page,
and existing file/state/storage limits. Media retain ordinary quota accounting.

Restoring is explicitly staged:

1. `PUT A/bundle` validates and prepares the bundle.
   The response gives file/media counts and `expected_version`.
2. Review it and capture the current scope generations for every path it will
   replace. `POST A/bundle/publish` accepts
   `{cid,expected_generations,expected_version:N}` with optional `scope`. It
   publishes an immutable version and restores included state/context in the same
   transaction as guard validation and the command receipt. Reuse that exact
   command after a lost acknowledgement. A changed page or scope causes a
   conflict. Connected clients receive restored state before reload.
3. `DELETE A/bundle` discards prepared assets that are not used by a published
   version. Only one stage/publish/discard operation runs at a time.

The same owner-only controls are in Settings. Publishing the first version still
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
publication, immutable asset graphs, and independent remixes. Contrib tests own
application workflow scenarios and their browser assets. A composition test
consumes an exact released workflow artifact through the public host interface.
See [E2E testing](E2E_TESTING.md) for the corresponding gates and fixture limits.
