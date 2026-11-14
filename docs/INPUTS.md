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
| Screen capture and clipboard | Ask about the visible screen or pasted text/images | Detected in capabilities; build with browser APIs after a tap |
| Barcode/QR and on-device OCR | Inventory, labels, signs | `qr.js`, `text.js`, camera snippet; check detector support |
| Gamepad and WebXR controllers | Accessible switches, games, spatial UI | Detected in capabilities; direct browser APIs |
| Bluetooth, Serial, USB, HID, NFC, MIDI | Heart-rate sensors, lab instruments, microcontrollers, switches, musical instruments | Bluetooth/Serial snippets and capability report; device-specific protocols still needed |
| Ambient light, magnetic field, gyroscope, accelerometer, proximity | Context and movement tools | Detected in capabilities where browser exposes APIs; direct browser APIs |
| Contacts and file/directory pickers | Explicitly selected people or documents | Detected in capabilities; direct picker APIs |
| Vibration, wake lock, orientation lock | Haptic feedback and device presentation | Detected in capabilities; `wakelock.js` where included |

The next reusable connectors worth adding are **gamepad** (map buttons and axes to
events), **MIDI** (note/control-change events), **USB/HID** (chooser and packet
inspector), **NFC** (read a tag), and **screen capture** (a user-selected frame).
Keep raw sensor rates on the device; send a short summary or explicit capture to the
agent. A connected peripheral usually needs its own protocol definition, so the
agent should first identify the device, service/vendor IDs, and expected packet
format before generating a connector.

Browser support differs substantially. In particular, browser API presence alone
does not prove usable hardware. The [Generic Sensor API guidance](https://developer.mozilla.org/en-US/docs/Web/API/Sensor_APIs)
requires handling construction and runtime errors. [Chrome's hardware capability
catalog](https://developer.chrome.com/docs/capabilities) covers Bluetooth, Serial,
USB, HID, and NFC. [WebXR](https://developer.mozilla.org/en-US/docs/Web/API/WebXR_Device_API)
and [file system pickers](https://developer.mozilla.org/en-US/docs/Web/API/Window/showOpenFilePicker)
have narrower browser support. The [Permissions API](https://developer.mozilla.org/en-US/docs/Web/API/Permissions_API)
cannot query every permission, and camera/microphone capture requires user permission
in a [secure context](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia).
