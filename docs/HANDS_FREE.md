# Explicit voice interaction

Voice is an optional adapter, loaded with
`import(tendril.assetUrl("voice.mjs"))` or `@tendriller/runtime/voice`. The headless
runtime has no voice engine or mandatory microphone UI. Importing and constructing
`createVoice(runtime, options)` starts no microphone, speech, or download. A stored
engine choice never resumes listening or unmutes a new visit.

An authored experience supplies its controls, visible active-use state, a stop
path, typed fallback, consent callback, and transcript callback. The transcript
callback decides whether to review/edit text, submit a declared command through its application session. Reading a voice cookbook does not select an
engine or install a listening behavior.

## Public lifecycle

| Operation | Behavior |
| --- | --- |
| `enableOutput("browser" | "neural")` | Requests the supplied consent decision, then enables this visit's output. Neural preparation is explicit. |
| `speak(text)` | Queues output only after it is enabled and unmuted. |
| `mute()` | Disables local output and stops current speech. |
| `prepareCapture()` | Requests transcription consent and prepares the selected local resources without opening a microphone. |
| `startCapture()` / `finishCapture()` | Record a bounded utterance and deliver transcription to the page callback. |
| `cancelCapture()` | Discard the active/pending recording or result. |
| `startWake({phrase,mode})` | Request consent and start foreground wake-phrase recognition in the explicitly selected mode. |
| `localAvailability()` / `installLocalLanguage()` | Inspect support or explicitly request the browser's local language-pack installation. |
| `stop()` | Stop output, capture, wake recognition, and pending starts. |
| `dispose()` | Stop and release worker, audio resources, subscriptions, and page listeners. |

`language(tag)` changes the local choice and stops existing activity.
`listening`, `speaking`, `muted`, and `outputStatus` are observable; `options.status` reports
output, capture, and wake progress/errors. `outputStatus` names the selected engine
and its preparation state; `muted` reports session playback consent separately.
The page explicitly calls `voice.speak(text)` for the application output it chooses.
Hidden pages, navigation, and the public sensor-stop signal stop active voice use. Backgrounding never automatically rearms recognition.
Voice choices can persist for a later visit; playback consent is local to this
adapter session. Another tab cannot unmute this adapter or change its active engine.

## Engines and their limits

Push-to-talk uses the content-addressed Cactus/Whistle engine and model described
by the selected runtime's `resources.json`. The optional worker checks the declared
WASM and model hashes. Recording is bounded to 30 seconds, audio is decoded through
`OfflineAudioContext`, and transcription occurs on the device. Preparation,
permission denial, decoding failure, cancellation, and a stalled worker all have
explicit outcomes. A cancelled result never becomes a late submitted command.
The page should preserve typed input throughout preparation and failures.

Wake input has two explicit choices:

- **`local`** requires on-device `SpeechRecognition`, sets `processLocally`, and
  needs a supported installed language pack. An unsupported browser or language
  fails without switching to a cloud recognizer.
- **`browser`** deliberately selects the browser recognition provider. It can use
  a network service; its consent description makes that tradeoff visible.

This adapter matches final speech transcripts against whole phrase words. It is
not a dedicated low-power acoustic wake-word model. It ignores output while the
adapter or browser is speaking, limits its command window, bounds repeated
recognizer restarts, and never treats unrelated background transcripts as input.
A different wake engine requires deliberate selection and device evidence rather
than an unsupported accuracy claim.

Browser synthesis is the lightweight output choice. Optional neural English output
uses pinned `phonon-tts@0.7.1` code and the Phonon model revision explicitly selected
by the adapter. Its first use is about 65 MB; the consent request says so. Other
languages and unavailable neural output use browser synthesis. Partially played
neural replies are not repeated in a fallback voice. Queued output can be stopped,
and an interrupted synthesis cannot block subsequent speech indefinitely.

Runtime code, worker code, and declared resources retain exact publication
identity. Only `tendril.js` and `sw.js` are eagerly saved for the hosted runtime;
voice and other optional runtime files are verified and cached on deliberate use.
The adapter's upstream model cache remains an explicit optional dependency.

## Verification and evidence

Unit tests exercise strict local recognition, consent/disabled behavior, whole-word
matching, duplicate results, output exclusion, permission errors, background stop,
failed construction, queue interruption, and unchanged durable input identity.
The service/browser specimens in `test/e2e/authored-pages.ts` use their own markup
and callbacks; they do not import a control product. A deterministic worker test
covers the WASM i64 model-length call and decoding without autoplay playback.

`npm run test:e2e:speech-real` separately exercises the pinned engine/model against
silence and the recorded speech fixture. Browser/provider availability and real
microphone quality require current device testing; mocked transcription never
establishes recognition accuracy. Report which checks actually ran and the exact
artifact revision rather than calling every supported API an exercised device.
