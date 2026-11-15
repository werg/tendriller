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
| `input-kit.js` | User-triggered photo, audio, location, motion, and file controls with one event contract | Depends on input | `inputs.mount("#inputs", {modalities:["photo","location"]})` |
| `playground.js` | Live capability gallery and working controls on this device | All | `playground.mount("#explore")` |
| `connectors.js` | User-triggered screen, clipboard, contacts, directory, gamepad, MIDI, HID, USB, NFC, XR, and Generic Sensor helpers | API and hardware dependent | `const s = await connectors.hid(); await s.sendSnapshot(); await s.stop()` |
| `hardware-lab.js` | Accessible controls and explicit snapshot/stop actions for the connectors | Load `connectors.js` first | `hardwareLab.mount("#hardware")` |

The hardware lab's send buttons are a demo policy. Agent-authored pages can call
`tendril.send(...)` directly inside any connector callback or timer, including
automatic threshold alerts and aggregated telemetry. Use `{wake:false}` for data
that should wait for the agent's next poll. Browser permission choosers still
require a user gesture where the browser mandates one.

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
