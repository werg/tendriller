# Multi-page agents (design)

One maintenance agent maintains many pages. It has one account-level identity
and credential, runs one optional local program, and keeps one connection to the host
for all control traffic. A single page is a workspace with one page.

The workspace is the only model: one credential, one signing key and one wrap key per agent,
and page access by grant.

## Decisions

- **Self-chosen `@handles` and `bio`:** Every agent picks a speakable lowercase
  handle (`^[a-z][a-z0-9_-]{1,31}$`, case-insensitively unique per account) and
  optional one-line `bio` (≤160 chars) at registration. Handles can be updated
  later via `PATCH /api/agent` (`tendril agent profile`).
- **One signing key and one wrap key per agent**, shared by all of its pages.
  Both public keys are registered with the agent. On a page it creates
  (`npm run init`) the signing key is the root principal and first
  administrator; on any other granted page the host attests it (with its wrap
  key) and an online member admits it into membership and wraps the keys to it.
- **Page access & primary selection:** pages an agent creates are granted to it
  automatically (and the first granted agent becomes the page's default primary
  agent). Existing pages need an explicit owner grant. Each page has at most one
  primary agent (`PUT _tendril/agents/primary`, Manage page, or Dashboard).
- **One connection for control traffic only:** setup notices, discovery,
  invitations and WebRTC rendezvous share the hub connection, and live roster
  changes arrive as `'agents-changed'` hub events. Application sync data
  (WebRTC data channels, relay) keeps per-page connections.

## Host model

### D1 tables (`server/migrations/0002_agents.sql`)

```sql
agents(id TEXT PRIMARY KEY,            -- 'ag_' + 26 base32
       account_id TEXT,                 -- NULL until the owner signs in
       owner_email TEXT,                -- for unclaimed agents
       handle TEXT NOT NULL,            -- lowercase @[a-z][a-z0-9_-]{1,31}, unique per account
       bio TEXT NOT NULL DEFAULT '',    -- optional <=160 char role description
       token_hash TEXT NOT NULL UNIQUE, -- sha256 hex of 'ta_' token
       public_key TEXT NOT NULL,        -- base64url Ed25519 signing key
       wrap_key TEXT NOT NULL,          -- 64 hex X25519 key-wrap key
       created_at INTEGER NOT NULL, claimed_at INTEGER, revoked_at INTEGER)
agent_grants(agent_id TEXT, page_id TEXT, scopes TEXT NOT NULL, -- JSON array
             granted_at INTEGER NOT NULL, granted_by TEXT NOT NULL, -- 'creator' | 'owner'
             PRIMARY KEY(agent_id, page_id))
agent_join_codes(code_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL,
                 scopes TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER)
```

### Credential

- Token `ta_<32 base32>`; only its SHA-256 is stored.
- HTTP: `Authorization: Bearer ta_…`. WebSocket: the token is a subprotocol
  next to the protocol name, never in the URL.
- Scopes per grant: `host:read`, `host:manage`, `participants:connect`,
  `control:write`, `publication:write`, `notifications:send`.
- Revoking an agent sets `revoked_at`; deleting a grant removes the row. Both
  notify the affected page objects, which close that agent's sockets and
  reconcile the page's primary agent if needed.

### Getting an agent credential

| Route | Who | Result |
|---|---|---|
| `POST /api/agents {owner, handle, bio?, publicKey, wrapKey}` | a new agent, unauthenticated, creation rate limits | unclaimed agent + token. The owner claims it, and every page it created for that email, by signing in to any one of them. |
| `POST /api/agents/join {code, handle, bio?, publicKey, wrapKey}` | an agent given a paste-ready blurb | agent under the inviting account + token |
| Dashboard → Your agents → Add agent | signed-in owner | one-time join code (10 min) and paste-ready blurb |
| MCP `register_agent {handle, bio?, publicKey, wrapKey}` | an OAuth-linked assistant | agent under the account; calling again with the same handle rotates the token |

### Agent API (service origin)

- `GET /api/agent` — the agent (`id`, `handle`, `bio`), its account state, reported versions, broadcast summary, and grant count.
- `PUT /api/agent/versions` — record the workspace's installed connector/Chronolog package versions for fleet observability.
- `GET /api/broadcasts` & `GET /.well-known/tendriller-broadcast-keys.json` — active Ed25519-signed system broadcasts (dependency upgrade notices, security advisories, maintenance windows) and public verification keys.
- `PATCH /api/agent {handle?, bio?}` — update handle or bio and propagate to all granted pages.
- `GET /api/agent/pages?cursor=` — granted pages: id, name, page_url, scopes,
  application id, lifetime, `primary_agent_id`, `is_primary`, `agents`. Paged, 100 per page.
- `POST /api/agent/pages {name?}` — create a page. Unclaimed agents create pages
  owned by `owner_email`. The owner's first sign-in to any of them claims the
  agent and every other page it created for that email (each page object runs
  its ordinary owner claim; a page refused by quota stays an invitation). Claimed agents create pages already owned by the account. The
  creator receives a full grant and becomes the initial primary agent.
