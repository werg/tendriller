# Tendriller CLI

The optional core CLI performs authenticated requests and publishes ordinary
files. It has no page template, component installer or application schema.
Use `tendril --help` for the complete command reference.

## Select the application and publish plain files

From a **source checkout** with development dependencies installed:

```sh
node tools/cli/bin/tendril.mjs new 'A useful page' --owner you@example.com --application peer --application-id 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef --as example
node tools/cli/bin/tendril.mjs --tendril example push ./page
node tools/cli/bin/tendril.mjs --tendril example publications
node tools/preview/bin/tendril-preview.mjs ./page
```

From an **extracted tools release**, use `node /path/to/private-tools/bin/tendril.mjs`
and `node /path/to/private-tools/bin/tendril-preview.mjs` instead. The release
archive has `bin/`, not `tools/cli/bin/` or `tools/preview/bin/`. See
[artifact installation](ARTIFACTS.md) for `manifest.json` and `SHA256SUMS`.

Creation requires `--application peer|cloudflare` and `--application-id ID`.
The 64-character example above is illustrative; replace it with the real
application-owned identity. `peer` is the normal stateful app choice. Page
creation does not construct a descriptor, schema, keys or session. Configure
the application's Chronolog composition explicitly. Plain static files need
none of those database inputs and can use the quiet peer runtime.

For a deliberately hosted app, use `--application cloudflare --application-id
hosted:my-page`. Hosted state, streams and timers remain separate capabilities.
The hosted remix command creates an independent Cloudflare history; it does not
copy the original application's identity.

Creation uses an email verified by the service's identity provider. Opening the
owner URL claims the page. A hosted Cloudflare interactive page also needs a
verified live agent receiver; its dashboard mode omits that requirement.
Peer publication never requires a hosted receiver.
The create response includes `unclaimed_limits`: the unclaimed stream retention
budget and per-request body limit are each **1 MiB (1048576 bytes)**. Claim
with the owner before starting a collector or sending a large backlog. A producer
heartbeat does not claim the page.
A private handle contains credentials and the immutable application selection,
and is saved with mode 0600. `--tendril`
selects a named handle, while `TENDRIL_API` and `TENDRIL_TOKEN` can supply one
privately through the environment. `TENDRIL_SERVER` chooses the service origin.

`push` accepts one file or a directory. A single HTML file is published as
`index.html` unless `--as` specifies a path. A directory replaces the page's file
set and uses `index.html`; `--entry nested/report.html` selects another authored
HTML entry. `--no-replace` adds or updates explicitly named files and preserves
the existing entry unless `--entry` changes it.
Dotfiles, `node_modules`, `_tendril/` and `_publications/` are excluded. Symlinks,
unsafe paths and nonregular filesystem entries are rejected. Text retains its
UTF-8 content; every file is uploaded as exact binary bytes with a verified
SHA-256 and size. Packing never edits files,
adds dependencies, checks copied-source equality or completes missing imports.

The service verifies uploaded content and commits one complete manifest against
the captured publication head revision. Unchanged SHA-256/size pairs reuse
verified blobs from the current manifest. A changed head returns a conflict;
the CLI does not overwrite a newer publication by recapturing its revision.
`push` returns `status:"pending"` immediately for peer pages, with no follow-up
host health polling, metadata read, state traffic or socket. Readiness belongs to
the installed application session. Once generation controls are configured,
publish signed code through the peer publication API; generic `push` cannot
replace an authenticated publication head.

For explicitly selected Cloudflare handles, `push` returns `status:"pending"` immediately by default for dashboards,
where nobody may be viewing the page. `--wait` opts dashboards into health
polling. Hosted interactive pages wait by default; `--no-wait` returns immediately.
`--wait` requires a saved Cloudflare selection; bare API/token credentials never
infer a backend or enable automatic health polling.
Pending means no device has reported a terminal health result; it is not proof
of failure.
A failed publication returns exit status 3. Reopen the authored page and inspect
its runtime errors before retrying.

## Operational boundaries

