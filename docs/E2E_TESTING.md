# Browser and installed-artifact checks

The release gate is `npm run check:release`: contract, type, boundary, unit,
Worker, clean-consumer, and operational-tool checks followed by browser tests.
CI checks Node 22.15 and 24. Browser tests exercise the target runtime with fresh
storage; reconnect scenarios create their pending work under that same contract.

```sh
npm ci
npx playwright install --with-deps chromium
npm run check:release
```

Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to use an already installed Chromium.
A machine that cannot launch the browser has not passed a browser test; use the
CI results to establish that part of the gate.

## Runtime and operational preview

`npm run test:browser` covers the browser runtime, notification and optional
speech adapters, the local Worker, and operational preview. The focused preview
command is `npm run test:tools:browser` after `npm run build:artifacts`.

The runtime tests check durable command outcomes, delayed rejection, outbox and
capture recovery, shared-state ordering, role changes, publication readiness,
and identified conversation receipts. Conversation DOM belongs to the test's
authored page. A reply arriving at the runtime does not imply that an application
displayed it or played audio; those actions use the public presentation and
explicit voice interfaces.

Preview serves exactly the authored publication and the built target runtime.
Missing files stay missing. Service capabilities and responses are explicit
fixtures, and unsupported operations fail. Tests cover nested relative assets,
immutable publication bytes, streams, offline publication saving, and the
headless API. Fixture responses do not establish private-record authorization,
transaction atomicity, or quota enforcement; use the actual Worker for those.
See [preview fixture and report details](tools/PREVIEW.md).

`npm run test:consumer` installs the public artifacts in a clean consumer and
checks runtime imports and TypeScript declarations. The tools artifact test
extracts its archive into an empty directory, invokes its CLI and public packer,
then serves authored HTML and embedded runtime assets without a source checkout,
dependency installation, or external runtime fetch. This is a packaging check;
browser offline behavior has separate browser tests.

Contrib checks its own cookbook metadata, provenance, snippets, and selected
adaptations against public core artifacts. Its browser specimens must name their
simulated permissions, sensors, and service operations. There is no core CI step
that downloads a contrib source checkout or installs a sessions composition.

## Credential-free local Worker

```sh
npm run test:e2e
```

The command builds the browser runtime, initializes a fresh temporary account
database, seeds two deterministic accounts with verified email identities and
session cookies, and starts Wrangler on local HTTPS port 8790. It needs no OAuth
application, Cloudflare token, production database, or live domain. The fixture
owner is `owner@example.test`; these records exist only in the temporary database,
which the runner deletes on shutdown. The default trusted-extension registry is
empty.

Tests cover verified-email claiming, rejection of a different identity, the
listener requirement for interactive publication, event cursors and delivery,
agent replies, presence, origin isolation, live DOM changes, coherent publication
updates, streams, and token enforcement. Trusted-extension checks run against
explicitly selected modules in the Worker host, with fresh records and scopes.

The local Worker generates production-style page URLs without a test port. The
browser helper adds `:8790` and follows automatic claim and one-use page-session
redirects through the browser context's cookie jar. Pages then run on distinct
`*.pages.localhost:8790` origins with real Worker WebSockets.
`ignoreHTTPSErrors` is limited to the local browser and API request contexts;
Node's TLS verification remains enabled.

## Optional speech and pinned model verification

Speech tests explicitly load the optional voice adapter and provide an authored
consent control. The fast tests use deterministic speech-worker and audio-context
fixtures. They check that the WASM `i64` model length is a JavaScript `bigint` and
that microphone startup follows a user gesture, without downloading a model.

Run the actual pinned speech engine and model in Chromium with:

```sh
npm run test:e2e:speech-real
```

The runner downloads Cactus 4.0.0 JS/WASM and the pinned Whistle model from the
revision URLs in `runtime/resources.mjs`, verifies every SHA-256 hash, and caches
the bytes under `~/.cache/tendriller-e2e/speech-4.0.0`. Override the cache with
`TENDRIL_SPEECH_CACHE`. Cache hits are verified too. A failed download or integrity
check fails the test.

The test initializes the actual worker, checks one second of silence, and
recognizes the committed synthetic sentence “Please check the sensor and record
the temperature.” Its generation command, provenance, and checksum live in
[`test/fixtures/speech/README.md`](../test/fixtures/speech/README.md). Empty output
fails; word error rate must be at most 30%, ignoring punctuation and case. The
result attaches the transcript and timing. This is an inference compatibility
check, not an accuracy, battery, or mobile-performance benchmark.

The **Pinned speech model** workflow runs for its selected engine/test/fixture
changes, weekly, and on manual dispatch. Its dedicated config starts no Worker
or account database and needs no microphone, OAuth session, or Cloudflare
credentials. Initial downloads require public internet. The ordinary fast suite
skips the real-model case unless `E2E_REAL_SPEECH=1` is explicitly selected.

`npm run test:tts` exercises lazy speech-output loading, browser fallback,
autoplay, queueing, cancellation, timeout, and recovery. Worker/browser speech
tests exercise explicit voice enablement, agent replies, interruption, and later
recovery. `npm run test:e2e:all` runs the local Worker/browser and TTS suites.
Neither the headless kernel nor receiving an agent reply enables speech by
itself.

## Live service and physical-device checks

For a manual staging isolation check, set `E2E_SERVICE_BASE` and
`E2E_OWNER_EMAIL`, run `node scripts/capture-e2e-auth.mjs`, then
`npm run test:e2e:public`. The capture script saves the signed-in owner's session
to `.e2e-auth.json`; keep that file private. The public suite creates and removes
its own test pages on separate origins. A successful local fixture does not
verify a deployed provider callback, wildcard certificate, or Cloudflare zone
configuration.

Browser automation cannot establish the behavior of a physical camera,
microphone, Bluetooth/Serial device, mobile background lifecycle, or installed
push subscription. Explicitly check the chosen application on its actual target
devices, including denied permission, missing APIs, active-use feedback, stop
controls, and text/keyboard alternatives. For voice, measure first and cached
startup, recognizer accuracy, interruption, mute, background stop, and resource
use. For push, close every page tab and check the installed mobile application.
Use [voice guidance](HANDS_FREE.md), [capture semantics](CAPTURES.md), and
[notification checks](PUSH_NOTIFICATIONS.md) for the relevant public interfaces.
