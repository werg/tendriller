# tendril CLI (optional)

Reference CLI for the Tendriller agent API. Zero dependencies, Node ≥ 18. Everything it
does is plain HTTPS described in `/agent.md`; agents may use `curl` instead.

```sh
node cli/bin/tendril.mjs --help
export TENDRIL_SERVER=http://localhost:8787          # default
node cli/bin/tendril.mjs new Kitchen --resident       # prints handle JSON + QR of page_url
node cli/bin/tendril.mjs --tendril kitchen push ./kitchen
node cli/bin/tendril.mjs --tendril kitchen wait       # blocks until a wake, prints events
```

- **Config**: `TENDRIL_API` + `TENDRIL_TOKEN`, or `--tendril <name>` / `TENDRIL_NAME`
  reading `~/.config/tendril/<name>.json` (mode 600, written by `new` and `adopt`;
  directory overridable with `TENDRIL_CONFIG_DIR`). `TENDRIL_SERVER` and
  `TENDRIL_CREATE_KEY` are used by `new`/`adopt`.
- **Output** is JSON on stdout (`--pretty` to indent); notes and the QR code go to stderr.
  Exit codes: 0 ok, 1 error, 2 `wait --timeout` expired / preview tooling missing,
  3 pushed version failed its health check, 4 page offline (409), 64 usage.
- **Cursor**: `events` and `wait` share a cursor per tendril in
  `~/.config/tendril/cursors/<id>.cursor` with `scripts/tendril-wait.sh`
  (`events --peek` or `--after N` reads without advancing it).
- **push** uploads a directory as one atomic version (`POST /files`, `replace: true`),
  skipping dotfiles and `node_modules`; binary files go as base64. A single `.html` file
  is uploaded as `index.html`. It then polls `/versions` up to `--timeout` s (20) and
  reports `healthy`, `failed` (with errors) or still `pending` (no device has loaded it).
- **preview** needs `playwright` resolvable from the current project
  (`npm i -D playwright && npx playwright install chromium`). It serves the directory with
  a recording `window.tendril` stub and snippets from `snippets/`, opens it in Chromium
  with fake camera/mic, and reports uncaught errors, console errors, recorded `tendril.*`
  calls and a screenshot (`<dir>/.preview.png`, never pushed).

## Scripts

- `scripts/tendril-wait.sh [cursor-file]`: POSIX sh + curl long-poll loop; exits 0 with
  a summary line and the events JSON when a wake arrives. Run it as a background command.
  Optional `TENDRIL_WAIT_MAX` seconds (exit 2).
- `scripts/codex-listener.sh`: runs the wait loop forever and, per wake, runs
  `$TENDRIL_ON_WAKE` (default `codex exec --skip-git-repo-check "$TENDRIL_PROMPT"`,
  or `resume --last` with `TENDRIL_RESUME=1`) with `TENDRIL_WAITING`,
  `TENDRIL_EVENTS_FILE` and `TENDRIL_PROMPT` set.

## Tests

`node --test cli/test/*.test.mjs` (unit tests plus the wait loop against a mock server).
