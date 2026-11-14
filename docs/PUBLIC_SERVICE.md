# Tendriller as a public service: plan

Status: repository implementation in progress, 2026-11-13. See `docs/PUBLIC_SERVICE_PROGRESS.md` for tested scope and launch blockers. The public trust model is the sole code path and is documented in `docs/PROTOCOL.md`.

## 1. Goals

- Any agent can create a tendril with no account, key or setup, as today.
- A person sees a tendril's page only after signing in with GitHub or Google, and the
  page then belongs to that sign-in.
- Abuse is expensive, visible and quick to remove. Creation and storage have hard
  service-wide ceilings; request costs trip an automatic stop (section 5.3).
- The whole Cloudflare setup is reproducible from the repository plus a few one-time
  manual steps.

Not goals: paid plans, team accounts, custom domains per user, data residency choices.
They can come later without changing this design.

## 2. The trust model: open creation, signed-in pages

### 2.1 Lifecycle

1. **Created (unclaimed).** `POST /api/tendrils` needs no key. It is rate limited per IP
   (section 5). The agent can name who the page is for:
   `{"owner": "ana@example.com"}` (an email), `"github:octocat"` or `"google:ana@example.com"`.
   The agent gets its token and the page URL as now and can upload files, set state and
   so on. An unclaimed tendril has small limits (section 5.2) and is deleted if nobody
   claims it within 24 hours.
