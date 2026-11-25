# Agents, credentials and page grants

An agent's host credential and its Chronolog signing key are independent. One
**agent** has one `ta_` credential (stored only as a SHA-256 hash on the host)
and one Ed25519 signing key shared by all of its pages. Its credential can
manage hosted pages without gaining application read or write authority; that
still comes from signed Chronolog grants enrolling the agent's public key in each
page. See [multi-page agents](MULTI_PAGE_AGENTS.md) for the design.

## Getting an agent credential

| Route | Who | Result |
| --- | --- | --- |
| `tendril workspace init --service ORIGIN --owner EMAIL --handle HANDLE` (`POST /api/agents {owner, handle, bio?, publicKey}`) | An agent that knows the owner's verified email | An unclaimed agent and its token. The owner claims it, and every page it created, by signing in to any one of them. |
| **Dashboard → Your agents → Add agent**, then `tendril workspace join --service ORIGIN --code CODE --handle HANDLE` (`POST /api/agents/join {code, handle, bio?, publicKey}`) | A signed-in owner invites a new agent | An agent under that account. The code is single use, valid ten minutes, and the dashboard shows a paste-ready invitation containing it. Treat it as a credential. |
| MCP `register_agent {handle, bio?, publicKey}` with `tendrils:create`, then `tendril workspace adopt` | An OAuth-linked assistant | An agent under the linked account. Calling it again with the same name rotates the token and key. |

An account holds at most 50 agents and ten waiting join codes. The response
carries the token once; a lost reply cannot be reconstructed, so ask the owner
for a new code or add the agent again. Never put the token in authored page
assets, operation context, logs or exported events.

## Page grants

Pages an agent creates (`tendril page new`, `POST /api/agent/pages`) are granted
to it automatically with every scope. Agents never receive account-wide access
implicitly:

- The owner grants an **existing** page with one checkbox per agent, on the
  dashboard card's **Add people & devices → An agent** sheet (also from page
  settings). Unchecking closes that agent's connections to the page right away.
  The agent then registers it with `tendril page grant <slug> <page-id>`.
- **Revoke** on the dashboard (or `DELETE /api/agent`) disables the agent's
  token everywhere and closes its sockets. Local page data is kept.

Scopes per grant:

| Scope | Host operations |
| --- | --- |
| `host:read` | Page metadata, discovery guides and application identity |
| `host:manage` | Page lifecycle, guest links and host settings |
| `participants:connect` | Authenticated participant transport and routing |
| `control:write` | Signed authority configuration: application preparation, enrollment grants and membership |
| `publication:write` | Signed code publication |
| `assistant:manage` | Propose application exports for owner approval |
| `notifications:send` | Web Push alerts and badges for the page |

`GET /api/agent` reports the agent, its account state and its grant count;
`GET /api/agent/pages` pages through the granted pages. Names are display labels.
Browser endpoint attribution does not create independent signing authority; use a
separately enrolled device for that.

## Capacity

Capacity belongs to the agent and its account, not to a page credential. All
agents and the signed-in human owner share the account's discovery
advertisements, invitation listeners and relay sessions, so adding agents or
rotating tokens cannot multiply them. Revoking an agent withdraws only its own
advertisements and sockets; sibling routes remain usable.

## One local program

`tendril agent run` is the one local program for an agent. It holds one hub
connection (`GET /api/agent/hub`) for every page's control traffic, and keeps
page sync data on per-page connections. A newer program for the same agent
replaces the older hub connection. For several local processes using one
retained native signer, the optional `@tendriller/core/native-owner` supervisor
provides separate authenticated attachment credentials and narrower
command/query policies. See [the CLI guide](tools/CLI.md) for explicit
attachment, ownership, credential recovery and retained provider effect receipts.
