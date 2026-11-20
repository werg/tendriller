# Preview authored files and verify the real application

**Use file preview for layout; use an authorized hosted page for this starter's
live session.** The [first-app guide](../BUILD_AN_APP.md) supplies a complete
native/browser composition. Its connected page uses real authority, enrollment,
keys and peer transports; a localhost tab does not inherit those things.

## Choose the check you need

| Goal | Command or surface | What it establishes |
| --- | --- | --- |
| Inspect the authored UI immediately | `npx tendril-preview ./page` | Local rendering of the exact authored asset graph |
| Capture the layout in a browser | `npx tendril-preview ./page --headless --desktop --out preview.png` | A screenshot and browser errors from that graph |
| Exercise the starter's real app/session | Signed publication on its authorized Tendriller page, with `npm run peer` running | Real commands, queries, operation journal, key acquisition and peer synchronization |
| Test a separate development environment | Create/claim/init/publish/enroll a development page using the same source | The same application implementation with an explicit separate identity and data |
| Validate the local host integration from the core checkout | `npm run test:first-app -- --session-archive /absolute/path/to/chronolog-peer-session.tgz` | An isolated packed host, synthetic local account, real application sessions and scripted browser checks |
| Integrate an already implemented local session bootstrap | `--bootstrap` naming an existing authored `openPreview` module | Exactly the real backend and cleanup supplied by that module |

The local integration command is an acceptance harness, not a persistent
production proxy or a promise of live OAuth behavior. It tears down its isolated
environment after checking it. See [development verification](../DEVELOPMENT.md)
for prerequisites and recorded limits.

## File preview is immediately runnable

From the application directory after `npm run build`:

```sh
npx tendril-preview ./page
```

The returned localhost URL serves the complete authored files. Opening the
canonical URL captures current edits as a new content-addressed graph. Existing
publication URLs retain their exact old bytes, including nested relative
assets. Symlinks and paths outside the authored directory are refused. Preview
keeps at most 64 graph revisions; restart it to reset that inspection history.

The first-app UI labels this mode as a layout preview and disables hosted device
setup. It has no supplied application backend. Seeing the layout is useful
early feedback; it does not establish retained state, a connected agent, SQL
execution, or working inference. Those use the real session and optional
capabilities described in [the capability map](../CAPABILITIES.md).

## The runnable live-review path

For the same actual application and retained data, use its actual authorized
page origin. Once the first-app create/claim/init steps are complete, stop the
native peer if it owns the device and run:

```sh
npm run build
npx tendril --session ./session.mjs publish ./page --operation notes-review-1
npx tendril --session ./session.mjs publication
npm run peer
```

Open the saved page URL and the selected release while signed in. If this
browser is new, follow the supplied [enrollment step](../BUILD_AN_APP.md#6-enroll-and-connect-the-owners-browser),
then connect it. Verify a browser command natively, a native command in the
browser, and same-device reopening. Stop the peer before a CLI command needs
the same native store, then resume it. The native peer must remain available
for the starter's coordinator and key-donor role.

The publication operation ID identifies this exact authored graph. If its reply
is uncertain, retry the same ID with unchanged files. A changed graph needs a
deliberate new publication ID. Opening an existing immutable release URL keeps
that release; use the page's **Open latest version** control to review the
newly selected publication.

For development data, create a separate development project/page and run those
same steps with its own private handle, descriptor and enrolled devices. Reuse
the same domain, session/Worker implementation, helpers and runtime backend.
The environment configuration selects the intended application. This verifies
the same implementation, but it is not the production application's session
identity or retained history. Review production data only through its own
authorized page and session.

## What the optional bootstrap hook actually provides

`--bootstrap` is an extension contract for an application that already has a
complete authorized local composition. It is not another required file missing
from the first-app starter. Do not invent `deployment.mjs` merely to pass this
flag or replace the app with a mock state provider.

The named module must exist inside the authored graph and export
`openPreview({ configuration })`. Its result has:

| Field | Required behavior |
| --- | --- |
| `application` | The real common backend made by `createApplicationBackend({ id: session.applicationId, session })` from `@chronolog/peer-session/tendriller` |
| `signals` (optional) | That session's actual live-signal surface |
| `close()` | Detaches this preview from its owner and closes resources created exclusively for this preview; owner shutdown is a separate explicit lifecycle |

The tool then calls
`startRuntime(configuration, { application, signals })` and exposes its
initialization promise as `globalThis.tendrilReady`. The selected application
identity comes from that real backend. A browser composition normally obtains
its facade through `openBrowserOwner`, while `serveBrowserOwner` in the owning
Worker controls the retained signer/store. Several preview documents may attach
to that one profile; their drafts and pending references remain per-view.

The bootstrap is responsible for real device creation or resume, verified
authority, enrollment and peer access from that local origin. The preview server
serves authored/runtime assets. It has no host account/application API under
`/_tendril/` and does not accept peer WebSocket upgrades. It does not forward
your agent token or hosted account cookie.

This origin boundary is concrete: localhost has a different cookie context,
IndexedDB device identity and storage from the hosted page. Removing an origin
check does not provide authorization or keys. Do not copy a production signer,
epoch key or cookie into a public bootstrap, or add an implicit credential
proxy to make the preview appear connected. An explicitly configured local
real host can supply its own development accounts and enrollment; that is a
separate environment, as in the integration harness above.

Keep SQL/WASM imports inside the session's lazy `createEngine` factory.
Protocol installation does not require opening a database. If the composition
owns an external SQL VFS pool, its close function must release it after the
session's database handles close. The [SQL starter](../STATE_MODELS.md) describes
that separate engine and lifetime boundary.

## Headless layout and interaction checks

With Playwright available in the application project, capture the authored
layout:

```sh
npx tendril-preview ./page --headless --desktop --out preview.png
```

Install Playwright in the project or supply `--playwright-path MODULE` with an
existing installation. `--desktop` selects a wider viewport, `--headed` makes
the browser visible, and `--wait-ms` adds a bounded observation interval.
Browser actions and screenshots require `--headless`; `--headed` can accompany
it when you want to watch that scripted browser run.

`--steps actions.json` accepts authored DOM actions such as `fill`, `click`,
`select` and `wait`. Choose selectors and interactions that exist in the graph
being tested. A layout-only run cannot fill disabled connected-app controls or
manufacture a real command outcome. For an already implemented live bootstrap,
the same headless options can drive its authored controls and the harness
awaits its `close()` before ending the browser/server.

Screenshots and interaction results describe the actual graph and composition
you ran. Record live authorization, peer connectivity, device durability,
inference/provider use and target-device qualification separately. The
[delivery checklist](../AGENT_DELIVERY.md) names the evidence needed before
calling the application connected and complete.
