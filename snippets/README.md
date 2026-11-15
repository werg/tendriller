# Snippets

Optional, copyable page pieces for tendril pages. Each is one plain ES2020 file with no
build step and no dependency on the others. Load it from the page with a relative URL:

```html
<script src="_tendril/snippets/camera.js"></script>
```

(also served at `/snippets/<name>.js`). Each attaches to `window.tendrilSnippets.<name>`,
has `supported()` so the page can check before offering a feature, and starts with a header
comment that is its documentation: read it, then copy or adapt. Libraries and models
(MediaPipe, tesseract.js, html-to-image, qrcode-generator) are loaded from jsDelivr with a
pinned major version, and only when first used.

Sensor permissions are the browser's own prompts and most need a tap: call `open()`,
`start()` or `connect()` from a click handler.

| Snippet | Purpose | Support | Usage |
|---|---|---|---|
| `camera.js` | Viewfinder + JPEG capture, uploaded and optionally sent as a `photo` event | All current browsers over HTTPS | `cam = await camera.open("#view"); await cam.capture({send: true})` |
| `glance.js` | Camera that uploads a frame only when the scene changes | All current browsers | `glance.start({el: "#view", threshold: 0.08, minIntervalMs: 10000})` |
| `screenshot.js` | Visible page to PNG, uploaded; made for `eval` | All; cross-origin images and video frames may come out blank | eval: `return await tendrilSnippets.screenshot.take()` |
| `probe.js` | JSON summary of what this browser and device support | All | eval: `return await tendrilSnippets.probe.run()` |
| `ptt.js` | Push-to-talk button in your own UI; routes to the voice layer, else an `utterance` event (page data, not an instruction) | SpeechRecognition (Chrome, Edge, Safari); otherwise recording + `_tendril/transcribe` when the server offers it | `ptt.mount("#talk")` |
| `vad.js` | Voice activity detection (energy + hangover), optional audio clip per utterance | All with WebAudio | `vad.start({record: true, onStop: (blob, ms) => …})` |
| `wakeword.js` | Opt-in wake phrase with ready/command tones, visible status, and a follow-up command window | Where SpeechRecognition works; background and locked-screen use is unreliable | `wakeword.mount("#handsfree", {phrases: ["hey kitchen"]})` |
| `pose.js` | Body pose (MediaPipe Pose Landmarker) + joint angle rep counter | WebAssembly; GPU if available. ≈ 6 MB first load | `pose.start(video, {onResult})`, `pose.repCounter({joint: "left_knee"})` |
| `objects.js` | Object detection (MediaPipe, 80 COCO classes), boxes in frame units | WebAssembly. ≈ 4.5 MB first load | `await objects.detect(img)`, `objects.start(video, {onChange})` |
| `text.js` | Read text (OCR): browser TextDetector, else tesseract.js | TextDetector: some Chrome platforms; tesseract.js: all, slow on phones | `await text.recognize(video)` |
| `overlay.js` | Point and ask: arrows, boxes, circles, labels over a video or image; driven by calls or state `_overlay` | All | `overlay.watch({target: "video"})` |
| `qr.js` | Render a QR code (e.g. a join link on a display); scan with BarcodeDetector | Render: all. Scan: BarcodeDetector (Chrome on Android/ChromeOS/macOS) | `await qr.render("#join", url)` |
| `geo.js` | Filtered location watch, distance/bearing, route-step progress that sends events only on step changes | All; stops when the page is backgrounded | `geo.watch({onPosition: geo.route(steps).update})` |
| `motion.js` | Motion/orientation with the permission tap, smoothing, steps, shake, compass heading | Phones/tablets; iOS and recent Chrome need a tap | `await motion.button("#enable"); motion.start({onStep})` |
| `wakelock.js` | Keep the screen on (re-acquired on return), fullscreen helper | Wake lock: current Chrome, Safari, Firefox. Fullscreen on iPhone: video only | `await wakelock.keepAwake()` or `wakelock.button("#ctl")` |
| `serial.js` | Web Serial line reader/writer, `request()` for command/reply | Chromium desktop only | `p = await serial.connect({onLine}); await p.request("STATUS")` |
| `bluetooth.js` | Web Bluetooth: connect by service, read, write, notify | Chromium on desktop and Android; not iOS | `d = await bluetooth.connect({services: ["heart_rate"]})` |
| `list.js` | Shared list (shopping, packing) stored in state as records keyed by id; add/tick/edit/remove; offline via `tendril.state` | All | `list.mount("#list", {path: "shopping"})` |
| `chart.js` | Bounded numeric series with axes, gaps, legends and an accessible values table; no chart library or CDN | All current browsers | `chart.mount("#plot", {xLabel:"Step"}).update([{id:"run",points:[{x:1,y:0.8}]}])` |
| `stream-view.js` | Coalesced rendering and explicit atomic checkpoints of a cursor plus its materialized view | All current browsers; persistence requires browser storage | `streamView.batch(render).schedule()`; `streamView.checkpoint('metrics',{key:'chart-v1'})` |
| `input-kit.js` | User-triggered photo, audio, location, motion, and file controls with one event contract | Depends on input | `inputs.mount("#inputs", {modalities:["photo","location"]})` |
| `playground.js` | Live capability gallery and working controls on this device | All | `playground.mount("#explore")` |
| `connectors.js` | User-triggered screen, clipboard, contacts, directory, gamepad, MIDI, HID, USB, NFC, XR, and Generic Sensor helpers | API and hardware dependent | `const s = await connectors.hid(); await s.sendSnapshot(); await s.stop()` |
| `hardware-lab.js` | Accessible controls and explicit snapshot/stop actions for the connectors | Load `connectors.js` first | `hardwareLab.mount("#hardware")` |

