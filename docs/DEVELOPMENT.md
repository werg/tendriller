# Develop and verify Tendriller

Use Node 22.15 or newer. `npm ci` installs the repository tools. The plain HTTP
API and browser scripts do not require an application framework.

## A supported loop

1. Run `npm run build` once, then `npm run preview -- recipes/field-notebook`.
   Open the printed localhost URL. This loads the **production `tendril.js`**, its
   real control, state, IndexedDB outbox, service worker and health reporting.
2. Edit the recipe. Reload to inspect page changes. Use `npm run build:watch` in a
   second terminal when editing runtime modules, snippets, recipes or assets.
3. Run `node cli/bin/tendril.mjs preview recipes/field-notebook --fixture recipes/field-notebook/scenario.json`.
   Inspect the screenshot, actual events, public API call trace, server-side state
   and activity. A preview is a deterministic local adapter, not a live host.
4. Run `npm run check` for the contract, types, Worker service and CLI checks.
   Run `npm run test:browser` for the shipping browser suites.
5. Attach a verified host receiver before publishing to a real page. Use the
   delivery probe and first real reply to confirm the intended conversation.

`npm run dev` builds assets, applies local D1 migrations and supervises both
Wrangler and a continuous asset build. Runtime, snippet, bridge, schema and
recipe changes rebuild automatically. Wrangler watches the resulting assets.
Local public-service identity and provisioning still follow `OPERATIONS.md`;
the isolated E2E runner seeds its own temporary identities without OAuth secrets.

## What preview tests

Preview runs the same browser code users receive. It does **not** replace
`window.tendril` with a fake API. A local WebSocket/HTTP adapter acknowledges
events, stores state using the server's compiled state implementation, stores
uploaded bytes, deduplicates retries, records reply receipts and models roles.
The trace wraps public methods and calls through to their real implementations.

The service worker caches page assets for offline use, while live `_tendril/`
API requests always reach the service. It removes legacy cached API responses
and respects `no-store`. Preview files use `no-cache`, so editing an external
JavaScript or CSS file and reloading retrieves the current file; its latest
saved copy remains available offline. Published asset requests retain the
loaded page's version. Explicitly immutable assets can use their cached copy.

Fixtures retain click, fill, permission denial, location, motion and hardware
steps. Additional steps are:

```json
{
  "role": "owner",
  "reply": "Your observation arrived.",
  "steps": [
    { "click": "#send", "expect_send": { "type": "observation" } },
    { "reply": { "text": "Take the next measurement", "speak": false } },
    { "state_ops": [{ "op": "set", "path": ["result"], "value": null }] },
    { "offline": true, "expect_connected": false },
    { "offline": false, "expect_connected": true },
    { "role": "display" }
  ]
}
```

`reply` at the fixture root provides a scripted response to each event. It does
not call a model. `reload`, `presence`, and `expect_connected` steps exercise
recovery and status. Persistent media and event replay use the real browser
outbox. Voice models are not automatically downloaded; audio defaults to muted
in preview, and a fixture can explicitly enable it.

`expect_send` waits for a public API invocation; `expect_event` waits for the local
server to accept an event whose data matches the supplied fields. Use the latter
before an agent response that refers to `$event.data.run.id`, `$event.seq`, or
another field of the last accepted event. `$device.id` resolves the actual browser
identity. These exact-value references work in state operations and response
bodies, so scenarios do not need guessed UUIDs.

Owner-only HTTP workflows can use explicit fixture routes:

```json
{
  "http": [{ "method": "GET", "path": "/_tendril/decisions", "json": { "decisions": [] } }],
  "steps": [{ "http": [{ "method": "GET", "path": "/_tendril/decisions", "json": { "decisions": [] } }] }]
}
```

A route can also have `status`, `expect_body`, `once`, `update` (replacement
routes after a successful match), and `broadcast` (a server message). Preview
lists each request in `mocked_http`; mocked service responses are explicit, and
the actual Worker suites cover their authorization and concurrency behavior.
Capability reports come from the browser itself. Use `hardware` and `denied`
fixtures to alter its inputs; the old `capabilities` API replacement is rejected.

OAuth, account claims, abuse controls, production limits, external host wake
admission, and real push delivery require the isolated Worker E2E suite or a
staging/live-host check. Unsupported adapter messages return
`preview_unsupported`; preview never silently pretends they succeeded.

## One public contract

`contract/index.mjs` owns the executable JSON schemas and validation.
`contract/index.d.mts` exports the browser, event, result, state, session and
device types. The Worker uses these schemas at write boundaries, MCP advertises
the same schemas, and preview uses the same validators. `runtime/src/types.ts`
imports the common identities and gives `window.tendril` a public type.

After changing a schema, run `npm run contract:generate` and commit the generated
`contract/v1.json` and `recipes/ui-schema.json`. CI checks that these files match.
The service exposes `/contract/v1.json`; the interface schema remains at
`/recipes/ui-schema.json`. Arbitrary application state and page event data remain
extensible. Public request envelopes reject obsolete or misspelled fields.

The small fetch client is usable without a framework:

```js
import { createClient } from "./contract/client.mjs";
const page = createClient(privateHandle);
const batch = await page.readEvents({ after: lastHandledSequence, wait: 300 });
await page.say({ text: "I received your measurement.", in_reply_to: batch.events.at(-1).seq });
```

The explicit cursor is deliberate: the caller decides when handling is complete.
`createPage(service, { owner, name })` validates the supported creation body before
sending it. `ApiError` preserves HTTP status, stable code and field details.
`npm link` makes the repository CLI available as `tendril`; package exports expose
the client, contract and browser declarations without requiring publication.

## Shipping gates

`npm run check:release` runs both non-browser and browser gates. The browser gate
includes runtime core, current control, push/rules, TTS, snippets, real-runtime
preview, every catalog recipe with a `scenario` field, and the isolated public Worker lifecycle. The latter covers owner claims,
listener-required publication, delivery, rendering, speech and cross-origin
behavior. Each suite writes to its own directory under `test-results/`: `runtime`,
`control`, `push`, `tts`, `snippets`, `preview`, and `e2e`. A later suite therefore
cannot clear an earlier suite's diagnostics. Failures retain Playwright traces and
screenshots; recipe preview screenshots and JSON attachments stay with their test.
CI uploads the complete directory, including hidden diagnostic files, as
`browser-failure-traces`. The optional staging suite uses `test-results/public`
and the legacy voice suite uses `test-results/legacy-voice`.

The old `runtime/test/real-server.spec.ts`, `test/e2e/core.spec.ts`, and
`runtime/test/voice` files describe an earlier anonymous service/realtime voice
implementation. They are not shipping gates. Current public-service E2E and
speech/TTS suites replace those flows. New service tests should be named
`server/test/*.public.test.ts` so the supported gate includes them automatically.

Install Chromium once with `npx playwright install chromium`. An existing local
browser can be selected explicitly with `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`.
If the host forbids browser processes or local sockets, run the non-browser checks
there and let CI execute browser/Worker suites; do not mistake that environment
restriction for a passing test.
