# Connect a Tendriller application to ChatGPT

The [Cloudflare assistant setup](CLOUDFLARE_ASSISTANT.md) connects ChatGPT to the
configured Tendriller page from the service's own `/mcp` endpoint. The
page Durable Object opens its enrolled Chronolog peer only when a request or
delivery needs it. Owner login, application consent, a live coordinator and
a supported ChatGPT subscription remain separate prerequisites.

## Choose a route that fits the task

| Need | Implemented route | Required next action or fallback |
| --- | --- | --- |
| Read or change an app from a tool-capable chat | OAuth-protected remote MCP queries and commands | Link the account, approve exact application permissions, then inspect `describe_application` before calling a domain command. |
| An app request should start work later | MCP Events subscriptions with durable delivery | Use a supported Work chat or dot, explicitly subscribe to an allowed event, and verify its callback. Keep the bridge running. |
| Continue the current mounted UI interaction | Assistance card attached to `get_assistance_status` | Choose **Send to ChatGPT** in a compatible MCP Apps host; the card sends only the request reference on that gesture. |
| The current chat has no event subscription feature | Manual request-reference handoff plus tools | Copy the application/request identifiers into the chat. Read current context through the linked tools before replying. |
| The agent can run local processes | Native session tools or `tendril --session` | Keep that enrolled process available, or resume its exact device store on the next invocation. |
| A configured published Workspace Agent should handle work | Optional fixed-channel Workspace Agent adapter | Configure its private access token and allowed event policy. This route has its own conversation and run receipt. |
| Continuous voice, camera or low-latency media | Explicit native provider/session composition | Use [voice](HANDS_FREE.md) and [reviewed input](AI_INPUT.md). Event notifications carry no audio, image or video stream. |
| Create a page or publish a reviewed UI | Optional lifecycle tools and existing publisher handoff | The human still claims the page; an enrolled publisher signs the exact reviewed graph. Large local graphs can use the CLI. |

