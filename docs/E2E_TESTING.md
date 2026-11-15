# Browser E2E tests

The core gate is `npm run check:release`: contract, type, build, unit, Worker,
fresh-consumer and compiled composition checks, followed by the runtime, control,
push, TTS and isolated Worker/browser suites. CI checks Node 22.15 and 24.
Contrib owns its component, preview, recipe and portable browser suites.

## Composed service and contrib

Core service and release CI also run the authenticated contrib browser suite
against the exact composed Worker:

```sh
npm run build
npm run build:service
npx playwright install --with-deps chromium
node scripts/test-contrib-integration.mjs
```

The runner checks `dist/service/pairing.json` against `composition.lock.json`,
derives the public source repository from the locked workflow release URL, and
fetches its exact `source_commit` into a temporary checkout. That checkout
installs its own locked dependencies and runs its own E2E tests. Playwright starts
the core-owned local fixture with `--entry dist/service/worker.mjs`; core's normal
local browser suite uses the engine entry. Both fixtures use fresh temporary
storage and the same test account setup. The contrib suite communicates only
through public HTTP and browser interfaces.

This gate covers live approvals, camera/location inputs, private participant
tasks, archive rollover, stale-generation rejection, draft recovery and display
privacy across authenticated browser sessions. It runs before release artifact
publication and blocks service deployment on failure. Traces and screenshots
remain under `test-results/contrib-integration/` after the temporary source and
service storage are removed. Deployment builds consume only the pinned trusted
workflow archive; they do not fetch the test checkout or its dependencies.

## Portable flows and accessibility

Run these commands in the independently versioned contrib repository:

```sh
npx playwright install --with-deps chromium firefox webkit
npm run test:portable
```

These are real browser engines running the production runtime and local preview
protocol adapter. They cover keyboard submission, shared state, display-role
rejection, IndexedDB/outbox replay after an offline reload, fresh asset updates,
granted/denied location, and usable simulation when Serial is absent. Permission
denials and absent APIs are explicitly injected browser fixtures; they do not
claim physical-device coverage.

Every complete workflow is audited with the pinned, locally served `axe-core`
in light and dark mode, with disclosures expanded, and after a keyboard-operated
action. WCAG A/AA violations fail the test; there is no CDN availability skip.
The checker and its license notices ship under `_tendril/`. Portable outputs are
under `test-results/portable`; accessibility JSON is attached to each test.

Run the credential-free local suite with:

```sh
npm run test:e2e
```

The command builds the browser runtime, applies D1 migrations in a fresh temporary directory, seeds two deterministic accounts with verified email identities and session cookies, starts Wrangler on local HTTPS port 8790, and runs headless Chromium. It needs no OAuth application, Cloudflare token, production database, or live domain. The local account fixture uses `owner@example.test`; it exists only in the temporary D1 database. The runner deletes that database when it stops.

Tests cover email-address claiming, rejection of a different verified identity, the listener requirement for first publication, long-poll reminders, page event delivery, agent replies, presence changes, origin isolation, live DOM updates and version reloads, event cursors, agent token enforcement, and microphone startup. The default speech tests use a deterministic worker fixture that requires the WASM `i64` model length to be a JavaScript `bigint`, plus a mocked `OfflineAudioContext` after a real mic-button gesture. They catch the startup regressions without downloading a model in CI.

For the full pinned speech engine and model in Chromium:

```sh
npm run test:e2e:speech-real
```

This test downloads Cactus 4.0.0 JS/WASM and the pinned Whistle model from their public Hugging Face revision URLs, verifies all three SHA-256 hashes, and caches them under `~/.cache/tendriller-e2e/speech-4.0.0` (override with `TENDRIL_SPEECH_CACHE`). It initializes the actual speech worker, checks one second of silence, and recognizes the committed synthetic sentence “Please check the sensor and record the temperature.” The fixture has its own checksum, generation command and provenance in `test/fixtures/speech/`. Empty output cannot satisfy the sentence assertion; word error rate must be at most 30%, ignoring punctuation and case. Results attach the actual transcript and timings.

The dedicated **Pinned speech model** workflow runs when its engine/test/fixture
files change, weekly, and on manual dispatch. It caches the downloads and verifies
them even on a cache hit. A failed download or model check fails that job rather
than becoming a skip. It needs public internet access on the first run and no
Cloudflare credentials, OAuth session, microphone or physical phone. The normal
fast suite still skips the expensive test; the dedicated config starts no local
Worker or account database. This is an inference compatibility smoke test, not
an accuracy or mobile-performance benchmark.

Run `npm run test:e2e:all` to run the local Worker/browser suite and the upstream `runtime/test/tts` browser suite together. The upstream suite owns detailed speech-output tests for lazy loading, fallback, autoplay, queueing, cancellation, timeout, and recovery. `test/e2e/tts-integration.spec.ts` adds cross-layer checks after explicit neural enablement: an agent `/say` response reaches the owner page and neural playback, and microphone input interrupts a long reply, reaches the agent event queue, and allows a later reply to play. Separate policy tests verify browser speech is immediate by default and optional model preparation does not replay a reply.

For a manual staging origin-isolation check using a real signed-in owner session, `npm run test:e2e:public` retains the separate public config. Set `E2E_SERVICE_BASE` and `E2E_OWNER_EMAIL`, then use `scripts/capture-e2e-auth.mjs` to save a local `.e2e-auth.json` browser session. Keep that session file private.

The local Worker intentionally generates production-style page URLs without a test port. The test helper adds `:8790` and follows the auto-claim and one-use page-session redirects through the browser context's shared cookie jar. Browser pages then run on distinct `*.pages.localhost:8790` origins with real Worker WebSockets. Playwright's `ignoreHTTPSErrors` applies only to the local browser and API request contexts; Node's TLS verification remains enabled.
