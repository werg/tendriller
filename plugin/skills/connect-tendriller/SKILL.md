---
name: connect-tendriller
description: Build or connect a Tendriller application with UI and sensor input, link the user's account, and verify real application reads and writes from ChatGPT.
---

# Build or connect a Tendriller application

Start with `tendril_guide` (`topic: "start"`). It returns the maintained setup
instructions directly, without requiring web browsing. Follow its `serviceOrigin`
for every request and link, including staging. A custom MCP connection may not
include this skill; the tool and server instructions provide the same entry path.
If the installed catalog lacks `tendril_guide`, call `get_profile` or
`list_tendrils` and read the returned `setup.startHere`, `setup.buildGuide` or
`setup.discoveryUrl` directly. Refresh the tool catalog when available. Keep the
returned origin; do not infer an environment from the plugin name or substitute
another service.

For a **new page/application**, read `tendril_guide` with `topic: "build"` and
`topic: "capabilities"`. Use the supplied native/browser starter, the supported
HTTP page-creation API and the existing UI/sensor helper modules. Before
downloading or installing packages, inspect this origin's `/api/readiness`
(the returned `setup.readinessUrl`). Require the matching `serviceOrigin`,
`mode: "open"` and `creation.available: true`. Stop on paused, read-only,
unavailable or unsupported readiness and report `creation.nextAction`; do not
repeat creation blindly or fall back to production. Follow the build guide and
the discovery descriptor's `firstApp.release` to verify and install the immutable
first-app kit and its exact local packages against the host identity.

For linked-account creation, run `npm run setup:prepare -- SERVICE_ORIGIN NAME`
in the retained starter project. Call `prepare_tendril_setup` with its printed
public arguments using this connector's existing `tendrils:create` grant. The
server resolves the owner; the local raw setup credential and OAuth credentials
do not enter tool arguments. Save the public ready result and run `setup:finish`
to reconstruct the same private handle. On a lost reply, inspect the original
`operationId` with `inspect_tendril_setup`; never generate a replacement intent
or fall back to anonymous creation. Follow the maintained build guide when the
catalog or granted scope needs an update.

Check that your
execution environment supports Node 24, installing the exact packages, retained
private storage and the required running participant. Provision early, initialize and publish the first signed version, prepare any
assistant-access proposal, and start the participant before giving the owner the
ready page and permission-review URLs. Never wait for claim or ask for a
"claimed" reply before publishing. Use `topic: "delivery"` for completion evidence. Complete claim, authority/first generation, device
connection, signed publication and bidirectional verification. Then follow
`topic: "connect"` to expose selected app operations through MCP. If the necessary
runtime is unavailable, read `topic: "deployment"` for measured hosting and handoff choices, name that prerequisite and offer a concrete handoff to a
coding-agent/runtime with the same origin and guide. MCP alone does not host a
new app's executable participant.

A full-featured or rich request requires domain views: conversations, timelines,
searchable list/detail, named related links and reviewed edits. A JSON editor or
field-by-field record form is only a diagnostic fallback. Reuse the importable
patterns in the build guide. After the first working version, run the dedicated
second-pass prompt in `topic: "delivery"`: walk every main flow in real desktop
and phone-sized browsers from fresh profiles, check Back/deep links, keyboard,
long content and loading/empty/error states, fix friction and report before/after
screenshots per flow. Transport and persistence checks do not establish usability.

Keep the starter's P2P-first participation helpers for both native and browser
owners. They share one direct-WebRTC/relay-fallback policy and include the native
RTC capability and browser provider. Do not construct another transport selector,
ship an always-failing RTC stub or defer P2P setup. Follow the selected service's
peer-connection guide and verify real application traffic with no hosted relay
payload when direct connectivity is available; explicitly qualify forced fallback.

Use the starter's reviewed browser pairing flow. The browser retains its own
key and request; the existing native owner durably pauses ordering and stages
the exact signed proposal before owner review. The service-origin review binds
the fingerprint, account, narrow rights, generation and retained prefix. The
native participant receives later pairing requests through a hibernating setup
subscription, without idle polling. Individual reviews expire after ten minutes;
uncertain replies and process restart preserve the ordering pause. Reopen that same participant and reconcile the original
outcome rather than signing a replacement. A committed grant still needs a real
session connection and cross-device command/read evidence.

Run the starter's assistant participant for ordinary approved queries and
commands. Event forwarding is an explicit `--events` choice with its own owner
review; it does not configure a subscription, extend the process lifetime or
establish future chat wake.

For sensor work, read `tendril_guide` with `topic: "sensors"`. Inspect task-relevant
keys with `tendril.capabilities(filter)`; use standard browser APIs and existing
session signals/content/commands. Register custom resources before acquisition
with `tendril.sensors.register({ kind, stop })`, check its cancellation signal
after awaits, and return asynchronous cleanup. Reuse the guide's runnable
observation reference and contrib snippets for freshness, coalescing and review.
An agent-requested observation renders a local prompt; only a trusted local
gesture starts capture, and explicit review authorizes sharing or retention.

For an **existing application**, call `list_tendrils`, then
`describe_application`. An empty list means no assistant-connected applications
for this account; it is not evidence of a missing plugin. For a known app, check
its account and have its existing participant propose assistant access using
`topic: "connect"`. Give the owner the returned review URL. They choose the
queries, commands and events to share; do not silently replace their app.

When account linking is requested, follow ChatGPT's sign-in prompt. The person
uses their normal GitHub or Google identity and reviews **Connect ChatGPT**.
Give one step at a time and keep credentials and authorization codes out of chat.
Ordinary calls use the OAuth-client binding; separate approved agent proofs are
for independently revocable agents, not a mandatory first step for every user.

Verify a relevant query. Execute a write when requested and verify its applied
result with a fresh read. Retain original operation IDs and inputs for uncertain
retries. If the app is offline, resume its enrolled participant from the existing
device store. Use `read_application_events` to catch up and keep its cursor.
Verify a supported subscription before promising future background delivery;
a page or mounted card does not guarantee a future wake of this conversation.

After a republish or participant restart, read the returned service origin's
`/docs/AGENT_RESTART.md`. Reconnect attach clients to the retained owner, preserve
handled cursors and exact pending inputs, and verify the actual consumer's
heartbeat plus a request/receipt/answer round trip. Use `/docs/AGENT_REQUESTS.md`
for durable listener presence and addressed answers; applied journal state does
not establish that an agent has read the request.

For sign-in and linking recovery, use the returned service origin's
`/docs/CHATGPT_INTEGRATION.md`. Users can revoke account access at
`/oauth/connections` or app capabilities at `/connections` on that same origin.
