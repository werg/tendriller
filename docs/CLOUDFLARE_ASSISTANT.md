# Connect any Tendriller application to an assistant

Tendriller exposes one account-linked `/mcp` endpoint on the service origin. Each page Durable Object owns its approved assistant connection, event inbox, webhook subscriptions, and delivery queue. Application code and durable state stay on the enrolled Chronolog participants (the workspace's agent program for each page) — the host executes no application code.

## Start from an agent conversation

Call `tendril_guide` with `topic: "start"` for the [MCP workflow](MCP_AGENT_GUIDE.md), `topic: "build"` to create a new app, or `topic: "connect"` to read this guide inside MCP. An empty `list_tendrils` means no assistant-connected apps exist for the linked account, not a missing plugin. All links use the connected `serviceOrigin`.

## Prepare the service once

1. Initialize the unified account schema (`server/migrations/0001_accounts.sql`, `@tendriller/engine/accounts-schema`).
2. Configure `OAUTH_CONFIG_JSON` with `resource: "<PUBLIC_BASE>/mcp"`, your registered clients (for ChatGPT's public Client ID Metadata Document flow: `id: "https://chatgpt.com/oauth/client.json"`, `metadataDocument: true`, `tokenEndpointAuthMethod: "none"`, exact redirect `https://chatgpt.com/connector_platform_oauth_redirect`), and `OAUTH_SIGNING_JWK`. Typical scopes: `tendrils:list`, `tendrils:create`, `applications:read`, `applications:write`, `events:subscribe`. See [OAuth setup](INTEGRATION_OAUTH.md).
3. Set `ASSISTANT_STORE_KEY` (32 random bytes base64) to encrypt webhook signing secrets and sign short-lived live inbox tickets. Keep it stable across deployments.
4. Optionally set `ASSISTANT_CALLBACK_ORIGINS` (whitespace-separated exact HTTPS origins allowed for event callbacks; redirects are blocked). Without it, tools and the live inbox still work.

## Enroll an application

1. Build and publish the app through [Build an app](BUILD_AN_APP.md) so its signed definition, initial generation, and page owner inside `tendril agent run` exist (this can happen before owner claim).
2. Generate and privately store an adapter key (`createAssistantKey()`), plus up to two distinct `backupKeys` for standby enrolled devices if needed. Propose the exact queries, commands, and event projections declared by the signed definition.
3. Give the owner the published page URL and `proposal.reviewUrl`. Once claimed, the owner reviews and approves exact capabilities at `/connections`. Editing capabilities keeps unchanged grants/subscriptions; removing an event or changing its projection clears its retained inbox/subscriptions.
4. Attach `connectApplicationAssistant` to the running Chronolog session, connect the MCP client to `<PUBLIC_BASE>/mcp`, and verify `list_tendrils`, `describe_application`, a read query, and an applied command.

```js
import { createScopedApplicationTools, forwardSessionEvents } from '@chronolog/peer-session';
import {
  createAssistantKey, proposeApplicationAssistant, connectApplicationAssistant,
  createAssistantEventDelivery,
} from '@tendriller/core/assistant';

// Setup once with the page's host client (`context.host` in a page module, or
// `createAgentClient({ service, token }).page(pageId, { applicationId })`); persist `key` privately.
const key = await loadAssistantKey() ?? createAssistantKey();
await saveAssistantKey(key);
const exposed = { queries: ['notes'], commands: ['addNote'] };
const proposal = await proposeApplicationAssistant({
  page: host, key, label: 'Shared notes', ...exposed,
  events: [{ name: 'note.added', description: 'A note was retained (ID only).' }],
});
console.log(proposal.reviewUrl);

// Inside the running page owner (the agent program) after owner approval:
const assistant = connectApplicationAssistant({
  page: host, key, session,
  tools: createScopedApplicationTools(session, exposed),
  onStatus: status => console.log(status),
});
await assistant.waitUntilOnline();

// Optional durable event forwarding (atomic checkpoint with load()/save(cursor)):
await forwardSessionEvents({
  session, topics: ['note'], checkpoint,
  deliver: createAssistantEventDelivery({ assistant }),
  project: event => ({ name: 'note.added', payload: { noteId: event.id } }),
});
```

### Execution and retry semantics

- **Authorization & routing:** the Worker verifies the adapter key and device against signed Chronolog grants. Reads can route to any eligible approved replica; new writes route to one owner-selected provider. Each WebSocket connection carries a monotonic epoch so replaced sockets cannot act for their successor.
- **Exact retries:** Tendriller retains the input digest and original signing device per `operationId`. Retries target that same signer and never silently move a saved operation to a different device. Use `inspect_application_operation`, `retry_application_operation`, or bounded `wait_application_operation` for uncertain outcomes; use `reapply_application_operation` with a new ID to deliberately link replacement work.
- **Event forwarding:** Chronolog's `forwardSessionEvents` owns recovery, cancellation, read views, and checkpoint advancement. Tendriller's `createAssistantEventDelivery` supplies host acknowledgement/retry and owner-declined projection handling (`onSkipped`). The checkpoint advances only after delivery completes.
- **Double scoping:** both the host gateway and the local participant (`createScopedApplicationTools` + `@tendriller/core/assistant`) enforce the exact allowed command/query set. Stop the adapter via `assistant.close()` or closing its session.

## Independently acting agents (consumer bindings)

OAuth authenticates the account and client, not separate chats inside the same client (unbound calls appear as **Tool caller via the OAuth client**). To isolate independent agents:

1. Generate and retain `createApplicationAgentKey()` (UUID + 32-byte secret).
2. Call `register_application_agent` with `applicationId`, `bindingToken`, `label`, requested capabilities, and route (`on-demand`, `event-subscriber`, `mounted-inbox`, or `native-loop`).
3. Have the owner approve the exact binding at the returned URL (capped by the app connection and OAuth grant).
4. Send the proof via `Tendriller-Agent-Binding`, MCP `_meta['tendriller/agentBinding']`, or `bindingToken` (never in app data, code, or events).

Each binding gets isolated `operationId` namespaces, subscriptions, cursors, and delivery receipts, and can be rotated (`rotate_application_agent`) or individually revoked (`revoke_application_agent`). Cryptographic execution provenance remains the Chronolog signing device; attested caller binding is passed separately from caller-asserted metadata. These bindings are distinct from the account's maintenance agents (see [Agents and grants](AGENT_BINDINGS.md)).

## Events, catch-up, and live inbox

- **MCP Events (`application.event`):** subscribe with `application_id` and an approved `event` name. Callbacks are challenge-verified, signed with HMAC-SHA256 (Web Crypto), fenced by selected generation and live OAuth grant, and retried via the page Durable Object alarm with backoff. Inspect pending/terminal receipts via `get_application_delivery`.
- **Turn-based catch-up (`read_application_events`):** retain the full opaque `next` cursor (app, binding, export version, generation, filter, sequence). Boundary changes return `resetRequired` and a reset cursor.
- **Live inbox (`open_application_inbox`):** mounts an MCP Apps card over a hibernating WebSocket using a short-lived ticket; clicking **Check inbox in this chat** prompts a follow-up turn. See [ChatGPT integration](CHATGPT_INTEGRATION.md).

## Resource bounds and cost

- Account discovery (`list_tendrils`) queries D1 without waking page Durable Objects; calls wake only the target page.
- Inbound participant and inbox sockets use Durable Object hibernation (zero idle polling or keepalives).
- Per-page bounds: 256 retained inbox events (plus records with pending deliveries), 8 subscriptions, 256 queued deliveries, 4 mounted live inboxes, 32 consumer bindings, 4,096 operation mappings, 8 concurrent RPCs (at most 2 RPCs and 4 subscriptions per binding). Delivery alarms lease up to 4 due jobs per pass. Disconnecting removes the page's inbox and subscriptions.


## HTTPS fallback when persistent transports are blocked

An already authorized OAuth client may use the same service origin's
`/v1/apps/APPLICATION_ID` gateway: `POST /commands`, `POST /commands/batch`,
`GET /operations/OPERATION_ID`, `GET` or `POST /query`, and `GET /events`.
Use its OAuth bearer token and, for an independently approved agent, the
`Tendriller-Agent-Binding` header. Command/query JSON has the same fields as the
corresponding MCP tool; batches contain `commands` and optional `stopOnError`.
The same account, OAuth scopes, reviewed capabilities and original signer
admission apply. Store credentials privately.

The HTTP and MCP batch tools accept up to 16 ordered individual commands and
return per-command outcomes, `complete`, and `nextIndex`. They are not an atomic
transaction. The complete HTTP request has a 25-second budget; remaining entries
are not submitted after cancellation or that deadline. Keep all original IDs
and inspect uncertain results before resuming at `nextIndex`.

For event catch-up, retain the returned compound cursor and JSON-encode it in
`since`; `limit` is 1..25. This endpoint returns immediately and supplies no
background wake. Prefer native supported push and hibernating WebSockets for
ongoing connections; use this fallback during an active turn when those routes
are unavailable. Continuous status polling creates unnecessary requests.