The provider's [MCP Events documentation](https://developers.openai.com/plugins/build/mcp-events)
currently lists Work chats on the web, desktop Work chats with Cloud selected,
and dots. Workspace controls still apply. Do not promise event delivery into an
arbitrary ordinary conversation. The [UI bridge](https://developers.openai.com/plugins/build/chatgpt-ui)
provides `ui/message` and a compatibility follow-up method only where that host
capability is available. A normal hosted Tendriller page has no such chat bridge.
These provider boundaries were checked on 19 November 2026; recheck them before
promising support on another surface.

## Establish the connection

1. Complete the native application setup in [Build an app](BUILD_AN_APP.md),
   including actual owner claim, signed definition, initial generation and
   reachable peers. The [kitchen example](https://github.com/werg/tendriller/tree/master/integrations/chatgpt/examples/kitchen)
   supplies a concrete request/reply domain, browser Worker and dedicated bridge
   enrollment commands. A new HTML release cannot change an existing immutable
   application definition.
2. Enroll a **separate bridge device** with reader access and only the necessary
   writer access. Preserve its device store and pinned authority across restart.
   It needs no publisher, administrator, recovery or coordinator grant. A native
   reader can read the application history; outbound topic filters do not create
   a narrower cryptographic grant.
3. Follow the [Cloudflare assistant setup](CLOUDFLARE_ASSISTANT.md). Use the
   [first-party OAuth service](INTEGRATION_OAUTH.md) with the same exact
   Tendriller `/mcp` resource and the actual callback shown by the intended client.
4. Link the OAuth account in the client. The integration verifies issuer,
   audience, signature, expiry and scopes. The host account adapter also
   introspects the token and binds all application checks to that exact live
   grant. Its stable profile ID binds the issuer/subject pair; it does not use
   mutable email as identity.
5. Have the authenticated owner review exact query, command and event names in
   the optional `/connections` page or an equivalent trusted owner interface.
   The Worker uses the existing Tendriller browser session. Signing in grants no app permissions.
   Notification consent and detailed event-content consent are separate.
6. Call `list_tendrils`, `get_application_status` and `describe_application`.
   Verify an authorized query before submitting a command. If asynchronous work
   is needed, explicitly subscribe in the selected supported chat and test one
   request through to an applied reply in the page.

OAuth is a resource-server boundary, not a device grant. The included first-party
adapter implements account mapping and owner lookup against current trusted host
records. An external-provider integration must supply equivalent checks.
Never replace them with an unconditional approval, token email,
application ID supplied by the model, or possession of the host agent handle.
See [authentication implementation](https://github.com/werg/tendriller/blob/master/integrations/chatgpt/AUTH.md)
and the provider's [OAuth requirements](https://developers.openai.com/plugins/build/auth)
for exact issuer/resource metadata, PKCE and redirect configuration.

The generated systemd and Caddy files describe the remaining installation:
the existing native coordinator remains a separate process, and the Node bridge
uses its own enrolled reader/writer store. The release builder and preparation
commands do not install or start production services. Local preflight verifies
release hashes, runtime paths and private storage; online preflight additionally
checks host registration, current native selection and least-privilege grants.
It never submits a command, grants consent or sends an event. A successful
preflight is readiness evidence, not a live ChatGPT round trip.

## Discover and use the tools

`tools/list` is authoritative for the configured service and current OAuth scopes.
Optional lifecycle and Workspace Agent tools appear only when configured.
Application schemas are further filtered by declared allowlists and connection
consent. The same checks apply to widget tool calls.

| Tools or protocol method | Purpose | OAuth scope |
| --- | --- | --- |
| `get_profile` | Stable opaque identity for this authenticated connection | Authenticated token |
| `list_tendrils` | Configured applications this account may access, with connection status | `tendrils:list` |
| `get_integration_options`, `get_application_status`, `describe_application` | Route choices, real native availability and permitted schemas | `applications:read` |
| `query_application`, `get_kitchen_context`, `get_assistance_status` | Current coherent selected-history query | `applications:read` |
| `get_event_details` | Allowed immutable source event, with separate content consent | `applications:read` |
| `get_operation_status` | Original command submitted by this account through this integration | `applications:read` plus the original command's active consent |
| `request_assistance`, `reply_to_assistance`, `call_application_command` | Declared application commands through the enrolled writer | `applications:write` |
| `events/list`, `events/subscribe`, `events/unsubscribe`, `resume_event_delivery` | Explicit event delivery and reviewed recovery resume | `events:subscribe` |
| `create_tendril` | Create for the account's verified owner email and return the real claim URL | `tendrils:create` |
| `prepare_page_release`, `publish_page_release` | Exact file-graph review, publisher handoff and approved publication | `pages:publish` |
| `trigger_workspace_agent`, `get_workspace_agent_run` | Configured published-channel trigger and receipt/status | `events:subscribe`, `applications:read`, respectively |

For the kitchen flow, read `get_assistance_status` with `applicationId` and
`requestId`. Review its status, current step, conflicts, expiry presentation and
captured `revision`. Send `reply_to_assistance` with the immutable
`requestEventId`, original `basedOnContextRevision`, matching `cookingStepId`,
answer, suggestions and a saved caller-owned `operationId`. Use the returned
structured revision object as native `basedOn`; do not turn it into a string.
Then inspect that operation and reread the request to observe the applied answer.

For a new request, preserve the selected `cookingStepEventId` as well as
`cookingStepId` and `basedOnContextRevision`; the immutable kitchen definition
rejects a request if the step changes before ordering. The browser stores one
pending request atomically across tabs and preserves it after an uncertain
response. Terminal abandoned/reapplication states require a deliberate reviewed
resolution before new intent.

Keep the operation ID **and every input** unchanged after an uncertain response.
The server rejects reuse by another caller or for different input. An HTTP
timeout does not authorize a new attempt. An explicit recovery may require a
new reviewed reapplication; it is never a background retry with a new identity.
The kitchen projection retains duplicate or stale response evidence. It is an
events-domain example, not a transactional inventory or hard-expiry guard.

## Event delivery and recovery

The catalog includes `assistant.help_requested`, `inventory.review_requested`,
`shopping.trip_completed` and `application.recovery_notice`. A catalog name
alone does not emit an event. Configure an explicit application `eventProjection`
for each domain event and obtain matching consent. The kitchen example emits
only the help-request projection. Recovery notices come from the observer.

Notifications contain selected application/source/operation identifiers,
generation and bounded revision metadata, with optional request ID, kind,
short summary and `get_event_details` reference. They contain no photos, sensor
stream or raw application record. Treat all user-authored text as untrusted
data. Fetch current authorized context before composing a reply; detailed event
reads additionally need `readEvents` consent and the exact permitted event name.

The service verifies the supplied HTTPS callback challenge before activation,
stores subscription secrets encrypted, signs exact delivery bytes, rejects
redirects and non-public destinations, and bounds retry attempts. A fresh
subscription begins at the selected tail; it advertises `cursor: null`, so the
protocol makes no historical replay promise. Internal cursors and matched jobs
commit atomically. A restart resumes those checkpoints and original identities.

| Observation | What it establishes |
| --- | --- |
| Native `saved` | The signer retained the original command attempt locally. |
| Native `applied` | The selected history contains an application outcome. |
| Native `shared` | The native operation reports its retained peer coverage. |
| Outbox queued/retry/failed | The notification's local delivery state and bounded attempts. |
| Webhook `accepted` | The destination accepted the HTTP event; no assistant answer is implied. |
| Assistant reply operation | A separate signed domain command, still subject to its own application state. |

Recovery can remove a previously observed event or answer from selected history.
The observer pauses delivery and retains the new `recoveryRevision`; it does not
reset its cursor silently. After inspecting current status and pending work,
call `resume_event_delivery` with that **exact** revision and choose:

- `from_current`: start after the current selected tail and cancel old pending
  domain deliveries for that subscription.
- `replay_selected`: scan selected history explicitly; retain prior event IDs,
  accepted receipts and attempt budgets instead of manufacturing fresh work.

A recovery notice requires its own consent and subscription. The paused status
remains available even if a notice cannot be queued. Subscription expiry/refresh
does not erase a recovery review. Every send/retry checks current account access,
consent, activation and actual selected-source presence. A request already sent
outside the service cannot be recalled; its later receipt remains evidence.
The event timestamp may use authenticated author metadata and is not a trusted
wall clock.

## Creation, publication and alternative agents

`create_tendril` returns the actual claim URL. Only the human owner completes
sign-in. Since host creation has no idempotency key, an uncertain creation is
retained for reconciliation and never blindly repeated. Creation does not grant
bridge access or configure the application.

`prepare_page_release` retains the exact authored graph, hashes and review
digest and returns an unsigned signing request. An existing authorized publisher
obtains the private review bundle through a trusted owner interface, checks the
actual asset bytes, and uses `signReviewedRelease` on its own native session.
`publish_page_release` accepts that exact signed publication only when a real
recorded approval callback also approves the review. No model field such as
`approved: true` supplies that approval. See the
[lifecycle handoff](https://github.com/werg/tendriller/blob/master/integrations/chatgpt/LIFECYCLE.md).
Use the existing CLI for large local bundles; the default remote request budget
is 256 KiB, including base64 and JSON overhead.

The optional [Workspace Agent adapter](https://github.com/werg/tendriller/blob/master/integrations/chatgpt/WORKSPACE_AGENT.md)
sends only selected-event identifiers to the operator-configured channel. Its
stable retry key and conversation key survive restart. The provider's
[published-channel API](https://developers.openai.com/workspace-agents/trigger-runs)
returns acceptance and optional run status, not the assistant answer. Configure
that agent to use the allowed MCP reply tool; observe the resulting application
command separately. This does not target the user's arbitrary existing chat.

For a local agent, reuse `createApplicationTools` or `serveApplicationToolLines`
from the public native session package, or the [session CLI](tools/CLI.md).
These remain useful when remote OAuth, subscriptions or widget hosting are
unavailable. Resume an existing dedicated device; do not open one SQLite device
store concurrently from several processes.

## Diagnose the failing boundary

| Symptom or reported code | Concrete next step |
| --- | --- |
| HTTP 401, `INSUFFICIENT_SCOPE` | Check configured issuer/audience/JWKS and use the client reauthorization flow for the exact scope. |
| `ACCOUNT_ACCESS_DENIED` | Repair the trusted account-to-application mapping or select an account that currently has access. |
| Connection missing, expired or revoked | The owner reviews the exact permissions again; reconnecting OAuth alone does not grant them. |
| `BRIDGE_GRANT_REQUIRED` or unavailable native authority | Verify the dedicated device enrollment and current signed grants, resume its private store and restore control connectivity. |
| Native session cannot apply or share | Inspect coordinator/peer availability and participation status. Keep the required native peer running; do not invent a second command engine. |
| Unknown query/command or projection | Inspect the immutable definition, configured allowlist and owner consent. Add declarations only through a supported application setup/evolution path. |
| Callback challenge, blocked address or redirect | Use the actual client-provided public HTTPS callback; inspect its categorized failure without bypassing address validation. |
| Subscription inactive, callback gone, no supported chat surface | Refresh or explicitly resubscribe; otherwise use manual tools, mounted UI or a configured Workspace Agent. |
| `SOURCE_NOT_SELECTED`, `APPLICATION_VIEW_RECOVERED`, recovery pause | Read current selected history and recovery status; review the exact recovery revision before choosing a resume strategy. |
| `BRIDGE_EVENT_SCAN_LIMIT`, `SOURCE_BASELINE_LIMIT` | Absence was not established. Adjust a trusted bounded scan budget or narrow the application design; do not answer from stale cached content. |
| `OPERATION_ID_CONFLICT` or uncertain command | Inspect the original operation and retained inputs. Preserve identity for exact retry; review any new intent separately. |
| `OPERATION_IDENTITY_UNCONFIRMED` | Retry the original request with its exact operation ID and inputs; status is withheld until the native saved identity is verified. |
| `HOST_ACCOUNT_MAPPING_INCOMPLETE`, OAuth configuration or migration 503 | Apply the additive OAuth migration and check the exact resource, bridge credential, application IDs and registered callbacks using preflight. |
| Management sign-in expired or host logout | Start `/connections/login` again. A new browser session does not replace revoked OAuth grants or application consent. |
| `REQUEST_TOO_LARGE` | Reduce the bounded remote graph or use the public CLI; an operator may configure up to 12 MiB after considering host limits. |
| Missing publication tool, publisher denial or changed release context | Configure the real approval lookup, use the enrolled publisher and prepare a new review for changed context. |
| `STORE_DECRYPTION_FAILED`, journal/outbox capacity | Restore the matching private key/store or archive reviewed receipts deliberately. Do not clear pending identities to make a retry succeed. |
| Webhook accepted or Workspace Agent completed but no answer | Read actual request/operation state and inspect the configured agent's permitted write-back tools. Receipt status is not a reply. |

## Verification and completion

Run the separate Node 24 gate, `npm run test:chatgpt`. The integration's tests
exercise OAuth verification, consent, callbacks, durable delivery and recovery,
MCP schemas, widget behavior, lifecycle handoff and Workspace Agent transport.
Supplying the pinned public Chronolog package additionally runs real native
SQLite stores, signed attempts, authenticated in-process peer exchange, exact
retry, recovery and reopen. The
[integration README](https://github.com/werg/tendriller/blob/master/integrations/chatgpt/README.md)
records how to build that artifact and what each check establishes.

Synthetic account/control services, injected callbacks/provider transports and
local widget tests do not qualify a live identity provider, Internet RTC/relay,
mounted ChatGPT UI or subscribed model turn. Before calling a deployed connection
complete, record the actual owner claim, configured account mapping, explicit
bridge grant and consent, successful linked query, verified subscription, one
source request, its delivery receipt, an assistant's correlated signed reply,
the page's applied read, reload and revoked-access behavior. Identify the
processes that remain running and preserve their restart state. Report the
specific unverified step when a prerequisite is unavailable.
