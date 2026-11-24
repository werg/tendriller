# Shared inventory: optional SQL starter

Follow [Choose retained state](https://tendriller.dev/docs/STATE_MODELS.md).
This directory is a separate application with its own private handle and device
store. It does not convert or overwrite the Shared Notes application.

Use the selected service's `/api/readiness` before acquiring or building the
optional SQL packages. `create` repeats that anonymous check and the host
contract check before loading native SQL code, then verifies the engine before
creating a page. Paused, read-only, unavailable or unsupported readiness stops
setup without private state or a production fallback. A saved handle resumes
only against the same service origin, without creating another page or reopening
an engine; retain the original directory and signing identity on resume.

`domain.mjs` declares the schema, a one-time seed command, and one guarded
transfer that changes two bins, inserts a receipt and emits an event atomically.
`setup.mjs` creates and configures the hosted application with its signed schema
and exact engine manifest. `session.mjs` reopens and participates through the
same public application session used by the events starter. `demo.mjs` checks
accepted and rejected transfers and retained state after a close/reopen.

When adapting the domain, edit its schema/commands/queries and the domain UI,
demo and display names. The build derives definition ID/version into public
configuration and verifies the public definition binding against the retained
initialized descriptor. A mismatch removes `page/` and asks you to restore the
original definition or use a fresh project; it never resets the existing signer
or history. Initialization uses a coherent read view rather than an `inventory`
query, and generic peer logs report change revisions. Keep SQL execution and
lazy engine loading in the native/owning Worker composition.

The native path requires a Chronolog archive built with `--sql-native` and the
patched native engine. The default events archive cannot run this directory.
`worker.mjs` supplies the owning browser composition of the same domain. Browser
SQL additionally needs `--sql-browser`, the exact separately built WASM assets,
an enrolled browser and a supported OPFS SQL VFS. `index.html` and `page.mjs`
provide the inventory UI; installing an events archive does not qualify SQL.
Node 24 is the qualified native tutorial runtime; the starter requires at least
24. Core's separate minimum remains Node 22.15. To parse setup results, use
`npm run --silent init` or `node setup.mjs init` and read stdout as JSON. Preserve
stderr diagnostics and nonzero exit statuses; do not suppress warnings globally.

Run this directory within the downloaded starter kit: its standalone peer uses
the shipped `../helpers/cli-lifetime.mjs`. Ctrl-C awaits the SQL session and
supervisor cleanup, flushes output, then disposes only the standalone process.
Cleanup/flush failure stays nonzero. Imported `openSession` and `runPeer` leave
process lifetime to their caller.

The native peer runs a private supervisor. Normal CLI invocations attach to it;
use `--mode own` for an explicit one-off command while the owner is stopped.
Fresh `local-terminal` bindings explicitly grant `publish` and ordinary application
capabilities, without `ownerAdmin`. Resuming preserves the saved policy. Older
bindings need a deliberately created, separately scoped publication credential
from `supervisor.createBinding`; do not silently broaden or reactivate them.
Browser documents use `openBrowserOwner` with `requiresDedicatedWorker: true`
against this directory's bundled `worker.mjs`. Synchronous OPFS APIs are not
available in SharedWorker in the qualified browser. Automatic mode therefore
elects a dedicated Worker under an exclusive Web Lock; forcing shared mode
returns `OWNER_STORAGE_UNSUPPORTED` before opening storage. All documents attach
to that one SQL owner, and detaching a document does not close sibling views.
The lazy WASM/VFS lifetime belongs to the owner, with database handles closed
before pool cleanup.

With the resident SQL peer running, `node session.mjs diagnostics` (or
`node session.mjs status PROFILE`) takes one local authenticated-link sample and
detaches. It opens no SQL engine or signing store. Counters are per current link,
reset on replacement, and do not measure billing or applied/retained operations.
See [transport diagnostics](https://tendriller.dev/docs/TRANSPORT_DIAGNOSTICS.md).


Build and publish the SQL page from this directory after same-origin readiness
and package acquisition described in the state-model guide:
Prepare all four engine files and publish the complete page before owner
sign-in. Prepared and claimed pages use the same advertised file-size budget;
claim is not a prerequisite for uploading the WASM engine.

```sh
npm run create -- https://YOUR_SERVICE VERIFIED_OWNER_EMAIL "Shared inventory"
npm run init
npm run demo
# Install the matching combined --sql-native --sql-browser session archive in
# the parent starter, together with its public SDK/tools and esbuild dependency.
# Copy manifest.json, sqlite3.mjs, sqlite3.wasm and sqlite3-opfs-async-proxy.js
# from that exact build into this directory's engine/ (not into page/).
npm run build
npx tendril --session ./session.mjs --mode own --timeout 120 publish ./page --operation inventory-release-1
npm run peer
```

The owner signs in at the ready page URL. Build/publish before claim; the host
handle alone is not a connected application. Publish only `page/`. The build
requires initialized matching public configuration, verifies WASM bytes and the
installed SQL package's supported manifest, copies all four engine files, and
removes stale/partial output on any failure. It never falls back to a static
preview. Runtime still verifies the signed authority and execution-manifest
binding before opening SQL. Keep `.tendriller/`, keys, stores and signed attempts
outside published assets.

For later UI updates, keep the SQL peer running and publish through its explicit
publication binding:

```sh
npm run build
npx tendril --session ./session.mjs --mode attach --timeout 120 publish ./page --operation inventory-review-1
npx tendril --session ./session.mjs --mode attach publication
```

Fresh CLI bindings include `publish`. Retained bindings keep their old policy;
the owner can deliberately provision a narrow publication credential using
[the existing supervisor](https://tendriller.dev/docs/tools/CLI.md#publication-capability-and-retained-bindings).
The signing device's publisher grant remains a separate requirement.

On an uncertain reply, preserve the exact output and operation ID. Inspect an
attached operation through the same retained profile and binding using
`publication-operation inventory-review-1`, and compare its receipt with the
selected head before an exact retry. The initial `inventory-release-1` above
used `--mode own`; inspect it through that same standalone ownership path while
the peer is stopped. A timeout does not cancel a saved owner publication.

A new browser deliberately chooses **Create or resume browser device**. It shows
its own stored public key without exporting its signing identity. Verify that
key; stop the native peer before running `npm run enroll -- PUBLIC_KEY` in this
same SQL project, then restart `npm run peer` and reload the page in the same
browser profile. This is explicit native administrator enrollment, not the
Shared Notes owner-review pairing workflow. Lost enrollment replies reuse the
saved signed request. Keep the native coordinator running for writes and epoch
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
history and pending intent. Other browser views and the native peer have their
own lifetimes. Reload resumes the same profile. Do not erase browser site data
or `.tendriller/` to repair setup. The diagnostics JSON is unencrypted health
information, not an encrypted checkpoint, backup or migration export. Lifecycle
callbacks cannot guarantee storage flush on eviction; the page saves intent
before commands rather than relying on shutdown.

Qualification must use the exact published graph: demonstrate a transfer, its
applied read on another participant, persistence after reload and verified signed
publication. Pure Node UI/build tests cover reviewed guards, uncertain retry and
failed-output cleanup; they do not qualify browser SQL, OPFS, enrollment or
transport. Existing remote browser SQL regressions cover their own SQL fixture,
not automatically this inventory UI. Run full browser qualification remotely.
