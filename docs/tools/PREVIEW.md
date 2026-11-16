# Preview through the released runtime

The preview command serves a local page using the exact `@tendriller/runtime`
artifact recorded in `core.lock.json`. The browser runs production state,
conversation control, durable outbox, generation capture and service-worker
logic. A separate fixture transport provides explicit deterministic responses.
It does not implement authentication, workflow privacy or transaction atomicity.
Use the real-service tests for those guarantees.

```sh
tendril scaffold field-notebook ./notebook
tendril-preview ./notebook --fixture ./notebook/scenario.json
```

The command prints a loopback URL. Every page navigation snapshots its complete
local files and declared component dependency graph into an immutable publication.
The publication pins its runtime identity too. After editing, open the printed
canonical URL to select the new publication. Reloading an already executing
publication preserves its original bytes, including lazily loaded components.
Offline reload uses the same complete graph when the browser has cached it.

Serving a local preview in a browser requires only Node.js 22.15+. For
headless scenarios/screenshots, install Playwright and Chromium from the
directory where you launch the helper:

```sh
npm install --no-save playwright
npx playwright install chromium
```

A preview uses **local fixtures**, never the live service. A built-in
control showing "Offline" refers to its disconnected local fixture socket
or an explicit scenario `offline` step, not to a live agent or internet
outage. `tendril.connected` reports the local socket state. Preview
health does not claim a real page or confirm a live publication.

For automated steps and a screenshot, install Playwright in the working project
and run:

```sh
tendril-preview ./notebook --fixture ./notebook/scenario.json --headless --out ./notebook.png
```

A missing Playwright installation or browser is reported explicitly. The
standalone server needs no browser library to serve a page. It does not fetch
executable code or models. Speech transcription is disabled in the fixture
configuration; browser speech and ordinary text inputs remain available.

## Fixture shape

A fixture is JSON with optional `state`, `role`, `scopes`, `permissions`,
`geolocation`, `denied`, `hardware`, `streams`, `http`, `reply` and `steps`.
Capabilities come from the real browser. `denied` and `hardware` configure browser
inputs; there is no replacement runtime capability report.

For a protected page, provide explicit scope descriptors:

```json
{
  "scopes": [{
    "id": "sessions:notebook",
    "generation": "fixture-notebook",
    "paths": [["notebook"]],
    "operations": []
  }],
  "steps": [
    {"fill": "#note", "value": "A flower beside the path."},
    {"click": "#send"},
    {"expect_event": {"type": "notebook.observation"}}
  ]
}
```

The adapter checks captured generations with the public runtime helper. It
never derives an authoritative generation from application state or event data.
A `scopes` step replaces the descriptor set explicitly, allowing stale-work UI
scenarios. It does not activate a real server module.

Ordered steps can fill or click controls; change roles, connection state or
presence; apply `state_ops`; append stream records; send an agent `reply`; or
reload the current publication. `event` plus `data` delivers a supported fixture
transport event. The runtime accepts those frames only with explicit preview
configuration. `motion` and `hardware_event` drive the corresponding browser
fixtures. `wait_ms` delays a step when needed.

Assertions include `expect_text`, `expect_connected`, `expect_send` for recorded
public method calls, `expect_event` for accepted application events, and
`expect_no_send`. Exact-value references such as `$event.data.observation_id` or
`$device.id` resolve from the most recent fixture event/device. They are data
references, never evaluated code.

## Explicit HTTP responses

Private workflow interfaces are always explicit operation paths. A fixture can
match a method and path, optionally check top-level request envelope fields,
and provide `status` and `json`:

```json
{
  "http": [{
    "method": "POST",
    "path": "/_tendril/workflows/sessions/responses",
    "json": {"participant": "fixture-owner", "responses": []}
  }]
}
```

`expect_body` compares declared top-level fields by exact JSON value. For a
workflow body, app fields belong inside `data`; command identity and generation
preconditions are separate. `once` consumes a response, `update` installs the
next explicit fixtures, and `broadcast` emits a protocol frame. Undefined
operations return a fixture error. Successful mocked responses are not evidence
that real authorization or module transactions passed.

## Stream fixtures

Declare each stream using its public definition and bounded initial records:

```json
{
  "streams": [{
    "name": "metrics", "durability": "durable",
    "records": [{"id": "sample-1", "type": "sample", "data": {"value": 12}}]
  }],
  "steps": [{
    "streams": [{"name": "metrics", "records": [
      {"id": "sample-2", "type": "sample", "data": {"value": 13}}
    ]}]
  }]
}
```

The adapter uses released record bounds and history algorithms. Real runtime
subscriptions perform retained replay, reconnect catchup and live delivery.
Ephemeral streams report that history is unavailable. Permission changes affect
subsequent reads and live subscriptions. No producer credential or collector is
created by a fixture.

## Verification ownership

`npm run test:preview` exercises the real runtime with fixture transport.
`npm run test:portable` covers the six complete workflows in Chromium, Firefox
and WebKit, including accessibility and offline publication closure.
`npm run test:components` tests individual component APIs with explicit browser
fixtures. `npm run test:e2e` uses an independently started authenticated service.

Headless preview returns `uncaught`, `console`, `events`, `calls`, `mocked_http`
and `fixture_trace` alongside its screenshot result. Keep this evidence separate
from actual service test results. `npm run capture:recipes` generates presentation
images and records the exact runtime identity used for the capture.
