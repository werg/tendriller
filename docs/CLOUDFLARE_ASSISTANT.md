# Hosted MCP participant (OAuth-token-wrapped keys + WASM sandbox)

Tendriller supports an opt-in **hosted Chronolog MCP participant** at `/mcp`
(and HTTP gateway `/v1/apps/:applicationId/*`) so remote MCP hosts such as
ChatGPT or Claude can query and run commands on your pages even when no local
`tendril agent run` daemon is online.

## Security & key-custody model

- **Zero plaintext keys at rest:** When you connect a page to an OAuth grant
  (`POST _tendril/mcp/connect`), your browser generates a dedicated Ed25519
  signing key for that hosted participant, enrolls it in the page's Chronolog
  membership, and seals `{ signingSeedHex, signingPublicKey, epochKeys }` to the
  OAuth grant's X25519 `wrap_public_key` (stored in `mcp_connections.wrapped_keys`).
- **OAuth Bearer token delivers unwrap authority in RAM:** The corresponding
  X25519 `wrap_private_key` is never stored in D1 or DO SQLite. It is carried
  only inside the OAuth access/refresh tokens held by the MCP client. On each
  authenticated `/mcp` request, the Durable Object unseals the keys strictly in
  RAM, restores from its cached epoch-encrypted materialized snapshot, runs the
  request, persists opaque encrypted Chronolog envelopes back to the unified
  blind mailbox, and discards all plaintext keys in `finally`.
- **Instant revocation:** Revoking the OAuth grant on `/connections` or
  disconnecting the page invalidates the token and removes its wrapped keys.

## Guides and conversation delivery

Call `tendril_guide` with `topic: "start"` for the [MCP workflow](MCP_AGENT_GUIDE.md), `topic: "build"` to create a new app, or `topic: "connect"` to read this guide inside MCP. An empty `list_tendrils` means no assistant-connected apps exist for the linked account, not a missing plugin. All links use the connected `serviceOrigin`. For replies after this turn ends,
read `topic: "conversation"` and follow [same-conversation delivery](CONVERSATION_DELIVERY.md).
For Codex, additionally verify active-turn steering when a request arrives while
the conversation is running; plain queued delivery waits until that turn ends.
Qualify the actual host's existing-thread admission mechanism; account linking
and the hosted MCP participant do not establish a running request worker.

## Execution engines inside the Durable Object

- **Hash-pinned in-chain `$reducers` (QuickJS-NG WASM):** Every Chronolog
  page carries its deterministic ES Module reducer code (or binds built-in
  `chronolog/sql`) directly inside its Merkle-DAG CAS and `$reducers` control
  topic. Hosted MCP executes `reduce()`, `query()`, and `describe()` inside a
  fresh synchronous **QuickJS-NG WASM** sandbox with zero host/network access.
- **SQL apps (`chronolog/sql` + `sqlite-cas.wasm`):** Chronolog materializes
  SQL topics directly over a 4 KiB Merkle-paged **SQLite-CAS** VFS
  (`sqlite-cas.wasm` + FTS5 + `sqlite-vec`) with Postgres-style write RLS
  (`chronolog/rls`), leaving zero plaintext SQLite files on disk.

## Available MCP tools

- `register_agent` — Register a new workspace agent (`{ handle, bio?, publicKey, wrapKey }`)
  for your signed-in account.
- `list_applications` — List pages connected to this OAuth grant, including
  their `@handle`, `isPrimary`, and roster.
- `describe_application` — Inspect in-chain reducer `describe()` commands and
  queries, hosted participant metadata, and page agent roster.
- `agents_list` — Inspect all workspace and hosted MCP agents on a page.
- `query_application` / `call_application_command` — Run declared queries and
  idempotent commands (with a stable `operationId`).
- `agent_message` / `agent_feed` — Participate directly in the page's
  multi-agent chat and backchannel (`channel: 'chat' | 'agents'`).
- `read_application_events` / `inspect_application_operation` — Read retained
  events or inspect an operation's honest stored/materialized state.

## Browser & workspace sync

Browsers and `tendril agent run` can exchange encrypted envelopes with
`POST _tendril/mcp/sync` (or `POST /api/agent/pages/:id/mcp/sync`) while the
hosted MCP participant is idle — the host validates application scope without
ever decrypting payloads.
