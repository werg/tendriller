# Working with Tendriller

## Build an application for a user

Read [the agent entry point](agent.md), then follow [Build an app](docs/BUILD_AN_APP.md).
Deliver the [running connected application](docs/AGENT_DELIVERY.md): start
provisioning early, prepare and publish before claim, start the agent program, give
the human the ready page URL without asking for a claimed reply, and finish with a verified live page and process/resume details. Treat setup as
part of the task. Use the [capability map](docs/CAPABILITIES.md) and import/adapt
the current helper modules before implementing another application stack.
The complete [session bootstrap](docs/SESSION_BOOTSTRAP.md) and tutorial files supply
the native session and browser Worker; do not invent a `deployment.mjs` import.
Start at the requested service origin's `/api/service` and
`/.well-known/tendriller.json`. Use that same origin for setup, including on staging.
Read `/api/readiness` before downloading or installing packages. Require open
creation readiness at that origin; stop on a pause, unavailable or unsupported
readiness and report its next action. Follow `firstApp.release` and the build
guide for the immutable kit and exact local package composition.
One **agent** has one `ta_` credential and one signing key shared by all of its
pages, kept in the workspace (`tendriller.json`, `pages/<slug>/`, `shared/`,
private `.tendriller/agent` and `.tendriller/pages/<id>`). Register it once:
with account-linked MCP, run `tendril workspace key`, call `register_agent` with
its public arguments, and retain the result with `tendril workspace adopt` (the
host derives the verified owner); from a domain, `tendril workspace init --owner
EMAIL`; or with a dashboard join code, `tendril workspace join`. Pages the agent
creates (`npm run page:new`) are granted to it automatically; the owner grants
an existing page with the per-agent checkbox on the dashboard or page settings,
then `tendril page grant`. `tendril agent run` (`npm run agent`) is the one local
program: one hub connection for all control traffic, one session per page.
For browser pairing, keep that agent program running. Its
bounded helper durably pauses ordering and stages the exact signed member-only
proposal; the host approves it automatically for the signed-in owner or an
admitted guest — there is no approval screen. Preserve the same browser key,
native records and ordering pause through uncertain replies or restart. A
committed enrollment still requires a real connected session and cross-device
verification.

The intended route is **register agent → create page → define state → configure authority and initial generation → publish signed UI → owner sign-in → connect devices → verify**. A created
page is only the host handle. The agent credential, device grants and publication
rights are independent. Use Chronolog for durable application commands, queries
and events; use session signals for disposable live updates. A separately hosted
backend is an architectural decision that needs a concrete requirement.

Keep the agent token, signing identities and epoch keys outside authored assets.
Resume existing device storage. Preserve operation IDs and signed attempts after
uncertain responses. The owner completes their own sign-in; device enrollment and
recovery remain explicit. If blocked, name the exact prerequisite and next action
from [troubleshooting](docs/TROUBLESHOOTING.md).

Completion means demonstrating a real command, an applied read from the other
participant, persistence after reload, and the verified signed publication. State
which process must remain running. An installed adapter or an HTML preview alone
does not establish a working connected application.
Report the actual agent program lifetime. Page residency and MCP do not establish
a supported handoff to, or future wake of, an existing ChatGPT conversation.

## Verify the user experience

A request for a full-featured or rich application requires domain views, not a
JSON editor or a form that merely mirrors stored fields. Use the importable
list/detail, inspector, comparison, reviewed edit and view-state examples in
[application patterns](docs/APP_PATTERNS.md#domain-views-you-can-import).
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
