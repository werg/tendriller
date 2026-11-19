# Connect any Tendriller application to an assistant

Tendriller exposes application tools at the service's `/mcp` endpoint. Each page
owns its approved connection, event inbox, subscriptions and delivery jobs in
its existing Durable Object. Application code and state stay with the enrolled
Chronolog participants. The same endpoint serves multiple owners and application
definitions, including applications that use SQL.

## Prepare the service once

Apply account migrations `0002_integration_oauth.sql` and
`0003_assistant_connections.sql`. Configure the exact service origin plus
`/mcp` as the OAuth resource. Register each intended client with its actual
callback and authentication method, and install `OAUTH_SIGNING_JWK`.
For ChatGPT's Client ID Metadata Document flow, use the exact metadata URL
shown in the plugin setup as the client `id`, set `metadataDocument: true` and
`tokenEndpointAuthMethod: "none"`, and pin its exact redirect URI. Tendriller
checks the public document when displaying the OAuth consent form.
The normal tool scopes are `tendrils:list`, `applications:read`,
`applications:write` and `events:subscribe`. Use `bridges: []` for this route.
See [OAuth setup](INTEGRATION_OAUTH.md).

Set `ASSISTANT_STORE_KEY` to 32 random bytes encoded as base64. It encrypts
webhook signing secrets and provides a separate derived signing key for live
inbox tickets. Keep the key available across deployments. Set
`ASSISTANT_CALLBACK_ORIGINS` to a whitespace-separated list of exact HTTPS
origins operated by approved callback providers. HTTPS redirects are blocked.
A deployment with no allowed callback origins can still offer tools and the
live inbox. These are service-wide settings.

## Enroll an application

1. Follow [Build an app](BUILD_AN_APP.md) through owner claim, signed definition,
   selected generation and a working application participant. Keep that
   participant available according to [Agent delivery](AGENT_DELIVERY.md).
2. Use the public helper below from the participant's private setup process.
   Save the adapter key in that participant's private store and reuse it on
   restart. The proposal's commands and queries must exist in the signed native
   definition. Describe what each exported event will contain so the owner can
   review the outbound data.
3. Give the owner the returned `reviewUrl`. They sign in and choose the exact
   queries, commands and events to expose. Their review is required again when
   replacing the adapter credential or changing its proposal.
4. Attach the adapter to the application's existing Chronolog session.
   Connect the intended client to the service `/mcp` and authorize it. Call
   `list_tendrils`, `describe_application` and one approved query. Test a real
   input and applied writeback before handing the connection to the owner.

```js
import { createApplicationTools } from '@chronolog/peer-session';
import {
  createAssistantKey, proposeApplicationAssistant, connectApplicationAssistant,
  forwardApplicationEvents,
} from '@tendriller/core/assistant';

// Run setup once with the existing private host handle. Retain key privately.
const key = await loadAssistantKey() ?? createAssistantKey();
await saveAssistantKey(key);
const exposed = { queries: ['notes'], commands: ['addNote'] };
const proposal = await proposeApplicationAssistant({
  api: handle.api, token: handle.token, key, label: 'Shared notes', ...exposed,
  events: [{ name: 'note.added', description: 'A note was retained. The event includes its ID only.' }],
});
console.log(proposal.reviewUrl);

// Start this part after the owner approves access, inside the running app peer.
const assistant = connectApplicationAssistant({
  api: handle.api, key, session, tools: createApplicationTools(session), ...exposed,
  onStatus: status => console.log(status),
});
await assistant.waitUntilOnline();

// Optional. Use an atomic private checkpoint file or equivalent durable store.
await forwardApplicationEvents({
  session, assistant, topics: ['note'], checkpoint,
  project: event => ({ name: 'note.added', payload: { noteId: event.id } }),
});
```

The sample assumes your existing `handle`, open `session` and private key/file
helpers. The checkpoint implements `load()` and `save(cursor)`. A missing
checkpoint begins at the first selected event. To send only future activity,
initialize it at the current selected tail using the same topic filter. The
helper advances the checkpoint after the host acknowledges all events in a
batch. A recovered history requires explicit review of what to resume.
Stop the adapter using `assistant.close()` or by closing its parent session.
The SDK scopes remote commands and queries again before calling the native tool.

## MCP Events and other clients

For native background delivery, subscribe to `application.event` using the
`application_id` and exact `event` name returned by `describe_application`.
This stable MCP catalog works for newly connected apps without adding tools
or event types to the plugin. The provider verifies its callback by challenge.
A fresh subscription starts with future emissions. Each queued delivery uses a
stable event ID and exact body across retries, and is fenced by the selected
Chronolog generation and current account grant. A receipt establishes delivery
to the provider. Confirm the resulting signed writeback in application history.

A tool-capable chat without background subscriptions can call
`read_application_events` on the next turn. Keep its returned `next` cursor and
generation, check `truncated`, and preserve context if the generation changes.
Compatible MCP Apps hosts can mount `open_application_inbox` to show new activity
over an inbound WebSocket. The card sends a follow-up to the same chat when the
person chooses **Check inbox in this chat**. The mounted card's ticket is
short-lived. Background processing is available through a supported subscribed
chat or a separately published agent with its own trigger. See the
[ChatGPT routes](CHATGPT_INTEGRATION.md).

## Cost and verification

- Account discovery reads an indexed account table without waking page objects.
  A call routes to the one requested page. The host runs no app code.
- Inbound application and live inbox sockets use the Durable Object Hibernation
  API. There is no keepalive request, outbound bridge socket, polling loop or
  scheduled assistant job during idle periods.
- Each explicitly forwarded event writes one inbox record and queues jobs only
  for matching active subscriptions. Delivery shares the page's existing alarm.
  It batches up to four due deliveries and backs off on transient errors.
- The inbox holds the newest 256 accepted events per page plus records needed
  for outstanding delivery. There are eight subscriptions, at most 256 queued
  deliveries and four mounted live inboxes per page. When the queue is full,
  the emitter receives an explicit error and can retry its exact source event.
  Disconnecting the application removes its event inbox and subscriptions.
- Verify a real client subscription, a user-initiated inbox follow-up, retry
  after eviction and an applied native writeback. For deployment billing, compare
  the same test page with and without the integration over a fixed idle window.
  Record Durable Object requests, duration, alarm invocations and SQL rows.

See [Cloudflare Durable Object pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).
