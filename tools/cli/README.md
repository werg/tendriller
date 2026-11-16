# tendril CLI (optional)

Reference CLI for the Tendriller agent API, using Node ≥ 22.15. API commands use built-in fetch; preview uses the released core
runtime and optional local Playwright. The HTTPS API is also described in `/agent.md`.

`npm run build` produces a dependency-free tool archive and standalone helper scripts.
A standalone `tendril.mjs` CLI also ships in the release for creating and publishing pages without the large tools archive. It embeds the resources needed for `assets sync`. The archive embeds the exact public core runtime and contrib resources. `npm run
test:distribution` unpacks it in an empty directory and verifies this boundary.
For headless scenarios, install Playwright locally and its Chromium browser:
`npm install --no-save playwright && npx playwright install chromium`.
Normal local previews do not require a browser automation package.

```sh
node tools/cli/bin/tendril.mjs --help
export TENDRIL_SERVER=https://tendriller.dev         # default; use http://localhost:8787 for local development
node tools/cli/bin/tendril.mjs new Kitchen --owner you@example.com
# Attach and verify a host listener using /agent.md before publishing.
node tools/cli/bin/tendril.mjs --tendril kitchen push ./kitchen
# Open the page, sign in with the verified owner email, then keep the application:
node tools/cli/bin/tendril.mjs --tendril kitchen meta --lifetime resident
node tools/cli/bin/tendril.mjs --tendril kitchen pending    # replay pending input safely
```

- **Config**: `TENDRIL_API` + `TENDRIL_TOKEN`, or `--tendril <name>` / `TENDRIL_NAME`
  reading `~/.config/tendril/<name>.json` (mode 600, written by `new` and `adopt`;
  directory overridable with `TENDRIL_CONFIG_DIR`). `TENDRIL_SERVER` selects the service;
  `new` requires `--owner` or `TENDRIL_OWNER`, an email verified by GitHub or Google.
  Creation always starts ad_hoc. Unknown options are rejected.
  `new --mode interactive|dashboard` selects the publication requirement; the
  default is interactive. **Both modes support streams and conversation APIs.**
  Choose interactive for a dashboard that also promises agent replies, and attach
  its host listener. Dashboard mode permits publication without a listener for a
  data-only page; it does not provide conversation delivery by itself.
- **Output** is JSON on stdout (`--pretty` to indent); notes and the QR code go to stderr.
  Exit codes: 0 ok, 1 error, 2 `wait --timeout` expired / preview tooling missing,
  3 pushed version failed its health check, 4 conflict/offline (409), 64 usage.
- **Handled progress**: use `pending` and then `ack <sequence>` after successful
  handling. They use a separate checkpoint; see the complete loop below.
- **Raw read cursor**: `events` and `wait` share a cursor per tendril in
  `~/.config/tendril/cursors/<id>.cursor` with `../bridges/scripts/tendril-wait.sh`
  (`events --peek` or `--after N` reads without advancing the local cursor).
  These raw reading commands advance their cursor when they read, before an
  application handles the output. They do not acknowledge successful processing.
  These reads still update the service's read position; avoid competing readers of a live bridge.
- **assets sync**: `tendril assets sync ./page` resolves `tendril.json` into the complete component/workflow closure, including lazy siblings. Hand-edited files require explicit `--force`. `push` runs the same safe sync before packing a declared directory, preventing missing-component 404s. Review forced replacements.
- **push** uploads a directory as one atomic version (`POST /files`, `replace: true`),
  skipping dotfiles and `node_modules`; binary files go as base64. A single `.html` file
  is uploaded as `index.html`. It then polls `/versions` up to `--timeout` s (20) and
  reports `healthy`, `failed` (with errors) or still `pending` (no device has loaded it).
