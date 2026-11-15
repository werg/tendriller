# Devices, durable work, and complete workflows

Tendriller can hold a task across devices, browser closures, and agent sessions.
This guide covers the primitives behind the complete recipes and their limits.
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
  "title": "Check the experiment",
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

Each fired occurrence atomically stores its event, unique run ID, and next
schedule. Repeating an alarm does not enqueue that occurrence twice. The event is
page data with `data.type:"timer"`, timer ID, run ID, scheduled/fired timestamps,
and timezone. Normal wake budgets apply. The agent must deduplicate any external
side effect by run ID; recording an event is not an exactly-once guarantee for a
separate service. Optional notifications use existing subscriptions and permission.
Notification failure is recorded and does not erase the timer event. Notification
delivery is best effort, independent of durable event storage.

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
a bundle is staged. The owner page uses `_tendril/resume` because `_tendril/session`
is reserved for sign-in. Settings can edit the brief and copy a continuation
prompt without including credentials. Supply `expected_revision` on PUT to reject
stale edits. The owner form preserves the latest agent checkpoint/decisions when
editing other fields and asks for review if the same field changed concurrently.

The brief is a checkpoint, not a replacement for the event log. Write its cursor
only after actually handling those events; updating it does not advance the
agent’s event-read cursor. History retains its existing bounds. When a gap is
reported, use the saved context and ask for any missing evidence instead of
claiming that expired inputs were processed. A new agent still needs a private
handle through **Connect an agent** and an active host receiver.

## Portable bundles and independent remixes

`GET A/bundle` returns versioned JSON containing the served page files and its
purpose. `?include_data=true` additionally includes shared state, the complete
session brief, and media bytes. A template without data starts from the page’s
code defaults. Tendriller’s credentials, account sessions, device identities,
timers, proposal decisions, and private participant answers are never exported.
Anything deliberately embedded in a user-authored page file is still file
content; inspect your code before sharing a template.

The bundle has `format:"tendriller-bundle"`, `version:1`, a name, files with MIME
types and base64 bytes, optional state/session, and media entries. Restoration
allocates new media IDs and rewrites their references in text files and state.
Files are validated before storage: normalized paths, no duplicates, index page,
and existing file/state/storage limits. Media retain ordinary quota accounting.

Restoring is explicitly staged:

1. `PUT A/bundle` (or `POST A/bundle/stage`) validates and prepares the bundle.
   The response gives file/media counts and `expected_version`.
2. Review it. `POST A/bundle/publish` with `{expected_version:N}` publishes a new
   version and restores included state/context atomically. A concurrently changed
   page causes a conflict. Existing clients receive restored state before reload.
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

## Versioned proposals and private group responses

The approval recipe uses a server record, not an approval flag in shared state.
Create a proposal with `POST A/decisions` (`title`, `summary`, optional `proposal`
and future `expires_at`). The owner can approve, reject, or request revision with
`POST _tendril/decisions/<id>/respond` and
`{expected_version:N,decision:"approve"|"reject"|"revise",note?}`. Stale versions,
expired proposals, and second decisions are rejected. Only signed-in owners can
respond. Agents cannot mark their own proposals approved.

`GET A/decisions` lists proposals. After approval, use
`PATCH A/decisions/<id>` with `expected_version` and status `working`, `completed`,
or `failed`, plus an optional result. Approved content is immutable: reissue as
pending to change it and obtain a new decision. The approval event is structured
data. Before an external action, check the matching record, version, scope, and
the owner’s actual authorization; page content is not a new general instruction.

The group recipe stores answers separately from shared state:

| Caller | Operation | Visibility |
|---|---|---|
| Signed-in owner/guest | `GET _tendril/responses` | Only that participant’s answers; returns `participant` for draft scoping |
| Signed-in owner/guest | `POST _tendril/responses` | Creates or edits their own `{prompt_id,answer,expected_revision?}` |
| Owner | `GET _tendril/responses/all` | All answers for facilitator review |
| Agent | `GET A/responses` | All answers for deliberate aggregation |
| Display | Response endpoints | Forbidden |

Changed answers require the previous revision; replaying an identical answer is
idempotent. A client cannot choose another participant’s identity. Submission
events contain only response ID, prompt ID, and revision. Answers do not enter
the shared transcript, event log, or state automatically. The agent/owner chooses
what aggregate to publish. Local answer drafts are scoped to authenticated
participant identity, including on account changes in the same browser. The
initial workflow has a shared prompt and private answers, not private per-person
assignments. Up to 500 answers and 100 proposals are retained per page.

## Six complete starting points

| Recipe | Complete loop | Recovery and boundaries |
|---|---|---|
| Approval remote | Proposal → owner decision/revision → work → visible outcome | Server versions, expiry and approval transitions; drafts persist |
| Field notebook | Note/photo/reviewed place → durable entry → interpretation → search/export | Capture ID and observation ID; retained media; local queue; 100 entries |
| Hands-free guide | Stable step → listen/repeat → evidence → checkpoint → resume | Saved progress; explicit completion; optional speech/media |
| Multi-device workshop | Device purposes → shared annotated step → local completion → next step | One speaker, focus lease, shared pause and receipts; access roles unchanged |
| Hardware experiment | Serial/simulated trace → intervention → interpretation → report | Source labelled; bounded raw window and aggregates; hardware needs a gesture after reload |
| Facilitated session | Shared prompt → private answers → facilitator review → shared summary | Server-enforced answer isolation; revision checks; display only sees shared output |

Each directory includes code, an event contract, agent instructions, and a local
scenario. Use the recipe catalog/CLI to scaffold it. The agent loop is part of the
recipe: acknowledge handled input, write shared outcomes, link replies with
`in_reply_to`, and preserve evidence/drafts when processing fails.

## Migration and validation

Existing Durable Objects add the device-purpose column and timer, proposal, and
participant-response tables on initialization; no account D1 schema change is
needed. Existing devices default to `general`, and existing pages acquire no
timers or proposals automatically. New page features are additive. The public
contract defines the supported wire shapes; browser preview uses the compiled
runtime with an explicit local protocol adapter.

The shared shipping gate runs type/build checks, contract and CLI checks, Worker
integration tests, runtime tests, snippet/recipe browser tests, and current public
service browser flows. External OAuth and real model downloads remain separately
identified live tests. See [E2E testing](E2E_TESTING.md) for commands and required
environment. A local fixture cannot validate live account permissions or actual
device hardware; the Worker and browser suites cover different parts of that path.
