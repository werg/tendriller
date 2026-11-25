# Multi-page agents (design)

One maintenance agent maintains many pages. It has one account-level identity
and credential, runs one local program, and keeps one connection to the host
for all control traffic. A single page is a workspace with one page.

The workspace is the only model: one credential and one signing key per agent,
and page access by grant.

## Decisions

- **One signing key per agent**, shared by all of its pages. The public key is
  registered with the agent and enrolled in each page's application grants.
- **Page access:** pages an agent creates are granted to it automatically.
  Existing pages need an explicit owner grant (a checkbox per agent). Agents
  never get account-wide access implicitly.
- **One connection for control traffic only:** setup notices, discovery,
  invitations, WebRTC rendezvous and assistant adapter streams share the hub
  connection. Application sync data (WebRTC data channels, relay) keeps
  per-page connections.

## Host model

### D1 tables (`server/migrations/0002_agents.sql`)

```sql
agents(id TEXT PRIMARY KEY,            -- 'ag_' + 26 base32
       account_id TEXT,                 -- NULL until the owner signs in
       owner_email TEXT,                -- for unclaimed agents
       name TEXT NOT NULL,              -- unique per account
       token_hash TEXT NOT NULL UNIQUE, -- sha256 hex of 'ta_' token
       public_key TEXT NOT NULL,        -- base64url Ed25519 signing key
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
  `control:write`, `publication:write`, `assistant:manage`,
  `notifications:send`. (`agents:delegate` is removed: owners grant.)
- Revoking an agent sets `revoked_at`; deleting a grant removes the row. Both
  notify the affected page objects, which close that agent's sockets.

### Getting an agent credential

| Route | Who | Result |
|---|---|---|
| `POST /api/agents {owner, name, publicKey}` | a new agent, unauthenticated, creation rate limits | unclaimed agent + token. The owner claims it by signing in to any page it created. |
| `POST /api/agents/join {code, name, publicKey}` | an agent given a paste-ready blurb | agent under the inviting account + token |
| Dashboard → Your agents → Add agent | signed-in owner | one-time join code (10 min) and paste-ready blurb |
| MCP `register_agent {name, publicKey}` | an OAuth-linked assistant | agent under the account; calling again with the same name rotates the token |

### Agent API (service origin)

- `GET /api/agent` — the agent, its account state, and grant count.
- `GET /api/agent/pages?cursor=` — granted pages: id, name, page_url, scopes,
  application id, lifetime. Paged, 100 per page.
- `POST /api/agent/pages {name?}` — create a page. Unclaimed agents create pages
  owned by `owner_email` (claimed on owner sign-in, which also claims the
  agent). Claimed agents create pages already owned by the account. The
  creator receives a full grant.
- `/api/agent/pages/<id>/<rest>` — the page routes (metadata, release, links,
  activity, application, assistant/propose, push, setup/watch, peers/*). The router authenticates the token in D1, requires a
  grant for `<id>`, and forwards to the page object with internal headers
  `x-tendril-agent` (agent id) and `x-tendril-agent-scopes`.

The page object keeps a local mirror of its grants (`agent_grants` table:
agent id, public key, scopes, revision) written through internal routes when a
grant changes. `currentPrincipal` checks that mirror synchronously, so
revocation applies at commit time without a D1 round trip.

### Hub

One `AgentHub` Durable Object per agent (`idFromName(agentId)`).

- `GET /api/agent/hub` (WebSocket, subprotocols `tendriller.hub.v1` and the
  token). One connection per running agent program; a newer connection
  replaces the older one.
- JSON text frames. Streams are virtual WebSockets onto the page object's
  existing socket endpoints:

  | Direction | Frame |
  |---|---|
  | agent → hub | `{t:"open", s, page, path, protocols}` — `path` is one of `setup/watch`, `peers/discovery/watch`, `peers/invitations`, `peers/rendezvous`, `assistant/adapter` |
  | agent → hub | `{t:"data", s, text}` or `{t:"data", s, base64}` |
  | agent → hub | `{t:"close", s, code?, reason?}` |
  | hub → agent | `{t:"opened", s, protocol}` / `{t:"data", s, …}` / `{t:"closed", s, code, reason}` |
  | hub → agent | `{t:"event", page, kind, data}` — `grant`, `revoked`, `page-deleted`, `publication` |
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
  - `page(id)` — the former per-page client (`request`, `peers`, `info`,
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
    agent/                 # identity.sqlite (shared signer), credential.json
    pages/<page-id>/       # device.sqlite, descriptor, cursors, pairing records
```

- `tendril workspace init --service <origin> --owner <email>` creates the
  workspace, the shared signing key and an unclaimed agent credential;
  `workspace join --code <code>` joins an account with a dashboard code;
  `workspace key` then `workspace adopt --credential <file>` registers through
  an account-linked MCP `register_agent`.
- `tendril page new <slug>` creates a page and its source folder.
- `tendril page grant <slug> <page-id>` / `tendril page list` / `tendril status`.
- `tendril agent run` is the only long-running local program: one hub
  connection, one Chronolog session per granted page (each with its own device
  store and the shared signer), one local socket for attach clients that name
  a page, one combined request/event stream with a cursor per page, automatic
  reconnection.
- `tendril mcp-stdio` serves every page; each tool takes `page`.
- Every CLI command takes `--page <slug|id>` where it acts on one page.

## Chronolog

- `openNativeDevice({ path, create, managedSigner })` reuses one agent key.
- A store pool serves many native stores from one worker thread.
- `mergeSessionChanges(sessions)` combines change feeds with a cursor per
  application; the per-session exit listener is removed.
