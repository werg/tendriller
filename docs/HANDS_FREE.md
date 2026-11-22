# On-device voice and wake phrases

Every hosted published page exposes **Page options → Set up voice input**. Opening
those controls loads the optional voice module; it does not download a speech
model, request microphone permission, or start listening. The controls offer
**Tap to talk**, an optional **Wake word** section, and an editable text fallback.
The headless kernel still has no voice engine or microphone acquisition in its
eager import graph.

Choose a phrase and language, review the explanation, then press **Start
microphone**. The explanation names the phrase, the model and total download
sizes, local processing, and session limits. A browser permission prompt may
follow. The shared controls accept only trusted local pointer or keyboard actions
for this decision. Opening a page, restoring preferences, receiving an agent
message, or invoking a control method cannot grant their consent. Each subsequent
start needs another local decision.

The active microphone indicator includes text and a polite screen-reader status;
color is additional information. It distinguishes preparation with the microphone
off, listening, a detected phrase, command capture, local processing, and failures.
**Stop microphone** remains reachable when the voice panel is collapsed. Escape
cancels a consent review or stops an active voice session and closes the panel.
Standard buttons support keyboard activation, fields have accessible labels, and
the controls preserve typed input when voice fails.

The generic hosted controls put recognized commands into a draft. The person can
edit the draft and choose **Copy text**. They never infer or submit an application
command. An authored page can provide the same controls with a callback: then the
button is **Use text**, and the callback runs only after that separate local
action. Raw audio and unrelated ambient transcripts do not enter that callback.

## Add controls to an authored experience

Use the optional module when an application needs a voice dock or an inline
section. Supplying a container places the controls there; otherwise they appear
as a dock above Page options. Mounting and disposing are explicit.

```js
const { mountVoiceControls } = await import(runtime.assetUrl('voice.mjs'));
const controls = mountVoiceControls(runtime, {
  container: document.querySelector('#voice-input'),
  phrase: 'Listen computer',
  language: 'en-US',
  transcript(text) {
    // The person already reviewed this text and pressed Use text.
    // Keep the application's existing review/submission flow.
    document.querySelector('#message').value = text;
    document.querySelector('#message').focus();
  },
});

// When this authored view is removed:
// controls.dispose();
```

The equivalent package import is `@tendriller/runtime/voice`. Omit `transcript`
for the generic review-and-copy behavior. Do not mount a second copy merely to
replace the hosted Page options entry: that entry already offers the feature.
The standard control always selects the pinned on-device model. Alternative
browser recognition modes require an authored experience and their own accurate
consent presentation.

## Public adapter and consent

For a custom presentation, `createVoice(runtime, options)` supplies the lower-level
lifecycle. Construction starts no microphone, playback, or model download. Supply
`consent`, `transcript`, and `status` callbacks. The custom page owns its visible
microphone indicator, stop action, transcript review, and typed fallback.

The consent callback receives a frozen snapshot with `purpose`, `engine`, and
`description`, plus the relevant `phrase`, `language`, `downloadBytes`, and
`maxSessionMs`. It must return `true` only for the person's explicit decision to
perform that exact action. A stored preference or a remote request is not such a
decision. Input settings are captured before awaiting consent, so changing the
caller's settings object during a pending decision cannot switch engines or
phrases. Stopping, changing language, or disposing invalidates pending starts.

For example, after implementing the local review/consent callback, an authored
Start handler can request the pinned model:

```js
await voice.startWake({ phrase: 'Listen computer', mode: 'model' });
```

Safari/iOS audio activation may need to happen synchronously in the final Start
gesture. The shared controls arrange their review before that gesture and consume
one synchronous consent decision. Custom presentations should preserve that same
ordering; an asynchronous consent dialog that discards user activation may need a
fresh Start action. The adapter never substitutes a cloud recognizer to work
around missing local support.

