# Tendriller public protocol

This describes the sole supported service model. `docs/PUBLIC_SERVICE.md` gives the design and `agent.md` gives the agent quick start. JSON errors have `{"error":{"code":"snake_case","message":"..."}}`; times are milliseconds since epoch.

## Origins and credentials

The service origin is `https://tendriller.dev`; each tendril page has its own origin `https://<12-char base32 id>.tendriller.site/s/<26-char base32 page key>/`. The service host serves the API, OAuth, dashboard, reports, and admin. Page hosts serve only the page and its runtime. Page keys route requests but never authorize a viewer alone. Mutating page requests and WebSocket upgrades require an `Origin` equal to that page origin. Page sessions are opaque `__Host-` cookies; service sessions are separate `__Host-` cookies on the service host. Cross-origin page storage is isolated by the host. HSTS covers the pages domain.

Agent tokens start with `tk_` and authorize `A = https://tendriller.dev/api/t/<id>`. Secrets are stored as hashes. Device IDs and device secrets identify browser devices for presence and offline replay; authorization comes from the page session and role.

## Lifecycle

`POST /api/tendrils` accepts `{"name"?,"owner": "verified@example.com","lifetime"?}`. Owner must be an email verified by GitHub or Google. Creation has an IP rate and daily cap, global hourly and live-unclaimed caps, a 24-hour claim deadline, and 2 MB storage. Only a claimed tendril can be made resident by its agent.

The creation response includes `agent_setup`: no event delivery is configured yet, and the agent must start a continuous long-poll or configure `PUT A/wake` with a persistent receiver before promising live replies. The first `index.html` upload returns `428 listener_required` until a long-poll is held or a wake receiver is configured. Every `GET A/events` response, including an empty long-poll timeout, includes `next_poll` with the returned cursor and `agent_reminder` to continue listening. File publication and `GET A` report `agent_delivery` (`none`, `live_poll`, or `wake_configured`). This is feedback about event routing, not a guarantee that an external agent host remains alive. Events remain queued for later retrieval when the receiver is absent.

Opening a page without a page session redirects through `/auth/page` and OAuth. The signed-in account must have the intended email among its verified provider emails; opening the link claims the page automatically. The service issues a one-use page code; the page origin redeems it for its own host-only cookie. The page owner may invite signed-in guests and approve invites made by agents. Only the owner may create a login-free display link. Display links are read only. `POST A/release` can release the claim before any guest has been approved.

Service sign-in uses GitHub or Google authorization code and PKCE. Account identities use provider subject, with verified emails recorded separately. The dashboard supports provider linking, export, and deletion.

## Agent API

All routes under `A` require `Authorization: Bearer tk_…`. `GET/PATCH/DELETE A` manage the tendril. Files and versions: `PUT A/files/<path>`, `POST/GET A/files`, `GET A/files/<path>`, `GET A/versions`, `POST A/rollback`. Interaction: `GET A/events?after=<cursor>`, `POST A/eval`, `POST A/say`, `POST A/status`, `POST A/check`. Data: `GET/PUT/PATCH A/state`, `GET A/logs`, `PUT/GET A/blobs`, `GET A/blobs/<id>`, `GET/POST A/activity`. Management: `GET/PATCH/DELETE A/devices`, `POST/GET/DELETE A/links`, `POST A/links/<id>/rotate`, `GET/PUT A/wake`, `POST/GET/DELETE A/tokens`, `GET/PUT A/rules`, `POST A/notify`. The agent can create guest invites only and cannot change roles. See `server/src/agent.ts` for exact request bodies.

## Page API and events

The page prefix `P` is the returned `page_url`. `GET P` serves the current version or a holding page. `GET P<path>` serves version files. Reserved `_tendril/` routes include runtime and speech assets, WebSocket, page info, blob upload/download, manifest, icon, agent listing and disconnect, guest approval, reporting, and owner version trust. They are all gated by the page role, except the one-time session code exchange. Static high-risk versions are withheld from guests and display links; owners see an explicit continue screen. A high-risk version on a young account holds the page.

The runtime opens `P_tendril/ws`; the server derives owner, guest, or display permissions from the page session. Owner text and on-device speech become instruction events. Guest and display input stays untrusted data. Browser device secrets support device identity and replay deduplication; they do not grant owner access. The runtime exposes `tendril.send`, shared state, blob upload, and page connection state. Speech uses a hash-pinned Cactus Whistle model downloaded after a microphone tap and transcribes locally.

Spoken output from `POST A/say` (default `speak:true`), `tendril.speak(text)`, and local `say` rules uses Phonon 31M neural English TTS by default. It may sound substantially better than browser speech synthesis. `say` messages appear on all devices but auto-speak only on non-pending owner devices. The runtime lazy-loads the pinned `phonon-tts` package from `P_tendril/tts/`, which includes its workers, Wasm, and license notices. That package pins its default Apache-2.0 model to a Hugging Face commit, downloads roughly 65 MB on first use, and caches assets in the browser. No text is sent to a speech server. WebGPU is selected when available, with single-thread Wasm CPU fallback; this adds no cross-origin isolation requirement. Non-English language preferences, a user-selected browser voice, and neural failures use browser synthesis. `_prefs.audio:false` mutes speech; changing audio/language preferences, submitting a message, or `tendril.tts.stop()` interrupts current/queued speech. Voice selection is stored locally per page origin and is not shared state. `tendril.tts.status` and the `tts` event report initialization/progress/failure. Settings expose voice selection, test, retry, and stop controls. Browser autoplay rules still apply.

Neural synthesis times out after 30 seconds without a new audio chunk, allowing browser fallback instead of blocking later replies indefinitely. Stop interrupts pending model waits as well as playback; a worker that does not acknowledge cancellation within one second is discarded and reloaded from cache for the next reply. Browser autoplay restrictions preserve the loaded model, so neural speech can resume after a user interaction without a manual retry.

## Limits and enforcement

Unclaimed storage is 2 MB and individual files are 1 MB; claimed storage is 25 MB and files are 5 MB. An account has 200 MB storage, at most 20 active tendrils and 3 residents. The service has an exact global byte reservation and admission object. Rate Limiting bindings slow request bursts. `service_state` can pause creation or set read only. A budget notification webhook changes state at configured thresholds.

Reports arrive from a signed-in page or the public Turnstile form at `/report`. Three qualifying account reports within 24 hours hold a claimed page. Reported unclaimed pages are deleted. Three unreversed holds in 30 days suspend an account. The owner can appeal at `/appeal`; allowlisted provider identities use `/admin` to act and audit reasons. `/_tendril/report` remains available from the page control. Every automatic/manual action is recorded in D1.

Young-page guest and display visitor bursts, creator-IP claim patterns, and repeated claim releases also trigger holds at the thresholds in `PUBLIC_SERVICE.md`. The owner dashboard shows sensor activity reported by each connected page device. Suspended owners may sign in to a restricted dashboard with notices and page/account appeals; normal page access remain denied. A scheduled Worker retries page disable/restore operations from the D1 queue; account suspension in D1 denies page access while reconciliation is pending.

## Deployment contract

Staging and production use isolated D1, R2, secrets, routes, and Worker names generated by `scripts/provision.mjs`. D1 migrations initialize creation paused. `docs/OPERATIONS.md` lists the external domain, OAuth, Turnstile, budget, legal, and browser checks required before opening service state. The repository contains one public service route path; no account-key or path-host fallback is deployed.
