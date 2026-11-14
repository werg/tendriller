# Inputs, sensors, and hardware connections

An agent should call `GET A/capabilities` after a person opens a page. The report is
per connected device, current at the time of the request, and does not prompt for
permission. `available` means an API exists in that browser, not that a matching
sensor or peripheral is connected. `permission: "unknown"` is a normal result where
the browser cannot query the permission. Use a visible control to request access.
The page's own `await tendril.capabilities()` returns the same shape and includes
currently tracked camera, microphone, screen, location, and motion activity.

## What to build with

| Input or connection | Ideas | Current Tendriller affordance |
|---|---|---|
| Camera, mic, location, motion, files | Field notes, voice coaching, walking, photo inspection | `input-kit.js`, complete recipes, playground, preview fixtures |
| Pointer, touch, keyboard, drag and drop | Drawings, gestures, editable controls, file drops | `ui.js` drawing/choice/text/slider, canvas recipe; direct DOM APIs |
| Speech recognition and synthesis | Voice instructions and spoken feedback | Built-in conversation voice, `A/say`, `tendril.speak` |
| Screen capture and clipboard | Ask about the visible screen or clipboard text | `connectors.js` capture/clipboard helpers and hardware lab; capture needs a tap |
| Barcode/QR and on-device OCR | Inventory, labels, signs | `qr.js`, `text.js`, camera snippet; check detector support |
| Gamepad and WebXR controllers | Accessible switches, games, spatial UI | `connectors.js` observation callbacks and optional snapshots |
| Bluetooth, Serial, USB, HID, NFC, MIDI | Heart-rate sensors, lab instruments, microcontrollers, switches, musical instruments | Bluetooth/Serial snippets; `connectors.js` USB/HID/MIDI/NFC inspectors |
| Ambient light, magnetic field, gyroscope, accelerometer, proximity | Context and movement tools | `connectors.js` reading callbacks and optional snapshots |
| Contacts and file/directory pickers | Explicitly selected people or documents | `connectors.js` chooser and bounded listing; file uploads in `input-kit.js` |
| Vibration, wake lock, orientation lock | Haptic feedback and device presentation | Detected in capabilities; `wakelock.js` where included |

Load `_tendril/snippets/connectors.js` and then `_tendril/snippets/hardware-lab.js`.
Mount the lab with `tendrilSnippets.hardwareLab.mount('#hardware')`. The device
explorer recipe already includes it. Every emitted event is
`{type:"input",modality,at,...}`. Screen captures upload a PNG and send its blob
reference; clipboard text, selected contacts, and directory names are bounded.
The hardware lab is a sample interface: for gamepad, MIDI, HID, USB, XR, and
Generic Sensors it sends only when the person presses **Send snapshot**. That is
the lab's choice, not a platform rule. Agent-authored page code can call
`tendril.send(data, {wake})` whenever its own logic decides: on a sensor reading,
after a threshold is crossed, on a timer, or after aggregating several readings.
NFC in the lab sends each scanned tag; **Stop** ends scanning.

For example, after starting a light sensor from an appropriate page control, an
agent can send at most one low-light event every 10 seconds:

```js
let lastSent = 0;
const run = tendrilSnippets.connectors.sensor('ambient_light', {
  onReading({lux}) {
    const now = Date.now();
    if (lux >= 20 || now - lastSent < 10_000) return;
    lastSent = now;
    void tendril.send({type:'input', modality:'ambient_light', lux, at:now})
      .catch(console.error);
  }
});
// Call run.stop() when the page no longer needs the sensor.
```

`onMessage`, `onReport`, `onChange`, and `onAction` offer the same pattern for
MIDI, HID, gamepads, and XR. `tendril.send` accepts any serializable page data;
these snippets do not constrain its schema or timing. Use `{wake:false}` for
background telemetry that should wait for the agent's next read. Events are
queued even when a page-started wake is withheld by the wake budget; the agent
still receives them on its next poll. Keep event payloads bounded (64 KB each)
and avoid sending every high-frequency raw sample.

An agent can also use the connectors directly. For example, from a visible button
handler call `await tendrilSnippets.connectors.hid()` and inspect `descriptor`,
then `await session.sendSnapshot()` or `await session.stop()`. For MIDI call
`midi({onMessage})`; for USB call `usb({filters})`; for WebXR call
`xr({mode:'immersive-vr',onAction})`. Chooser APIs must be invoked in the tap's
call stack, so load the scripts before the user clicks. A connected peripheral
usually needs its own protocol definition: identify its vendor/product or service
IDs, then implement packet parsing for that specific device. USB/HID write and USB
read methods are available on the returned session; do not send arbitrary commands
without knowing that device's protocol. XR support and controller events depend on
a device and immersive session being available.

To test without hardware, run
`tendril preview recipes/explore-device --fixture recipes/explore-device/scenario.json`.
The fixture can supply `hardware.clipboard`, `contacts`, `directory`, `gamepads`,
`midi`, `hid`, `usb`, `nfc`, and Generic Sensor readings. A step with
`hardware_event` injects a mock NFC tag, MIDI/HID packet, gamepad state, or sensor
reading. `expect_send` verifies the resulting page event. The example scenario
checks clipboard, gamepad, and NFC from end to end in headless Chromium.

Browser support differs substantially. In particular, browser API presence alone
does not prove usable hardware. The [Generic Sensor API guidance](https://developer.mozilla.org/en-US/docs/Web/API/Sensor_APIs)
requires handling construction and runtime errors. [Chrome's hardware capability
catalog](https://developer.chrome.com/docs/capabilities) covers Bluetooth, Serial,
USB, HID, and NFC. [WebXR](https://developer.mozilla.org/en-US/docs/Web/API/WebXR_Device_API)
and [file system pickers](https://developer.mozilla.org/en-US/docs/Web/API/Window/showOpenFilePicker)
have narrower browser support. The [Permissions API](https://developer.mozilla.org/en-US/docs/Web/API/Permissions_API)
cannot query every permission, and camera/microphone capture requires user permission
in a [secure context](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia).
