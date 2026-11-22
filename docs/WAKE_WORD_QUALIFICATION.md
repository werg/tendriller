# Wake word qualification

This is the release checklist and evidence boundary for issue [#15](https://github.com/werg/tendriller/issues/15).
The standard controls offer deliberate, foreground, on-device phrase recognition.
They do not promise an always-on hardware wake detector. Browser automation can
exercise the controls and lifecycle, while a physical device is required to
qualify actual microphone behavior, interruptions, battery restrictions, and
recognition quality.

The user starts the microphone locally, after reviewing the phrase, language,
download size, and privacy explanation. Recognized commands enter an editable
draft. Generic hosted controls copy reviewed text; an authored page may supply
its own explicitly invoked transcript callback. A detection never submits an
application command by itself.

## Immutable assets

The authoritative registry is [`runtime/resources.mjs`](../runtime/resources.mjs).
It pins Cactus engine commit `1a028f5a3972b67dd8d8752f882113d475e7ec4c`
and Whistle model commit `ad73f1468dd5203791e0cc81d31544c553563645`.

| Asset | Download bytes | SHA-256 |
| --- | ---: | --- |
| `cactus.js` | 63,150 | `bb61bcf0c48712bfb9cd0ade8f0748889dfde9944ac308220f42afbc605f82bc` |
| `cactus.wasm` | 1,241,703 | `4198b30795ded7739fe6c9e80bf26d5a844767c081574d40c8dc0487cde8b4b6` |
| `whistle.cact` | 16,919,407 | `b6e02f048568ac5d01a2042556c658061e699acbc0aa2a1439f52f3d461dffeb` |
| **Total** | **18,224,260** | Each asset is verified independently. |

The consent screen rounds the complete download to **18.2 MB**, including the
**16.9 MB** model. Download size does not describe peak runtime memory. There is
no asset download merely from mounting the controls or opening the page. No
ambient audio is sent to an upload, transcription, telemetry, or event endpoint.

## Foreground and device limits

The current policy is explicit and deliberately conservative:

| Boundary | Limit or outcome |
| --- | --- |
| Wake session | At most 5 minutes; a new local start is required afterward |
| Command window | 8 seconds after a phrase without a following command |
| Audio segment | At most 8 seconds of mono 16 kHz PCM |
| Concurrent inference | One request; the audio worklet applies backpressure |
| One model inference | 10-second watchdog; expiry stops the worker and microphone |
| Per fixed minute | At most 15 inferences and a 20-second inference wall-time budget |
| Total processed audio per wake session | At most 120 seconds; silence is gated before inference |
| Tap-to-talk recording | At most 30 seconds |
| Tab ownership | An origin-wide Web Lock; unavailable/busy ownership fails closed |
| Reported low battery | Wake stops at 20% or less while not charging |
| Reported Data Saver | Wake is refused or stopped; deliberate tap-to-talk remains available |
| Hidden, frozen, navigated, revoked, or interrupted page | Capture stops; no automatic rearming |

Inference wall time is a conservative proxy for device work, not a hardware CPU
meter. The worker watchdog can terminate synchronous WASM from outside the
worker. An unresolved native permission prompt cannot be cancelled by JavaScript;
after Stop, ownership stays reserved until any late stream is received and
closed, preventing another participating tab from opening a parallel microphone.

## Automated gates

Run from the exact source checkpoint being considered for release:

```sh
npm ci
npm run check
npx playwright install chromium firefox webkit
npx playwright test --config runtime/test/voice-controls.playwright.config.ts
npm run test:e2e:speech-real
```

The controls part of the suite bundles the actual controls into a local HTTP page, with a
deterministic voice adapter. It runs the browser's real DOM, trusted pointer and
keyboard input, focus behavior, and responsive layout. It checks:

- Inert mounting, clear model-size and phrase disclosures, and two separate
  actions to review consent and start the microphone.
- Rejection of synthetic clicks and adapter calls that have no one-shot local
  consent; consent is consumed and cannot be reused by a later start.
- A microphone-off preparation state, an explicit active-microphone indicator,
  a Stop control while the panel is collapsed, cancellation, and visible errors.
- Labeled phrase/language/draft fields, Enter and Space activation, Escape,
  focus restoration, reduced-motion preferences, and a 320-pixel viewport.
- Separate tap-to-talk consent, recording, finish, and cancel actions.
- Editable transcripts, preservation of existing typed text, explicit delivery
  or copying, and cleanup when the controls are disposed.

The additional `local-wake-pipeline.spec.ts` runs the actual built voice adapter,
browser AudioContext, and AudioWorklet, with synthetic WAV audio supplied through
a MediaStream. It checks bounded PCM, backpressure, track cleanup, and absence of
audio uploads. Its worker inference is deterministic. The separate real-model
pipeline test uses the same browser audio path with the actual verified WASM and
model instead of that deterministic worker.

Those tests do **not** measure recognition accuracy, physical microphone access,
operating-system permission UI, or mobile power use. The mobile WebKit project
is a browser engine with an iPhone viewport; it is not an iPhone running Safari.

Linux CI provides a clocked PulseAudio null sink for Firefox's real AudioContext.
This preserves browser activation checks while allowing the synthetic audio
graph to run without speakers attached to the runner. Successful pipeline and
model runs retain their JSON evidence in the uploaded test artifacts.

The runtime unit tests exercise detector, worker, resource verification, and
cancellation behavior independently of this presentation suite. The pinned
speech integration test downloads/verifies the real assets and runs actual
WASM inference on synthetic PCM fixtures and silence. Its recorded transcript
and timing are smoke-test evidence for those exact samples. A synthetic voice
fixture is not evidence of performance across human speakers, accents,
microphones, background noise, or languages.

When a host cannot launch a browser, the following additional check runs the
exact built worker and real pinned model in a Node VM, with in-memory browser API
fixtures. It produces `test-results/speech-node/evidence.json`, recording the
worker/runtime identity, asset and audio hashes, actual results, timing, and
network requests:

```sh
npm run build
node scripts/qualify-speech-node.mjs
```

That is actual model inference, but it does not qualify getUserMedia,
AudioWorklet, browser permission prompts, or physical devices. Keep its evidence
separate from a real browser run.

The default phrase is **“Listen computer”**. The synthetic corpus in
[`test/fixtures/speech/wake-manifest.json`](../test/fixtures/speech/wake-manifest.json)
records the exact phrase-only, phrase-plus-command, and related nonmatching
utterances with generation provenance and checksums. The older “Hey Tendril”
default was not reliably transcribed by the pinned model in synthetic probes;
it was not made to match by adding fuzzy aliases. Custom phrases remain explicit
choices and need testing with the person's own voice and language. One English
synthetic voice does not establish a supported accuracy rate or a multilingual
phrase recommendation.

## Physical device matrix

Record the browser version, operating-system version, hardware, source commit,
runtime ID, and observed outcome for each tested row. **The rows below are
required tests, not a claim that they have already been performed.** Do not
replace an unavailable device with a browser user-agent string and call it a
physical-device pass.

| Environment | Required observations | Physical-device evidence |
| --- | --- | --- |
| Chrome or Edge on Windows/macOS/Linux | Permission prompt, actual wake phrase and following command, two tabs, headphone/speaker feedback, permission revocation | Pending; record actual device and run |
| Firefox on desktop | Capability refusal or actual model path, worker/WASM startup, recording codec, permission revocation, keyboard and screen reader | Pending; record actual device and run |
| Safari on macOS | AudioContext activation from the final click, suspended/interrupted context, permission changes, backgrounding | Pending; record actual device and run |
| Chrome on an Android phone | Physical microphone, app switching, screen lock, another app using the microphone, battery/data restrictions, portrait/landscape | Pending; record actual device and run |
| Safari on an iPhone/iPad | Final-click activation, denied permission, tab/app switching, lock screen, phone/Siri interruption, Low Power Mode, installed Home Screen app | Pending; record actual device and run |

For a browser without a required API, the passing outcome is an understandable
unsupported message, no microphone/worker left running, and usable typed input.
Do not report recognition as supported solely because an API name exists.
When the browser exposes no Battery Status API or operating-system power-mode
signal, record that limitation. A fixed time/CPU budget remains necessary; the
page cannot claim to detect every device power restriction.

## Device procedure

Use a fresh profile or explicitly clear only the test page's microphone grant
before the first run. Keep developer tools available for resource/traffic
inspection. Use an isolated test page and synthetic commands that make no
external changes.

1. **Cold opening:** open the page and its Page options. Confirm no speech model
   requests, no microphone indicator, and no active audio context. Open the voice
   controls and verify that this remains true. The editable text fallback works.
2. **Consent and download:** review wake setup. Check the chosen phrase, language,
   18.2 MB download disclosure, foreground-only limit, and no-upload explanation.
   Cancel once and confirm nothing starts. Review again, press Start microphone,
   and check that assets are verified before capture. Deny the browser prompt and
   verify an actionable error; retry through a new local action.
3. **Recognition:** start with headphones and a quiet room. Speak the phrase,
   then a harmless command; repeat with phrase and command in one utterance.
   Check that only the command reaches the draft. Speak unrelated text, a partial
   phrase, and a similar word; neither should become a draft. Existing typed
   text must remain present. Review and explicitly copy/use the result.
4. **False activation and feedback:** play speech containing the phrase through
   the page's output and through speakers. Test delayed output completion and
   interruption. The page's own speech must not trigger a command, including a
   late recognizer result after output ends. Record observed false activations
   from unrelated external sound; do not claim complete immunity to acoustic
   replay or accidental speech.
5. **Stop and concurrency:** stop during model loading, a pending permission
   prompt, listening, command capture, and transcription. Grant an old pending
   prompt after Stop; any late stream must immediately close and no text may be
   delivered. Open another tab on the same origin and start there. At most one
   participating voice capture may own the microphone. Stopping or closing its
   owner must permit a fresh local start in the other tab.
6. **Lifecycle:** switch tabs, background the browser, navigate, go back/forward,
   lock the screen, and dismiss a Home Screen app. Confirm the microphone closes
   and returning does not resume it. Test a phone call/Siri/other audio app where
   available; a suspended or interrupted context must stop with a clear state.
   Revoke microphone permission while listening. Any revoked/ended stream must
   stop processing and delivery.
7. **Power and bounds:** exercise an exposed low-battery or data-saving state,
   sustained speech, and a deliberately slow/stalled worker. Record actual
   session, utterance, and processing bounds from the selected implementation.
   Repeated restarts must not extend one session indefinitely. After a refusal,
   the page's typed input remains usable and listening requires another tap.
8. **Accessibility:** use the platform screen reader and keyboard/switch control.
   Confirm the active microphone state, wake phrase, button names, field labels,
   detected/recording/transcribing/error states, and reachable Stop control.
   Progress must not continuously interrupt speech with download byte counts.
   Check zoom and narrow/landscape viewports; no essential control may be clipped.
9. **Privacy:** inspect network traffic from activation through unrelated speech,
   a detection, and cancellation. Only declared asset requests are expected for
   the model path. Neither raw audio nor ambient transcripts may appear in
   outgoing requests, storage, logs, or application callbacks. Capture evidence
   with the synthetic test phrase only; do not retain bystanders' speech.
10. **Closed tabs:** close every page tab. Verify that no microphone remains.
    Confirm the controls distinguish optional background Web Push notifications,
    which use no microphone. A service worker cannot maintain this listening
    session and must never be described as doing so.

## Evidence record

For every actual device run, append a record with these fields to the release's
qualification evidence. Keep the table above pending until an actual result is
available; attach failed as well as successful outcomes.

```json
{
  "source_commit": "full Git SHA",
  "runtime_id": "exact built runtime ID",
  "tested_at": "ISO 8601 timestamp",
  "hardware": "physical model; distinguish emulation",
  "os_version": "observed version",
  "browser_version": "observed version",
  "language": "tested language tag",
  "phrase": "synthetic test phrase",
  "microphone": "built-in or identified test headset",
  "cases": { "cold_open": "pass/fail", "consent": "pass/fail" },
  "power_api": "available/unavailable",
  "actual_session_ms": null,
  "actual_inference_ms": null,
  "false_activations": null,
  "missed_phrases": null,
  "notes": "observed limitations and links to sanitized evidence"
}
```

Do not put secret page URLs, microphone recordings, unrelated transcripts,
credentials, or personal data in a public test artifact. This evidence does not
authorize publication or production deployment; those remain separate actions.
