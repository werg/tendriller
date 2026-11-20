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

The native path requires a Chronolog archive built with `--sql-native` and the
patched native engine. The default events archive cannot run this directory.
`worker.mjs` supplies the owning browser composition of the same domain. Browser
SQL additionally needs `--sql-browser`, the exact separately built WASM assets,
an enrolled browser and a supported OPFS SQL VFS. This directory does not ship
a separate browser UI or claim that installing an events archive qualifies SQL.

Run this directory within the downloaded starter kit: its standalone peer uses
the shipped `../helpers/cli-lifetime.mjs`. Ctrl-C awaits the SQL session and
supervisor cleanup, flushes output, then disposes only the standalone process.
Cleanup/flush failure stays nonzero. Imported `openSession` and `runPeer` leave
process lifetime to their caller.

The native peer runs a private supervisor. Normal CLI invocations attach to it;
use `--mode own` for an explicit one-off command while the owner is stopped.
Browser documents use `openBrowserOwner` with `requiresDedicatedWorker: true`
against this directory's bundled `worker.mjs`. Synchronous OPFS APIs are not
available in SharedWorker in the qualified browser. Automatic mode therefore
elects a dedicated Worker under an exclusive Web Lock; forcing shared mode
returns `OWNER_STORAGE_UNSUPPORTED` before opening storage. All documents attach
to that one SQL owner, and detaching a document does not close sibling views.
The lazy WASM/VFS lifetime belongs to the owner, with database handles closed
before pool cleanup.
