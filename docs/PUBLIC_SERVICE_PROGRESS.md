# Public service implementation status

Updated 2026-11-14. The repository has one public-service code path. Both domains, OAuth providers, Turnstile, D1 and R2 resources, secrets, legal pages, and Workers are deployed. Staging creation is **open** for testing with friends. Production creation remains **paused** until its real sign-in and page-opening flow has been checked.

## Implemented and checked

- Service and per-page origins, page sessions, Origin checks, HSTS, GitHub/Google OAuth with PKCE, verified email matching, automatic owner claim on page open, guest approval, owner-only display links, and agent revocation.
- Account dashboard, provider linking, export, deletion, page-scoped agent tokens, per-account and service byte reservations, global creation admission, rate limits, and service state controls. Account keys and the device authorization flow have been removed.
- Reports, Turnstile, static version screening, automatic holds and suspension, in-app notices, page/account appeals, admin actions, audit log, and sensor history.
- On-device speech input and neural speech output with pinned model assets, fallback and recovery behavior, provisioning scripts, CI, legal pages, and operational runbooks. Speech model loading passes the WASM `i64` length as `BigInt`; microphone decoding uses `OfflineAudioContext`.
- Local TypeScript checks, 19 Worker tests, 14 local headless browser tests, and 13 speech-output browser tests pass. The browser suite covers automatic claim, listener requirements, event delivery, page replies, presence, origin isolation, microphone startup, neural speech playback, interruption, and recovery. The opt-in test also initializes the pinned Cactus WASM and Whistle model in Chromium and transcribes silence.
- The live staging API created, published, redirected, and deleted a temporary page successfully. The user confirmed staging GitHub sign-in, linking Google to that account, and opening an agent-created page without a Claim step. A page tap and typed instruction appeared in `GET A/events`; an agent `POST A/say` reply reached the page and played as voice. The staging and production guides and health endpoints were checked live; retired routes were checked on staging.
- The agent guide now starts with page ideas and the create/publish/converse loop. The page sends UI and sensor data with `tendril.send`; the agent replies through the built-in conversation with `POST A/say`. The first page publication requires a live event poll or configured wake receiver, and every poll response includes a next-poll reminder.

## Further launch checks

- Test a different verified email being refused in a real staging browser, then test production GitHub and Google sign-in and page opening before opening production creation.
- Run the optional Playwright staging origin-isolation suite with an authenticated staging browser session and `E2E_OWNER_EMAIL`; the local two-origin suite passes without external credentials.
- Verify speech on a mid-range phone, in-app notices and suspended-account appeals, the 90-day held-page deletion alarm, and the suspension reconciliation cron in staging.
- Exercise rate and storage limits under load and confirm budget monitoring. Cloudflare's account-wide budget alerts are email-only; the generic webhook auto-pause endpoint is not a configured Free-plan control.
- Submit the pages domain for HSTS preload and the Public Suffix List when appropriate.

See `docs/OPERATIONS.md` for deployment and operations.
