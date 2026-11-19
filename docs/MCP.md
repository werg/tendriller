# MCP host tools and optional application integration

For a new application, call `tendril_guide` first or follow [Build an app](BUILD_AN_APP.md). The guide returns same-origin setup, starter download and troubleshooting links. The initial MCP instructions also name this route.

The authenticated MCP endpoint adapts host administration to the same filtered participant transport. It accepts JSON-RPC over POST at `<agent_api>/mcp`; use the agent bearer token. A capability URL variant is available for clients that cannot send headers. Keep credentials private.

| Tool | Participant operation |
| --- | --- |
| `peer_application` | `control/read` |
| `configure_peer_application` | `control/configure` |
| `select_peer_generation` | `control/select` |
| `administer_peer_generation` | `control/administer` |
| `peer_definition` | `publication/definition` |
| `peer_publication` | `publication/read` |
| `publish_peer_publication` | `publication/publish` |
| `discover_peers` | `discovery/read` |
| `tendril_guide` | First-app workflow, starter and documentation links |
| `tendril_info` | Explicit host identity/lifecycle metadata, configuration state and owner account ID for enrollment |

Read tool schemas from `tools/list`. Preserve signed transition/release bytes and operation identity on uncertain replies. Verify returned authority and publication ancestry through the application's Chronolog session.

This **host endpoint** does not run application commands, expose a data event
queue, subscribe an agent wake receiver or load server domain modules. An agent
opens its own public application session for commands, queries, emitted events,
live signals, operations and explicit recovery. The CLI's session adapter can
use the same application session.

## Optional remote application MCP service

The separate [ChatGPT integration](CHATGPT_INTEGRATION.md) runs an enrolled native
participant and exposes authorized application tools at its own configured HTTPS
MCP resource. It supplies OAuth protected-resource metadata, explicit connection
consent, bounded queries/commands, durable MCP Events subscriptions, a mounted
assistance card, and optional lifecycle and Workspace Agent adapters. It does not
change `<agent_api>/mcp` or let the host execute domain code.

Its `get_integration_options` reports configured routes and prerequisites;
`describe_application` returns permitted domain schemas. Read `tools/list` for
actual tools and scopes. Preserve operation IDs and native revision objects.
Owner claim, account access, native grants, egress consent, subscriptions and
publisher approval remain independent. The integration guide covers setup,
manual/native fallbacks, exact retry, recovery and live acceptance evidence.
