# Pinned speech fixtures

`sensor-check.wav` is synthetic speech generated specifically for this repository,
using the original sentence **“Please check the sensor and record the temperature.”**
It is not a recording of a person or an excerpt from a benchmark corpus.
`manifest.json` records the generator, exact command, transcript, PCM format and
SHA-256 digest. Ordinary tests read the committed bytes and do not run a speech
synthesizer or need a microphone.

To regenerate intentionally, install FFmpeg with its CMU Flite filter and run:

```sh
node scripts/generate-speech-fixture.mjs
```

The generator uses [CMU Flite](https://github.com/festvox/flite)'s `slt` voice,
resamples to mono 16 kHz PCM16 and adds a quarter-second of silence at each end.
The fixture's checksum must match its manifest before the real-model test runs.
The sentence check ignores punctuation/case and allows at most 30% word error;
an empty transcript fails. This is an integration smoke test, not a claim about
recognition accuracy across voices, languages or environments. A separate
one-second zero-sample input checks silence handling.

## Default wake phrase fixtures

`wake-manifest.json` pins three additional synthetic `slt` recordings for the
default phrase **“Listen computer”**: phrase and command in one utterance, the
phrase by itself, and an unrelated sentence with similar words. It records the
expected exact wake decision, expected command words, generator arguments and
SHA-256 for each WAV. Regenerate intentionally with:

```sh
node scripts/generate-wake-fixtures.mjs
```

The real-model browser check tests all three decisions. Its full voice-adapter
scenario also replays the command recording through an actual AudioContext,
MediaStream and AudioWorklet before local model inference. The microphone source
is injected; this is not physical microphone or mobile-device qualification.

For a host that cannot launch a browser, build the runtime and run:

```sh
node scripts/qualify-speech-node.mjs
```

That check executes the exact bundled worker with real, verified Cactus WASM and
Whistle weights inside a Node VM. It checks the committed speech and wake
fixtures, real VAD-segmented input, silence, unrelated phrase rejection, command
separation and absence of any audio network request. It writes its exact hashes,
responses, timings and environment limitations to
`test-results/speech-node/evidence.json`. Browser APIs are supplied by the fixture;
the result must not be reported as a browser run.

An optional `--probe-default` run uses local FFmpeg/Flite to compare candidate
phrases and record every generated WAV checksum and command. The original
“Hey Tendril” failed this small synthetic probe; “Computer listen” worked in a
combined sentence but failed as a standalone phrase. “Listen computer” passed
both paths and the unrelated-sentence check. This explains the default choice;
one synthetic voice does not establish false-accept/false-reject rates or broad
recognition accuracy. Wake matching remains exact, without fuzzy spelling rules.
