# tendril CLI (optional)

Reference CLI for the Tendriller agent API, using the repository's Node ≥ 22.15
toolchain. API commands use built-in fetch; preview uses the installed repository
runtime and Playwright. The HTTPS API is also described in `/agent.md`.

`npm pack` produces an installable local tarball with the compiled preview assets
and all starter files. Install that tarball in another project to use the CLI and
typed fetch client without a source checkout. For headless previews, separately
install `playwright` in that project and run `npx playwright install chromium`;
API commands and scaffolding do not need a browser. `npm run test:consumer`
verifies this installation path without publishing anything.

```sh
node cli/bin/tendril.mjs --help
export TENDRIL_SERVER=http://localhost:8787          # default
node cli/bin/tendril.mjs new Kitchen --owner you@example.com
# Attach and verify a host listener using /agent.md before publishing.
node cli/bin/tendril.mjs --tendril kitchen push ./kitchen
# Open the page, sign in with the verified owner email, then keep the application:
node cli/bin/tendril.mjs --tendril kitchen meta --lifetime resident
node cli/bin/tendril.mjs --tendril kitchen wait       # blocks until a wake, prints events
```

- **Config**: `TENDRIL_API` + `TENDRIL_TOKEN`, or `--tendril <name>` / `TENDRIL_NAME`
  reading `~/.config/tendril/<name>.json` (mode 600, written by `new` and `adopt`;
  directory overridable with `TENDRIL_CONFIG_DIR`). `TENDRIL_SERVER` selects the service;
  `new` requires `--owner` or `TENDRIL_OWNER`, an email verified by GitHub or Google.
  Creation always starts ad_hoc and uses no creation key. `--resident` at creation,
  `--create-key`, and `--pairing` fail with instructions for the current flow.
- **Output** is JSON on stdout (`--pretty` to indent); notes and the QR code go to stderr.
  Exit codes: 0 ok, 1 error, 2 `wait --timeout` expired / preview tooling missing,
  3 pushed version failed its health check, 4 conflict/offline (409), 64 usage.
- **Cursor**: `events` and `wait` share a cursor per tendril in
  `~/.config/tendril/cursors/<id>.cursor` with `scripts/tendril-wait.sh`
  (`events --peek` or `--after N` reads without advancing the local cursor).
  These reads still update the service's read position; avoid competing readers of a live bridge.
- **push** uploads a directory as one atomic version (`POST /files`, `replace: true`),
  skipping dotfiles and `node_modules`; binary files go as base64. A single `.html` file
  is uploaded as `index.html`. It then polls `/versions` up to `--timeout` s (20) and
  reports `healthy`, `failed` (with errors) or still `pending` (no device has loaded it).
- **preview** uses the compiled production runtime, real control, state and
  persistent outbox with an explicit local protocol adapter. Run `npm ci`,
  `npm run build`, and `npx playwright install chromium` first. It serves the
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
  mocks for account-backed workflows. See [Development](../docs/DEVELOPMENT.md).
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
tendril bundle publish --expected-version 7
tendril bundle discard
tendril remix --owner you@example.com --name "Next experiment" --as next-run
```

Export refuses to overwrite an existing output file. Without `--include-data`
it creates a template; with the flag it includes shared state, session and media
bytes. The remix has a new private handle and is staged until its own receiver
is connected and the copy is published. Credentials, private participant answers,
approvals and timers are excluded.

`decisions new @proposal.json` requests a versioned owner decision;
`decisions update <id> @outcome.json` records an approved action's result with
`expected_version`. Only the owner can approve/reject/revise on the page. Agents
can use `responses` to read private group answers for intentional aggregation.
See [Experiences](../docs/EXPERIENCES.md) and each recipe's `AGENT.md` for complete
loops and recovery rules.

## Scripts

- `scripts/tendril-wait.sh [cursor-file]`: POSIX sh + curl long-poll loop; exits 0 with
  a summary line and the events JSON when a wake arrives. Run it as a background command.
  Optional `TENDRIL_WAIT_MAX` seconds (exit 2).
- `bin/codex-bridge.mjs attach <private-handle.json>`: when run inside a Codex turn on Linux, installs a user service that holds a hibernating agent WebSocket and queues count-only notices into the same Codex conversation. The agent reads the events with its private token and calls `codex-bridge.mjs ack <page-id> <seq>` after responding. It does not put page data in a queued Codex message. Use `codex-bridge.mjs detach <page-id>` to stop and remove the service and its local credentials. See `/agent.md` for the complete flow.
- `bin/hermes-bridge.mjs attach <private-handle.json>`: Linux service that holds an agent WebSocket and submits a count-only note through the Hermes Wake plugin to its bound chat. Requires the plugin, gateway injection, and `/wakes here` in the intended chat. Call `hermes-bridge.mjs ack <page-id> <seq>` after responding and `detach <page-id>` to remove the service. See `/agent.md` for host-specific setup and limitations.

## Tests

`npm run build && npm run test:cli` (command/adapter tests and host/wait loops).
`npm run test:browser` also runs the real-runtime preview and recipe scenarios.
