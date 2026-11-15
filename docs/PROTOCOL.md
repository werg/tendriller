# Tendriller public protocol

This describes the sole supported service model. `docs/PUBLIC_SERVICE.md` gives the design and `agent.md` gives the agent quick start. JSON errors have `{"error":{"code":"snake_case","message":"..."}}`; times are milliseconds since epoch.

Executable schemas are exposed at `/contract/v1.json` and owned by
`contract/index.mjs`; TypeScript declarations and the fetch client live alongside
them. The runtime, API write boundaries, MCP tools and local preview use this
contract. `docs/EXPERIENCES.md` specifies the additive device/timer/session/bundle,
decision and private-response workflows.
`docs/DURABILITY.md` specifies opt-in event consumer leases and durable timer
notification retries, including their explicit retention and delivery limits.

## Origins and credentials

The service origin is `https://tendriller.dev`; each tendril page has its own origin `https://<12-char base32 id>.tendriller.site/s/<26-char base32 page key>/`. The service host serves the API, OAuth, dashboard, reports, and admin. Page hosts serve only the page and its runtime. Page keys route requests but never authorize a viewer alone. Mutating page requests and WebSocket upgrades require an `Origin` equal to that page origin. Page sessions are opaque `__Host-` cookies; service sessions are separate `__Host-` cookies on the service host. Cross-origin page storage is isolated by the host. HSTS covers the pages domain.

Agent tokens start with `tk_` and authorize `A = https://tendriller.dev/api/t/<id>`. Secrets are stored as hashes. Device IDs and device secrets identify browser devices for presence and offline replay; authorization comes from the page session and role.

## Lifecycle

`POST /api/tendrils` accepts `{"name"?,"owner": "verified@example.com","lifetime"?}`. Owner must be an email verified by GitHub or Google. Creation has an IP rate and daily cap, global hourly and live-unclaimed caps, a 24-hour claim deadline, and 2 MB storage. Only a claimed tendril can be made resident by its agent.

The creation response includes `agent_setup`: no event delivery is configured yet, and the agent must attach this conversation to a host wake path before promising live replies. `GET A/events` accepts `wait=0..300` seconds; the recommended `wait=300` returns as soon as a waking event arrives, and the client reconnects after an empty timeout. The first `index.html` upload returns `428 listener_required` until an agent WebSocket or long poll is active, or a wake receiver is configured. A WebSocket receiver uses `wss://tendriller.dev/api/t/<id>/events/socket` and offers `tendriller.agent.v1` plus its private `tk_…` token in `Sec-WebSocket-Protocol`. The server accepts `tendriller.agent.v1`, keeps the Durable Object hibernatable, and sends only `{t:"wake",seq}`. On connect, reconnect, and wake, fetch `GET A/events?after=<acknowledged cursor>&wait=0`; the socket is receive-only. A JSON `{"t":"ping"}` receives an automatic `{"t":"pong"}` without waking the object. Never put the token in the URL. Every `GET A/events` response, including an empty long-poll timeout, includes `next_poll` with the returned cursor and `agent_reminder` to continue listening. File publication and `GET A` report `agent_delivery` (`none`, `live_socket`, `live_poll`, or `wake_configured`). This is feedback about event routing, not a guarantee that an external agent host resumes the intended conversation; verify two delivery probes end to end. Events remain queued for later retrieval when the receiver is absent.

Opening a page without a page session redirects through `/auth/page` and OAuth. The signed-in account must have the intended email among its verified provider emails; opening the link claims the page automatically. The service issues a one-use page code; the page origin redeems it for its own host-only cookie. The page owner may invite signed-in guests and approve invites made by agents. Only the owner may create a login-free display link. Display links are read only. `POST A/release` can release the claim before any guest has been approved.

Service sign-in uses GitHub or Google authorization code and PKCE. Account identities use provider subject, with verified emails recorded separately. The dashboard supports provider linking, export, and deletion.

## Agent API

`PUT A/wake` accepts `{"webhook":{"url":"https://…","token":"<secret>","auth":"bearer|standard_webhooks|hermes_v2"}}`. `auth` defaults to `bearer`. Bearer sends `Authorization: Bearer <token>` (the token may be omitted for a public receiver). `standard_webhooks` requires a `whsec_` plus base64 secret and signs `{webhook-id}.{webhook-timestamp}.{raw JSON}` with HMAC-SHA256, returning `webhook-signature: v1,<base64>`. `hermes_v2` signs `<unix timestamp>.<raw JSON>` with the literal route secret and sends `X-Webhook-Timestamp` and `X-Webhook-Signature-V2` as a hex HMAC-SHA256 digest. GET wake reports the mode and `has_token`, never the secret. The receiver still needs the private page API token and a host-specific way to resume the correct conversation.