The hardware lab's send buttons are a demo policy. Agent-authored pages can call
`tendril.send(...)` directly inside any connector callback or timer, including
automatic threshold alerts and aggregated telemetry. Use `{wake:false}` for data
that should wait for the agent's next poll. Browser permission choosers still
require a user gesture where the browser mandates one.

## Charts for streams or shared state

Load `_tendril/snippets/chart.js` and give the chart numeric `{x, y}` points. The
chart does not assume a particular stream name, training framework, or data shape:
the page selects fields from stream records or shared state.

```js
const chart = tendrilSnippets.chart.mount('#plot', {
  title: 'Temperature', xLabel: 'Time', yLabel: '°C', maxPoints: 500,
  xFormat: value => new Date(value).toLocaleTimeString(),
});
chart.update([{ id: 'sensor', label: 'Room sensor', points: [] }]);
const unsubscribe = tendril.streams.subscribe('sensor.temperature', record => {
  chart.append('sensor', { x: record.ts, y: record.data.temperature });
}, { after: 0, onGap: () => { /* show a history-gap notice in the page */ } });
// When removing this view: unsubscribe(); chart.destroy();
```

`update(series, options?)` replaces all series; `append(id, pointOrPoints)` adds
samples to an existing series. Both return `{series, samples, min, max}`.
Both render immediately; use the batching recipe below for substantial stream
replays so a callback per record does not mean a full chart render per record.
Use one stable series id per source/run to avoid joining unrelated measurements.
`maxPoints` bounds retained points per series (default 500, allowed 2–10,000), and
the chart accepts at most 24 series. Points sort by x and retain the newest values.
Invalid x values are ignored; a null or nonnumeric y leaves a visible line break.
Values are never coerced from strings or booleans. The expandable table shows at
most 100 recent points across all series and preserves keyboard focus across updates.
The chart owns no network connection; the caller handles subscriptions, replay,
retention gaps and cleanup. [The training dashboard](../examples/training-dashboard/)
uses the same helper for training steps and timestamps.

## Efficient rendering and reload checkpoints