2. **Claim, on first open.** Opening the page URL starts sign-in right away: the page
   shows one screen ("An AI agent made this page for you. Sign in with GitHub or Google to
   open it.") and the OAuth sign-in follows. With a named owner, only a sign-in whose
   verified identity matches can open it: an email matches a verified email from Google
   or GitHub (GitHub's verified addresses come from the `user:email` scope), and
   `github:`/`google:` match the account. The screen shows the expected owner masked
   (`a***@example.com`). Without a named owner, the first person to sign in claims it.
   Either way the tendril is then bound to that account. Link previewers and crawlers
   cannot claim, because claiming needs an interactive OAuth sign-in.
3. **Claimed.** The page is served only to signed-in accounts with a role: the owner, and
   people the owner invited (section 2.3). Quotas now come from the owner's account. `GET A`
   reports the owner (`{"owner": {"provider": "github", "login": "octocat"}}`) so the agent
   can tell the user who claimed it.

### 2.1.1 What the agent may do after the claim

Building and running the page is the point, so the agent token keeps files, versions,
state, eval, events, say, status, logs, blobs, notify (within the owner's quota),
webhooks and MCP Events, and deleting the tendril. What changes:

- **The owner sees and controls agents.** The control lists every agent token (name,
  last used, webhook target if any) and has "Disconnect agent", which revokes it; with
  every token revoked the page keeps working as the owner's, with no agent. Deleting the
  tendril by token is recorded in the owner's dashboard.
- **Invites need the owner.** A guest invite created by the agent works only after the
  owner approves the guest's first sign-in in the control. There is no automatic approval.
- **No login-free access from the agent.** Display links are owner-only (section 2.2),
  and the agent cannot change roles.
- **Release only before others see it.** `POST A/release` works only while no guest has
  been approved, so an agent cannot strip an established page from its owner.

### 2.2 Closing the gaps of claim-on-first-open

| Gap | Answer |
|---|---|
| An attacker sends an unclaimed link to one victim, who claims it and sees attacker content. | One link reaches one person; mass phishing needs one tendril per victim, which the per-IP creation limit and abuse handling (section 6) make expensive. The claim screen warns first. A first visit to a claimed page from a device that has not opened it before shows a one-line notice in the control ("made by an AI agent; Tendriller never asks for passwords"). |
| The link is posted in a group chat and the wrong person claims it. | Name the owner at creation (step 1); then nobody else can claim it. Without one, the agent sees the owner in `GET A` and can `POST A/release` to make it unclaimed again (harmless: an agent can always make a new tendril). |
| An attacker names a victim as owner. | Gives the attacker nothing beyond sending them an unnamed link: the victim still has to choose to sign in, and the tendril is then the victim's, with the same notices and reporting. |
| An anonymous agent uses the API as free file storage or a file share without ever showing the page. | Unclaimed tendrils hold at most 2 MB and live 24 hours; API reads of files and blobs are rate limited per tendril. |
| Outbound requests (webhooks, MCP Events) on behalf of anonymous agents. | They only fire on wakes, and wakes come from page events, which need a claimed page. Webhook and MCP Events targets must be public HTTPS (already enforced). |
| Login-free viewing (a kitchen display, a TV). | Only the owner can create a link that skips sign-in (`display` role), from the page while signed in, never from the agent token. The link shows "shared by <owner>" and counts against the owner's quota. Every login-free view therefore traces to a signed-in person. |

### 2.3 Roles after the claim

Today roles come from page links plus device pairing. With sign-in:

- **Owner**: the claiming account, on any device where it is signed in. Device pairing
  (`pairing: required`) is no longer needed and is removed.
- **Guest**: an account the owner invited. The owner (from the page) or the agent
  (`POST A/links {"role":"guest"}`) creates an invite link; opening it requires sign-in.
  An invite the owner made admits the guest directly; one the agent made waits for the
  owner's approval in the control (section 2.1.1). Guests' text and voice stay data, not
  instructions (unchanged).
- **Display**: login-free, owner-created only (section 2.2).

The page key in the URL stays as the routing secret, but it no longer grants access by
itself.

### 2.4 Optional account keys for agents

Signed-in users can create named API keys on the dashboard (or through the device flow
below) and give them to their agents. A key is never required. It gives:

- higher limits (the account's quota from the start, resident tendrils);
- tendrils that are already claimed by the key's account, so there is no claim step and
  no race;
- revocation per agent.

**Device flow**, so an agent can get a key without copy and paste:
`POST /api/device` → `{device_code, user_code, verification_url}`. The agent shows the
URL and code to its user, who signs in and approves "Agent <name> wants a key". The agent
polls `POST /api/device/token` and receives `ak_…` once approved.

## 3. Domains and origin isolation

Two domains, both on Cloudflare:

- **Service domain**, `tendriller.dev`: landing page, `agent.md`, the API,
  sign-in, dashboard, admin, abuse reports.
- **Pages domain**, `tendriller.site`: only tendril pages, each at
  `<tendril id>.tendriller.site`. Every tendril is its own origin, so one page cannot read
  another's storage, cookies or service worker. Abuse on a page cannot affect the service
  domain's reputation. The server already supports this (`PAGE_HOST_MODE=subdomain`).

`.dev` is on browsers' HTTPS-only (HSTS preload) list as a whole top-level domain;
`.site` is not. The pages domain therefore sends
`Strict-Transport-Security: max-age=63072000; includeSubDomains; preload` from the start
and is submitted to the HSTS preload list (hstspreload.org) in phase 1.

Then submit the pages domain to the Public Suffix List, so browsers treat each
subdomain as a separate site and reputation systems (Safe Browsing) judge pages one by
one. Acceptance takes weeks, so start early.

Until it is accepted, sibling tendrils are separate origins but the same site: one can
send same-site requests to another and can set a cookie for the whole pages domain that
shadows another's. So, independent of the list:

- Page session cookies use the `__Host-` prefix (`Secure`, `Path=/`, no `Domain`), which a
  sibling cannot set or overwrite.
- Every state-changing page request and the WebSocket upgrade must carry an `Origin`
  equal to the tendril's own origin; anything else is refused. `SameSite` is not relied on.
- The page API never reads a cookie without the prefix.
- Tests run two hostile tendrils against each other: cookie tossing, cross-tendril
  requests and WebSocket connections, and reads of storage, all of which must fail.

### 3.1 What is automatable on Cloudflare

All of it except buying the domains and creating the OAuth apps:

| Step | How | Manual? |
|---|---|---|
| Register both domains | Cloudflare Registrar or any registrar | Yes, once (payment) |
| Add the zones, point nameservers | Automatic with Cloudflare Registrar; otherwise API plus a registrar change | Once |
| Certificates | Universal SSL covers the apex and one subdomain level (`<id>.tendriller.site`) automatically and for free. Deeper levels would need Advanced Certificate Manager, so pages stay one level deep. | No |
| Pages wildcard | Proxied DNS record `*` (`AAAA 100::`) on the pages zone through the API, and a Worker route `*.tendriller.site/*` in `wrangler.jsonc` | No |
| Service domain | Worker Custom Domain in `wrangler.jsonc` (creates its DNS record and certificate) | No |
| D1 database, R2 bucket, rate-limit namespaces | `wrangler d1 create`, `wrangler r2 bucket create`; rate limits are declared in `wrangler.jsonc` | No |
| Secrets | `wrangler secret put` from a script | No |
| GitHub OAuth app, Google OAuth client | Their consoles; the client ids and secrets then become Worker secrets | Yes, once each |

A new tendril needs nothing: the wildcard record and route cover every id. A script,
`scripts/provision.mjs`, will do the automatable rows idempotently with a scoped API token
(Zone DNS edit, Workers Scripts and Routes edit, D1 edit, R2 edit). Deploys run from CI
(section 8).

## 4. Accounts and sign-in

- **Storage:** D1, with tables `accounts`, `identities (provider, subject)`, `sessions`,
  `api_keys (hash, name, account, created, last_used)`, `tendrils (id, owner, created,
  claimed, state, bytes)`, `reports`, `audit_log`, `blocks`. Per-tendril data stays in
  each Durable Object. D1 is the index across tendrils and the place quotas are checked.
- **Sign-in:** OAuth authorization code flow with PKCE for GitHub and Google (OIDC), done
  by the Worker on the service domain. Accounts are keyed by `(provider, subject)`, not by
  email. A signed-in user can link the other provider.
- **Session on the service domain:** an `HttpOnly; Secure; SameSite=Lax` cookie with an
  opaque id, stored hashed in D1.
- **Session on a page origin:** a page subdomain cannot read the service cookie. Opening
  a page without a page session redirects to `<service>/auth/page?tendril=<id>`. If the
  service session is valid and the account has a role, the service redirects back to
  `<id>.<pages>/_tendril/session?code=<one-time code>`. The page origin exchanges the
  code with its Durable Object and sets a host-only `HttpOnly` cookie. One sign-in per
  browser covers every tendril; later visits pass through without a prompt.
- **The runtime's WebSocket** authenticates with that page session instead of the device
  secret. Device ids stay for presence and the device list.
- **Account deletion** deletes the account, its keys and every tendril it owns. A data
  export (JSON of the tendril list plus each tendril's files) comes with it.

## 5. Rate controls and quotas

Two mechanisms:

- The Workers **Rate Limiting binding** for request rates. It counts per Cloudflare
  location and is approximate (eventually consistent), so it slows floods but does not
  enforce hard caps. Periods are 10 or 60 seconds.
- **Hard quotas** counted exactly:
  - per tendril in its Durable Object (one writer, so exact);
  - per account and service-wide by reservation: before accepting a write, the Durable
    Object reserves the bytes in D1 with one conditional statement
    (`UPDATE accounts SET reserved = reserved + ? WHERE id = ? AND reserved + ? <= quota`,
    plus the same against the service-wide total). A failed or rolled-back write releases
    its reservation; deleting files or the tendril releases theirs. The Durable Object's
    alarm reconciles the account's reservation with its real usage, so drift from a
    crash cannot accumulate.

### 5.1 Request rates (Rate Limiting binding)

| Key | Limit (starting point) |
|---|---|
| Create, unauthenticated, per IP | 5 / 60 s, plus 30 per day per IP (counted in D1) |
| Create, per account key | 30 / 60 s |
| Agent API, per tendril token | 300 / 60 s |
| `eval`, per tendril | 60 / 60 s |
| Failed authentication, per IP | 20 / 60 s (then 429 for the rest of the minute) |
| Abuse reports, per IP | 5 / 60 s |
| Sign-in attempts, per IP | 20 / 60 s |
| Page WebSocket messages, per device | 50 / s, exact, in the Durable Object |

### 5.2 Quotas (exact)

Starting values, deliberately tight; loosen with real usage. There is no paid tier.

| | Unclaimed | Claimed (free account) |
|---|---|---|
| Lifetime | 24 h unless claimed | ad hoc: 30 days idle; resident: until deleted |
| Storage per tendril (files, versions, blobs) | 2 MB | 25 MB |
| Single file / blob | 1 MB | 5 MB (today 25 MB) |
| Tendrils per account | — | 20 active, 3 resident |
| Storage per account | — | 200 MB |
| Notifications | none | 20 per tendril per hour |
| Webhook and MCP Events subscriptions | none (no wakes before claim) | 10 per tendril (as now) |
| Display links | none | 3 per tendril |
| Server-side voice | none | none (speech runs on the device, section 7) |

When a quota is reached the API answers `429` or `413` with `{"error":{"code":"quota", "limit", "used"}}`
and the page's control says so.

### 5.3 Global controls

- A `service_state` row in D1 (`open`, `creation_paused`, `read_only`), checked on every
  create and write. It stops creation or writes without a deploy.
- **Hard ceilings:**
  - Keyless creation passes through one Admission Durable Object that counts exactly:
    creations per hour and live unclaimed tendrils, service-wide. Past either cap,
    keyless creation answers `503 {"code":"busy"}`; account creation continues within
    account quotas.
  - Stored bytes are capped service-wide by the reservation in section 5. Past the cap,
    writes answer `507 {"code":"service_full"}`.
- **Automatic stop for request costs**, which cannot be capped exactly (page traffic,
  API calls): Cloudflare usage notifications post to a webhook on the service, which sets
  `creation_paused` at a first threshold and `read_only` at a second, and emails the
  operator. Unauthenticated traffic to a claimed page only reaches the sign-in redirect,
  so it is cheap.

## 6. Abuse handling

### 6.1 What to expect

Phishing and credential capture; malware or scam downloads; spam and search-engine pages;
covert tracking (a page that streams someone's location or camera without their
knowledge); crypto mining in the browser; illegal content; using the service as free
storage or as an outbound request relay.

### 6.2 Prevention

- Pages only for signed-in accounts with a role, one claimer per link (section 2).
- A separate pages domain, an origin per tendril, the Public Suffix List (section 3).
- A visible sensor indicator: while a page uses location, camera, microphone or motion,
  the control shows it, and the owner sees from the dashboard which devices shared what.
  Guests always see the indicator.
- Checks on every new version before it is served to anyone but the owner. These are
  cheap static checks: `<input type=password>`, forms posting to other origins, large
  executables, known miner scripts, and known brand names next to sign-in words. Matches
  raise a score. A high score withholds the version from guests and display links, and
  shows the owner an interstitial before the page loads ("This version asks for
  passwords or sends data elsewhere. Tendriller never asks for passwords. Continue only if
  you trust the agent that made it."), because under claim on first open the owner may be
  the target. On a young account a high score holds the tendril (section 6.4).
- Outbound URLs are allowed without an external reputation lookup. Static checks still
  flag external form actions and other suspicious page content; known malicious links
  alone are not detected by this screening.
- Every page carries "Report this page" in the control's menu, and `/_tendril/report` works
  even when the control is hidden.

### 6.3 Detection

- Reports: from the page, from `<service>/report` (URL plus reason, Turnstile protected),
  and by email to `abuse@<service domain>` (also the address Cloudflare forwards its own
  abuse complaints to).
- Complaints Cloudflare forwards, and mail to `abuse@`, go through Email Routing to a
  Worker that extracts tendril URLs and files them as reports, so no inbox needs watching.
- Signals: version checks (6.2); a burst of distinct signed-in guests,
  or of display-link visitors from many IPs, on a young tendril; many tendrils created and
  then claimed by different accounts from one IP (one sender, many victims); repeated
  releases of claims.

Initial signal thresholds: on a tendril under 7 days old, 8 distinct guest sign-ins or
20 distinct display visitor IPs in 10 minutes; 10 different claiming accounts for
tendrils from one creator IP in 24 hours; or a third claim-release attempt for the
same tendril in 24 hours. Visitor IPs are hashed with a per-tendril random salt.

### 6.4 Response

Nobody reviews reports as they come in. Takedowns are automatic; a person looks only at
appeals, when they can. The terms say so: no promised review time, and an appeal
restores a page that was wrongly held.

- **Automatic hold** (the tendril is disabled pending appeal) when any of these happens:
  - a forwarded complaint naming the tendril;
  - reports from 3 different signed-in accounts within 24 hours. Only accounts at least
    7 days old count, accounts that reported pages later restored on appeal stop
    counting, and an owner's own invitees count once together, so a group cannot take
    down a stranger's page cheaply;
  - a high version-check score on an account younger than 7 days;
  - a signal from 6.3 that crosses its threshold.
- **Automatic account suspension:** an account with 3 holds not reversed on appeal within
  30 days is suspended (all tendrils disabled, keys revoked, identity blocked).
- **Unclaimed tendrils** that are reported are deleted outright, and their creator IP
  loses keyless creation for 24 hours.
- **Admin console** at `<service>/admin` for accounts on an allowlist of GitHub or Google
  identities. It shows the report and flag queue with a sandboxed preview (static file
  listing, plus an optional Browser Rendering screenshot), the tendril's owner and history,
  and actions, used for appeals and for anything automation missed:
  - **Disable a tendril:** the Durable Object marks itself disabled, pages show a takedown
    notice, the API answers 403 `{"code":"disabled"}`. Files are kept as evidence for
    90 days, then deleted.
  - **Suspend an account:** all its tendrils disabled, keys revoked, sign-in refused; the
    identity goes into `blocks` so a new account cannot be made with it.
  - **Block an IP or range** for unauthenticated creation.
  - **Restore**, with a reason.
- **Notices:** the owner gets an email at the address the identity provider gave
  (GitHub primary email or Google email) with the reason and an appeal link. Reporters get
  an acknowledgement.
- **Audit log** of every automatic and manual action, with what triggered it.
- **Known weakness:** with no human queue, a page that passes the checks stays up until
  three established accounts report it, and a wrongful hold lasts until someone reads the
  appeal. Watch the hold and appeal rates in the first weeks and add a review step if
  either is high.

## 7. Speech on the device

No server-side speech at launch: no Workers AI transcription and no OpenAI realtime voice.
The runtime transcribes on the device with a small downloadable model:

- **Model:** Cactus Whistle (Cactus Compute, released 2026-10-02): 16.9 MB, Apache 2.0,
  English, German, French, Spanish, Italian, Dutch and Polish, batch transcription of up
  to 30 s per pass. Its engine is built for the browser as WebAssembly (a WebGPU build
  exists in the community).
- **Delivery:** the service serves a pinned copy of the model and engine from R2, so pages
  do not depend on a third-party host. The runtime downloads them the first time someone
  presses the microphone, never before, and says how large the download is.
- **The cost of isolation:** browsers partition caches by site, so with an origin per
  tendril (and the pages domain on the Public Suffix List) each tendril downloads the
  model once per device. 17 MB is acceptable for a deliberate tap; the control shows it.
- **Interface:** the same `listen()` and microphone button as today, so the model can be
  swapped for a newer one without changing pages. The model choice is a runtime setting
  (`speech: {model, url, sha256}`), checked by hash before use.
- **Fallback:** typing works when the model cannot load or the download is declined.
  Browser speech recognition is excluded because its processing location cannot be
  guaranteed by this service's on-device privacy promise.
- **Privacy:** audio never leaves the device, and there is no speech processor to list in
  the privacy policy.

Before building: confirm the browser package and API of the Cactus engine (the launch post
shows a browser demo but the integration documentation is thin), measure transcription
time on a mid-range phone, and decide whether to chunk long recordings into 30 s passes.

## 8. Legal and privacy

To be written with legal review before launch: terms of service and acceptable use
policy, privacy policy (what is stored: files, events and sensor data for 30 days,
transcripts the page sends, device information; processor: Cloudflare; speech is
transcribed on the device), a DMCA designated agent, a minimum age, GDPR rights (export and deletion are
section 4), and a law-enforcement request process. The claim screen links the terms and
the privacy policy.

## 9. Operations

- **Environments:** `staging` and `production` as Wrangler environments, each with its own
  domains, D1, R2 and secrets. The current workers.dev deployment becomes staging.
- **CI:** GitHub Actions run typecheck and tests, deploy staging on `main`, and deploy
  production on a tag, with a scoped API token stored as a repository secret.
- **Monitoring:** Workers observability logs, alerts on error rate, creation rate and
  quota rejections, and a public status page.
- **Backups:** D1 Time Travel for the account index. Tendril data lives only in its
  Durable Object and R2, so there are no backups of user pages beyond the takedown evidence
  copies. Say so in the terms.
- **Runbooks:** pausing creation, mass takedown, key leak, OAuth secret rotation.

## 10. Changes to the code

- `router.ts`: split by host. The service domain gets API, auth, dashboard, admin and
  report routes; the pages domain gets only page routes. Remove `CREATE_KEY`; add per-IP
  limits and the `owner` field.
- New `server/src/accounts/` (OAuth, sessions, keys, device flow), `server/src/abuse/`
  (reports, checks, admin), and D1 migrations.
- `tendril.ts`: `owner`, `claimed_at`, `disabled`, per-tendril limits from the owner's
  tier, `release`, byte reservations in D1, deletion of unclaimed tendrils after 24 h.
- An Admission Durable Object for keyless creation, and a webhook for Cloudflare usage
  notifications.
- `page.ts` and `ws.ts`: the claim screen, page sessions, the role check before serving
  anything, the first-visit notice, report routes.
- Runtime control: sign-in state, the sensor indicator, invite and approve, display links,
  the report menu, and on-device speech (section 7).
- An Email Routing Worker for `abuse@` and forwarded complaints.
- `PROTOCOL.md` sections 1, 2, 6 and 8 and `agent.md` rewritten for the new model; `agent.md`
  gains the device flow and the `owner` field.

## 11. Phases

The repository has one public-service model. Creation begins paused in each new D1
environment. Do not open production until quotas, reporting, automatic takedowns,
appeals, and legally reviewed pages pass the staging launch checks. There is no
creation-key fallback or path-host route.

1. **Domains and isolation.** Register `tendriller.dev` and `tendriller.site` (Cloudflare
   Registrar puts the zones on Cloudflare directly), provisioning script, subdomain mode by default,
   HSTS preload and Public Suffix List submissions for `tendriller.site`,
   CI and environments, `__Host-` cookies and Origin checks. Check: the hostile-tendril
   tests in section 3 pass.
2. **Sign-in and claim.** OAuth, sessions, the claim screen, page sessions, roles, invites,
   display links, the `owner` field, release, agent list and disconnect, owner approval of
   agent invites, deletion of unclaimed tendrils. Check: an unclaimed page never serves page
   content; a second account cannot open a claimed page without an invite; an agent cannot
   admit a guest without the owner.
3. **Quotas and rate limits.** Rate Limiting bindings, byte reservations, the Admission
   Durable Object, the service state switch and the usage-notification webhook. Check:
   concurrent uploads to two tendrils of one account cannot exceed its quota; load tests
   at each limit.
4. **Abuse tooling.** Reports, the abuse mail Worker, automatic holds and suspensions,
   version checks, notices and appeals, admin console, audit log.
5. **On-device speech.** Whistle in the runtime, hosted copy, hash check, fallbacks.
6. **Keys and device flow.** Dashboard, `ak_…` keys, device flow, higher limits.
7. **Launch.** Terms, privacy policy, abuse contact, status page, budget alerts, Public
   Suffix List submission (started in phase 1), runbooks.

## 12. Decisions (2026-11-13)

- Abuse: automatic holds only; people review appeals, with no promised time (section 6.4).
- Display links: at launch, owner-created only (section 2.2), 3 per tendril.
- Quotas: the tight set in section 5.2; no paid tier.
- Speech: on the device with a downloadable model, Cactus Whistle first (section 7); no
  server-side speech.

- Domains: `tendriller.dev` (service) and `tendriller.site` (pages).

## 13. Open questions

None at the moment.
