# Public service implementation status

Updated 2026-11-14. The repository has one public-service code path. Both domains, OAuth providers, Turnstile, D1 and R2 resources, secrets, legal pages, and Workers are deployed. Staging creation is **open** for testing with friends. Production creation remains **paused** until its real sign-in and page-opening flow has been checked.

## Implemented and checked

- Service and per-page origins, page sessions, Origin checks, HSTS, GitHub/Google OAuth with PKCE, verified email matching, automatic owner claim on page open, guest approval, owner-only display links, and agent revocation.
- Account dashboard, provider linking, export, deletion, page-scoped agent tokens, per-account and service byte reservations, global creation admission, rate limits, and service state controls. Account keys and the device authorization flow have been removed.
- Reports, Turnstile, static version screening, automatic holds and suspension, in-app notices, page/account appeals, admin actions, audit log, and sensor history.
- On-device speech runtime with pinned model assets in R2, provisioning scripts, CI, legal pages, and operational runbooks.
- Local TypeScript checks and 17 tests pass. Tests cover required owner email, refusal of a different verified account, automatic claim and page session, resident promotion after opening, and browser-origin routing checks. The live staging API created, published, redirected, and deleted a temporary page successfully. The user confirmed staging GitHub sign-in, linking Google to that account, and opening an agent-created page without a Claim step. A page tap appeared in `GET A/events`; an agent `POST A/say` reply reached the page and played as voice. The staging and production guides and health endpoints were checked live; retired routes were checked on staging.
- The agent guide now starts with page ideas and the create/publish/converse loop. The page sends UI and sensor data with `tendril.send`; the agent replies through the built-in conversation with `POST A/say`.

## Further launch checks

- Test a different verified email being refused in a real staging browser, then test production GitHub and Google sign-in and page opening before opening production creation.
- Run the Playwright two-origin isolation suite with an authenticated staging browser session and `E2E_OWNER_EMAIL`.
- Verify speech on a mid-range phone, in-app notices and suspended-account appeals, the 90-day held-page deletion alarm, and the suspension reconciliation cron in staging.
- Exercise rate and storage limits under load and confirm budget monitoring. Cloudflare's account-wide budget alerts are email-only; the generic webhook auto-pause endpoint is not a configured Free-plan control.
- Submit the pages domain for HSTS preload and the Public Suffix List when appropriate.

See `docs/OPERATIONS.md` for deployment and operations.
