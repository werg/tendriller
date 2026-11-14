# Public service implementation status

The repository uses one public-service code path. New D1 environments initialize `creation_paused`; the service has not been launched. The user has not yet registered the domains or created OAuth applications.

## Implemented locally

- Service and page host split, page sessions, page `Origin` checks, HSTS, GitHub/Google OAuth with PKCE, verified identity matching, named or first-person claim, invited guests, owner-only display links, and owner agent revocation.
- Account dashboard, named keys, device flow, data export, deletion, D1 account index, per-account and service byte reservations, keyless Admission object, rate bindings, state switch, and budget webhook.
- External and page reports, Turnstile validation, abuse Email Routing handler, static version screening, automatic holds and suspension, appeals, admin actions with a static preview, and D1 audit log. The owner dashboard shows per-device page sensor history.
- On-device Cactus Whistle runtime with pinned model and engine hashes, R2 asset installation script, provisioning script, CI workflow, and operational runbooks.
- Public service tests and TypeScript checks pass locally. A new browser isolation suite is ready for staging; it cannot run until the real domains, OAuth apps, and owner key exist. The prior browser suite assumes anonymous page access and device pairing and is excluded. The deployed service and real provider, email, domain, and browser flows have not been exercised.
- Experience follow-ups implemented locally: cohesive landing, claim and first-version waiting screens; account page cards with direct actions and one-time key reveal; guest request polling with approve/decline; private speech setup with streamed progress and language guidance; and a runnable create/publish/event/reply example. These browser-facing changes still need staging verification on real page origins.

## Launch blockers and incomplete plan items

- Register and activate both domains, issue certificates (including the deeper staging wildcard if used), create OAuth apps and Turnstile widgets, configure Email Routing, Cloudflare budget notifications, DNS, and secrets.
- Provision isolated staging and production D1/R2, apply migrations, install speech assets, deploy staging, and run end-to-end browser and provider checks. Submit the pages domain to HSTS preload and Public Suffix List.
- Legally review and supply terms, acceptable use, privacy, DMCA/abuse contact, minimum age, and request process under `legal/`. The routes and deploy gate are wired, but the pages are absent until approved text is supplied.
- Verify Whistle on a mid-range phone and its privacy/performance behavior. The model has not been benchmarked in a browser.
- Verify Email Sending for automatic owner notices, reporter acknowledgements, and expiring appeal links for suspended owners. Held tendrils retain files for 90 days before the alarm deletes them; exercise that timer in staging. Visitor bursts, creator-IP claim patterns, and repeated releases trigger holds at the documented thresholds. Suspension and restoration enqueue every affected page for retry by a 15-minute scheduled reconciler; verify the cron in staging.
- The local test suite now checks concurrent D1 account reservations. Perform real two-subdomain browser isolation tests, load tests, alert delivery checks, and incident exercises before opening `service_state`.
- Cloudflare's current account-wide budget alerts are email-only, so the existing generic webhook auto-pause endpoint is not a configured Free-plan control. The setup script no longer requires its secret. Use Free-tier hard limits or paid Workers/Durable Objects spending limits; a compatible webhook policy needs separate verification before automatic pause is claimed.

See `docs/OPERATIONS.md` for the setup and launch checklist.
