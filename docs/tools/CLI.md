# Tendriller CLI

The optional core CLI performs authenticated requests and publishes ordinary
files. It has no page template, component installer or application schema.
Use `tendril --help` for the complete command reference.

## A plain-files page

```sh
node tools/cli/bin/tendril.mjs new 'A useful page' --owner you@example.com --as example
node tools/cli/bin/tendril.mjs --tendril example push ./page
node tools/cli/bin/tendril.mjs --tendril example versions
node tools/preview/bin/tendril-preview.mjs ./page
```

Creation uses an email verified by the service's identity provider. Opening the
owner URL claims the page. An interactive page also needs a verified live agent
receiver; choose dashboard mode only when no conversational receiver is needed.
A private handle contains credentials and is saved with mode 0600. `--tendril`
selects a named handle, while `TENDRIL_API` and `TENDRIL_TOKEN` can supply one
privately through the environment. `TENDRIL_SERVER` chooses the service origin.

`push` accepts one file or a directory. A single HTML file is published as
`index.html` unless `--as` specifies a path. A directory replaces the page's file
set and requires `index.html`; `--no-replace` adds or updates explicitly named files.
Dotfiles, `node_modules`, `_tendril/` and `_publications/` are excluded. Symlinks,
unsafe paths and nonregular filesystem entries are rejected. Text retains its
UTF-8 content; binary data is transported explicitly. Packing never edits files,
adds dependencies, checks copied-source equality or completes missing imports.

The service owns the publication identity and final asset hashes. `push` waits
for the publication's health result unless `--no-wait` is given. Pending means no
device has yet reported a terminal health result; it is not proof of failure.
A failed publication returns exit status 3. Reopen the authored page and inspect
its runtime errors before retrying.

## Operational boundaries

| Commands | Responsibility |
| --- | --- |
| `state`, `say`, `status`, `eval` | Explicit state, reply, presence and browser requests |
| `pending`, `ack`, `events`, `wait` | Read input and advance handled progress after effects |
| `devices`, `focus`, `capabilities` | Device purpose and live observation; purpose does not grant authority |
| `link`, `tokens` | Authorized sharing and agent credentials |
| `timers`, `session`, `bundle`, `remix` | Durable operational context and deliberate page copies |
| `scopes`, `workflow` | Captured generations and explicit installed trusted extensions |
| `notify`, `notifications` | Send a notification or inspect readiness without sending |
| `upload`, `blobs` | Page media and explicit retention operations |

`workflow <module> <operation> [json]` checks the selected module's advertised
interface/schema before dispatch. No domain module is installed by default.
Use `--cid`, `--scope` and `--generations` for protected commands. A retry must
retain its original command ID, payload and captured generations; a stale command
needs a deliberate newly composed action, not an automatic generation rewrite.

## Delivery and checkpoints

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
