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
| `wakeword.js` | Listen for a phrase ("hey kitchen") and hand over the command after it | Where SpeechRecognition works; not a true offline wake word | `wakeword.start({phrases: ["hey kitchen"], onWake})` |
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
