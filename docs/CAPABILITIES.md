# Choose existing capabilities before building

Use this map as soon as the user's task is understood. Then follow
[Build an app](BUILD_AN_APP.md) and deliver the [running application](AGENT_DELIVERY.md).
The machine-readable equivalent is
[`/.well-known/tendriller-capabilities.json`](/.well-known/tendriller-capabilities.json).
Its task keywords, exact imports, examples and ownership boundaries are searchable.
It describes software capabilities; `tendril.capabilities()` separately inspects
the current browser without requesting permissions.

## Task to implementation

| When the task needs… | Start with… | Executable source / next guide |
| --- | --- | --- |
| Shared notes, checklists, retained facts, ordinary CRUD | One Chronolog definition with declared commands and `session.query` | `domain.mjs`, `setup.mjs`, `session.mjs`, `worker.mjs` in the [starter](/downloads/tendriller-first-app.tgz); [state choice](STATE_MODELS.md) |
| Atomic stock deduction, multiple related rows, relational guards | The optional SQL capability and a signed schema/engine manifest | `sql/` in the starter; [events versus SQL](STATE_MODELS.md) |
| State fetching and live UI refresh | `createLiveView(session, {query, input})` over real session queries and changes | `helpers/live-view.mjs`; [application patterns](APP_PATTERNS.md) |
| Operation status, uncertain replies, retry and recovery | The operation journal and `createOperationView` | `helpers/operation-view.mjs`; [application patterns](APP_PATTERNS.md) |
| Typing, presence, disposable progress | `session.signals.send/subscribe` | [Live signals](APPLICATION_SIGNALS.md) |
| Photo/file → analysis → editable suggestions → explicit commit | `createReviewedInput`, immutable session content and a declared command | `helpers/reviewed-input.mjs`, `media/`; [reviewed AI input](AI_INPUT.md) |
| Camera permission, preview and frame capture | Browser acquisition plus the supplied camera controller | `media/camera.mjs`; [reviewed AI input](AI_INPUT.md) |
| Active/pending sensor indicators and Stop all | `tendril.sensors.status/on/stopAll` | [Browser API](BROWSER_API.md#sensors-and-voice) |
| Speech recognition, transcription, audio output or wake modes | `createVoice` from `@tendriller/runtime/voice` | `media/voice.mjs`; [voice lifecycle](HANDS_FREE.md) |
| UI preview and headless browser interaction | `tendril-preview ./page`; add a real bootstrap for session execution | [Preview](tools/PREVIEW.md) |
| Inference using a protected provider credential | An explicitly enabled native participant with an allowed-device list and request budget | `media/inference-client.mjs`, `media/inference-service.mjs`; [reviewed AI input](AI_INPUT.md) |
| Agent-side tools and a connected process | The same owned session plus `createApplicationTools` / `serveApplicationToolLines` | [Delivery and process lifetime](AGENT_DELIVERY.md) |
| Hosted UI and signed publication | `createClient` from `@tendriller/core` and the authorized session publisher | [Build an app](BUILD_AN_APP.md) |

The starter's helper modules are ordinary, importable application source. Adapt
their rendering and interaction policy to the task. They are not new SDK exports,
another database, a synchronization protocol or a hidden server dependency.

## Use the correct package and layer

```js
import { defineApplication, defineCommand, defineQuery } from '@chronolog/peer-session';
import { createApplicationBackend } from '@chronolog/peer-session/tendriller';
import { connectApplicationWorker } from '@chronolog/peer-session/browser';
import { createVoice } from '@tendriller/runtime/voice';
import { createLiveView } from './helpers/live-view.mjs';
```

On a published page, optional voice can instead use the exact pinned runtime:

```js
const { createVoice } = await import(tendril.assetUrl('voice.mjs'));
```

`@tendriller/core/voice` and `@tendriller/core/browser` provide **types**, not runtime
constructors. The headless runtime constructor is
`startRuntime` from `@tendriller/runtime/kernel`. Browser signer, storage and
replication belong in the owning Worker; the page uses its facade. Native code
opens its own enrolled device through `@chronolog/peer-session/native`.

## Acquisition, tracking, interpretation and commit

These are separate responsibilities. A working camera example needs all the
relevant pieces, and each is visible in the supplied controller and review flow.

| Responsibility | Owner | What completion establishes |
| --- | --- | --- |
| Permission and acquisition | A trusted user gesture calling browser `getUserMedia`, a file input or another native API | The requested resource or selected file is actually available |
| Active/pending observation and global cancellation | Tendriller sensor wrappers | Tracked use is visible; Stop all invalidates pending acquisitions and stops tracked resources |
| Preview, frame extraction and local cleanup | Application camera controller | The candidate is the frame/file the person can inspect; obsolete resources are released |
| Analysis | A deliberately chosen local engine or credential-owning provider integration | Suggestions associated with that exact source, subject to the provider's limits |
| Review and command submission | The person and the application's declared command | An explicit immutable reviewed intent enters the real operation journal |

Calling `getUserMedia` is the acquisition layer; replacing the existing voice
lifecycle or global sensor cancellation is unnecessary. There is no
`tendril.camera.capture()` or general `tendril.ai()` API. Model output cannot
silently become a command, and a content-upload receipt is not command acceptance.

## Preview early, verify the hosted session

Once authored files exist, use `tendril-preview ./page` for layout. The tool
serves their complete immutable graph and supports headless DOM actions.
Its static mode has no application state provider. For live local execution,
`--bootstrap` must name an actual authored `openPreview` module returning the
real application backend, signals and cleanup. The
[preview guide](tools/PREVIEW.md) identifies that composition and its origin
boundary; a missing bootstrap is a setup task, not a cue to add a mock database.

The first-app tutorial's published page is its complete connected execution
surface. Its native and browser participants exercise the same definition,
commands, queries, journal and recovery. Localhost does not inherit the published
page's account cookies, signing device or data. The browser integration gate uses
a real isolated packed host and explicitly enrolled devices; it never substitutes
another persistence implementation.

## Use contrib as an implementation source with evidence

[Contrib](https://github.com/werg/tendriller-contrib) contains cookbook decisions,
concrete specimens and independent qualification. Follow a cookbook's **current
public API and executable check** links, inspect their exact source/artifact
versions, and run the relevant check when adapting them. Record which files or
patterns you reused. Reading a cookbook alone does not complete its integration.

Some guides preserve historical component and pilot links. For example,
[capture-reviewed-evidence](https://github.com/werg/tendriller-contrib/blob/main/cookbooks/capture-reviewed-evidence/COOKBOOK.md)
explicitly identifies retired capture transports. Those links explain earlier
interaction evidence; current retained content and submissions use the owned
session. The supplied first-app archive is the maintained implementation starting
point for this onboarding route, with current helpers directly available to import.

## Capabilities that need an additional integration

A running session watcher can receive application work while its process exists.
It cannot arrange a future ChatGPT turn. This release does not provide or qualify
a direct handoff from an arbitrary ChatGPT conversation to a device grant,
running participant and supported wake mechanism. See
[delivery](AGENT_DELIVERY.md#an-existing-chatgpt-conversation) before promising that.

Likewise, general vision/LLM inference is an application integration. The example
keeps credentials in a native process and returns reviewed suggestions. It does
not add an automatic external-effect dispatcher or irreversible finality.
Domain rules such as ingredient normalization, unit conversion, recipes and
household preferences remain application code.
