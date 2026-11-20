# Working with Tendriller

## Build an application for a user

Read [the agent entry point](agent.md), then follow [Build an app](docs/BUILD_AN_APP.md).
Deliver the [running connected application](docs/AGENT_DELIVERY.md): start
provisioning early, prepare and publish before claim, start the participant, give
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
With account-linked MCP, use the starter's `setup:prepare`, call
`prepare_tendril_setup` with its public arguments, and use `setup:finish` with
the exact ready result. Retain the original private intent and use
`inspect_tendril_setup` after a lost reply; the host derives the verified owner.

The intended route is **create → define state → configure authority and initial generation → publish signed UI → owner sign-in → connect devices → verify**. A created
page is only the host handle. Host credentials, device grants and publication
rights are independent. Use Chronolog for durable application commands, queries
and events; use session signals for disposable live updates. A separately hosted
backend is an architectural decision that needs a concrete requirement.

Keep private handles, signing identities and epoch keys outside authored assets.
Resume existing device storage. Preserve operation IDs and signed attempts after
uncertain responses. The owner completes their own sign-in; device enrollment and
recovery remain explicit. If blocked, name the exact prerequisite and next action
from [troubleshooting](docs/TROUBLESHOOTING.md).

Completion means demonstrating a real command, an applied read from the other
participant, persistence after reload, and the verified signed publication. State
which process must remain running. An installed adapter or an HTML preview alone
does not establish a working connected application.
Report the actual native process lifetime. Page residency and MCP do not establish
a supported handoff to, or future wake of, an existing ChatGPT conversation.

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
