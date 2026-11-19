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
| `capabilities()` | Describe browser availability and permissions without requesting them |
| `sensors` | Observe tracked use and cancel active or pending acquisitions |
| `assetUrl(path)` | Resolve an explicit dependency in the pinned runtime |
| `installation` | Observe browser installation state and explicitly request an available native prompt |
| `publication.saveOffline()` | Explicitly retain the complete current code graph |

Construction starts no host connection, fetch, IndexedDB outbox, service worker registration or sensor permission request. Explicit host requests authenticate with existing account cookies. The runtime creates no extra device secret or device authorization headers.

## Home Screen setup

Open **Page options** to add the page to the Home Screen or read the current platform's setup steps. A native **Add to Home Screen** button appears only after the browser supplies a `beforeinstallprompt` event. Android otherwise uses the browser menu's **Add to Home Screen** or **Install app**. On iPhone and iPad, use **Share → Add to Home Screen**, leave **Open as Web App** enabled if shown, then tap **Add**. Share may be inside the page menu. If the option is missing, try Safari and **Share → Edit Actions**. Supporting third-party iOS browsers can also add web apps; Safari is a fallback, not a requirement. See [Chrome's custom install guidance](https://web.dev/articles/customize-install) and [Apple's Home Screen instructions](https://support.apple.com/guide/iphone/open-as-web-app-iphea86e5236/ios).

Startup does not open an install prompt. On eligible published mobile pages, a small suggestion may appear after a 12-second delay following a trusted page interaction. It stays out of focused form editing, active or pending sensor use, and hidden pages. **Not now** suppresses suggestions for that page on this browser for 30 days; Page options remains available. Already standalone pages do not show installation suggestions.

The default manifest uses the page's stable base URL for `id`, `start_url` and `scope`. Each Tendriller page has its own identity and launch target; a fresh Home Screen launch requests its currently selected publication. An open tab remains pinned to its immutable publication, including on reload. **Page options → Open latest version** explicitly opens the selected release. Authored metadata takes precedence over host defaults. An authored manifest also suppresses the host's icon, Apple title and theme defaults so its branding remains in control; viewport defaults still fill a missing viewport tag.

For the default manifest, a custom page `icon` URL ending in `.png`, `.webp`, or `.svg` replaces the generated installation artwork. Serve a square image large enough for the target browsers. Use an authored manifest to declare exact sizes, provide alternate icons, or reference artwork at a URL without a supported file extension.

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

`sensors.status()` separates active resources from pending permission acquisitions. `sensors.stopAll()` cancels pending results, stops tracked media and location watches, and prevents late grants from becoming active. This local safety control does not report camera or microphone use to the host.

Load optional voice from `import(runtime.assetUrl('voice.mjs'))` or `@tendriller/runtime/voice`. Supply consent, transcript and status callbacks. Route an accepted transcript into the application's chosen command; invoke `voice.speak(text)` explicitly for the application's chosen output. Importing or constructing voice starts no capture, playback or download. See [voice lifecycle](HANDS_FREE.md).

## Immutable code and offline use

Each publication pins its complete authored file graph and runtime. **Page options → Save for offline use** calls `publication.saveOffline()`, which registers offline support on demand and resolves only after the required graph is verified and saved by the service worker. Home Screen installation does not implicitly call it. It is code retention, not an application-data backup or synchronization guarantee. Different open publications keep their own assets through lazy loads and offline reload; live features still depend on the page's data and connection lifecycle.

The service-owned management page remains available if authored JavaScript fails. It manages account access and displays publication history. Changing selected code requires a new signed Chronolog publication.

While visible, the holding page checks for a signed publication and opens the selected release as soon as it is available. Once a version is open, its URL pins that publication so a reload can recover the same code. Use **Open latest version** in the page controls to load the currently selected release.
