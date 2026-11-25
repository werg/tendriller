# Preview authored files and verify the real application

Use file preview for immediate layout review. Use the supported
[isolated local host](../LOCAL_HOST.md) for connected UX review with synthetic
owner access and development data. Its matching release kit runs the real
application session, commands, queries, enrollment and peer transports before
production sign-in. Review production state through its own authorized page.

## Choose the check you need

| Goal | Command or surface | What it establishes |
| --- | --- | --- |
| Inspect the authored UI immediately | `npx tendril-preview ./pages/notes/dist` | Local rendering of the exact authored asset graph |
| Capture the layout in a browser | `npx tendril-preview ./pages/notes/dist --headless --desktop --out preview.png` | A screenshot and browser errors from that graph |
| Exercise the starter's real app/session | Signed publication on its authorized Tendriller page, with `npm run agent` running | Real commands, queries, operation journal, key acquisition and peer synchronization |
| Review connected UX before production sign-in | `npm run dev:host -- --release FULL_SOURCE_SHA --state /absolute/isolated-state --open`, then use its matching kit | The selected sealed host release, synthetic owner, real application implementation and separate development identity/data |
| Validate the local host integration from the core checkout | `npm run test:first-app -- --session-archive /absolute/path/to/chronolog-peer-session.tgz` | An isolated packed host, synthetic local account, real application sessions and scripted browser checks |
| Integrate an already implemented local session bootstrap | `--bootstrap` naming an existing authored `openPreview` module | Exactly the real backend and cleanup supplied by that module |

The `test:first-app` integration command is an acceptance harness that tears down
its isolated environment after checking it. The supported `dev:host` runner
retains its own development state for interactive work. See
[local host setup](../LOCAL_HOST.md) and [development verification](../DEVELOPMENT.md)
for their prerequisites and recorded limits.

## File preview is immediately runnable

From the workspace after `npm run build -- notes`:

```sh
npx tendril-preview ./pages/notes/dist
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

## Connected UX review before production sign-in

Follow [the local-host procedure](../LOCAL_HOST.md) using the full source SHA of
the release you intend to qualify. The runner verifies its sealed manifest,
packed host, public assets and matching first-app kit. Use a fresh local
workspace directory and the generated local network preload. Register its agent,
create a page, initialize and publish the same application source, keep
`npm run agent` running, then sign in and have the agent admit the browser through the synthetic
test account in the runner's Chromium profile. This is a separate development
agent and page with their own keys and data.

Seed realistic examples through the domain's real commands, including empty
and long-content cases. Do not substitute a mock state provider for connected
review. Walk each main flow at **1440×900** and **390×844**: create or edit, inspect
the applied result from another participant, navigate Back/deep links, reload,
and check loading, unavailable and uncertain-operation states. Capture
before/after screenshots and fix the observed friction before final delivery.
[Agent delivery](../AGENT_DELIVERY.md#the-user-experience-is-part-of-the-deliverable)
defines the flow evidence.

Production OAuth and owner sign-in are not prerequisites for this local UX pass.
Record the release source/composition, selected publication, development-data
scope, browser and viewports. Production authorization, real owner enrollment,
remote providers and physical-device behavior still require their own checks;
local results do not claim those observations.

The runner supplies the real host and browser setup already supported by the
project. It requires no new app backend, proxy, preview authentication route or
custom bootstrap. Use its Playwright installation; an existing Chromium can be
selected with `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` as documented in
[Local host](../LOCAL_HOST.md#1-start-the-selected-release). File preview can use
an existing Playwright module through `--playwright-path`.

## Review a running hosted application

For the application's actual retained data, use its authorized page origin.
Keep `npm run agent` running and publish through its explicitly authorized
attachment:

```sh
npm run build -- notes
npx tendril --page notes publish pages/notes/dist --operation notes-review-1
npx tendril --page notes publication
```

The [publication capability](CLI.md#publication-capability-and-retained-bindings)
is explicit; a retained binding is never elevated automatically.

Open the saved page URL and selected release while signed in. If this browser is
new, follow the supplied [verification and second-device step](../BUILD_AN_APP.md#6-verify-local-use-offline-readiness-and-another-device),
then connect it. Verify a browser command in a native read (when the optional agent
program is running), a native command in the browser, and same-device reopening.
Ordinary local Save does not depend on the agent program; it is needed only for
live native coordination and for admitting new devices, and attached
publication does not replace it.

The publication operation ID identifies the exact authored graph. After an
uncertain reply, inspect its retained receipt and the current selected head,
then retry the same identity with unchanged files when appropriate. A changed
graph needs a deliberate new operation. An immutable release URL stays on its
selected bytes; use **Open latest version** to review the current publication.

## What the optional bootstrap hook actually provides

`--bootstrap` is an extension contract for an application that already has a
complete authorized local composition. It is not another required file missing
from the first-app starter. Do not invent `deployment.mjs` merely to pass this
flag or replace the app with a mock state provider.

The named module must exist inside the authored graph and export
`openPreview({ configuration })`. Its result has:

| Field | Required behavior |
| --- | --- |
| `application` | The real common backend made by `createApplicationBackend(session)` from `@chronolog/peer-session/tendriller` |
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
npx tendril-preview ./pages/<slug>/dist --headless --desktop --out preview.png
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
