# Browser API

The browser runtime composes one application session with page-host services and local device utilities. It does not own a second application database, device signer, transport or delivery queue.

## Runtime composition

The default injected `tendril.js` entry assigns `window.tendril` and mounts a small management/sensor utility. The public `@tendriller/runtime/kernel` export instead provides `startRuntime(configuration, options)` without mounting UI. Both return the same `RuntimeApi`.

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
actual data operation loads the database component and acquires OPFS inside the same
owning Worker. The page-side `@chronolog/peer-session/browser` entry is only the
Worker facade; the Worker imports its owner from `@chronolog/peer-session/worker`.
See [the data lifecycle](APPLICATION_BACKENDS.md#protocol-first-durable-data-on-demand).

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
| `publication.saveOffline()` | Explicitly retain the complete current code graph |

Construction starts no host connection, fetch, IndexedDB outbox, service worker registration or sensor permission request. Explicit host requests authenticate with existing account cookies. The runtime creates no extra device secret or device authorization headers.

## Connection lifecycle

Install `session.participate(...)` with the [host introduction adapter](PEER_CONNECTIONS.md). For browser RTC, `openWorkerWebRtcConnection` and the page's `serveWorkerWebRtcConnections` bridge keep the connection's authentication, replication and recovery inside the owned Worker. The runtime remains a view and utility binding; it starts no second controller. Show participation status and exact recovery proposals instead of implementing local polling or elections.

## Applied views and operation state

Use the [application contract](APPLICATION_BACKENDS.md) or the session directly. Capture coherent applied read views and release them. Keep saved, applied and shared progress distinct. Show recovery notices and abandoned operations explicitly; let the user decide whether to reapply with current arguments and guards.

## Sensors and voice

`sensors.status()` separates active resources from pending permission acquisitions. `sensors.stopAll()` cancels pending results, stops tracked media and location watches, and prevents late grants from becoming active. This local safety control does not report camera or microphone use to the host.

Load optional voice from `import(runtime.assetUrl('voice.mjs'))` or `@tendriller/runtime/voice`. Supply consent, transcript and status callbacks. Route an accepted transcript into the application's chosen command; invoke `voice.speak(text)` explicitly for the application's chosen output. Importing or constructing voice starts no capture, playback or download. See [voice lifecycle](HANDS_FREE.md).

## Immutable code and offline use

Each publication pins its complete authored file graph and runtime. `saveOffline()` resolves only after the required graph is verified and saved by the service worker. It is code retention, not an application-data backup or synchronization guarantee. Different open publications keep their own assets through lazy loads and offline reload.

The service-owned management page remains available if authored JavaScript fails. It manages account access and displays publication history. Changing selected code requires a new signed Chronolog publication.