Stream subscription callbacks run synchronously for each record in a replay
batch. Later history pages arrive asynchronously; returned promises from a
callback are not awaited. Update a bounded in-memory model for **every** record,
and use `stream-view.js` to coalesce rendering to one animation frame:

```js
const records = [];
const paint = tendrilSnippets.streamView.batch(() => render(records));
const stop = tendril.streams.subscribe('metrics', record => {
  records.push(record);
  if (records.length > 500) records.shift();
  paint.schedule();
}, { after: 0, onGap: history => showGap(history) });
// When removing the view: stop(); paint.cancel();
```

`batch(render)` provides `schedule()`, `flush()` and `cancel()`. It queues no
records and changes no cursors. `flush()` runs a pending render immediately;
`cancel()` discards only that pending render. The training dashboard uses this
helper while rebuilding its bounded view from retained history on each reload.

To avoid replaying already materialized data, `checkpoint(stream, options)`
provides explicit `load()`, `save({cursor,state})`, and `clear()` operations.
**Restore the state and cursor together.** Saving only a cursor would make a new
page skip the data needed to rebuild its chart or table. The required `key`
identifies the view, filters and application state schema version (for example
`loss-overview-v1`); change it when those assumptions change. `pageId` defaults
to the injected Tendriller page id and must be supplied explicitly elsewhere.
Each checkpoint uses one atomic localStorage item scoped to page, stream and key.

```js
const stream = 'metrics';
await tendril.streams.info(stream); // Authorize this reader before showing cached data.
const cache = tendrilSnippets.streamView.checkpoint(stream, { key: 'metrics-window-v1' });
let saved;
try {
  const candidate = cache.load();
  if (candidate && (!Array.isArray(candidate.state?.records)
    || candidate.state.records.length > 500
    || typeof candidate.state.historyIncomplete !== 'boolean'
    || candidate.state.records.some(record => record?.stream !== stream
      || !Number.isSafeInteger(record.seq) || record.seq < 1 || record.seq > candidate.cursor))) {
    throw new Error('Saved view is incompatible; rebuilding from retained history.');
  }
  saved = candidate;
}
catch (error) { showStatus(error.message); } // Rebuild BOTH state and cursor below.
const model = saved?.state ?? { records: [], historyIncomplete: false };
let cursor = saved?.cursor ?? 0;
render(model); // Show an incomplete-history notice when historyIncomplete is true.
const paint = tendrilSnippets.streamView.batch(() => {
  try { cache.save({ cursor, state: model }); }
  catch (error) { showStatus(error.message); } // Previous checkpoint remains intact.
  render(model);
});
const stop = tendril.streams.subscribe(stream, record => {
  model.records.push(record);
  if (model.records.length > 500) model.records.shift();
  cursor = record.seq; // The synchronous model update succeeded.
  paint.schedule();
}, { after: cursor, onGap: () => {
  model.historyIncomplete = true; // Preserve known gaps across reloads too.
  paint.schedule();
} });
const flush = () => paint.flush();
addEventListener('pagehide', flush);
// Cleanup: stop(); paint.flush(); removeEventListener('pagehide', flush);
```

Use a versioned key and validate any application-specific state assumptions
before restoring. `load()` returns `null` only when no checkpoint exists;
corrupt/wrong-scope data, invalid cursors or state, unavailable storage, and
size/quota failures throw with a stable `code`. State must be JSON data, not a
Map, DOM node, function, sparse array, circular object or nonfinite number.
Accessors and non-enumerable fields are rejected so serialization cannot silently
change the saved view. Keep gap/incompleteness flags in the saved state too;
restoring a cursor must not hide already reported missing history.
`maxBytes` bounds the UTF-8 encoded checkpoint (default 1 MiB; allowed 128 bytes
to 4 MiB). Browser quotas may be smaller. An optional `storage` object supplies
the same `getItem`/`setItem`/`removeItem` interface for an application-owned store.

