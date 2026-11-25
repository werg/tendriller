# Sensors: extending an agent's eyes and ears through the page

A Tendriller page runs on the user's phone, tablet, or desktop and connects to the
agent through one owned Chronolog session. Adding a new sensor normally requires
only ordinary page code using standard browser APIs and the existing session — no
host sensor endpoint or Tendriller core change is needed.

Keep four responsibilities separate on every sensor path:

1. **Discover** relevant browser APIs without prompting via `tendril.capabilities(['camera', 'location'])`, and always keep a file or manual fallback usable.
2. **Acquire** from a trusted local user gesture (`event.isTrusted === true`) using standard browser APIs or an existing starter helper.
3. **Track and stop** through `tendril.sensors` (automatic for five core kinds) and cooperative `tendril.sensors.register()` for page-owned resources, before starting acquisition.
4. **Transport and commit** using the least durable session lane that fits the data — sensor readings or model suggestions never silently mutate application state.

## Choose the right session path

| Observation shape | Session path | Bounds & behavior |
| --- | --- | --- |
| Live telemetry, location previews, tilt/motion readings, derived detections | `session.signals` | Ephemeral signed JSON, max 16 KiB per frame. `mode: 'latest'` coalesces newly received values within an active subscription; it does not replay missed sends. Rate-limit and coalesce at the producer before `send()`. See [live signals](APPLICATION_SIGNALS.md#page-observations-and-sensor-readings). |
| Bounded photo, screen frame, audio clip, or other binary evidence | `session.content` (`stage` → `write` → `commit`) | Encrypted 64 KiB peer-to-peer chunks up to 128 MiB; pass the small immutable `ContentReference` + SHA-256 over a signal or command. |
| Reviewed observation, accepted measurement, inspection record | `session.command` | Durable signed operation with a stable `operationId`. Check reviewed domain versions inside the definition. The captured revision is not an order input. |
| Continuous real-time RTP audio/video stream | **Not built into Chronolog** | `@chronolog/transport-webrtc` carries two SCTP data channels (reliable ordered history/control + unordered disposable JSON signals), not RTP media tracks. Do not stream raw video frames over `session.signals`; use bounded snapshots, clips, transcripts, or telemetry instead. |

Document units, capture time (`observedAtMs`), and accuracy/quality in your
application payload. Transport issue time is assigned at `send()`, so a freshly
delivered signal can still carry an old reading; enforce both sample age and
transport expiry on the receiver.

## Generic browser capabilities and tracking coverage

Call `tendril.capabilities(filter?)` to inspect exposed browser APIs and queryable
permission states without requesting access. Selected permission queries run in
parallel. Omit the filter for the full report; an empty array queries nothing,
and unknown or repeated names do not add probes. This filter scopes the explicit
inspection call; the existing runtime-wide change observer still watches the
broader permission catalog. Inspect only task-relevant keys:

```js
const report = await tendril.capabilities(['camera', 'microphone']);
if (!report.capabilities.camera.available) {
  showFileUploadOnly();
}
```

`available: true` means the browser exposes the API — not that working hardware,
granted permission, or fresh readings exist. Keep capability reports local unless
the application intentionally shares a bounded summary. A custom registration whose
`kind` matches a known capability key makes its `active` field true while active;
untracked non-core capabilities retain `active: null`. A filter does not acquire
hardware or add new capability keys.

| Capability / sensor | Standard browser API or starter module | `tendril.capabilities()` key(s) | `tendril.sensors` tracking | Fallback |
| --- | --- | --- | --- | --- |
| Camera (photo/frame) | `media/camera.mjs` (`createCameraController`) or `getUserMedia` | `camera` | Automatic (`camera`) | Image file picker (`camera.useFile`) |
| Voice (on-device STT / wake / TTS) | `media/voice.mjs` (`createVoiceController`) or `mountVoiceControls` from `@tendriller/runtime/voice` | `microphone`, `speech_recognition`, `speech_synthesis` | Automatic (`microphone`) | Typed input |
| Raw audio clip | `getUserMedia({ audio: true })` + `MediaRecorder` | `microphone` | Automatic (`microphone`) | Audio file upload |
| Screen capture (frame) | `navigator.mediaDevices.getDisplayMedia` | `screen_capture` | Automatic (`screen`) | Screenshot file upload |
| Location (fix / watch) | `navigator.geolocation` | `location` | Automatic (`location`) | Manual stop/address selection |
| Motion & orientation | `DeviceMotionEvent` / `DeviceOrientationEvent` (request permission on iOS from a click) | `motion`, `orientation` | Automatic (`motion`) | Manual event button |
| Generic Sensors & hardware connectors | `Accelerometer`, `Gyroscope`, `AmbientLightSensor`, `BarcodeDetector`, `navigator.bluetooth`, `navigator.serial`, `navigator.usb`, `navigator.hid`, `NDEFReader`, `navigator.wakeLock` | `accelerometer`, `gyroscope`, `ambient_light`, `barcode`, `bluetooth`, `serial`, `usb`, `hid`, `nfc`, `wake_lock` | Cooperative `tendril.sensors.register({ kind, stop })` + own visible Stop button | Recorded log or manual entry |

The [first-app source archive](/downloads/tendriller-first-app.tgz) includes
`media/camera.mjs`, `media/voice.mjs`, `helpers/reviewed-input.mjs`, and
`helpers/signal-request.mjs`. For detailed patterns and acceptance criteria across
other modalities, see the [Tendriller cookbooks](https://github.com/werg/tendriller-contrib):
`discover-capabilities`, `capture-reviewed-evidence`, `follow-location-progress`,
`interpret-motion`, `notice-visual-changes`, `connect-instrument`, and
`select-local-perception`.

## Cooperative resource registration

Use standard browser APIs directly. Register pending work **before** a chooser or
permission request, so Stop sensors can invalidate it while the browser's own UI
is still open. Registration never acquires hardware.

```ts
const handle = tendril.sensors.register({
  kind: 'serial',                    // Prefer an existing capability key.
  label: 'Bench meter',               // Optional, local-only human-readable label.
  state: 'pending',                   // Default; also active, stopping, failed.
  stop: async () => { /* release the page-owned resource */ },
});
handle.signal;                       // AbortSignal, invalidated before stop().
handle.setState('active');            // Ignored after cancellation.
handle.unregister();                 // Abort and invoke the same cleanup once.
```

`setState()` reports a phase; it never acquires or stops hardware. Use
`unregister()` for individual Stop or normal completion. The `stop` callback runs
at most once across local `unregister()`, Stop sensors, reentrant cleanup, and
page teardown. `unregister()` is the local Stop/dispose
operation; it also invokes cleanup after normal completion, so release code
should tolerate already-closed resources. All selected cancellation signals are
aborted before Stop sensors invokes any callback. Always check the signal after
every acquisition await and close late arrivals yourself.

Return the cleanup promise. `stopAll(): number` remains synchronous and counts
newly stopped/cancelled tracked resources; it does **not** promise physical
shutdown. While a cleanup promise is pending, `status().resources` keeps its
`stopping` entry. A rejection or synchronous throw becomes `failed` and remains
visible across repeated local Stop, global Stop and teardown. After resolving a
failed cleanup yourself, call `handle.unregister({ acknowledgeFailure: true })`
to remove that entry without invoking its failed callback again. Acknowledgement
only removes an already-failed stop attempt: it cannot cancel a fresh resource,
hide a pending cleanup, or acknowledge a page-reported failure before Stop ran.
Ordinary `unregister()` remains idempotent and never hides a cleanup failure.

The existing `active` and `pending` arrays remain present and contain distinct
kinds, including cooperative kinds in those phases. The optional `resources`
array contains local `{ id, kind, label?, state }` snapshots and is omitted when
no custom registrations remain. Page options displays labels and stopping/failed
states. Read `status()` first; `sensors.on(listener)` observes subsequent changes.

For Screen Wake Lock (dashboards, timers, recipes, hands-free voice), use the
built-in helper directly inside a trusted click handler:

```js
const lease = await tendril.sensors.wakeLock({
  label: 'Keep screen awake',
  autoReacquire: true, // optional: re-acquire when returning to the tab
});
// Later:
await lease.release();
```

`tendril.sensors.wakeLock` registers a `wake_lock` resource automatically so
**Stop sensors** and `pagehide` release it cleanly.

For custom browser APIs without a built-in helper (such as Bluetooth, Serial, or
custom sampling loops), register directly with `tendril.sensors.register`:

```js
let current;
startButton.addEventListener('click', event => {
  if (!event.isTrusted || current) return;
  let lock, pending;
  const handle = tendril.sensors.register({
    kind: 'wake_lock', label: 'Keep screen awake',
    async stop() {
      if (current === handle) current = undefined;
      const granted = await pending?.catch(() => undefined);
      const activeLock = lock ?? granted;
      if (activeLock && !activeLock.released) await activeLock.release();
    },
  });
  current = handle;
  // Invoke the browser API directly in this gesture, before any await.
  try {
    pending = navigator.wakeLock.request('screen');
    void pending.then(granted => {
      if (handle.signal.aborted) return; // stop() awaits pending and releases it
      lock = granted;
      handle.setState('active');
      granted.addEventListener('release', () => handle.unregister(), { once: true });
    }, error => {
      const cancelled = handle.signal.aborted;
      handle.unregister();
      if (!cancelled) showError(error);
    });
  } catch (error) { handle.unregister(); showError(error); }
});
stopButton.addEventListener('click', () => current?.unregister());
document.addEventListener('visibilitychange', () => {
  if (document.hidden) current?.unregister();
});
```

The runtime stops registrations and emits `sensors_stopped` on `pagehide`,
including BFCache entry. Restoring visibility never rearms them. The page still
owns its sampling timers, preview UI and visibility policy; the existing
`sensors_stopped` event remains useful for controller-level cleanup. Cooperative
tracking cannot discover resources that page code never registered.

## Agent-requested observation ("eyes and ears" loop)

[Reviewed media and inference](AI_INPUT.md) covers the human-initiated flow
(person captures → optional native inference → edits → commits). When the
**agent** needs a fresh observation from the user's device, reverse the trigger
while keeping consent and review strictly local:

1. **Agent requests an observation** via a declared command (for durable requests
   that survive reload) or a bounded signal using `helpers/signal-request.mjs`
   (for live sessions), e.g. `{ requestId, kind: 'camera', prompt: 'Show the router LEDs' }`.
2. **Page checks `tendril.capabilities(filter)` and renders a request card** showing
   what the agent asked for, the best available capture action, and a file or
   manual fallback. Receiving a request **never** starts a sensor automatically.
3. **Person taps a trusted button** to capture, then inspects the captured frame,
   clip, or reading (with retake/discard available).
4. **Page sends the reviewed result** — staging binary bytes through
   `session.content` or sending small structured readings via `session.signals` /
   a declared `session.command` bound to `requestId`, `sha256`, and the captured
   revision.
5. **Agent observes the result** via `session.changes`, `session.signals.subscribe`,
   or `read_application_events`, fetches any referenced bytes via
   `session.content.read(reference)`, and continues its work.

## Runnable reference and modality cookbooks

The optional [observation reference](https://github.com/werg/tendriller/tree/master/docs/tutorial/observation)
combines a simulated source and a location adapter with a browser view, native
receiver, correlated replies and explicit command retention. The maintained
[observation reference guide](OBSERVATION_REFERENCE.md) explains the real-session
Chromium/native checks, including a browser Worker facade, and integration. It is deliberately outside
the lean first-app archive; copy only the pieces your application needs.

The five [sensor cookbooks](https://github.com/werg/tendriller-contrib/tree/main/cookbooks)
`discover-capabilities`, `follow-location-progress`, `interpret-motion`,
`connect-instrument`, and `capture-reviewed-evidence` include executable
`snippets/` and `checks/`. Their checks establish state transitions, framing,
freshness and review boundaries, while their evidence sections distinguish
physical-device qualification.

## Bounded content and local retention

New Chronolog session builds offer `content.putBytes(bytes, { mediaType, signal })`
and `content.readBytes(ref, { maxBytes, signal })` over the same encrypted chunk
transport. Always choose an explicit `maxBytes` before allocating a read.
The starter's streaming `stage/write/commit` and `read({ offset, length })` paths
remain compatible with its pinned public session archive.

Use `await session.content.prune(ref)` to evict a discarded local observation
when using a session build with the pruning API. This is local cache/storage
cleanup, not remote erasure or deletion of an application command. Authorized
peers may retain their copies, and a later explicit read can fetch content again.
New content uses per-reference storage and can reclaim its own payloads completely.
Ambiguous shared ciphertext in legacy stores is preserved to avoid deleting another
offline reference; pruning still removes the selected manifest and metadata.
Choose retention deliberately; durable commands should not silently retain every
live sample.

The media inference protocol also accepts bounded `audio/webm`, `audio/mp4`,
`audio/ogg` and `audio/wav` clips. `IMAGE_TYPES` remains compatible, and the supplied
OpenAI vision provider remains image-only. Audio needs an explicitly audio-capable
provider; accepting a clip for transport does not establish transcription support.

## Safety and lifecycle checklist

- **Trusted gesture only:** Start every sensor from a real pointer/keyboard action (`event.isTrusted === true`).
- **Capture context early:** Read the current revision/task ID before starting async recording, encoding, or analysis.
- **Stop on teardown and hide:** Release tracks, watches, listeners, ports, and wake locks on `pagehide`, `sensors_stopped`, and the appropriate `visibilitychange` boundary. Never auto-rearm on `pageshow` or visibility return.
- **Distinguish active from fresh:** `sensors.status().active` shows that a track, watch, or listener is registered — not that fresh, usable measurements are arriving.
- **Verify honestly:** Mocked unit tests establish cancellation and state transitions; test actual browser permission UX and hardware behavior on target devices before claiming device support.

See [Browser API](BROWSER_API.md#sensors-and-voice), [Live signals](APPLICATION_SIGNALS.md),
[Reviewed media and inference](AI_INPUT.md), and [On-device voice and wake phrases](HANDS_FREE.md)
for full API details.
