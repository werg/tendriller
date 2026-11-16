# Hands-free wake phrase (core widget)

The always-present **Tendriller control** owns hands-free recognition. A page does not
need to load a contrib snippet or modify its app code. Open the control → Talk →
**Hands-free wake phrase** to start/stop; use Configure (or Settings and history →
Hands-free wake phrase) to change the phrase, recognition mode, and test it.

## User flow

1. Choose a two-or-more-word phrase (default "Hey Tendril") and recognition mode.
   These preferences stay in local device/page storage, not in shared app state.
2. **On-device only** is the default. Use **Check / install on-device language**
   if your browser needs a speech language pack. Engine and language support
   vary. If local support is missing, the control does **not** silently change
   privacy modes.
3. To use the browser's usual speech recognition instead, explicitly select
   **Browser recognition (may use cloud)** and save. Browser vendors may process
   microphone audio remotely; internet access may be required.
4. Tap **Start hands-free**, then say the phrase and command together ("Hey Tendril,
   add eggs to my list"), or say the phrase and wait up to eight seconds before
   the command. The control shows a microphone chip with **Stop** whenever
   recognition is active. **Test wake phrase** confirms detection without sending
   a command to the agent.
5. Commands go through the same conversation instruction path as push-to-talk,
   including guest rules, receipts, offline handling, rate limits and draft
   recovery. Nothing is sent merely from overheard background speech.
6. Listening stops when the user taps Stop, invokes Stop all sensors, initiates
   push-to-talk, hides the control, changes wake settings, loses input privileges,
   backgrounds/navigates away from the page, or experiences terminal recognition
   errors. It **does not restart automatically** on return/reload. Other
   preferences (like contrast or output volume) do not disarm it.

The core widget's wake indicator is independent of the page's getUserMedia
sensor tracker: speech-recognition implementations may obtain microphone audio
internally rather than through a MediaStream exposed to the page. The browser
itself still enforces microphone permissions and indicators.

## Scope, privacy and browser reality

This first implementation matches **complete word tokens in final speech
transcripts**, not raw audio against a trained wake-word classifier. It may
produce false positives or miss a phrase, especially in noise, with homophones,
or when the browser punctuates or segments speech unexpectedly. Keep the page
open, foregrounded and unlocked. Browsers frequently interrupt microphone
capture in background tabs and locked mobile screens. No web page can promise
always-on, screen-off listening across platforms.

- SpeechRecognition compatibility is narrower than general getUserMedia support. The core uses the modern unprefixed interface rather than vendor-prefixed recognition APIs.
- On-device SpeechRecognition requires both the API support and an installed
  language pack. processLocally=true is applied *only* when selected, and
  failure never falls back to the browser/cloud service.
- The browser-managed mode may send ambient microphone audio to the browser
  provider, even though Tendriller only sends explicit post-wake commands to
  the agent.
- The core's optional Cactus/Whistle **push-to-talk** transcription model is a
  separate on-device audio path. It does not provide a continuous wake detector.
- A wake notification cue follows existing display/sound accessibility settings.
  The confirmation test does not submit the following spoken words.

## Modern options evaluated (November 2026)

| Approach | Benefits | Costs / decision |
| --- | --- | --- |
| Web Speech on-device | Platform-managed local ASR, little bundled code, language pack provisioning API | Availability and installed languages vary; still full speech recognition. **Default where available.** |
| Browser-managed Web Speech | Broadest practical compatibility on supported browsers, no model bundle | May be cloud-based; network/privacy tradeoff. **Explicit opt-in only.** |
| Purpose-built local wake classifier (e.g. Picovoice Porcupine Web) | Lower compute cost than continuous ASR; can be fully local; supports custom keyword models | SDK access key and distribution terms, keyword assets, licensing, worker/AudioWorklet integration, platform test matrix. **Candidate for a future independently reviewed engine.** |
| AudioWorklet + WASM/custom model | Local audio frames, device privacy, custom inference, no vendor ASR service | Model accuracy/licensing, memory/battery budget, resampling, accessibility and browser suspension must be tested. **Not shipping without a validated model and benchmarks.** |
| Native OS assistant/background service | Better support for screen-off and mobile lifecycle | Requires explicit OS integration, not a web-only capability. **Out of scope for page UI.** |

Before changing engines, measure false-accepts per hour, missed activations,
time-to-ready, 8-second follow-up command accuracy, on-device power usage,
model download/storage and latency on low-end Android, iOS Safari, desktop
Chrome/Edge/Firefox and assistive input devices. Ensure model integrity,
license/redistribution compliance, prompt/permission UX and disposal semantics
match the core runtime's shipping gate.

## Verification

- runtime/test/wakeword.test.mjs covers complete-word matching, same-utterance
  commands, post-wake command turns, duplicate results, explicit privacy choice,
  denied permission and background stop.
- runtime/test/control/wakeword.spec.ts covers the shipping Shadow DOM widget,
  settings/persistence, live indicator, routing, test-only flow, reload and
  access changes.
- Run npm run check plus npm run test:browser in core. Browser automation
  fakes SpeechRecognition; real microphone/service and on-device language pack
  behavior require explicit device tests before a production release.

## References

- [Chrome 139 — on-device Web Speech API](https://developer.chrome.com/blog/new-in-chrome-139)
- [MDN — Web Speech and local pack installation](https://developer.mozilla.org/en-US/docs/Web/API/Web_Speech_API/Using_the_Web_Speech_API)
- [MDN — getUserMedia permissions and secure contexts](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)
- [Porcupine Web quick start](https://picovoice.ai/docs/quick-start/porcupine-web/)
