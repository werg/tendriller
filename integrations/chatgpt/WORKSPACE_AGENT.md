# Optional published Workspace Agent route

`createWorkspaceAgentAdapter` in `workspace-agent.mjs` implements a separate
fixed-destination route for a published Workspace Agent API channel. It does
not target arbitrary ChatGPT chats. Use it when the owner has explicitly
configured that agent, its access token, outbound event policy and MCP
write-back permissions.

The [current provider contract](https://developers.openai.com/workspace-agents/trigger-runs)
accepts a trigger under `https://api.chatgpt.com/v1/workspace_agents/agtch_…/trigger`.
It can continue a conversation using a stable key and deduplicate retried events
using an idempotency header. Beta run tracking returns a run ID and reports
queued, in-progress, suspended, completed or failed work. The API does not
return the assistant's answer. The configured agent must call the permitted
Tendriller MCP reply tool, and the page observes the resulting signed command.

## Configuration and authorization

Pass the existing encrypted delivery store and native bridge, a configured
`triggerId`, and either a private `accessToken` or async `getAccessToken`
callback. Tokens are used only in request headers, never returned or written to
delivery records. The adapter uses fixed provider paths with redirect rejection,
a 15-second request deadline and a 64-KiB response bound.

The required `authorize(principal, applicationId, eventName)` callback is called
with `null` first for account/application/route access, then with the actual
selected event name for event-specific egress consent. It must return exactly
`true`. It is rechecked immediately before delivery and on every status request.
The native bridge independently verifies current application access and grants.
Never configure an unconditional approval callback for a remote deployment.

```js
const adapter = createWorkspaceAgentAdapter({
  store, bridge, authorize,
  triggerId: configuredPublishedAgentChannel,
  getAccessToken: () => readPrivateAgentToken(),
});
const receipt = await adapter.trigger(authenticatedPrincipal, {
  applicationId, sourceEventId, operationId: savedCallerOwnedOperationId,
});
const status = await adapter.status(authenticatedPrincipal, {
  operationId: savedCallerOwnedOperationId,
});
```

Only the operator configures the destination. Tool callers supply application,
source event and operation identifiers; they cannot supply a token, endpoint,
conversation URL, arbitrary prompt or another agent channel.

The adapter reads the real source through `bridge.getEvent`, sends static
instructions plus a small identifier record, and omits request text, summaries,
photos and media. The recipient fetches current context through authorized MCP
tools. `conversation_key` is derived from configured channel, principal and
application, so this route consistently uses its own application conversation.
Principal identity includes the exact issuer and subject. Equal subjects from
different issuers cannot share an operation receipt or conversation key.

## Idempotency, restart and recovery

The delivery record is persisted before network I/O. It binds operation ID to
owner, application, immutable source event and configured channel. Reusing the
same operation ID for another owner or source fails. A retry sends the original
body and idempotency key; accepted operations return their retained receipt.
Short durable leases coalesce concurrent processes and permit recovery after
a crashed sender's bounded lease expires. The adapter checks current lease and
state after asynchronous authorization immediately before provider I/O. A valid
late acceptance receipt remains evidence even after its original lease expires;
it cannot make a recovered source current again or regress an observed run.

The journal defaults to at most 10,000 operations (`maxOperations`, configurable
from 1 to 100,000). At capacity, new operations fail before provider I/O while
existing receipts and exact retries remain available. Receipts are not silently
evicted, because doing so would discard idempotency evidence. Reconcile and
archive reviewed operations deliberately before changing storage or capacity.

Transport failures, redirects or malformed `202` receipts are **uncertain**:
the provider may have accepted the event. A retry preserves identity. The
default budget is five attempts within one hour, after which inspect the
provider conversation or run and reconcile explicitly. Provider idempotency
retention is not independently measured by these tests.

Before every outbound retry, the adapter rechecks the selected source and
current consent. If the source is no longer selected, it sends nothing new.
An already accepted receipt remains reportable with `sourceCurrent: false`.
Recovery during an in-flight external request cannot atomically undo that
external request; the assistant must reread current state before a write-back.

Run status validates the returned run/channel identity and conversation URL.
`completed` means provider run completion; it does not prove a Tendriller
reply was applied or shared. Observe those statuses through the native
operation/query tools. A failed poll preserves the last known status and
records that fresh status is unavailable.

## Verification limits

`node --test integrations/chatgpt/test/workspace-agent.test.mjs` exercises the
exact fixed API contract, durable-before-send ordering, cross-owner/source
binding, concurrent lease behavior, lost-response retry, revocation, recovery,
bounded receipts, redirect rejection and run tracking with injected transport.
It makes no real external request and uses no production token. A live
published-channel trigger, its configured MCP tools and the resulting page
write-back remain deployment acceptance checks.