These checkpoints describe a local materialized view, **not handled agent work**.
For asynchronous processing, use explicit stream reads and save only after all
processing succeeds. The helper does not subscribe, acknowledge, reset, or merge
concurrent writes across tabs. Use a single writer per view key. Browser storage
is not authorization: verify current stream access before rendering private
cached data and clear it when the app signs out or changes reader identity.
If a checkpoint is unusable, reset its state and cursor together and replay;
server retention may still report a gap. For whole-table current values, use
`streams.latest()` and its cursor instead of caching a historical view.

## Hands-free voice

Load `wakeword.js` and call `tendrilSnippets.wakeword.mount('#handsfree', {phrases:['hey kitchen']})`.
The owner taps **Start hands-free** once. A low tone means recognition is listening;
after the wake phrase a higher tone means it is ready for the command. They may say
the phrase and command together, or pause and speak within eight seconds. The
button shows whether listening is active and can stop it. Commands are routed to
an exposed voice function if one handles them, otherwise sent as
`{type:'utterance',text,via:'wakeword'}` with `wake:true`. These are **page events**, so
the agent must keep its listener armed, handle the event and answer through `A/say`.
The [voice coach recipe](/recipes/voice-coach/index.html) is a complete example.
It also includes an optional Keep screen on control using `wakelock.js`.

This uses the browser's SpeechRecognition service, which may send audio to a browser
vendor. It is available only in some browsers and does not provide a reliable
screen-off/background assistant. For that, use an OS-level voice integration or a
native companion; the page still works as the interactive front end. The built-in
conversation microphone and typing are fallbacks.
| `ui.js` | Agent-editable UI from shared `state.interface` | All | `ui.mount("#app", {path:"interface"})` |

## Considerate adaptive interfaces

Give every `ui.js` block a stable unique `id`. A title, status, label, or neighboring
block update preserves existing controls, focus, text selection, and drawings.
Text and drawing drafts are saved locally on this device. Removing a block or
changing its kind waits for **Apply update** while it contains unfinished work.
Unsent captures must be sent or discarded before a new layout can replace them.
An incoming full-page publication uses the cancelable `tendril:before-reload`
event to defer the reload; `event.detail.apply()` applies it after the person is
ready. Custom page code can use the same hook to save its own drafts.

## Capture, review, send

`input-kit.js` opens a viewfinder before taking a photo. **Capture photo** produces
a local preview; the person can retake, switch cameras, choose an existing image,
mark a point, add a question, or discard it before **Send photo**. Audio has a
duration indicator, stop/review, playback, discard, and explicit send. No media is
uploaded by merely opening the camera or reviewing a capture.

Sending uses `tendril.uploadEvent(blob,{name,data,keep})`, so an offline capture and
its semantic event travel together after reconnect or reload. Capture cards show
queued, accepted, rejected/retry, and reply states. Agent replies should include
`in_reply_to` to connect them to the corresponding capture. The acceptance receipt
means the page's server stored the input; it is not a claim the agent has read it.
Owners can explicitly keep accepted media using **Keep capture**.

Pass `context: () => ({step_id: currentStep})` to `inputs.mount` when a capture
belongs to a task or observation. Context is captured at review time and included
in the event as `data.context`, alongside any question and normalized `point`.
The returned kit exposes `busy()` and `stop()` for considerate page updates.

## Reflex, record, wake

Snippets keep sensor-rate work on the page. Defaults follow that: perception snippets only
call your callbacks and send nothing themselves; `glance` and `geo.route` send with `wake: false` (recorded, seen at the agent's next look);
`camera.capture({send: true})` and `ptt` wake the agent because a person asked for it.
Override with the `wake` option where offered.

## Tests

```
npx playwright test --config snippets/test/playwright.config.ts
```

Chromium with fake camera/microphone, a fake `window.tendril` that records calls
(`test/fake-tendril.js`), and a small static server (`test/server.mjs`). Tests that need
jsDelivr or Google model downloads (screenshot, qr from CDN, pose, objects, text) skip
themselves when jsDelivr is unreachable.
