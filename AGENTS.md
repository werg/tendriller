# Working with Tendriller

## Build an application for a user

Read [the agent entry point](agent.md), then follow [Build an app](docs/BUILD_AN_APP.md).
Deliver the [running application](docs/AGENT_DELIVERY.md): start provisioning
early, prepare and publish before claim, give the human the ready page URL without
asking for a claimed reply, and verify browser operation and peer convergence.
The agent program (`tendril agent run`) admits new devices and runs native
features; never make its or any native participant's reachability a prerequisite
for an admitted browser's reads or durable writes. Treat setup as part of the task. Use the [capability map](docs/CAPABILITIES.md) and import/adapt
the current helper modules before implementing another application stack.
The complete [session bootstrap](docs/SESSION_BOOTSTRAP.md) and tutorial files supply
the native session and browser Worker; do not invent a `deployment.mjs` import.
Start at the requested service origin's `/api/service` and
`/.well-known/tendriller.json`. Use that same origin for setup, including on staging.
Read `/api/readiness` before downloading or installing packages. Require open
creation readiness at that origin; stop on a pause, unavailable or unsupported
readiness and report its next action. Follow `firstApp.release` and the build
guide for the immutable kit and exact local package composition.
One **agent** has one `ta_` credential, one signing key and one X25519 wrap key
shared by all of its pages, kept in the workspace (`tendriller.json`, `pages/<slug>/`, `shared/`,
private `.tendriller/agent` and `.tendriller/pages/<id>`). Every agent chooses a
unique speakable lowercase `@handle` (`^[a-z][a-z0-9_-]{1,31}$`) and optional
short `bio` (≤160 chars) at registration. Register it once:
with account-linked MCP, run `tendril workspace key --handle HANDLE`, call `register_agent` with
its public arguments, and retain the result with `tendril workspace adopt` (the
host derives the verified owner); from a domain, `tendril workspace init --owner
EMAIL --handle HANDLE`; or with a dashboard join code, `tendril workspace join --code CODE --handle HANDLE`. Pages the agent
creates (`npm run page:new`) are granted to it automatically (and the first granted
agent becomes the page's default primary agent); the owner grants
an existing page with the per-agent checkbox on the dashboard or page settings,
then `tendril page grant`. Primary agents answer general chat messages and step
back when another `@handle` is addressed directly; non-primary agents stay silent
on general messages unless addressed or delegated. `tendril agent run` (`npm run agent`) is the optional
local program: one hub connection for all control traffic, one session per page.
The page's creator makes its keys: `npm run init -- <slug>` signs the descriptor,
genesis membership (pinning the owner account and the host attestation key) and
first epoch key as the agent (`--browser-first` leaves creation to the owner's
first browser). The host never signs membership or sees epoch keys. Admission is
one mechanism: a signed-in browser obtains a host attestation of its device key
and wrap key, and any online member admits an owner-account device (attested
mode) as an administrator by default (the signed policy grant) and wraps the
page keys to it. Strict mode holds owner devices for an
administrator's Approve; invite links admit other accounts by the same path.
Remove device signs a revocation and rotates the epoch key to the remaining
members. A new device waits, visibly, until a holder is online; retained devices
open cached local state before background authority refresh or discovery.
Preserve exact signed intents across uncertain replies.

The intended route is **register agent → create page → choose finality/availability policy and create page keys → publish signed UI → owner sign-in → member admits the browser → author and replicate → verify**. A created
page is only the host handle. The agent credential, host credentials, membership grants,
data permissions, finality eligibility and publication rights are independent.
Chronolog operations are an authenticated CRDT set, ordered solely by signed author
timestamp, signing public key and stable proposal ID. No participant assigns
operation order. Use session signals for disposable live updates. A separately
hosted application backend needs a concrete requirement; Tendriller is not the
application database.

Finality is optional admission/closed-time evidence, never an operation sorter.
Choose the supported policy explicitly; ordinary apps default to no finality.
Browser, native and host finalizers use the same configured proof contract. A
missing finalizer may delay finality, not local authoring or provisional reads.
Explain that an unseen operation behind a sealed time frontier can be excluded;
retain its intent visibly and never silently retimestamp or resubmit it.

Application schema and permission changes are normal authorized transactions.
Do not freeze schema in setup metadata or require code publication to run DDL.
Pinned SQL engine/platform manifests establish deterministic execution, not an
immutable database schema. There are no old ordering profiles, compatibility
adapters or migrations to implement.

Keep the agent token, signing identities and epoch keys outside authored assets.
Resume existing device storage. Preserve operation IDs and signed attempts after
uncertain responses. The owner completes their own sign-in; device removal, strict-mode approval and
invites are signed by page members. If blocked, name the exact prerequisite and next action
from [troubleshooting](docs/TROUBLESHOOTING.md).

Completion means demonstrating a real locally stored and materialized operation,
independent authoring while disconnected, automatic convergence with another
participant, persistence after reload, and verified signed publication. Distinguish
local durability, revisable materialization, peer retention and configured finality.
State which browser/optional processes (including the agent program) must remain
open for live synchronization or finality; do not imply they are needed to save
local work. An installed adapter or HTML preview alone does not establish a
working application.
Report the actual agent program and request worker lifetimes separately. Bind
presence only to the worker and topics it handles; a connected native participant
or event forwarder cannot advertise an absent assistant. For an existing Codex or
ChatGPT conversation, qualify the actual host route and a second request after
the first turn ends using [same-conversation delivery](docs/CONVERSATION_DELIVERY.md).
For a running Codex conversation, inject requests into its active turn through
the verified steering route; a queue that waits for completion does not satisfy
active delivery. Verify both active-turn injection and idle wake.
Page residency and MCP alone do not establish that handoff.

## Verify the user experience

A request for a full-featured or rich application requires domain views, not a
JSON editor or a form that merely mirrors stored fields. Use the importable
list/detail, inspector, comparison, reviewed edit and view-state examples in
[application patterns](docs/APP_PATTERNS.md#domain-views-you-can-import).
Prefer FRP/reactively derived frontends: render coherent materialized snapshots
plus separate local view/draft state. Notifications invalidate and rederive views;
never append network arrivals into a second mutable UI database. Incoming earlier
operations can revise SQL outcomes, move/remove rows or change schema. Update
counts, details and inspectors accordingly while preserving stable-ID selection,
unsent text, focus, keyboard access and deep links. Keep local data visible offline
and do not gate ordinary Save on network, agent or finalizer availability.

After the first working version, run the dedicated second-pass prompt and flow
matrix in [delivery](docs/AGENT_DELIVERY.md#the-user-experience-is-part-of-the-deliverable).
Exercise every main flow in a real browser at desktop and phone widths, starting
with fresh profiles; fix observed friction and retain before/after screenshots.
Check deep links, Back, keyboard access, long content, loading, empty and error
states. Passing transport and persistence checks alone does not complete the UX.

## Contribute to this repository

Use Node 22.15 or newer for core; the native tutorial uses Node 24. Read
[development](docs/DEVELOPMENT.md) before editing. `npm ci` and `npm run check`
are the core gate; `npm run check:release` includes browser qualification.
Run `npm run contract:generate` after executable metadata-schema changes.

Keep the host application-neutral. `server/` owns authentication, signed controls,
code publication and introductions; `contract/` owns the public SDK; `runtime/`
owns browser composition and sensors; `tools/` consumes built public artifacts.
Chronolog owns signing identity, execution, storage, operations and replication.
Tutorial files are public consumers, never imports into the host or kernel.

Update the first-app guide, discoverability links and onboarding checks together
when the user-facing lifecycle changes. `npm run test:onboarding` checks the
documentation graph and packaged tutorial after a build.
[The cold-start acceptance procedure](docs/AGENT_ONBOARDING_TEST.md) records
whether an unfamiliar agent can actually finish the task. Report the exact checks
run and their limits. Production deployment is a separate action.

### Release changelog, sunsetting & deploy broadcasts

Tendriller compiles `releases/entries/<YYYY-MM-DD>-<slug>.json` during `npm run build`
into `docs/CHANGELOG.md` (`/changelog.md`, `/api/changelog`) and `server/src/release-changelog.json`.
Deployed Workers idempotently Ed25519-sign and publish any `broadcast: true` entries
using deterministic `bc_...` IDs (zero CI secrets required, and manually revoked
broadcasts are never resurrected).

- **When to add an entry in `releases/entries/`:** ONLY for (1) major new user/agent
  capabilities (`category: "feature"`), (2) security fixes requiring client/agent action
  (`category: "security"`), (3) API/helper deprecations entering sunset (`category: "deprecation"`,
  must set `sunset_at: "YYYY-MM-DD"` and name the replacement), or (4) breaking changes /
  removal of a sunsetted path (`category: "breaking"`, set `supersedes` to the deprecation slug).
- **When NOT to add an entry:** Never add entries for routine bugfixes, internal refactors,
  test updates, or minor copy tweaks — keep agent broadcast noise at zero.
- **Agent-only deploy broadcasts:** Automated release entries may ONLY target
  `audiences: ["agents", "mcp"]`. Human UI banners (`dashboard`, `page_owners`, `page_all`)
  are rejected by CI validation and reserved strictly for manual one-off operator notices
  via `/admin` or `scripts/broadcast.mjs`.
- **Sunsetting windows:** Experimental APIs: **7–14 days**; stable public SDK/host/tutorial
  APIs: **30 days**; security fixes: immediate advisory + **24–72h** (or immediate if
  actively exploited). Delete legacy paths cleanly once `sunset_at` passes rather than
  keeping compatibility shims. Run `npm run build` after adding an entry so `docs/CHANGELOG.md`
  and `llms-full.txt` stay in sync.
