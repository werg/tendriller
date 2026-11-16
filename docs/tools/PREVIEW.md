# Truthful local preview

`tendril-preview` serves the exact authored page directory with the production
runtime from the same core build. It supplies a small, explicit fixture adapter
for local iteration. Missing files remain missing. No catalog, recipe declaration,
component graph, or upstream source lock participates in preview.

## Start a page

```sh
node tools/preview/bin/tendril-preview.mjs ./page
node tools/preview/bin/tendril-preview.mjs ./page --headless --fixture ./scenario.json --out ./page.png
```

The directory must contain `index.html`. The first command prints a local URL and
keeps serving until stopped. The second requires Playwright and Chromium, runs
ordered fixture steps, saves a screenshot and emits a JSON report. `--desktop`
chooses a wider viewport; `--headed` opens the automation browser visibly.

Page files and the runtime are recorded in an immutable local publication.
Opening the canonical page URL selects current authored bytes; an already-loaded
publication retains its own files, including lazy modules. Nested HTML receives
a publication base relative to its directory, so `../shared.js` and local styles
resolve as authored. Symlinks are rejected consistently with publication packing.
Generated screenshots use a dot-prefixed default path and are not page assets.

## Explicit fixtures

```json
{
  "role": "owner",
  "state": {"reading": null},
  "service": {"workflows": []},
  "permissions": [],
  "denied": ["camera"],
  "reply": "A simulated response",
  "streams": [{"name": "measurements", "durability": "durable", "records": []}],
  "steps": [
    {"click": "#send"},
    {"expect_event": {"kind": "sample"}},
    {"offline": true, "expect_connected": false},
    {"offline": false, "expect_connected": true}
  ]
}
```

`service.workflows` declares **simulated service availability**, separately from
browser capability observation. Its default is empty. Listing an extension does
not implement it: its HTTP operations require explicit fixtures. The contract
must match the bundled runtime. The page directory has no authority to declare a
service capability. A missing-capability case is part of an honest page check.

Permission and hardware fixtures are explicit browser inputs. `denied` can block
camera, microphone, location or motion; `hardware` can supply selected hardware
records. Capability presence is still derived by the production browser code.
These inputs establish behavior under the simulated conditions, not real-device
availability, accuracy or background operation. Permissions default to none.

State operations, stream history, scope matching and generation capture consume
public pure support algorithms from the runtime artifact. The production browser
owns its socket, durable outbox, captures, subscriptions and publication lifecycle.
The fixture adapter intentionally has no private application records or trusted
transaction implementation.

## HTTP fixtures and unsupported operations

```json
{
  "service": {"workflows": [{"id":"review","interface_version":"1","schema_version":"1"}]},
  "http": [{
    "method": "POST",
    "path": "/_tendril/workflows/review/respond",
    "expect_body": {"data": {"version": 3, "choice": "revise"}},
    "json": {"accepted": true}
  }]
}
```

Request body assertions compare JSON values, including nested objects. A mismatch
returns `fixture_mismatch`. `once`, `update` and `broadcast` allow explicit
scenario transitions. `mocked_http` in the report records what was simulated.
Undeclared service operations return `501 preview_unsupported`; missing page or
runtime assets return 404. The report fails when page errors or console errors
occur, including a missing script. No success fixture implies authorization,
quota safety, transaction atomicity or external exactly-once effects.

Other ordered steps can set `role`, `scopes`, `presence`, `state_ops` or `streams`,
fill a selector, reload, supply a reply, and assert visible text or accepted events.
`$event.seq` and `$device.id` resolve actual fixture identities instead of invented
IDs. Steps preserve order and failures are included in `fixture_trace`.

Use the real service suites for privacy, permissions, transactional rollback,
retention and host delivery. Use actual devices for consent and sensor behavior.
The preview is a development tool, not a second implementation of those guarantees.