| Operation or property | Behavior |
| --- | --- |
| `prepareCapture()` | Requests transcription consent and prepares verified local resources, with no microphone request. |
| `startCapture()` / `finishCapture()` | Requests fresh recording consent, records at most 30 seconds, and delivers the local transcription to the page callback. |
| `cancelCapture()` | Cancels preparation, recording, decoding, or a pending transcription result. |
| `startWake({ phrase, mode })` | Requests fresh consent and starts the explicitly selected foreground phrase detector. |
| `stopWake()` | Stops wake input without changing an unrelated tap-to-talk recording. |
| `localAvailability()` / `installLocalLanguage()` | Checks browser language-pack support or explicitly requests its installation; neither starts a microphone. |
| `language(tag)` | Stops current activity and saves a validated language choice. |
| `microphoneActive` | Reports actual microphone use separately from preparation or permission waiting. |
| `wakeStatus` / `captureStatus` | Exposes current state and an actionable explanation. |
| `settings` | Returns a copy of saved language, phrase, and engine choices; these never imply permission to listen. |
| `enableOutput('browser' \| 'neural')` | Requests output consent and enables output for this adapter session; neural preparation is explicit. |
| `speak(text)` | Stops input before queuing the page's explicitly selected output, preventing delayed recognition of its own reply. |
| `mute()` | Disables this adapter's output and stops current speech. |
| `stop()` | Stops output, capture, wake recognition, and pending starts. |
| `dispose()` | Stops and releases workers, audio resources, subscriptions, and page listeners; repeated disposal is safe. |

`listening`, `speaking`, `muted`, and `outputStatus` are also observable.
`options.status` includes the activity kind, state, explanation, and microphone
state where applicable. A custom page should not derive microphone activity from
`listening`: a session can be preparing or waiting without holding an active
track. A browser recognizer being aborted can still report an active microphone
until its native `end` event confirms shutdown.

## Recognition engines and pinned assets

| Wake mode | Processing and consent |
| --- | --- |
| **`model`** | Pinned Cactus/Whistle speech recognition in a local worker, with AudioWorklet sound-activity gating and whole-phrase matching. Ambient audio is never uploaded. This is the shared control's choice. |
| **`local`** | The browser's on-device `SpeechRecognition`, requiring an installed language pack and verified `processLocally` activation. The browser owns its model/version. Unsupported or missing local recognition fails without a cloud fallback. |
| **`browser`** | Explicit selection of the browser recognition provider, including prefixed browser APIs where available. It may send **all microphone audio, including ambient speech**, to that provider. Its separate consent description says so. |

The pinned path implements phrase spotting through local speech recognition. It
is not a dedicated low-power acoustic wake-word model. Sound activity triggers one
bounded inference at a time; silence and brief clicks do not continuously invoke
the model. The worklet discards incoming audio while inference is busy instead of
accumulating an unbounded queue. After a phrase alone, wait for **Speak your
command** before continuing. A phrase followed by a command in the same utterance
also works. Only the command is delivered. An unrelated speech result remains
inside the worker and is discarded; it is not returned as a page transcript.

The immutable registry is [`runtime/resources.mjs`](../runtime/resources.mjs):

| Asset | Exact download bytes |
| --- | ---: |
| Cactus JavaScript engine | 63,150 |
| Cactus WebAssembly engine | 1,241,703 |
| Whistle model | 16,919,407 |
| **Complete speech download** | **18,224,260** |

