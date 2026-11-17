# MCP host tools

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
| `tendril_info` | Explicit host identity/lifecycle metadata |

Read tool schemas from `tools/list`. Preserve signed transition/release bytes and operation identity on uncertain replies. Verify returned authority and publication ancestry through the application's Chronolog session.

MCP does not run application commands, expose a data event queue, subscribe an agent wake receiver or load server domain modules. An agent opens its own public application session for commands, queries, emitted events, live signals, operations and explicit recovery. The CLI's session adapter can use the same application session.
