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
