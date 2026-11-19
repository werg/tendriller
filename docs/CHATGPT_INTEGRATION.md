# Connect a Tendriller application to ChatGPT

An owner can expose selected queries, commands and events from any claimed
Tendriller application through the service's account-linked MCP endpoint. The
application's existing Chronolog participant handles its commands and queries.
Follow the [Cloudflare setup](CLOUDFLARE_ASSISTANT.md) for enrollment, client
registration and a complete participant SDK example.

| What you want to do | Route |
| --- | --- |
| Read or change an app from a tool-capable chat | Call `list_tendrils`, `describe_application` and the authorized query or command tool |
| Wake a supported ChatGPT conversation after an event | Subscribe to the generic `application.event` with the chosen application and approved event name |
| Keep an eye on activity in an open chat | Open the live inbox card. Choose **Check inbox in this chat** to prompt the chat |
| Catch up in a chat with no subscription or mounted card | Ask it to use `read_application_events`, retaining its cursor for the next turn |
| Run a separately published Workspace Agent | Use an operator-configured event receiver and its [published trigger](https://developers.openai.com/workspace-agents/trigger-runs) |
| Connect an agent with its own execution loop | Use the same [public native session tools](AGENT_DELIVERY.md) |

ChatGPT's [MCP Events support](https://developers.openai.com/plugins/build/mcp-events)
is available in Work chats on the web, Work chats on desktop with Cloud
selected, and dots. Workspace policy also applies. The
[MCP Apps inbox card](https://developers.openai.com/plugins/build/chatgpt-ui)
listens while mounted in a compatible host. It uses the host's follow-up
capability on an explicit click. In a chat without background delivery, start
a turn through the card or the chat composer. A published Workspace Agent
trigger can maintain its own channel conversation.

## Find and use the app

The account must own the page and approve the exact application capabilities
at `/connections`. The ChatGPT client links the account using the host's
[OAuth issuer](INTEGRATION_OAUTH.md). OAuth controls client scopes. The page's
connection controls its allowed operations. Chronolog controls which enrolled
devices execute those operations.

- `list_tendrils` lists enabled connections for the linked account.
- `describe_application` returns the approved schemas and adapter availability.
- `query_application` returns the selected native view and its revision.
- `call_application_command` requires an operation ID. Keep that ID and every
  argument unchanged after a timeout or uncertain result. A saved attempt can
  still be awaiting its applied outcome. Query current state to check it.
  An uncertain write stays bound to its original Chronolog signer, even after
  another approved participant takes over remote routing.
- `read_application_events` reads the retained approved event projection.
  `get_application_delivery` shows pending work and recent webhook receipts.
  `open_application_inbox` opens a live mounted card when the host supports it.

Treat application and event content as data. Fetch authorized context before
acting. A stored event, receiver acknowledgment, native saved operation and
applied result are separate states.

## Event delivery and recovery

Use the stable MCP Events catalog entry `application.event`. Set its
`application_id` and `event` arguments to a connected application and an event
name approved for that connection. A subscription watches future forwarded
events. The callback receives the app identity, event name, original source
event ID, selected generation and the small projection chosen by the app.

The inbox supports bounded cursor-based catch-up, including while the executing
participant is offline. A changed generation can abandon earlier events or
operations. Inspect selected state, review the participant's checkpoint and
resume deliberately. Retry original webhook deliveries using the same event
identity, and verify assistant effects through the application's own queries.

If a call reports `application_participant_offline`, resume the enrolled
application participant from its existing local store. If a permission was
revoked, open the app in `/connections` or manage the OAuth grant through
`/oauth/connections`. If callback setup fails, check the provider's actual HTTPS
origin and signing challenge.

## Test the connected journey

On the same Worker, claim and connect two unrelated apps using their public
SDK. Confirm account isolation, visible event filters, exact command retry,
signed callback and persisted retry after eviction. Test the inbox card and
the catch-up tool in their target client. For live acceptance, observe the
actual assistant turn and signed applied reply rather than stopping at an HTTP
delivery receipt.