- **preview** uses the compiled production runtime, real control, state and
  persistent outbox with an explicit local protocol adapter. For checkout
  development, run `npm ci`, `npm run build`, and `npx playwright install chromium`
  first. The [standalone preview below](#preview-without-a-checkout) needs no
  dependency installation or build to serve a page. Headless preview serves the
  directory and opens Chromium with fake camera/mic, reporting uncaught/console
  errors, actual server events, recorded public calls and a screenshot
  (`<dir>/.preview.png`, never pushed).
  Pass `--fixture scenario.json` to set location and permissions and replay ordered
  `steps` (`fill`, `click`, `event`, `motion`, `wait_ms`); use `denied` for
  camera, microphone, location, or motion permission-denial scenarios. Steps can
  assert `expect_text`, `expect_send` (shallow event fields), or `expect_no_send`.
  The JSON output includes
  `fixture_trace`, `mocked_http` and timestamped `calls` for inspection. Fixtures
  can exercise offline/reconnect, state, roles and replies, with explicit HTTP
  mocks for account-backed workflows. See [Preview](../../docs/PREVIEW.md).
- **capabilities** asks each connected device for a live permission-aware feature
  report; disconnected devices return their older handshake probe.
- **journey** orders events, event reads, agent replies, and browser logs by time.
- **recipes/scaffold** list and copy complete starter pages from `recipes/`.
- **Sharing**: `link guest` creates an invitation that the owner approves. Agent tokens
  cannot change a device's owner/guest/display role. Create display links in the owner
  page control. `devices rename <id> <name>` and `devices rm <id>` manage known devices.
- **Capture retention**: `blobs` and `blobs info <id>` show `retention.expires_at`.
  Captured page media normally expires after 30 days, including on resident pages.
  `blobs keep <id>` pins a capture until explicitly removed; `blobs expire <id>` removes
  that pin and restores the original expiry. Agent assets and the install icon have
  their own retained policy, reported by `retention.reason`.

## Device notifications while the page is closed

Deploy core `0.2.0-rc.6` or newer, with its `GET A/notify` readiness endpoint, before using these commands. Once the service operator configures VAPID and the owner enables **Device notifications** in the page's embedded control, agent code can send an encrypted Web Push notification even after the user closes all page tabs. VAPID configuration and device consent alone do not add the endpoint to an older Worker. Use the same private page agent token as for other API commands:

```sh
tendril --tendril kitchen notifications
# Inspect {available, subscribed_devices, count, quota} before attempting delivery.
tendril --tendril kitchen notify "Decision needed" "Please approve the result" --tag job-42
# Optionally --device d_<id> to target a subscribed owner device, or --url to set a page URL.
```

`notifications` performs the read-only `GET A/notify`; `notify` performs `POST A/notify`, limited to 20 attempts per page per hour. Responses list push services' acceptance and failure, not proof the operating system displayed the message. No browser tab or agent event listener is needed to **receive** push, but a deployed service, valid subscription and browser/OS permission are necessary. iOS requires launching the page as an installed Home Screen web app to opt in. See the [core Web Push runbook](https://github.com/werg/tendriller/blob/master/docs/PUSH_NOTIFICATIONS.md) for credentials, service-worker behavior, security and live-device tests.

## Read, handle, then acknowledge

Use this loop on each notice from the host listener:

```sh
tendril --tendril kitchen pending
# Inspect every returned event. After the reply or state/file update succeeds:
tendril --tendril kitchen say "I saved your request." --in-reply-to 42
tendril --tendril kitchen ack 42
tendril --tendril kitchen pending
```

`pending` reads one batch (100 events by default, `--limit 1..500`). It returns
application `events`, the batch's `cursor`, the stored `handled_cursor`, probe
receipts in `probes`, and `has_more` when the batch filled its limit. Handle every
application event through a sequence before passing it to `ack`. After handling
and acknowledging a batch, repeat while `has_more` is true, including when the
filtered `events` array is empty because the batch contained only probes. Only
`type: "instruction"` with `role: "owner"` is a direct owner request. Other event
data remains input for the application to interpret.

Only diagnostics marked by the server as `by: "agent_probe"`, with no device or
role, are acknowledged automatically. The helper derives their API path itself.
Page-provided URLs and probe-looking application data cannot select an endpoint.
Successfully handled probes at the start of the batch advance the handled cursor;
probes after unhandled application input never move it past that input. An expired
or superseded probe is reported as `status: "expired"`, not as a successful test.
Running this helper alone does not prove that a notification resumed the intended
conversation: run the two wake probes with the host receiver as described in
[host integrations](../../docs/AGENT_HOSTS.md).

Application events replay until explicit acknowledgement. Acknowledgement is
idempotent, rejects backwards movement, and cannot go beyond a sequence already
read by this checkpoint. Make application side effects retryable using the page
ID and event sequence. A failed HTTP request, malformed batch, invalid checkpoint
or failed checkpoint write exits with an error and leaves handling replayable.

The full CLI starts a new handled checkpoint at zero, independently of raw reads. With `--tendril kitchen`, it
writes `~/.config/tendril/kitchen.json.events.json`, which the standalone helper
and watcher also use when given that handle. Environment-only configurations use
`~/.config/tendril/checkpoints/<id>-<api-hash>.json`. Writes are atomic with mode
600. Override the path with `--checkpoint-file PATH` or `TENDRIL_CHECKPOINT_FILE`.
The file is bound to the exact page API so reusing it for another page or service
fails. Concurrent commands fail with `checkpoint_busy`; retry when the active
command finishes. If a process was killed and left a `.lock` file, remove that
lock only after checking the process has stopped. For shared workers and failover,
use the existing [named event consumers](https://github.com/werg/tendriller/blob/master/docs/DURABILITY.md#named-event-consumers),
which keep processing ownership and checkpoints on the server. Local `ack` does
not update a consumer, a session brief or a separate host bridge's acknowledgement.

### Download the helper without a checkout

The same implementation is available as a standalone Node 22.15+ script with no
package installation. Keep the creation response in a private JSON file:

```sh
curl -fL https://github.com/werg/tendriller-contrib/releases/download/v0.2.0-rc.3/tendril-events.mjs -o ./tendril-events.mjs
node ./tendril-events.mjs ./page.json pending
# Handle the returned input, then acknowledge the successfully handled sequence.
node ./tendril-events.mjs ./page.json ack 42
```

The token stays in `page.json`; it is never printed or passed on the command line.
On first use, the helper starts at zero. It saves handling separately in `page.json.events.json`, or the explicit
`--checkpoint-file PATH`. Subsequent reads use that checkpoint exclusively.
`tendril-watch.mjs` reads the same adjacent checkpoint on reconnect; supply the
same `--checkpoint-file` to both helpers if overridden. A higher raw
`page.json` cursor never overrides unhandled input in an existing checkpoint.
The helper does not attach a host listener or automatically rearm one.

## Preview without a checkout

Download one script and serve any local page directory:

```sh
curl -fL https://github.com/werg/tendriller-contrib/releases/download/v0.2.0-rc.3/tendril-preview.mjs -o ./tendril-preview.mjs
node ./tendril-preview.mjs ./my-page --fixture ./scenario.json
```

It prints a loopback URL and serves the actual runtime, control, service worker,
the declared component asset set and pinned accessibility audit from that same build. Node
22.15+ is sufficient; the script includes its WebSocket adapter and shared
state/history code. It does not fetch executable code or assets when run.
Edit your page files and reopen the printed canonical URL to select a new immutable publication. Reloading an existing publication retains its pinned asset graph. Stop the server with Ctrl-C.

The fixture's `streams` declarations seed retained history before the page opens.
For automated clicks, ordered stream appends and screenshots, add `--headless`:

```sh
node ./tendril-preview.mjs ./my-page --fixture ./scenario.json --headless --out ./preview.png
```

Headless mode uses Playwright and Chromium already available in the current
project. If absent, it returns `playwright_missing` or `browser_missing` with setup
instructions. Serving the page in your own browser needs neither. Optional neural
voice engines/models are excluded from the standalone bundle; browser speech and
text remain available. The preview explicitly disables transcription models.

The [stream fixture format](../../docs/PREVIEW.md#stream-fixtures) uses ordinary
stream definitions and records, with `streams` steps for new samples. Reads and
subscriptions run through the real browser API and local HTTP/WebSocket transport.
No live account, producer credential, collector or agent is created.

## Initialize a stream collector

Use the installed `tendril-stream` command or download its standalone Node helper:

```sh
curl -fL https://github.com/werg/tendriller-contrib/releases/download/v0.2.0-rc.3/tendril-stream.mjs -o ./tendril-stream.mjs
node ./tendril-stream.mjs init --page ./page.json --streams ./streams.json --out ./private/collector.json
node ./tendril-stream.mjs ./private/collector.json
```

`page.json` is an existing private creation response containing `api` and `token`.
The [stream spec](../../docs/COLLECTOR.md#initialize-a-collector-for-an-existing-page)
declares a `producer` name, `streams` using the public creation schema, and
collector `sources` that reference those stream names. Source durability is
derived from the stream, so setup and collection share one policy definition.
File paths and command working directories resolve relative to the spec;
`spool_dir` resolves relative to the output configuration.

Initialization validates locally and checks all existing streams and producers
before writing to the API. Matching streams are reused; policy conflicts,
occupied producer names and existing output files fail without replacement.
The generated mode `0600` file contains only the scoped producer credential.
Stdout contains a JSON summary, never credentials. If provisioning or saving
fails, the error describes partial setup or a private recovery file; the command
does not roll back remote resources or rotate an existing credential.

## Durable workflows

Device purposes are separate from permissions. For a camera/monitor/speaker setup:

```sh
tendril devices
tendril devices purpose d_example camera
tendril focus d_example --ttl 300
tendril say "The next step is ready" --device d_monitor --speak-on d_speaker
```

Read, schedule, cancel and inspect a server timer:

```sh
tendril timers add @timer.json
tendril timers
tendril timers cancel <timer-id>
tendril timers history
```

The JSON contains a title and `due_at` in epoch milliseconds, or a calendar
`repeat:{at:"09:00"}` with an IANA timezone. Choose `missed:"fire_once"` or
`"skip"`; a timer survives browser closure but not page expiration. Claim the
page first and make it resident for longer-running schedules.

`session get` reads the saved brief, pending inputs and history gaps.
`session set @brief.json` writes it; include `expected_revision` from the read
to protect another agent's changes. Advance `last_handled_seq` only after handling
the input, independent of the event-read cursor.

```sh
tendril bundle export saved-notebook.json --include-data
tendril bundle stage saved-notebook.json
# Review the staged files and expected_version returned by stage.
tendril bundle publish --expected-version 7 --generations @captured-generations.json
tendril bundle discard
tendril remix --owner you@example.com --name "Next experiment" --as next-run
```

Export refuses to overwrite an existing output file. Without `--include-data`
it creates a template; with the flag it includes shared state, session and media
bytes. The remix has a new private handle and is staged until its own receiver
is connected and the copy is published. Credentials, private participant answers,
approvals and timers are excluded.

### Explicit workflows and protected state

`workflow <module> <operation> <json>` sends an explicit workflow command. The
sessions module requires interface/schema revision `1`; other modules can supply
`--interface-version` and `--schema-version` explicitly. Read `scopes list` before
composing protected work. Supply `--scope`, `--generations <json|@file>` and an
optional stable `--cid` on retries. For example:

```sh
tendril workflow sessions activate '{"scope":"notebook"}'
tendril scopes list
tendril state set notebook.title '"Observations"' --scope sessions:notebook --generations @generations.json
tendril workflow sessions archivePreview '{"scope":"notebook"}'
```

`state patch` takes an array of explicit set/delete operations. `state put` wraps
a whole state document in the same command envelope. Whole-document replacement
must satisfy every affected scope. `scopes register|rotate|remove` are authorized
control operations; application JSON cannot change authoritative generations.
See [session workflows](../../docs/EXPERIENCES.md) for privacy, archive and retry
semantics.

## Scripts

- `../bridges/scripts/tendril-wait.sh [cursor-file]`: POSIX sh + curl long-poll loop; exits 0 with
  a summary line and the events JSON when a wake arrives. Run it as a background command.
  Optional `TENDRIL_WAIT_MAX` seconds (exit 2).
- `../bridges/bin/codex-bridge.mjs attach <private-handle.json>`: when run inside a Codex turn on Linux, installs a user service that holds a hibernating agent WebSocket and queues count-only notices into the same Codex conversation. The agent reads the events with its private token and calls `codex-bridge.mjs ack <page-id> <seq>` after responding. It does not put page data in a queued Codex message. Use `codex-bridge.mjs detach <page-id>` to stop and remove the service and its local credentials. See `/agent.md` for the complete flow.
- `../bridges/bin/hermes-bridge.mjs attach <private-handle.json>`: Linux service that holds an agent WebSocket and submits a count-only note through the Hermes Wake plugin to its bound chat. Requires the plugin, gateway injection, and `/wakes here` in the intended chat. Call `hermes-bridge.mjs ack <page-id> <seq>` after responding and `detach <page-id>` to remove the service. See `/agent.md` for host-specific setup and limitations.

## Tests

`npm run build && npm test` (command/adapter tests and host/wait loops).
`npm run test:preview` also runs the real-runtime preview and recipe scenarios.