The consent screen rounds those sizes to **16.9 MB** for the model and **18.2 MB**
for the complete download, and also shows the exact total. These are download
sizes, not peak runtime memory. Executable JavaScript, WebAssembly, and model
weights each have their own pinned SHA-256 digest and size. The worker verifies
all three before executing the engine or loading the model. Runtime resource
metadata must match the built-in pins; it cannot silently select different model
bytes after consent. Exact revisions and digests are listed in the
[qualification record](WAKE_WORD_QUALIFICATION.md#immutable-assets).

Tap-to-talk uses the same pinned model. It decodes the bounded recording with
`OfflineAudioContext`, without needing autoplay permission, and transcribes on
the device. Finishing stops tracks immediately; it does not wait for a delayed
`MediaRecorder` result. Cancelling active inference terminates the worker and
suppresses late callbacks. Download, permission, recording, and worker failures
remain visible and leave typed input usable.

The model supports English, German, French, Spanish, Italian, Dutch, and Polish.
The standard control starts with the device or saved language, retains regional
language tags, and makes the selection visible. Unsupported languages need a
deliberate change or typed input; they do not silently become English. The default English phrase is **Listen computer**. Choose a
distinctive phrase of at least two words in the selected language. Matching uses
whole words, preserves punctuation in the following command, and compares
normalized Unicode text. Actual recognition quality still needs device and
speaker evidence.

## Foreground, power, and work bounds

| Boundary | Implemented limit |
| --- | --- |
| Wake session | At most 5 minutes; another local start is required afterward |
| Captured wake utterance | At most 8 seconds of mono 16 kHz PCM |
| Command window after phrase alone | 8 seconds; already admitted inference can finish within its watchdog |
| Concurrent model work | One inference; no queued ambient windows |
| Single model inference | At most 10 seconds before the external watchdog stops the worker and microphone |
| Inference work per fixed minute | At most 15 inferences and a 20-second inference wall-time budget |
| Total audio admitted to model per session | At most 120 seconds |
| Tap-to-talk utterance | At most 30 seconds |
| Pending microphone permission | A bounded visible wait; any later grant is stopped after cancellation |

Inference wall time is a conservative device-work budget, not a measurement of
hardware CPU use. Fixed audio buffers, backpressure, total audio limits, worker
termination, and hard session deadlines bound work on slow or noisy devices.
The [local detector](../runtime/src/voice/local-wake.ts) and
[microphone policy](../runtime/src/voice/microphone.ts) are the executable policy.

A same-origin Web Lock coordinates the adapter's wake and tap-to-talk modes across
open tabs. A second tab receives an explanation instead of stealing ownership.
Browsers without Web Locks fail closed for voice acquisition. This coordinates
participating Tendriller tabs on one origin; it does not claim to control another
origin or another application's microphone. After Stop, an unresolved native
permission request retains the lease until any late stream arrives and is
closed. An aborted browser recognizer retains ownership until native shutdown
is confirmed. The page never opens a replacement microphone in that interval.

Wake listening is refused or stopped when an exposed battery status is at or
below 20% while discharging, or when exposed Data Saver is enabled. Deliberate
tap-to-talk remains available. Browsers such as Safari may not expose those
signals; the page cannot claim to detect every operating-system power mode.
Foreground, time, and work bounds still apply when optional status APIs are
absent. Permission revocation, ended/muted tracks, interrupted audio processing,
page hiding/freezing, navigation, and **Stop sensors** all stop input. Returning
to the page never automatically rearms it.

The adapter stops recognition before playing its own speech, discards stale
results, and clears the command window. It cannot promise that unrelated sound
from another device will never contain the chosen phrase. Reviewed text prevents
an accidental acoustic match in the shared control from becoming an application
command.

**Wake word requires a visible, running page with microphone permission. It does
not work when all tabs are closed. A service worker cannot maintain an always-on
microphone.** Background Web Push notifications use no microphone and are a
separate feature. Server agent event delivery, including `A/wake` and wake
budgets, is also separate from spoken phrase detection.

## Output and offline assets

Browser synthesis is the lightweight output choice. Optional neural English
output uses pinned `phonon-tts@0.7.1` code and the explicitly selected Phonon model
revision. Its first use is about 65 MB, disclosed separately. Other languages or
unavailable neural output use browser synthesis. Partially played neural replies
are not repeated in a fallback voice. Output remains muted on each new visit;
another tab cannot unmute this adapter or change its active engine.

Runtime and worker code retain their publication identity. The hosted runtime
saves only its required startup files eagerly. Voice code and optional speech
resources are requested on deliberate use; mounting controls does not prefetch the
model. Cached resources are still checked against their declared identity. The
optional neural output model cache is a separate dependency. Saving page code
for offline use alone does not establish that optional speech resources or a
browser language pack are present.

## Verification and evidence

`npm run test:runtime-unit` exercises cancellation interleavings, cross-tab
ownership, permission/power policy, phrase matching, sound-activity segmentation,
worker input bounds, individual asset verification, strict local recognition,
output exclusion, and late-result suppression. The adapter integration tests use
real runtime classes with controlled browser devices and workers; they do not
measure acoustic recognition quality.

`npm run test:e2e:voice-controls` runs the shared controls in Chromium, Firefox,
WebKit, and a mobile WebKit viewport. The presentation tests use deterministic
voice results while exercising actual trusted input, focus, labels, responsive
layout, consent, draft review, and stop controls. A separate pipeline test runs
the actual browser AudioWorklet with generated media and deterministic inference.
Neither a mobile viewport nor a generated MediaStream is a physical phone or
microphone test.

`npm run test:e2e:speech-real` separately exercises the actual pinned model in a
browser. After `npm run build`, `node scripts/qualify-speech-node.mjs` can verify
and run the same worker/WASM/model against the pinned speech fixture in a Node
VM, including a matching phrase, a nonmatching phrase, silence, and sound-gated
audio. That alternative records hashes, runtime identity, timings, and transcript
results; it does not qualify browser permissions, AudioWorklet execution, Safari,
or physical-device recognition. A few recorded or synthetic fixtures are smoke
tests, not an accuracy corpus across speakers, accents, languages, or noise.

Use the [qualification matrix and physical-device procedure](WAKE_WORD_QUALIFICATION.md)
for release evidence. Record the exact source/runtime, browser, operating system,
hardware, and checks actually run. Keep untested Safari/iOS, Android, real
microphone, interruption, power, and screen-reader cases explicitly pending.
