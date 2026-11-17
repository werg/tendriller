# Preview exact authored files and the real session

The preview serves a complete authored asset graph. It does not emulate hosted
state, streams, event sockets, upload receipts or a second application runtime.
A static page can be inspected without installing application services:

```sh
tendril-preview ./page
```

The returned localhost URL serves the authored files. Opening its canonical URL
captures current edits as a new content addressed graph. Existing publication
URLs keep their exact old bytes, including nested relative assets. Symlinks and
paths outside the authored directory are refused. Preview keeps at most 64 graph
revisions; restart it to reset that local inspection history.

## Install the application's owned session

A live application supplies an authored browser module:

```sh
tendril-preview ./page --bootstrap deployment/preview.mjs
```

That module exports `openPreview({ configuration })` and returns
`{ application, signals?, close }`. `application` is the common Tendriller backend
made with `createApplicationBackend` from `@chronolog/peer-session/tendriller`.
`signals` is that session's live-signal surface. `close` closes the owned session
and any resources created by the deployment. The preview calls
`startRuntime(configuration, { application, signals })` with the selected backend
identity and exposes its promise as `globalThis.tendrilReady`.

The bootstrap owns real device creation or resume, verified enrollment inputs,
worker/storage lifetime and peer transports. Bundle or supply all of its public
runtime assets in the authored graph. A browser can use the public Worker session
facade while keeping the signer and durable store out of the page:

```js
import { createApplicationBackend } from './chronolog/tendriller.mjs';
import { connectApplicationWorker } from './chronolog/browser.mjs';

export async function openPreview() {
  const worker = new Worker(new URL('./application-worker.mjs', import.meta.url), { type: 'module' });
  const session = await connectApplicationWorker(worker);
  return {
    application: createApplicationBackend({ id: session.applicationId, session }),
    signals: session.signals,
    async close() { await session.close(); worker.terminate(); },
  };
}
```

The worker module opens the actual application and calls the public
`serveApplicationWorker` from `@chronolog/peer-session/worker`. Opening the session
starts its lightweight protocol participant. Database code and OPFS stay deferred
until the authored page actually uses durable data; signaling and control do not
wait for a database. Keep SQL/WASM imports inside the materializer factory. Its
enrollment and connection configuration are part
of the complete deployment, not hidden preview fixtures. Production and preview
use the same commands, queries, journal and recovery behavior. Missing setup is
an explicit error; the preview does not substitute an in-memory data model.

## Run browser checks

```sh
tendril-preview ./page --bootstrap deployment/preview.mjs --headless \
  --steps actions.json --out preview.png
```

The optional JSON steps contain DOM actions such as
`{"action":"fill","selector":"#title","value":"Review"}`,
`{"action":"click","selector":"#submit"}` and
`{"action":"wait","selector":"#result","state":"visible"}`.
They drive authored controls. They cannot directly change state, inject a receipt
or impersonate a host message. Screenshots and browser errors describe the actual
local execution and supplied bootstrap.

Install Playwright in the project or supply `--playwright-path MODULE`.
`--desktop` selects a wider viewport, `--headed` opens the browser visibly, and
`--wait-ms` adds a bounded observation interval. The harness awaits the supplied
session's close before ending the browser and local server.

A local preview is not evidence of deployed login, permissions, Internet
connectivity, device durability or billing. Use the independent packed artifact
gates and real deployment qualification for those boundaries.
