# Outbound OAuth Connections & Org/Team Access

Tendriller supports two complementary OAuth extensions without ever storing plaintext third-party OAuth tokens or granting the host Chronolog membership/epoch keys:

1. **Outbound third-party OAuth connections** for pages and agents across a declarative OAuth 2.1 provider catalog (plus generic BYO OAuth 2.1 / OIDC).
2. **GitHub Organization/Team and Google Workspace domain tie-ins** for seamless team admission and seamless zero-trust offboarding.

## Part 1: Outbound OAuth Connections (Tier A & Tier B)

Tier selection is an **API/configuration choice**. When building or configuring an app that needs an external integration, agents should discuss the security vs. always-on trade-offs with the user in chat and then pass `tier: "agent-held"` or `tier: "host-brokered"` to the API or CLI:

| Dimension | Tier A: `agent-held` (Zero-Trust, free on all plans) | Tier B: `host-brokered` (Wrapped Proxy, Pro/Team/Self-Hosted) |
| --- | --- | --- |
| **Token storage** | Local `.tendriller/private/connections/` (0600); host performs at most ephemeral X25519 seal to agent `wrapKey` and wipes on `ack` | Host stores **only AES-256-GCM ciphertext** wrapped under a client-held 256-bit `K_conn`; unseals transiently in RAM on invoke, then wipes RAM |
| **Works when local agent is offline?** | No (for server-side sync) | Yes — mobile/browser pages and Hosted MCP can invoke approved actions 24/7 |
| **Custody options** | Bound to target agent's `wrapKey` | `personal` (only connecting user's devices hold `K_conn`) or `page` (Team plan: `K_conn` stored inside encrypted Chronolog state via `shared/helpers/connections.mjs`) |
| **CORS & confidential `client_secret`** | Handled by local agent (plus optional stateless `/api/agent/connections/refresh` broker) | Handled by SSRF-checked host proxy (`POST _tendril/connections/:id/invoke`); raw tokens never touch page JS |

### Supported Providers

Query `GET /api/oauth/providers` (or run `tendril connection providers`) for the live list and configured status:
- **Work & Dev:** `github`, `linear`, `notion`, `slack`, `figma`, `airtable`, `discord`
- **Productivity & Cloud:** `google` (Calendar, Gmail, Drive, Docs/Sheets, Tasks, Contacts, YouTube), `microsoft` (Outlook, OneDrive, To Do, Teams), `dropbox`, `todoist`
- **Personal, Health & Media:** `spotify`, `strava`, `fitbit`, `oura`
- **Generic BYO OAuth 2.1 / OIDC:** Register any custom HTTPS provider (`POST /api/account/oauth/providers` with `slug`, `authorize_url`, `token_url`, `client_id`, `allowed_hosts`) and connect as `custom:<slug>`.

Operators configure built-in outbound client credentials via the Worker secret `OUTBOUND_OAUTH_CLIENTS_JSON` (a JSON map `{ "<provider>": { "client_id": "...", "client_secret": "..." } }`); `github` and `google` automatically fall back to `GITHUB_CLIENT_ID`/`GOOGLE_CLIENT_ID`. Optional `OAUTH_CONFIG_KEY` (falling back to `HOST_ATTESTATION_KEY`) envelope-encrypts BYO provider `client_secret`s and inbound HMAC webhook secrets at rest in D1.

### Tier A (Zero-Trust Agent-Held) Workflow

```bash
# 1. Start an agent-held connection (share authorize_url with the user in chat)
tendril connection connect github --tier agent-held --scopes "read:user,repo"

# 2. If `tendril agent run` is active, it automatically pulls, unseals (0600), and wipes the host handoff
#    via the hub's `outbound-connection-ready` event; otherwise pull manually:
tendril connection pull

# 3. Revoke anytime (or from /connections in your browser)
tendril connection revoke <connection-id>
```

### Tier B (Wrapped Host-Brokered) Workflow