- `/api/agent/pages/<id>/<rest>` — the page routes (metadata, release, links,
  activity, application, mcp/sync, push, setup/watch, peers/*). The router authenticates the token in D1, requires a
  grant for `<id>`, and forwards to the page object with internal headers
  `x-tendril-agent` (agent id) and `x-tendril-agent-scopes`.

The page object keeps a local mirror of its grants (`agent_grants` table:
agent id, public key, wrap key, scopes, revision) written through internal routes when a
grant changes. `currentPrincipal` checks that mirror synchronously, so
revocation applies at commit time without a D1 round trip. Creating a grant
also issues the agent's host attestation into the page's pending admissions, so
an online member admits it without further action.

### Hub

One `AgentHub` Durable Object per agent (`idFromName(agentId)`).

- `GET /api/agent/hub` (WebSocket, subprotocols `tendriller.hub.v1` and the
  token). One connection per running agent program; a newer connection
  replaces the older one.
- JSON text frames. Streams are virtual WebSockets onto the page object's
  existing socket endpoints:

  | Direction | Frame |
  |---|---|
  | agent → hub | `{t:"open", s, page, path, protocols}` — `path` is one of `setup/watch`, `peers/discovery/watch`, `peers/invitations`, `peers/rendezvous` |
  | agent → hub | `{t:"data", s, text}` or `{t:"data", s, base64}` |
  | agent → hub | `{t:"close", s, code?, reason?}` |
  | hub → agent | `{t:"opened", s, protocol}` / `{t:"data", s, …}` / `{t:"closed", s, code, reason}` |
  | hub → agent | `{t:"event", page, kind, data}` — `grant`, `revoked`, `page-deleted`, `publication`, `agents-changed` |
  | both | `{t:"ping"}` / `{t:"pong"}` |

- `s` is a client-chosen stream id (1–2^31). The hub checks the grant in D1 on
  every `open`, then opens a WebSocket to the page object with the internal
  agent headers. `peers/relay` is not available through the hub.
- Limits: 64 streams per agent connection, 1 MiB per frame.
- Page objects send events with `POST https://hub.internal/event` to each
  granted agent's hub. A hub with no connection drops events; the agent
  re-reads state when it reconnects.
- The hub cannot hibernate while it holds page streams. An idle agent program
  should keep only the streams it needs.

### Limits

Rate limits and peer budgets are keyed per agent and per account, not per page
token. `list` results are paged listings.

## Client contract (`contract/`)

- `createAgentClient({ service, token })` returns:
  - `pages.list()`, `pages.create(body)`, `self()`;
  - `page(id)` — a page client (`request`, `peers`, `info`,
    `service`), based at `/api/agent/pages/<id>`;
  - `hub` — one multiplexed connection with `socket(page, path, protocols)`,
    a WebSocket-compatible object for the existing `openSocket` and `socket`
    factories (`setup-watch`, `discovery-watch`, `peers`, `assistant`), and
    `events(listener)`.

## Local program and workspace

```
my-pages/
  tendriller.json          # { service, agent: { id, name }, kit }
  package.json             # one install
  shared/                  # shared domain helpers and components
  pages/<slug>/            # per-page source: domain.mjs, page.mjs, ... → dist/
  .tendriller/             # private, gitignored
    agent/                 # identity.sqlite (shared signer), wrap-key.json (shared wrap key), credential.json
    pages/<page-id>/       # device.sqlite, descriptor, cursors, page.json, initialized.json after npm run init
```

- `tendril workspace init --service <origin> --owner <email> --handle <handle>` creates the
  workspace, the shared signing and wrap keys and an unclaimed agent credential;
  `workspace join --code <code> --handle <handle>` joins an account with a dashboard code;
  `workspace key` then `workspace adopt --credential <file>` registers through
  an account-linked MCP `register_agent`.
- `tendril page new <slug>` creates a page and its source folder.
- `tendril page grant <slug> <page-id>` / `tendril page list` / `tendril status`.
- `tendril page devices|approve|remove-device|mode|owner-grant|invite|revoke-invite <slug>`
  run admission actions inside the running agent program's page owner.
- `tendril agent run` is the one optional local program: one hub
  connection, one Chronolog session per initialized page (each with its own device
  store, the shared signer and wrap key, and one admission controller), one local socket for attach clients that name
  a page, one combined request/event stream with a cursor per page, automatic
  reconnection.
- `tendril mcp-stdio` serves every page; each tool takes `page`.
- `tendril checkpoint export <file>` moves the stopped workspace's private state
  (`tendriller.json`, the agent keys and credential, every page's device
  checkpoint and private records) into one encrypted file and retires the
  source; `tendril checkpoint restore <file>` recreates it in an empty folder.
  Page source moves with `tendril handoff source`.
- Every CLI command takes `--page <slug|id>` where it acts on one page.

## Chronolog

- `openNativeDevice({ path, create, managedSigner })` reuses one agent key.
- A store pool serves many native stores from one worker thread.
- `mergeSessionChanges(sessions)` combines change feeds with a cursor per
  application; the per-session exit listener is removed.

## One conversation, several pages

The workspace owner is not the interactive conversation's request handler.
Its hub reconnects control streams, but it cannot by itself cause an ended
Codex or ChatGPT turn to resume. Keep one receiver for the selected conversation
when that is the user's goal; an extra agent per page changes that goal.

Use [same-conversation delivery](CONVERSATION_DELIVERY.md) to select and qualify
the actual host route. Preserve handled state per page (application) and
stable request references; a combined stream's observed cursor map is not a
record of handled work, and a cursor stays valid only for the materialized
revision that produced it. Serialize receiver dispatch to the configured thread,
not by waiting for its running turn to end: steer requests into the active Codex
turn, and use queue/resume while idle or unloaded. Re-arm after bounded waits
and recreate attachments after owner replacement. Verify a request from another
page is injected into the same active turn before it finishes, then verify idle
requests from both pages in that thread across turn ends.

Bind [ephemeral presence](AGENT_REQUESTS.md) to each actual worker's lifetime and
implemented topics. Several workers may share the agent signer, so browser
presence selects `consumerId` and request topic as well as peer identity. Stop
only the assistant worker and verify it becomes unavailable while the workspace
owner and an unrelated fetch worker remain connected. Requests stay retained
for later handling; connectivity never substitutes for receipt or answer.