`events` is an immediate cursor-based replay command. `events --follow` and
`wait` use authenticated agent WebSockets for wake notifications and fetch the
available queue after connection and each wake. The legacy `--wait` option and
held HTTP event requests are no longer supported. `pending` and `ack` still
keep handled checkpoints separate from reads. `tendril events send --wake`
submits one bounded, rate-limited delivery probe through the existing
`POST /wake/probe` endpoint; it is a diagnostic, not an owner instruction.
The listener should read the probe, rearm and verify a second one. For the
standalone tools package, `tendril-events /private/page.json send --wake`
performs the same check.

| Commands | Responsibility |
| --- | --- |
| `state`, `say`, `status`, `eval` | Explicit state, reply, presence and browser requests |
| `pending`, `ack`, `events`, `wait` | Read input and advance handled progress after effects |
| `devices`, `focus`, `capabilities` | Device purpose and live observation; purpose does not grant authority |
| `link`, `tokens` | Authorized sharing and agent credentials |
| `timers`, `session`, `bundle`, `remix` | Durable operational context and deliberate page copies |
| `scopes`, `workflow` | Captured generations and explicit installed trusted extensions |
| `notify`, `notifications` | Send a notification or inspect readiness without sending |
| `blob` | Verified immutable binary transfers and guarded pin operations |
| `file` | Shared-file revision reads, guarded writes, history and downloads |
| `publications`, `publication`, `rollback` | Publication heads, exact manifests and guarded selection |

`workflow <module> <operation> [json]` checks the selected module's advertised
interface/schema before dispatch. No domain module is installed by default.
Use `--cid`, `--scope` and `--generations` for protected commands. A retry must
retain its original command ID, payload and captured generations; a stale command
needs a deliberate newly composed action, not an automatic generation rewrite.
Publication replacement and rollback target the complete `["publications"]`
namespace, including removed paths. Inspect `scopes list` and provide every
relevant original generation with `--generations`; enumerating only the new
manifest's paths is insufficient. Shared-file mutations target
`["files", "reports/latest.json"]`, with the canonical file path as one segment.

## Binary transfers and shared files

```sh
tendril blob upload ./photo.png --name 'Latest observation'
tendril blob info b_aaaaaaaaaaaaaaaaaaaa
tendril blob list --limit 100
tendril blob list --after b_aaaaaaaaaaaaaaaaaaaa --limit 100
tendril blob download b_aaaaaaaaaaaaaaaaaaaa ./downloaded-photo.png
tendril blob pin b_aaaaaaaaaaaaaaaaaaaa --keep true --cid keep-observation
tendril file put reports/latest.json ./report.json
tendril file get reports/latest.json ./downloaded-report.json
tendril file history reports/latest.json
tendril file delete reports/latest.json --revision 4
tendril publication 3
tendril rollback 2
```

An upload reserves its digest, size, type and optional name, sends bytes only
when required, and verifies the completion receipt before reporting success.
Downloads require an explicit local destination, verify its full size and hash,
and replace the destination only after verification. Existing files require
`--overwrite`. Remote names never become local paths; symlink destinations and
symlink source files are rejected.
Blob listings are bounded pages ordered by blob ID. When `cursor` is non-null,
pass it as `--after` to read the next page; a null cursor marks the end.

Shared-file paths identify revisioned references to immutable blobs. `file put`
captures the current revision before uploading; `--revision` supplies a deliberate
revision instead. A deleted path retains its tombstone revision, so recreation
still uses compare-and-swap. Conflicts exit with status 4 and preserve the original
uploaded blob and operation identity. `file get` downloads the exact blob named
by the captured head, even if that shared path subsequently changes.

Uploads, shared-file writes/deletions, pushes, rollbacks, and timer mutations save private resume records under the
selected configuration directory. Their keys include the destination service,
content bytes and command intent. Repeating the same command resumes that
operation or returns its accepted receipt; changed bytes create a new operation.
`--resume-file` selects an explicit record. `--cid` selects an explicit command
identity. To deliberately repeat a completed operation as new work, choose a new
CID. Changing bytes or guards while reusing an explicit record is rejected.

Publication rollback selects a particular retained version against a head
revision captured once before its first request; `--expected-head` supplies an
explicit reviewed revision. File deletion similarly preserves its first observed
revision or the supplied `--revision`. A lost reply replays the exact saved
command even if another writer has since changed the head. Rollback requires an
explicit publication version. No command rewrites an original
failed operation with newer generations or revisions automatically.

