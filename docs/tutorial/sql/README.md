# Shared inventory: optional SQL starter

Follow [Choose retained state](https://tendriller.dev/docs/STATE_MODELS.md).
This directory is a separate application with its own private handle and device
store. It does not convert or overwrite the Shared Notes application.

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