`POST A/wake/probe` injects a synthetic, wake-eligible `event` with `role:null`, `by:agent_probe`, and `data:{kind:"delivery_probe",nonce}`. It exercises the same WebSocket, long-poll, webhook, or MCP Events delivery path without a browser or owner impersonation. The response includes `nonce`, `seq`, `status_url`, and `ack_url`. After the resumed agent reads the event, it calls `POST <ack_url>`; `GET <status_url>` then has a non-null `ack_at`. The server refuses acknowledgement before any event read has advanced through that sequence. A probe expires after ten minutes, and a page may create at most five per hour. Only the newest probe is inspectable. This tests host delivery, not the browser's first real interaction. MCP exposes `probe_delivery`, `check_delivery_probe`, and `acknowledge_delivery_probe` tools for hosts that use only MCP.

All routes under `A` require `Authorization: Bearer tk_…`. `GET/PATCH/DELETE A` manage the tendril. Files and versions: `PUT A/files/<path>`, `POST/GET A/files`, `GET A/files/<path>`, `GET A/versions`, `POST A/rollback`. Interaction: `GET A/events?after=<cursor>`, `POST A/eval`, `POST A/say`, `POST A/status`, `POST A/check`. Data: `GET/PUT/PATCH A/state`, `GET A/logs`, `PUT/GET A/blobs`, `GET A/blobs/<id>`, `GET/POST A/activity`. Management: `GET/PATCH/DELETE A/devices`, `POST/GET/DELETE A/links`, `POST A/links/<id>/rotate`, `GET/PUT A/wake`, `POST/GET/DELETE A/tokens`, `GET/PUT A/rules`, `POST A/notify`. The agent can create guest invites only and cannot change roles. See `server/src/agent.ts` for exact request bodies.

Optional handled checkpoints use `GET A/consumers` and
`POST A/consumers/<name>/claim`, then `GET …/events` and
`POST …/renew`, `…/ack`, `…/release` with `X-Tendril-Lease`. A name identifies one
logical subscriber; same-name workers fail over through a 30–900-second lease,
while different names read independently. Reads replay unacknowledged work;
only an explicit handled acknowledgement advances the checkpoint. Missing history
requires explicit gap acknowledgement. Legacy `/events` and host bridges retain
their existing behavior. Full shapes and limits are in [DURABILITY.md](DURABILITY.md).

## Page API and events

The page prefix `P` is the returned `page_url`. `GET P` serves the current version or a holding page. `GET P<path>` serves version files. Reserved `_tendril/` routes include runtime and speech assets, WebSocket, page info, blob upload/download, manifest, icon, agent listing and disconnect, guest approval, reporting, and owner version trust. They are all gated by the page role, except the one-time session code exchange. Static high-risk versions are withheld from guests and display links; owners see an explicit continue screen. A high-risk version on a young account holds the page.

The runtime opens `P_tendril/ws`; the server derives owner, guest, or display permissions from the page session. Owner text and on-device speech become instruction events. Guest and display input stays untrusted data. Browser device secrets support device identity and replay deduplication; they do not grant owner access. The runtime exposes `tendril.send`, shared state, blob upload, and page connection state. Speech uses a hash-pinned Cactus Whistle model downloaded after a microphone tap and transcribes locally.

Spoken output from `POST A/say` (default `speak:true`), `tendril.speak(text)`, and local `say` rules uses browser speech immediately. Phonon 31M neural English speech is an optional device preference, enabled explicitly in settings or with `tendril.tts.enable()`. Enabling it prepares roughly 65 MB on first use and caches the assets in the browser; browser speech remains available during setup. `say` messages appear on all devices, while the server selects the owner device that should speak automatically. The runtime also checks that the device is a non-pending owner. The optional neural runtime loads the pinned `phonon-tts` package from `P_tendril/tts/`, including its workers, Wasm, and license notices, and an Apache-2.0 model pinned to a Hugging Face commit. Neural synthesis runs locally. WebGPU is selected when available, with single-thread Wasm CPU fallback; this adds no cross-origin isolation requirement. Non-English language preferences, a user-selected browser voice, and neural failures use browser synthesis. `_prefs.audio:false` mutes speech; changing audio/language preferences, submitting a message, or `tendril.tts.stop()` interrupts current/queued speech. Voice selection and neural enablement are stored locally per page origin and are not shared state. `tendril.tts.status` and the `tts` event report initialization/progress/failure. Settings expose enablement, browser voice selection, test, retry, and stop controls. `tendril.tts.disable()` returns to browser speech. Browser autoplay rules still apply.

