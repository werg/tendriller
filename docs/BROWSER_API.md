# Browser API

For the complete Worker, device enrollment and UI files, start with [Build an app](BUILD_AN_APP.md). This is the API reference after that bootstrap; `ready()` alone does not mean a peer is connected.

The browser runtime composes one application session with page-host services and local device utilities. It does not own a second application database, device signer, transport or delivery queue.

## Runtime composition

The default injected `tendril.js` entry assigns `window.tendril` and mounts a small **Page options** utility for Home Screen setup, offline code saving, management and sensor cancellation. The public `@tendriller/runtime/kernel` export instead provides `startRuntime(configuration, options)` without mounting UI. Both return the same `RuntimeApi`.

`configuration.application` is exactly `{id}`. A published document also carries its immutable publication/runtime manifest and its own logical `documentPath`. Startup rejects undeclared document paths before browser side effects.

```js
const runtime = startRuntime(configuration, {
  application: createApplicationBackend({ id: session.applicationId, session }),
  signals: session.signals,
});
```

The application and signal ports may instead be installed once after startup. Their readiness indicates installation only. The owned session supplies status, recovery and its signing `deviceId`.

Chronolog's protocol participant can be installed immediately without activating
durable application data. Signals, peer authentication, membership and code updates
remain available while `application.backend.status.database` is `idle`. The first
actual data operation loads the database component and acquires an exclusive
Web Lock, then opens its *pinned* OPFS or IndexedDB record backend inside the
same owning Worker. The page-side `@chronolog/peer-session/browser` entry is only the
Worker facade; the Worker imports its owner from `@chronolog/peer-session/worker`.
See [the data lifecycle](APPLICATION_BACKENDS.md#protocol-first-durable-data-on-demand).

An owning Worker can explicitly call `probeBrowserCapabilities()` to check
new-device events eligibility without opening a signer or data store. The
page runtime does not probe at startup and does not interpret SQL's separate
OPFS SAH-pool prerequisite as event storage support. The browser may evict
site storage or suspend a Worker; a successful probe is not a durability or
Safari device-qualification guarantee.

## Public services

| Service | Purpose |
| --- | --- |
| `application` | Matching single-session backend binding |
| `signals` | Independent ephemeral send/subscribe binding |
| `host.peers` | Filtered participant exchange, discovery, bootstrap hints and bounded introductions |
| `host.request(path,options)` | Explicit relative host lifecycle request with the page account session |
| `identity` | Page/version/publication identity, base and management URL |
| `ready()` | Authored UI readiness |
| `on(...)` | Local readiness, capability and sensor observations |
| `capabilities(filter?)` | Inspect selected browser APIs and permissions in parallel without requesting access |
| `sensors` | Observe tracked use and cancel active or pending acquisitions |
| `assetUrl(path)` | Resolve an explicit dependency in the pinned runtime |
| `installation` | Observe browser installation state and explicitly request an available native prompt |
| `documentUrl(reference)` | Build a document or fragment URL in this page’s current live or explicitly pinned context; performs no navigation |
| `publication.saveOffline()` | Explicitly retain the complete current code graph |
| `transport.install(participation)`, `status()`, `onChange()`, `refresh()` | Bounded local authenticated-link diagnostics; no polling, probes or host queries. See [transport diagnostics](TRANSPORT_DIAGNOSTICS.md) |
| `publication.updateAvailable`, `onUpdate`, `hold()`, `update()`, `pinned`, `policy` | Latest-release behaviour: observe a newer selected release, defer the automatic switch while there is unsaved work, or switch now |

The hosted `tendril.js` entry opens one receive-only publication metadata WebSocket during construction, including on holding and explicitly pinned pages. The bare `startRuntime()` kernel opens it only when passed `watchPublication: true`; otherwise construction starts no host connection or fetch. A healthy publication watch sends no heartbeat or periodic HTTP request; transport failure can trigger bounded recovery reads and reconnects. This watch does not install an application transport. Construction creates no IndexedDB outbox, service worker registration or sensor permission request. Explicit host requests authenticate with existing account cookies. The runtime creates no extra device secret or device authorization headers.

## Favicons and page branding

Give every published app a recognizable favicon so people can find its tab among
their other Tendriller pages. Set the existing `icon` metadata field to one emoji; the
host converts it to an SVG automatically. No image file, upload or image service
is needed. Compound emoji such as `👩🏽‍💻`, flags and keycaps are supported. The SVG
uses the device's emoji font, so its appearance can vary by platform.

From a native agent using the private handle and public SDK:

```js
const host = createClient(handle, { applicationId: handle.application.id });
await host.request('', { method: 'PATCH', body: { icon: '🌱' } });
```

Import `createClient` from `@tendriller/core`. The equivalent HTTP request is
`PATCH` to the returned handle's `api` URL, with `Authorization: Bearer TOKEN`,
`Content-Type: application/json` and the body `{"icon":"🌱"}`. This host metadata
operation requires `host:manage`; keep the agent credential outside browser code.
For the CLI, see [set a favicon](tools/CLI.md#set-a-favicon).

| `icon` value | Result |
| --- | --- |
| One emoji, such as `"🌱"` or `"👩🏽‍💻"` | Generated SVG favicon; preserves the complete emoji sequence |
| An HTTPS image URL | Uses that image for the favicon |
| `null` | Restores the generated default icon |

Choose an emoji that fits the user's task when creating the app, and give the
page a useful `name` and `short_name` in the same request if needed. Reload the
page after a metadata change; it does not push a favicon update into an already
open document. Authored `<link rel="icon">` tags take precedence. An authored
manifest also suppresses host icon defaults, so update that authored branding
when it is present. Before the first publication, the holding page retains the
Tendriller icon.

## Page options placement

The hosted utility sits at the bottom right. Its collapsed **Page options**
button has a 44 px minimum touch target inside a bar with 4 px padding and a
1 px border (54 px high without wrapped sensor controls). The width depends on
the font and active controls. Active/pending sensors can make the bar wider or
wrap it onto more lines. Menus, installation suggestions and update notices
temporarily expand above that persistent bar.

Apps can declare clearance for bottom tabs, floating actions or a side rail
with CSS custom properties on `:root`. These work in the authored stylesheet
before the runtime mounts, and update responsively without a JavaScript call.

| Property | Direction | Meaning |
| --- | --- | --- |
| `--tendril-utility-inset-bottom` | App input | Minimum distance from the viewport bottom; a CSS length or `calc(...)` |
| `--tendril-utility-inset-right` | App input | Minimum distance from the viewport right |
| `--tendril-utility-width` | Runtime output | Measured outer width of the persistent control bar, in CSS pixels |
| `--tendril-utility-height` | Runtime output | Measured outer height of that bar, including wrapped sensor controls |

Each actual inset is the maximum of the requested value, 12 px, and that
edge's safe-area inset. An omitted input requests no additional clearance.
The measured outputs appear after the first layout and track size changes
using `ResizeObserver`; use a fallback for the initial render. They exclude
the temporary menus above the bar. Do not set the output properties yourself.
The runtime restores prior inline values when the utility is disposed.

For a 64 px bottom tab bar:

```css
:root {
  --app-tabs-height: 64px;
  --tendril-utility-inset-bottom:
    calc(var(--app-tabs-height) + env(safe-area-inset-bottom) + 8px);
}
.app-tabs {
  box-sizing: border-box;
  position: fixed;
  inset: auto 0 0;
  height: calc(var(--app-tabs-height) + env(safe-area-inset-bottom));
  padding-bottom: env(safe-area-inset-bottom);
}
main {
  padding-bottom: calc(
    var(--tendril-utility-inset-bottom) +
    var(--tendril-utility-height, 54px) + 12px
  );
}
```

The optional floating voice controls use the same right/bottom clearances and
sit 10 px above the measured utility bar. They follow changes in sensor-control
height without a separate hard-coded app offset. Supplying a voice
`container` still places those controls inline. Both floating panels keep their
content scrollable within the remaining viewport. Keep enough room for the
controls and verify your chosen clearances at narrow and landscape sizes;
moving the utility preserves its installation, management and sensor-stop
actions.

Existing publications acquire this layout contract only when republished with
the updated pinned runtime. Changing host code alone does not modify the
runtime of an already signed publication.

## Home Screen setup

Open **Page options** to add the page to the Home Screen or read the current platform's setup steps. A native **Add to Home Screen** button appears only after the browser supplies a `beforeinstallprompt` event. Android otherwise uses the browser menu's **Add to Home Screen** or **Install app**. On iPhone and iPad, use **Share → Add to Home Screen**, leave **Open as Web App** enabled if shown, then tap **Add**. Share may be inside the page menu. If the option is missing, try Safari and **Share → Edit Actions**. Supporting third-party iOS browsers can also add web apps; Safari is a fallback, not a requirement. See [Chrome's custom install guidance](https://web.dev/articles/customize-install) and [Apple's Home Screen instructions](https://support.apple.com/guide/iphone/open-as-web-app-iphea86e5236/ios).

Startup does not open an install prompt. On eligible published mobile pages, a small suggestion may appear after a 12-second delay following a trusted page interaction. It stays out of focused form editing, active or pending sensor use, and hidden pages. **Not now** suppresses suggestions for that page on this browser for 30 days; Page options remains available. Already standalone pages do not show installation suggestions.

The default manifest uses the page's stable base URL for `id`, `start_url` and `scope`. Each Tendriller page has its own identity and launch target; a fresh Home Screen launch requests its currently selected publication. A page always shows the latest release by default (see below). Authored metadata takes precedence over host defaults. An authored manifest also suppresses the host's icon, Apple title and theme defaults so its branding remains in control; viewport defaults still fill a missing viewport tag.

For the default manifest, an emoji `icon` uses the same generated SVG as the favicon. A custom HTTPS `icon` URL ending in `.png`, `.webp`, or `.svg` replaces the generated installation artwork. Serve a square image large enough for the target browsers. Apple touch icons continue to use the default PNG unless `icon` is an HTTPS PNG URL or the page supplies its own Apple touch icon. Use an authored manifest to declare exact sizes, provide alternate icons, or reference artwork at a URL without a supported file extension.

Existing signed publications pin their `runtime_id`. Deploying this host updates metadata on newly served HTML, but existing pages receive the new Page options UI and `installation` API only through a new signed publication using the updated runtime. Cached HTML and already open tabs retain their existing publication behavior.

`installation.status()` returns `{state, platform}`; `platform` is `ios`, `android` or `desktop`.

| State | Meaning |
| --- | --- |
| `available` | A native prompt is ready for a user gesture |
| `manual` | Offer browser-menu instructions; no native prompt is currently available |
| `installed` | This window is running as an app, or the browser reported installation |
| `unavailable` | This context is insecure or embedded; open the page in a secure top-level browser window |

`on(listener)` observes subsequent state changes and returns an unsubscribe function. Read `status()` for the initial view. An authored native-install button can use the same API:

```js
const button = document.querySelector('[data-install-page]');
const message = document.querySelector('[data-install-status]'); // role="status"
const render = ({ state }) => { button.hidden = state !== 'available'; };
render(tendril.installation.status());
const unsubscribe = tendril.installation.on(render);

button.addEventListener('click', async () => {
  // Call before any other await to preserve this click's user activation.
  const result = await tendril.installation.prompt();
  message.textContent = result === 'accepted'
    ? 'Installation requested. Follow your browser’s confirmation.'
    : result === 'dismissed'
      ? 'You can add this page later.'
      : 'Use your browser’s menu to add this page.';
});
// Call unsubscribe() when disposing this view.
```

`prompt()` returns `accepted`, `dismissed` or `unavailable` and consumes a native event at most once. Calling it without a user gesture leaves the pending prompt available for a click. Acceptance is the user's choice, not confirmation that installation has completed. The headless kernel exposes the same API without instructions or suggestions; authored UI must supply its own manual help. Do not duplicate the default runtime's automatic suggestion.

A Home Screen app may need sign-in or device connection again. On iOS/iPadOS, installation can copy cookies but does not copy localStorage or IndexedDB, and subsequent storage is separate. Preserve the owned session's explicit enrollment/recovery flow; installing an icon does not transfer its device signer or application data. See [WebKit's storage behavior](https://webkit.org/blog/14787/webkit-features-in-safari-17-2/).

## Connection lifecycle

Install `session.participate(...)` with the [host introduction adapter](PEER_CONNECTIONS.md). For browser RTC, `openWorkerWebRtcConnection` and the page's `serveWorkerWebRtcConnections` bridge keep the connection's authentication, replication and recovery inside the owned Worker. The runtime remains a view and utility binding; it starts no second controller. Show participation status and exact recovery proposals instead of implementing local polling or elections.

## Applied views and operation state

Use the [application contract](APPLICATION_BACKENDS.md) or the session directly. Capture coherent applied read views and release them. Keep saved, applied and shared progress distinct. Show recovery notices and abandoned operations explicitly; let the user decide whether to reapply with current arguments and guards.

## Sensors and voice

`tendril.capabilities(filter?: readonly string[])` inspects exposed browser APIs
and queryable permissions in parallel without requesting access. Filter before
probing: for example `await tendril.capabilities(['camera', 'location'])`.
Omitting the filter returns every known key; `[]` returns none, and unknown keys
are ignored. `available` means the API is exposed, not that
working hardware or usable readings have been verified. `permission: 'unknown'`
can mean that the browser cannot query that permission. Capability and sensor
observations stay local unless the application explicitly shares them.

Automatic sensor tracking covers **camera, microphone, screen, location and
motion**: media acquired through `getUserMedia`/`getDisplayMedia`, geolocation,
legacy motion/orientation event listeners, and browser speech recognition.
`sensors.status().active` includes registered watches/listeners and a recent
location fix; it does not prove that fresh measurements are arriving. `pending`
covers wrapped media acquisitions, one-shot location reads, and cooperative
registrations awaiting acquisition. Custom active/pending kinds join the same
arrays. Track the last successful reading separately when freshness matters.
`sensors.on(listener)` observes changes; read `status()` for the initial snapshot.

`sensors.register({ kind, label?, state?, stop })` enrolls any page-owned resource
before acquisition. The default phase is `pending`; the handle exposes an
`AbortSignal`, `setState('pending' | 'active' | 'stopping' | 'failed')`, and
`unregister()`. `setState()` reports lifecycle state without acquiring or stopping
hardware. Use `unregister()` for local Stop/dispose: it invalidates the signal
and invokes the same at-most-once cleanup as Stop sensors. Late grants must check
the signal and release their own resources. Returning an asynchronous cleanup
promise keeps the entry visible as `stopping`; failed cleanup remains `failed`
across repeated Stop/disposal and teardown. After manual resolution, use
`unregister({ acknowledgeFailure: true })` to remove the failed entry explicitly.
That acknowledgement never stops fresh work or hides cleanup still in progress;
ordinary `unregister()` remains idempotent.

`sensors.stopAll(): number` synchronously reports the number of newly
stopped/cancelled resources, rather than waiting for physical shutdown. It
invalidates all selected cooperative signals before invoking their callbacks.
The optional `status().resources` snapshots contain `{ id, kind, label?, state }`
and are omitted when no cooperative resources remain. Page options displays
human-readable labels and cleanup phases. Matching known capability keys report
`active: true` while custom resources are active.

The runtime also stops resources and emits `sensors_stopped` on `pagehide`,
including BFCache entry; restoration never restarts capture. Controllers still
own sampling loops, preview UI and visibility cleanup. The
[cooperative lifecycle example](SENSORS.md#cooperative-resource-registration)
shows registration without adding sensor-specific wrappers. These observations
remain local and do not report sensor use to the host.

Ordinary page code can acquire a new sensor through its browser API, with local
user interaction and permission handling. Send small disposable readings through
[session signals](APPLICATION_SIGNALS.md), and carry binary observations through
session content using the [reviewed media pattern](AI_INPUT.md). A declared
application command retains an observation when the application intentionally
saves it. See the [capability map](CAPABILITIES.md#task-to-implementation) for
location, motion and local perception cookbook links.

Every hosted published page offers **Page options → Set up voice input**. The
shared controls load lazily and provide tap-to-talk, an explicitly enabled
on-device wake phrase, a visible microphone indicator and Stop, and an editable
review-and-copy draft. Opening them does not download the model or open a
microphone. A separate trusted local Start action is required. Generic controls
never submit application commands.

An authored page can import `mountVoiceControls` from
`import(runtime.assetUrl('voice.mjs'))` or `@tendriller/runtime/voice` and supply a
`container` and optional `transcript(text)` callback. That callback runs only when
the person reviews the draft and chooses **Use text**. The lower-level
`createVoice` adapter accepts explicit consent, transcript, and status callbacks;
`startWake({ phrase, mode: 'model' })` selects the pinned local path. Its
`microphoneActive` state is separate from preparation, and `stop()` cancels
pending starts and results. `voice.speak(text)` stops input before queuing output.
Construction starts no capture, playback or model download.

The verified speech model is 16,919,407 bytes; model plus engines total
18,224,260 bytes. Listening is bounded and foreground-only, with same-origin
microphone ownership across tabs and no automatic rearming. See the
[voice lifecycle, consent, and engine choices](HANDS_FREE.md) and
[device qualification limits](WAKE_WORD_QUALIFICATION.md).

## Immutable code and offline use

Each publication pins its complete authored file graph and runtime. **Page options → Save for offline use** calls `publication.saveOffline()`, which registers offline support on demand and resolves only after the required graph is verified and saved by the service worker. Home Screen installation does not implicitly call it. It is code retention, not an application-data backup or synchronization guarantee. Different open publications keep their own assets through lazy loads; an offline reload of the page URL opens the latest saved release (see below); live features still depend on the page's data and connection lifecycle.

The service-owned management page remains available if authored JavaScript fails. It manages account access and displays publication history. Changing selected code requires a new signed Chronolog publication.

The holding page uses the same publication watch to open the first selected signed release as soon as it is available; it does not poll while the watch is healthy.

## Storage durability of a browser device

A browser device keeps its only signing key, its journal and its unsent signed work in
origin storage. The SDK (`openBrowserOwner`, `createBrowserIdentity`) asks the browser to
persist that storage (`requestPersistentStorage()`; the attachment's `storagePersisted`;
`persistStorage: false` opts out).

Chromium's in-memory storage (private windows and automation contexts) drops the files
of an origin-private (OPFS) directory that nothing has touched for about ten minutes,
even while the owner holds it open; the next open then fails closed with
`APPLICATION_DATA_STORAGE_MISSING`. A normal profile keeps them. Opening the
directory's handle resets that clock, so an attached page does so, leanly:

- nothing runs when the browser reports the storage as persisted;
- it runs only while the page is visible, every 4 minutes (`storageKeepAliveMs`,
  default 240000; 0 disables), and never wakes a hidden or frozen tab;
- hiding, freezing, showing or resuming the page touches once, so a backgrounded
  tab has a full window: a private-window tab hidden for more than about ten minutes
  can still lose its store;
- one tick opens each `chronolog-*` directory handle without listing records:
  about 4 ms for one store and 23 ms for 50 stores of 10,000 records in total
  (measured in headless Chromium).

The in-memory case cannot be detected directly: quota, `persisted()` and `persist()`
read the same as on a normal profile, so the keep-alive runs wherever storage is not
known to be persistent.

## The latest release by default

The address bar keeps the page's own URL; the document's assets resolve through
its injected `<base>`, which names the immutable publication graph. So:

- opening or reloading a canonical page URL, including a Home Screen launch,
  loads the release that is selected **now**; explicit immutable URLs retain their pin;
- an open tab holds the page's one hibernating publication watch
  (`contract/publication-watch.mjs`, opened by the hosted `tendril.js` entry; the
  bare `startRuntime` kernel opens it only with `watchPublication: true`) and learns
  of every change of the selected release, rollbacks included. What happens next
  depends on the page's update policy (`publication.policy`):
  - **`live` (default):** the page is replaced as soon as the agent publishes,
    with no prompt. Only an active `tendril.publication.hold()` or text the person
    actually typed (trusted input) and has not yet sent or cleared defers it; it
    switches the moment that field is sent or emptied. Focus alone, values the app
    sets itself, sliders and selects never block.
  - **`careful` (opt in):** add `<meta name="tendriller-updates" content="careful">`
    for edit-heavy pages. The page also waits while any editable field is focused or
    any inspectable form control differs from its initial HTML defaults (open shadow
    roots, checkbox/radio checkedness, selected options, changed disabled or
    read-only controls included), and Page options shows **New version published**
    with an **Open update** link to the page's own address.

  Both policies also apply while hidden or resumed;
- pinning is explicit: a document opened at its immutable
  `…/_publications/ID/` URL stays on that release (for a review or a comparison),
  and `publication.pinned` is `true`.

The immutable `<base>` also applies to authored relative links. A plain
`<a href="other.html">` follows that signed release’s document and therefore opens
a pinned URL, even when the source page was live. A plain `href="#section"` also
resolves against the immutable base, rather than necessarily the current document.
The runtime does not intercept clicks or rewrite authored links.

For navigation that follows the current live/pinned document context, assign the
URL explicitly:

```js
otherLink.href = tendril.documentUrl('other.html');
sectionLink.href = tendril.documentUrl('#section');
```

The pure builder resolves standard URL references relative to the address-bar
document, retaining query strings and fragments as normal URL resolution does.
On a live page it returns a canonical page URL; on an explicitly pinned page it
stays within that immutable publication. It rejects references that escape that
context. Use an explicit canonical URL or `publication.update()` to leave a pin.
Asset references and explicit immutable links remain unchanged. This is an
authored navigation choice; it does not save drafts or establish a connection.

Every release is still the signed, verified publication the host selected; the
switch is an ordinary navigation, so the runtime verifies it as on any load.
Device keys and retained operations remain in their existing browser storage. Applications must persist drafts explicitly; runtime inspection does not save them. Closed shadow roots, custom editors, blurred contenteditable content, detached controls and other application work are not covered by the form-default check. Such an app calls
`const release = tendril.publication.hold()` while that work is unsaved, then
`release()`. Update safety is checked on publication changes, input/change,
focus leaving an editor, form reset, visibility changes, page restoration and hold
release. Form reset is observed at the document level. Native `reset` events from
forms inside shadow roots are not composed, so they do not reach that listener;
release an application hold after resetting such a form to trigger the safety
check. A pending update otherwise waits for another observed trigger. There is
no periodic safety scan. Programmatic changes that do not emit
these events must use a hold while unsaved: persist the draft, update native form
defaults to the saved values when appropriate, then release the hold. Custom
editors and closed shadow roots require this explicit lifetime. Alternatively,
`publication.update()` is an explicit decision to switch immediately; it bypasses
these protections rather than detecting whether programmatic work was saved.
`publication.onUpdate(listener)` lets an app show its own notice;
`publication.update()` explicitly switches immediately, overriding draft protection and active holds. An application should offer it only when the person has saved or accepted discarding local work. A pinned document opens its corresponding document in the current release.

Why pages used to stay on their first release, and how that is kept: (1) a reload
recovered the exact code that held unsent work; drafts and pending operation
references are retained in storage and the switch waits for unsaved input or an
explicit hold. (2) A new release's owner Worker could not take a profile from an
older one still running in another tab; pages now attach to the running owner
whatever its Worker version, and a changed application definition still needs a
new application rather than a publish. (3) Offline launches use the saved graph
when the network is unavailable; an offline reload of the page URL opens the
latest complete saved release, falling back to the tab's own.