```js
import {
  consumeConnectionCallbackFragment,
  createPageConnectionsClient,
  listenForConnectionPopup,
} from '@tendriller/core/connections';
import { pageConnectionCommands, pageConnectionQueries, rekeyAllPageConnections } from '../../shared/helpers/connections.mjs';

const conns = createPageConnectionsClient(window.tendril);

// Zero-copy-paste browser handoff: receive K_conn from the OAuth callback via URL fragment or popup postMessage
const fromRedirect = consumeConnectionCallbackFragment();
const stopPopup = listenForConnectionPopup(serviceOrigin, ({ connection, connection_key }) => {
  // Store K_conn locally (personal custody) or in encrypted Chronolog via setPageConnectionKey (page custody)
});

// Invoke an allowlisted provider action (K_conn is sent only in TLS X-Connection-Key header; redirects are never followed)
const result = await conns.invoke(connectionId, kConn, {
  action: 'google.calendar.events:list',
  params: { calendar_id: 'primary' },
  query: { maxResults: '10', singleEvents: 'true' },
});

// For `custody: "page"` team connections, pass `onEpochRotated` to `admitBrowserSession` / `openNativePage`
// / `createAdmission` to call `rekeyAllPageConnections` / `rekeyPageConnectionsForAgent` automatically
// whenever a member is removed or offboarded from an org.
```

### Account Dashboard & Inbound Webhooks (Zero Token Decryption)

Visit `/connections` on the service origin to review or revoke external OAuth connections, inspect registered BYO providers, and view or refresh verified organizations & teams (**Sync GitHub Orgs & Teams**).

Configure a webhook secret on any connection (`POST /api/account/connections/:id/webhook`). Incoming deliveries to `POST /api/webhooks/connections/:id` verify HMAC-SHA256 (`X-Hub-Signature-256`, `Linear-Signature`, or `X-Tendriller-Signature-256`) without touching OAuth tokens and forward signed wake events to the agent hub.

---

## Part 2: GitHub & Google Org/Team Access and Seamless Offboarding

Team-tier and self-hosted pages can admit collaborators by verified **GitHub Organization**, **GitHub Team**, or **Google Workspace domain** without minting per-email invites:

- **Google Workspace:** Verified `hd` domain claim (`google-domain:acme.com`) is recorded automatically on Google sign-in whenever `email_verified === true` (consumer `gmail.com` is excluded).
- **GitHub Organizations & Teams:** Incremental `read:org` scope is requested only when needed (`/auth/github?org_sync=1`), syncing `github-org:<org>` and `github-team:<org>/<slug>` with a 30-minute TTL.

### Admin-Signed Group Policy

Group rules are signed by a page administrator (`tendriller-group-policy-v1`) and verified against the page's current Chronolog `AuthorityBundle` — the host can never forge or widen rules:

```bash
tendril page group my-app --add github-team:acme/eng --role writer
tendril page group my-app --add google-domain:acme.com --role reader
tendril page group my-app          # list rules and pending departures
tendril page group my-app --remove r_github_team_acme_eng
```

When a verified member opens the page's normal URL, the host grants guest access automatically and issues a companion host-signed `tendriller-group-attestation-v1` alongside the device's `@chronolog/authority` attestation. Any online administrator browser or `tendril agent run` verifies both signatures against the pinned genesis host key and signed group policy, then admits the device and wraps the epoch keys automatically.

### Seamless Zero-Trust Offboarding

When a user leaves a GitHub org/team (detected via `POST /api/webhooks/github-org` with `GITHUB_ORG_WEBHOOK_SECRET` or org re-sync) or Google Workspace domain:
1. **Immediate host gate:** The host revokes org-derived `page_sessions`, blocks new peer introductions/relays, and closes active WebSockets (`4001 Organization membership ended`).
2. **Automatic cryptographic key rotation:** The host signs a `tendriller-org-departure-v1` attestation using its pinned genesis attestation key. The first online administrator (owner browser or `tendril agent run`) verifies the host signature, confirms the member was admitted strictly via that org rule (guardrail: never touches the page owner or individually invited members), automatically removes the device from Chronolog membership, rotates the epoch key to all remaining members, and clears the departure.