Neural synthesis times out after 30 seconds without a new audio chunk, allowing browser fallback instead of blocking later replies indefinitely. Stop interrupts pending model waits as well as playback; a worker that does not acknowledge cancellation within one second is discarded and reloaded from cache for the next reply. Browser autoplay restrictions preserve the loaded model, so neural speech can resume after a user interaction without a manual retry.

`tendril.send()` distinguishes accepted, queued, and rejected results. Media inputs use `tendril.uploadEvent(blob, options)` to persist the blob and its semantic input as one recoverable transaction, with explicit retry/discard controls and retention metadata. `resident` keeps a page available; captured page media still expires after 30 days unless pinned by the owner. See [CAPTURES.md](CAPTURES.md) for the result contract, offline replay, and pin APIs.

## Durable experiences

Device purpose is separate from access role. `GET A/devices` returns purpose and
focus; `PATCH A/devices/<id>` accepts name/purpose without changing permissions.
`POST A/focus` leases a connected owner device for 30–86400 seconds. `POST A/say`
accepts `device` for presentation and `speak_on` for one speaking socket; an
audio-only recipient receives `present:false`. Device targeting never makes the
shared transcript private. Non-owner device configuration messages expose only
that device's own presentation information.

`A/timers` supports list/create, `A/timers/<id>` update/delete, and
`A/timers/history` execution history. Occurrence event/run/next-schedule writes
are atomic and deduplicated by run ID. A requested notification intent joins that
transaction, with bounded retries and per-device results in history `delivery`.
Provider delivery is at least once; see [DURABILITY.md](DURABILITY.md).
IANA calendar recurrence, missed-run
coalescing/skip, claim/hold/read-only checks, and page lifetime bounds are described
in [EXPERIENCES.md](EXPERIENCES.md). Device rules remain browser-local.

`GET/PUT A/session` saves/resumes compact context with optional expected-revision
checks, independent of event-read cursor consumption. `GET A/bundle` exports the
served page; `include_data=true` adds state/session/media bytes. `PUT A/bundle`
stages; `POST A/bundle/publish {expected_version}` publishes atomically;
`DELETE A/bundle` discards; `POST A/remix` creates an independent staged copy.
First publication retains the listener requirement. Page owners have equivalent
routes under `_tendril/`, using `_tendril/resume` for session context.

`GET/POST A/decisions` and `PATCH A/decisions/<id>` manage proposals/outcomes;
only the signed-in owner can respond through
`POST P_tendril/decisions/<id>/respond`. Expected versions, expiry and valid
transitions are enforced on the server. Private participant answers are stored
outside shared state: a participant reads/writes only their own
`P_tendril/responses`; the owner reads all with `/responses/all`, and the agent
reads `GET A/responses`. Submission events contain identifiers/revision only.

## Limits and enforcement

Unclaimed storage is 2 MB and individual files are 1 MB; claimed storage is 25 MB and files are 5 MB. An account has 200 MB storage, at most 20 active tendrils and 3 residents. The service has an exact global byte reservation and admission object. Rate Limiting bindings slow request bursts. `service_state` can pause creation or set read only. A budget notification webhook changes state at configured thresholds.

Reports arrive from a signed-in page or the public Turnstile form at `/report`. Three qualifying account reports within 24 hours hold a claimed page. Reported unclaimed pages are deleted. Three unreversed holds in 30 days suspend an account. The owner can appeal at `/appeal`; allowlisted provider identities use `/admin` to act and audit reasons. `/_tendril/report` remains available from the page control. Every automatic/manual action is recorded in D1.

Young-page guest and display visitor bursts, creator-IP claim patterns, and repeated claim releases also trigger holds at the thresholds in `PUBLIC_SERVICE.md`. The owner dashboard shows sensor activity reported by each connected page device. Suspended owners may sign in to a restricted dashboard with notices and page/account appeals; normal page access remain denied. A scheduled Worker retries page disable/restore operations from the D1 queue; account suspension in D1 denies page access while reconciliation is pending.

## Deployment contract

Staging and production use isolated D1, R2, secrets, routes, and Worker names generated by `scripts/provision.mjs`. D1 migrations initialize creation paused. `docs/OPERATIONS.md` lists the external domain, OAuth, Turnstile, budget, legal, and browser checks required before opening service state. The repository contains one public service route path; no account-key or path-host fallback is deployed.