## Reviewed timer commands

```sh
tendril timers list
tendril timers add '{"title":"Review measurements","repeat":{"at":"09:00","days":[1,2,3,4,5]},"timezone":"Europe/Berlin"}' --cid weekday-review
tendril timers update TIMER_ID '{"title":"Review the latest measurements"}' --revision 1 --cid rename-review
tendril timers cancel TIMER_ID --revision 2 --cid cancel-review
tendril timers rm TIMER_ID --revision 3 --cid remove-review
tendril timers history
```

Replace `TIMER_ID` and each example revision with the actual timer and revision
you reviewed in `timers list`. Update, cancel, and removal require explicit
`--revision N`; the CLI never fetches a newer revision to make a stale decision
succeed. Alarms increment revisions when they advance or complete schedules, so
a conflict can indicate that the reminder ran while its edit was being prepared.
`timer_conflict` exits with status 4 and reports the revision observed when that
command was rejected. Refresh `timers list` and review the changed timer before
choosing a new command and revision.

Put only timer settings in the JSON argument. Command metadata comes from
`--cid`, `--scope`, and `--generations`, with `--revision` supplying the reviewed
timer revision. If active scopes bind `timer.write`, capture their original
tokens and pass them, for example
`--scope schedule --generations '{"schedule":"captured-token"}'`.

The CLI saves the complete request before sending it. Rerunning the same command
after a lost reply uses the same command ID, settings, guards, and revision.
Without `--cid`, it generates and stores an ID once. Without `--resume-file`, it
selects a private record by destination and command intent. An accepted replay
returns its saved receipt; no repeated creation or edit is performed. A retained
timer-domain rejection also replays unchanged after quota, claim, or lifetime
conditions improve. To request otherwise identical work as a new decision after
review, choose a new `--cid`. See [receipt boundaries](../DURABILITY.md#timer-mutation-receipts)
for the domain errors retained and failures that cannot store a decision.
`--resume-file ./reminder-command.json` chooses a specific recovery record;
changing its settings, guards, or reviewed revision is refused before a request.

Create and update output the complete accepted timer. Removal outputs
`{id,revision,deleted:true}`. These receipts remain recoverable after later timer
changes, so use `timers list` to display the current schedule. A saved receipt
does not establish current notification delivery; use `timers history` for that.
The owner must claim the page, and timer deadlines must respect its lifetime.

## Delivery and checkpoints

`info` redacts the secret `page_url` in both JSON and `--pretty` output. Only
`info --show-url` reveals it; run that option solely where output is private.
New/adopt intentionally prints the URL once for owner handoff, so keep its
output private as well.

For `pending`/`ack`, the private handled checkpoint defaults to
`<selected-config-file>.events.json` (or
`$XDG_CONFIG_HOME/tendril/checkpoints/<page-id>-<api-hash>.json` when using
environment credentials). Override it with `--checkpoint-file` or
`TENDRIL_CHECKPOINT_FILE`. Each JSON checkpoint stores `handled_cursor` and
`delivered_cursor`, bound to the page API; it is distinct from the read-only
`events`/`wait` cursor in `~/.config/tendril/cursors/<page-id>.cursor`.
Never edit it to skip unhandled work, and keep it private alongside credentials.

Read with `pending`, finish the intended reply/state/file effects, then `ack` the
last completely handled sequence. Delivered and handled cursors are separate.
The receiver may replay an unacknowledged batch after interruption; side effects
need their own stable IDs. Delivery probes are handled explicitly without
pretending ordinary user work completed. See [host operations](AGENT_HOSTS.md).

No command output proving service acceptance proves a person saw or understood
it. Notification results report push-service acceptance; presentation receipts
report that a page presented a reply. Real service authorization remains authoritative.

## Other optional tools

Use `tendril-preview` for exact-file browser fixtures and `tendril-stream` for
bounded telemetry collection. Their references live in
[preview operations](PREVIEW.md) and
[collector operations](COLLECTOR.md).
The [artifact guide](ARTIFACTS.md) describes verified installation.
