# Shared inventory: optional SQL page template

Follow [Choose retained state](https://tendriller.dev/docs/STATE_MODELS.md).
A page created from this template is its own application with its own private
records and device store inside the workspace; it never converts or overwrites
another page. It shares the workspace's one agent key and agent program.

`domain.mjs` declares the schema, a one-time seed command, and one guarded
transfer that changes two bins, inserts a receipt and emits an event atomically.
`setup.mjs` configures the hosted application with its signed schema and exact
engine manifest. `agent.mjs` is this page's owner inside `tendril agent run`, using
the same shared native composition as the notes template. `demo.mjs` attaches to
the running agent program and checks accepted and rejected transfers and retained
state after detaching and attaching again.

The native path requires a Chronolog archive built with `--sql-native` and the
patched native engine; the default events archive cannot run this template.
`npm run page:new -- SLUG --template inventory` loads that engine before creating
any hosted page. `worker.mjs` supplies the owning browser composition of the same
domain. Browser SQL additionally needs `--sql-browser`, the exact separately built
WASM assets, an enrolled browser and a supported OPFS SQL VFS.

```sh
npm run page:new -- stock --template inventory --name "Shared inventory"
npm run init -- stock
npm run agent          # keep running; it opens the page once initialized
npm run demo -- stock
# Copy manifest.json, sqlite3.mjs, sqlite3.wasm and sqlite3-opfs-async-proxy.js
# from the exact --sql-browser build into pages/stock/engine/ (not into dist/).
npm run build -- stock
npm run deploy -- stock
```

The owner signs in at the page URL that `page:new` printed. Build and publish
before claim. Publish only `pages/stock/dist/`. The build requires initialized
matching public configuration, verifies WASM bytes and the installed SQL
package's supported manifest, copies all four engine files, and removes
stale/partial output on any failure. Runtime still verifies the signed authority
and execution-manifest binding before opening SQL. Keep `.tendriller/` outside
published assets. When adapting the domain, the build refuses a definition that
differs from the retained initialized descriptor; restore it, or create a new page.

Browser documents use `openBrowserOwner` with `requiresDedicatedWorker: true`
against this page's bundled `worker.mjs`. Synchronous OPFS APIs are not available
in SharedWorker in the qualified browser, so automatic mode elects a dedicated
Worker under an exclusive Web Lock. All documents attach to that one SQL owner.

A new browser deliberately chooses **Create or resume browser device**. It shows
its own stored public key without exporting its signing identity. Verify that
key; stop `npm run agent` before running `npm run enroll -- SLUG PUBLIC_KEY`
(the agent program owns this page's device while it runs), then restart
`npm run agent` and reload the page in the same browser profile. This is explicit native administrator enrollment, not the
Shared Notes automatic browser pairing. Lost enrollment replies reuse the
saved signed request. Keep the agent program running for writes and epoch
key delivery. Signing in alone does not enroll a device.

The table renders `inventory.stock` as `{ id, units }`. Transfer captures the
displayed revision and both reviewed balances and sends `transfer` with
`transferId`, `from`, `to`, `units`, `expectedSource`, `expectedDestination`.
Guards execute atomically; changed balances reject the whole operation. The UI
retains the exact intent before its first RPC. Until an applied accepted or
rejected outcome is observed, new transfers are blocked; inspect or retry the
original operation, including after reload. Retry uses the session's saved
attempt when present, otherwise resends the original input and revision. It
never silently re-reviews changed balances. Recovery exclusions require explicit
review of the original history and current balances; this UI does not reapply
automatically or discard unresolved intent. Applied does not prove peer retention.

**Detach this view** releases only this attachment, preserving device storage,
history and pending intent. Other browser views and the agent program have their
own lifetimes. Reload resumes the same profile. Do not erase browser site data
or `.tendriller/pages/` to repair setup. The diagnostics JSON is unencrypted health
information, not an encrypted checkpoint, backup or migration export. Lifecycle
callbacks cannot guarantee storage flush on eviction; the page saves intent
before commands rather than relying on shutdown.

Qualification must use the exact published graph: demonstrate a transfer, its
applied read on another participant, persistence after reload and verified signed
publication. Pure Node UI/build tests cover reviewed guards, uncertain retry and
failed-output cleanup; they do not qualify browser SQL, OPFS, enrollment or
transport. Existing remote browser SQL regressions cover their own SQL fixture,
not automatically this inventory UI. Run full browser qualification remotely.
