# A connected kitchen assistance example

This is a complete, new Chronolog application: a cooking step, explicit help
requests, responses, and retained conflicting or stale answers. It uses the same
public bootstrap, browser Worker, signed publication and encrypted peer relay as
the maintained [first-app tutorial](../../../../docs/tutorial/README.md).
The fixture does not change an existing kitchen's immutable application
definition. Create a new application or use a separately supported evolution
procedure when adopting these commands in an existing project.

## Run the application

Copy this directory to a new project directory and use Node 24. Install the exact
public SDK, tools, and events-only Chronolog archives for the host, plus esbuild,
using the acquisition procedure in [Build an app](../../../../docs/BUILD_AN_APP.md).
Do not install an assumed public npm release of `@chronolog/peer-session`.

```sh
npm install /absolute/path/tendriller-core.tgz /absolute/path/tendriller-tools.tgz \
  /absolute/path/chronolog-peer-session.tgz esbuild
npm run create -- https://YOUR_HOST owner@example.com "Kitchen assistance"
# The human opens the printed claim URL and signs in as the designated owner.
npm run init
npm run build
npx tendril --session ./session.mjs publish ./page --operation kitchen-release-1
# In the published page, choose Set up this browser and verify its public key.
npm run enroll -- BROWSER_PUBLIC_KEY_FROM_THE_PAGE
npm run peer
# In the page, choose Connect existing device, then select a cooking step.
```

Only `page/` is publishable. `.tendriller/` contains credentials, the creator's
signer, epoch keys and saved signed transitions. Keep it private and retain it
across restarts. The native creator peer must stay available for coordination.
Stop it before another CLI process opens the same creator device store. A page
preview on another origin is intentionally unable to use the published browser
session; use the actual signed page for connected testing.

**Ask assistant** creates an application request; it does not claim that a chat
was notified. If remote events are unavailable, **Copy request reference** gives
the user an explicit handoff to a connected tool-capable chat. The source remains
in Chronolog, and the assistant must fetch the current request before answering.
The interface starts no microphone, camera or background model request.

## Enroll the separate remote bridge

The bridge needs its own device store, never the creator's or browser's signer.
Stop the creator temporarily during enrollment:

```sh
npm run bridge:key
# Verify the printed dedicated bridge public key and approve its access.
npm run enroll:bridge -- VERIFIED_BRIDGE_PUBLIC_KEY
npm run peer
```

Point the integration's application session factory at `bridge-session.mjs`,
which opens `bridge-device.sqlite`. Keep the creator peer running separately;
the bridge has reader/writer rights, but no coordinator, recovery, administrator
or publisher rights. It receives keys through the authenticated peer session.
The current Chronolog reader grant permits reading application history; a
topic filter is an outbound minimization policy, not a topic-restricted key.
Obtain explicit consent for that access and for the selected outbound events.

Configure the separate integration service with:

| Setting | Fixture value |
| --- | --- |
| Session factory | `openSession` from this directory's `bridge-session.mjs` |
| Allowed queries | `kitchenContext`, `assistanceStatus` |
| Assistant write commands | `replyToAssistance` (add `requestAssistance` only when needed) |
| Event topics | `assistant` |
| Event projection | `kitchenEventProjection` from `projection.mjs` |
| Outbound event | `assistant.help_requested` |

Account linking, a verified owner mapping, an explicit connection consent, valid
Chronolog grants, and the destination subscription remain independent
prerequisites. Use the integration's configuration and diagnostics for those
layers. Enrollment by itself does not subscribe any ChatGPT conversation.

## Read and answer a request

The canonical native query is:

```js
const { revision, value } = await session.query('assistanceStatus', { requestId });
// Review value.status, value.currentStepId, value.conflicts and expiresAtMs.
const operation = await session.command('replyToAssistance', {
  requestId,
  requestEventId: value.requestEventId,
  answer: 'A response to the actual question.',
  suggestedSteps: ['One optional step.'],
  cookingStepId: value.cookingStepId,
  basedOnContextRevision: value.contextRevision,
}, { operationId: savedCallerOwnedOperationId, basedOn: revision });
// Retain the operation before any bounded applied/shared wait.
```

`requestEventId` binds the answer to the original selected-history fact.
`basedOnContextRevision` is the original request's context label, while the
native `basedOn` is a structured revision captured by the fresh read. Preserve
those distinct values. Do not serialize the native revision into the native
`basedOn` parameter.

The domain records facts. Its query chooses the first valid response, keeps
additional answers and duplicate request IDs visible as conflicts, and labels a
changed cooking step as stale. It also records late response evidence from the
signed author's timestamp. That timestamp is not a trusted wall clock; the UI
separately labels a pending request expired using the local time. These checks
do not provide transactional inventory guards or a hard expiry authorization
boundary. Use the supported SQL engine and deterministic guards if an action
must atomically test mutable stock, task state or permissions.

The bridge and OAuth/consent layers must still restrict commands. An assistant
answer does not change inventory, make a purchase, grant a role, or publish code.

## Failure and recovery behavior

The client stores its operation reference before the first submission. A lost
response leaves the same command, inputs and operation ID available for inspect
and exact retry after reload. An abandoned attempt requires deliberate
reapplication after reviewing the new selected history. The example does not
automatically manufacture a replacement attempt.

Application `applied`, peer `shared`, webhook accepted and assistant replied are
different observations. The page renders replies from `session.changes()` and a
new coherent query. If recovery removes a response from selected history, the
next projection removes it; it does not preserve a shadow answer database.
The remote delivery journal may still show that an earlier event was delivered,
so its recovery notice must be read alongside current application state.

## Evidence

`node --test integrations/chatgpt/test/kitchen.test.mjs` exercises correlation,
conflicts, stale steps, expiry presentation, metadata egress and uncertain
operation resumption. With `CHRONOLOG_SESSION_PACKAGE` pointing at an extracted
public archive, its optional native case additionally creates two actual native
stores under signed authority, submits a request and a second-device response,
checks exact retry, and reopens the first store to verify persistence. This case
passed against Chronolog `d014879ecb29714e80311d6101cfa8973953d5c4` (archive SHA-256
`673a6ecdf6c6741721efbb250f711f3acf7fa9784624ad5bcbf6596e5a00996c`). It uses the
public in-process transport; it does not qualify Internet RTC or relay.

The browser files are a real public-session composition,
not a claim that a production page, OAuth connection or ChatGPT subscription has
been provisioned. Record the claim, signed release, two-device read, reload,
exact retry and actual subscribed-chat write-back before declaring that live
round trip complete.
