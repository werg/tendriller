# Chaos testing

`npm run test:chaos` is seeded monkey testing of the first-app workspace. It uses
the same packed host as [`test:first-app`](DEVELOPMENT.md#onboarding-as-a-public-surface)
and the same downloaded kit. On top of that it runs one agent program, several notes
pages and several real Chromium profiles. A seeded random sequence of actions kills,
pauses and restarts actors, takes them offline, reloads them and republishes. Safety
invariants are checked after every action. Liveness is checked at periodic *heal*
phases.

Chaos testing finds bugs. It does not qualify anything: a passing seed covers only
that seed's sequence. Gates and their claims are listed in
[browser and integration qualification](E2E_TESTING.md).

## Run it

Build artifacts from a clean, committed checkout, as for `test:first-app`:

```sh
npm ci && npm run build:artifacts && npm run release:artifacts && npm --prefix tools ci
npm run test:chaos -- --seed 1234 --steps 80
```

The seed is always printed, both first and last. Without `--seed`, a random 32-bit seed is drawn.

| Option | Meaning |
| --- | --- |
| `--seed N` | 32-bit seed (decimal or `0x…`). The same seed and configuration produce the same action sequence |
| `--steps N` / `--duration 10m` | Number of chaos actions (default 60), or a wall-clock bound (`ms`, `s`, `m`, `h`) |
| `--browsers N` | Maximum number of browser profiles. One is enrolled first; `browser.enroll` adds the rest (default 3) |
| `--pages N` | Number of notes pages in the workspace, 1–4 (default 2) |
| `--transport direct\|relay` | Real RTC, or RTC disabled in the browser so the relay fallback carries application traffic |
| `--heal-every N`, `--heal-deadline 120s` | Heal phase frequency and liveness deadline |
| `--first-app-archive PATH` | Kit to test (default `dist/tendriller-first-app-VERSION.tgz`, which must match `dist/manifest.json`) |
| `--report PATH` | Report file (default `.results/chaos/chaos-SEED.json`). Evidence goes in the sibling directory of the same name |
| `--replay REPORT.json` | Re-run exactly the action log of an earlier report |
| `--shrink [--shrink-budget 40]` | After a failure, delta-debug the action log to a minimal sequence that still fails |
| `--network` | Add packet-fault actions from the [Docker network lab](../test/e2e/network-qualification/faults.mjs). They are only available inside that lab's container; elsewhere the run prints that they are disabled and records the limit |
| `--no-host-restart`, `--keep-going` | Leave out the host restart action. Keep going after the first violation (the default stops) |
| `--fixture DIR`, `--keep`, `--port 8791` | Reuse a prepared setup directory, keep work directories, and choose the host port (8791 by default, so a concurrent `test:first-app` on 8790 is unaffected) |
| `--headed`, `--no-trace` | Show the browsers, or skip Playwright tracing |
| `--inject-fault offline-then-draft` | **Test only.** Adds a deliberate fake failure so you can watch the shrinker work. It never indicates a product problem |

Setup runs once into a *fixture* directory. It installs the kit, registers the agent,
creates, initializes and builds the pages, publishes v1 of each and signs the owner in.
After that the agent and host are stopped. Every run, replay and shrink trial starts from
a fresh copy of the fixture, with fresh browser profiles. Pass `--fixture DIR` to reuse
one fixture across several invocations.

## What runs

Actions are sequential. Each one is drawn by weight from those whose preconditions hold
against a model of the world. Its random choices are recorded as explicit parameters.

| Area | Actions |
| --- | --- |
| Browsers | `browser.enroll` (a new persistent profile, enrolled by the running agent program), `addNote` (plain, unicode, emoji/ZWJ, markup, multiline, surrounding whitespace, exactly 2,000 UTF-16 units, over-length), `draftReload`, `reload`, `reopenTab`, `secondTab`, `closeTab`, `navigate` (to the workspace's other page, enrolling there first if needed), `offline`/`online` (`context.setOffline`), `closeProfile`/`reopenProfile` |
| Agent program | `agent.command` (native `addNote` through a separate attach CLI), `agent.kill` (SIGKILL), `agent.stop` (SIGTERM), `agent.start`, `agent.pause`/`agent.resume` (SIGSTOP/SIGCONT) |
| Races | `race.saveKill`: Save in a browser, and 0–400 ms later SIGKILL the agent program while the apply is in flight |
| Publication | `publish`: a new signed UI version, marked `<!-- chaos-ui-vN -->`, while tabs are open |
| Host and network | `host.restart` (dispose and reopen Miniflare on the same storage); `net.fault`/`net.restore` (with `--network` in the lab only); `wait` |
| `heal` | Every `--heal-every` actions and at the end. Restores every actor, then checks liveness |

Navigation-type actions (reload, new tab, navigate) only pick online profiles: page
code is not saved for offline use by default, so an offline navigation is expected to
fail. `addNote` picks any tab, including offline ones and tabs whose agent program is
stopped or paused, because saving is local-first.

## Invariants

Safety is checked after every action, in every open tab's rendered notes and in the
agent's `query notes` for every page:

- `unique-operation-ids`, `single-application-per-intent`: no operation ID, and no
  note token, appears twice in a view.
- `known-authors`, `author-matches-submitter`: every row's author is the agent device
  or an enrolled browser device, and the agent attributes each note to the device that
  submitted it.
- `page-isolation`, `text-integrity`: a note never appears on another page, and its
  text round-trips exactly (after the template's own `trim()`).
- `applied-never-disappears`: an operation ID seen once in the agent query stays in
  every later agent query.
- `no-page-errors`: no uncaught page error, unhandled rejection or crash. Console
  errors are reported separately (`messages.consoleErrors`), and known benign messages
  from deliberate offline or restart are counted under an allowlist
  (`DEFAULT_CONSOLE_ALLOWLIST` in `test/chaos/invariants.mjs`).
- `draft-survives-reload`, `agent-restarts`: checked by the actions themselves.

Liveness is checked at each heal: the agent is running, every profile is open and online,
and no packet fault is active. Within `--heal-deadline`:

- `converges`: every note the model recorded as saved is in the agent query and in every
  open tab of its page. A browser note counts as saved once its signed attempt was
  confirmed (`Saved on this device`, `Saved locally` or `Applied: accepted`, or the
  operation status shows it). The `#result` text alone is not trusted for application,
  and only text that names the attempt's own operation ID counts. Uncertain attempts are
  reported and not required. A browser attempt that has not yet been seen applied is
  *parked* while no tab of its profile shows that page: it waits in that profile's local
  journal for the page origin, which is expected. Parked notes are listed in
  `convergence[].parkedNotes`, and become required again once such a tab is open.
- `not-stuck-connecting`: every tab shows `Connection: connected/following/coordinating`
  and `application: ready`.
- `live-update`: every tab with no typed draft shows the latest confirmed publication.
- `persists-across-reload`: after every tab reloads, all saved notes are still shown.

The convergence time is recorded for each heal (`convergence[]`, and
`summary.convergeMs`).

## Read a report

The report (`format: tendriller-chaos-report-v1`) contains:

- `status`, `seed`, `config` and `versions`: harness commit and dirty flag, core source,
  Chronolog source, composition and browser.
- `summary`, then `invariants` (checks and violations per invariant) and `violations`
  (each one with its step and action).
- `actions`: the complete timestamped log. Each entry has `index`, `name`, `params`,
  `at`, `offsetMs`, `durationMs`, `status` and `result` or `error`. `status` is `ok`,
  `error` (the action itself failed, which is reported but is not an invariant),
  `skipped` (its precondition no longer held during a replay) or `skipped-at-runtime`
  (for example, Save was disabled).
- `convergence`, `notes` (each submitted note with its origin, operation ID and status),
  `messages`, and the final `snapshots` of every agent query and tab.
- `evidence`, only when the run fails: per-tab screenshots and states, Playwright traces
  (`npx playwright show-trace FILE`), and the agent program's full stdout and stderr for
  each start (`agent-logs/agent-N.std{out,err}.log`).

To reproduce a failure, use `--replay` with the report. The timing will differ, so a
replay that passes does not show the failure was spurious. Run it a few times. Then use
`--shrink`. A shrink trial counts as reproducing the failure only if it fails the *same*
invariant as the original. The minimal sequence is written as its own replayable report
(`…-minimal.json`).

## Add an action or invariant

1. In `test/chaos/actions.mjs`, add an entry with a `weight`, a pure `pre(model)`, a
   `plan(rng, model, context)` that draws every random choice into parameters, and an
   `effect(model, params, result)`. Effects that change the model's structure (which
   actors are running, open, online, or where they are) must depend only on `params`.
   That keeps a seed's sequence independent of timing. Results may only refine
   expectations. If the parameters name profiles or tabs, extend `paramsStillValid`.
2. In `test/chaos/driver.mjs`, add an executor under the same name. Return a
   JSON-serializable result, plus `violations` for anything the action observes directly.
3. For an invariant, add its name and description to `INVARIANTS` in
   `test/chaos/invariants.mjs`. Make the check a pure function there, and call it from
   the sweep or heal in `test/chaos/runner.mjs`.
4. Extend `test/chaos/chaos.test.mjs`. `npm run test:ci` runs it as part of `npm run check`.

## CI

`.github/workflows/chaos.yml` builds artifacts, then runs a matrix of seeds: three random
seeds nightly, or the seeds, step count and transport given to `workflow_dispatch`. Each
seed's report and evidence are uploaded as `chaos-report-SEED`. The workflow is not a
required check.
