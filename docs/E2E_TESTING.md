# Browser E2E tests

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

This opt-in test downloads Cactus 4.0.0 JS/WASM and the pinned Whistle model from their public Hugging Face revision URLs, verifies all three SHA-256 hashes, caches them under `~/.cache/tendriller-e2e/speech-4.0.0`, then initializes the actual speech worker and transcribes one second of silence. It needs internet access on the first run and no Cloudflare credentials. Later runs use the verified cache. The default suite skips this test.

Run `npm run test:e2e:all` to run the local Worker/browser suite and the upstream `runtime/test/tts` browser suite together. The upstream suite owns detailed speech-output tests for lazy loading, fallback, autoplay, queueing, cancellation, timeout, and recovery. `test/e2e/tts-integration.spec.ts` adds cross-layer checks: an agent `/say` response reaches the owner page and neural playback, and microphone input interrupts a long reply, reaches the agent event queue, and allows a later reply to play.

For a manual staging origin-isolation check using a real signed-in owner session, `npm run test:e2e:public` retains the separate public config. Set `E2E_SERVICE_BASE` and `E2E_OWNER_EMAIL`, then use `scripts/capture-e2e-auth.mjs` to save a local `.e2e-auth.json` browser session. Keep that session file private.

The local Worker intentionally generates production-style page URLs without a test port. The test helper adds `:8790` and follows the auto-claim and one-use page-session redirects through the browser context's shared cookie jar. Browser pages then run on distinct `*.pages.localhost:8790` origins with real Worker WebSockets. Playwright's `ignoreHTTPSErrors` applies only to the local browser and API request contexts; Node's TLS verification remains enabled.
