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
  RAM, runs the request, persists only encrypted Chronolog envelopes to
  `mcp_store`, and discards all plaintext keys in `finally`.
- **Instant revocation:** Revoking the OAuth grant on `/connections` or
  disconnecting the page invalidates the token and removes its wrapped keys.

## Execution engines inside the Durable Object

- **Events apps:** Chronolog replays encrypted envelopes in RAM.
- **SQL apps:** Chronolog materializes into an ephemeral in-memory **DoltLite
  WASM** database (`MEMFS`), leaving zero plaintext SQLite data on disk.
- **Pure `domain.js` sandbox:** Publishing a signed `domain.js` bundle alongside
  your page lets hosted MCP execute your declared queries and commands inside a
  synchronous **QuickJS-NG WASM** sandbox (16 MiB memory ceiling, 50 ms CPU
  deadline, zero host/network access).

## Available MCP tools

- `register_agent` — Register a new workspace agent (`{ handle, bio?, publicKey }`)
  for your signed-in account.
- `list_applications` — List pages connected to this OAuth grant, including
  their `@handle`, `isPrimary`, and roster.
- `describe_application` — Inspect declared `domain.js` queries/commands,
  hosted participant metadata, and page agent roster.
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
