# Working with Tendriller

## Build an application for a user

Read [the agent entry point](agent.md), then follow [Build an app](docs/BUILD_AN_APP.md).
Deliver the [running application](docs/AGENT_DELIVERY.md): start provisioning
early, prepare and publish before claim, give the human the ready page URL without
asking for a claimed reply, and verify browser-first operation and peer convergence.
A native participant or agent server is optional; never make its reachability a
prerequisite for ordinary browser reads or durable writes. Treat setup as part of
the task. Use the [capability map](docs/CAPABILITIES.md) and import/adapt
the current helper modules before implementing another application stack.
The complete [session bootstrap](docs/SESSION_BOOTSTRAP.md) and tutorial files supply
the native session and browser Worker; do not invent a `deployment.mjs` import.
Start at the requested service origin's `/api/service` and
`/.well-known/tendriller.json`. Use that same origin for setup, including on staging.
Read `/api/readiness` before downloading or installing packages. Require open
creation readiness at that origin; stop on a pause, unavailable or unsupported
readiness and report its next action. Follow `firstApp.release` and the build
guide for the immutable kit and exact local package composition.
With account-linked MCP, use the starter's `setup:prepare`, call
`prepare_tendril_setup` with its public arguments, and use `setup:finish` with
the exact ready result. Retain the original private intent and use
`inspect_tendril_setup` after a lost reply; the host derives the verified owner.
Browser enrollment authenticates the account, origin and device-key proof; it
does not pause or select application history. Bootstrap the first authorized
browser's local identity, permissions and keys durably. Additional devices need
explicit authenticated key provisioning; an empty browser cannot invent missing
private keys. Retained devices open cached local state before background authority
refresh or discovery. Preserve exact signed intents across uncertain replies.

The intended route is **create → choose finality/availability policy → publish signed UI → owner sign-in → initialize browser locally → author and replicate → verify**. A created
page is only the host handle. Host credentials, device grants, data permissions,
finality eligibility and publication rights are independent. Chronolog operations
are an authenticated CRDT set, ordered solely by signed author timestamp, signing
public key and stable proposal ID. No participant assigns operation order. Use
session signals for disposable live updates. A separately hosted application
backend needs a concrete requirement; Tendriller is not the application database.

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

Keep private handles, signing identities and epoch keys outside authored assets.
Resume existing device storage. Preserve operation IDs and signed attempts after
uncertain responses. The owner completes their own sign-in; device enrollment and
recovery remain explicit. If blocked, name the exact prerequisite and next action
from [troubleshooting](docs/TROUBLESHOOTING.md).

Completion means demonstrating a real locally stored and materialized operation,
independent authoring while disconnected, automatic convergence with another
participant, persistence after reload, and verified signed publication. Distinguish
local durability, revisable materialization, peer retention and configured finality.
State which browser/optional processes must remain open for live synchronization
or finality; do not imply they are needed to save local work. An installed adapter
or HTML preview alone does not establish a working application.
Report actual process lifetimes. Page residency and MCP do not establish
a supported handoff to, or future wake of, an existing ChatGPT conversation.

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
