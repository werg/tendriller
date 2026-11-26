# Outbound OAuth Connections & Org/Team Access (Agent Guide)

Tendriller lets pages and agents integrate with external services (GitHub, Google, Linear, Notion, Slack, Spotify, Strava, and any custom OAuth 2.1 provider) **without ever storing plaintext third-party OAuth tokens on the host** and **without granting the host Chronolog membership or epoch keys**. It also supports seamless **GitHub Organization/Team** and **Google Workspace domain** admission and automatic zero-trust offboarding.

---

## 1. Choosing Tier A vs. Tier B (Agent Chat Playbook)

**Do NOT build a UI tier-picker modal inside your app.** Tier selection is an **API/CLI configuration choice** that you agree on with the user **in chat** while designing or configuring the app.

Before writing integration code:
1. **Check live provider availability on the selected host** (`GET /api/oauth/providers` or `tendril connection providers --server <SERVICE_ORIGIN>`). Each built-in provider reports `configured: true | false`, `default_scopes`, `allowed_api_hosts`, and its typed `actions`.
2. **Discuss the security vs. always-on trade-off with the user in chat:**

| Dimension | Tier A: `agent-held` (Zero-Trust, free on all plans) | Tier B: `host-brokered` (Wrapped Proxy, Pro/Team/Self-Hosted) |
| --- | --- | --- |
| **Plaintext tokens on host?** | Never — host ephemerally X25519-seals to your agent's `wrapKey` and wipes on `ack` | Never at rest — host stores **AES-256-GCM ciphertext** wrapped under a client-held 256-bit `K_conn`; unseals strictly in RAM on invoke, then discards |
| **Works when local agent is offline?** | No (local agent must run to call third-party APIs and write into Chronolog) | Yes — mobile/browser pages and Hosted MCP can invoke allowlisted actions 24/7 |
| **Custody options** | Bound to the target agent's `wrapKey` (`.tendriller/private/connections/<id>.json`, `0600`) | `personal` (Pro+: only connecting user's devices hold `K_conn`) or `page` (Team+: `K_conn` stored encrypted inside Chronolog via `shared/helpers/connections.mjs` so admitted teammates share it) |
| **CORS & confidential `client_secret`** | Handled by local agent (plus optional stateless `POST /api/agent/connections/refresh` broker) | Handled by SSRF-hardened host proxy (`POST _tendril/connections/:id/invoke`, `redirect: "manual"`); raw OAuth tokens never enter page JS |
| **Best fit** | Developer tools, personal automations with an active `tendril agent run`, maximum zero-trust | Mobile/web apps that must sync/query while laptop is closed, multi-member team dashboards |

3. **If the user's requested provider has `configured: false` on this host:**
   - Tell them cleanly that the host operator has not configured a shared OAuth app for that provider yet.
   - Offer the **BYO OAuth 2.1 (`custom:<slug>`)** route: they can register their own OAuth app in the provider's developer portal with redirect URI `<SERVICE_ORIGIN>/auth/outbound/callback/custom%3A<slug>` and register it via `/connections` (under **Register custom OAuth 2.1 provider**) or `POST /api/account/oauth/providers`.
4. **If a Tier B call returns HTTP `402` (`plan_upgrade_required`):**
   - Explain clearly that Tier B `personal` requires **Pro** (`hostBrokeredOAuth`), Tier B `page` custody and org/team admission require **Team** (`teamOrgOAuth`), and **Tier A (`agent-held`) is free on every plan** (and all tiers are unlimited on self-hosted instances). Share `/pricing` or `/dashboard/billing` or offer to switch to Tier A if the user prefers.

---

## 2. Built-in Provider Catalog & Typed Actions

Query `GET /api/oauth/providers` for the live catalog. Every built-in provider supports both `agent-held` and `host-brokered`, plus `http:request` pinned strictly to `allowed_api_hosts` (HTTPS only, private/loopback/IP-literal hosts rejected, HTTP 3xx redirects never followed).

| Provider ID | Category | Built-in Action IDs | Allowed API Hosts |
| --- | --- | --- | --- |
| `github` | Work & Dev | `github.repos:list`, `github.issues:list`, `github.issues:create`, `github.pulls:list`, `github.gists:list`, `github.actions:runs` | `api.github.com` |
| `linear` | Work & Dev | `linear.graphql:query` | `api.linear.app` |
| `notion` | Work & Dev | `notion.search`, `notion.pages:get`, `notion.databases:query` | `api.notion.com` |
| `slack` | Work & Dev | `slack.channels:list`, `slack.messages:history`, `slack.messages:post` | `slack.com` |
| `figma` | Work & Dev | `figma.files:get`, `figma.comments:list` | `api.figma.com` |
| `airtable` | Work & Dev | `airtable.bases:list`, `airtable.records:list`, `airtable.records:create` | `api.airtable.com` |
| `discord` | Work & Dev | `discord.guilds:list`, `discord.messages:post` | `discord.com` |
| `google` | Productivity | `google.calendar.events:list`, `google.calendar.events:create`, `google.tasks:list`, `google.tasks:create`, `google.gmail.messages:list`, `google.drive.files:list`, `google.sheets.values:get` | `www.googleapis.com`, `gmail.googleapis.com`, `tasks.googleapis.com`, `docs.googleapis.com`, `sheets.googleapis.com`, `people.googleapis.com`, `youtube.googleapis.com` |
| `microsoft` | Productivity | `microsoft.calendar.events:list`, `microsoft.mail.messages:list`, `microsoft.onedrive.items:list`, `microsoft.todo.lists:list` | `graph.microsoft.com` |
| `dropbox` | Productivity | `dropbox.files:list` | `api.dropboxapi.com`, `content.dropboxapi.com` |
| `todoist` | Productivity | `todoist.tasks:list`, `todoist.tasks:create`, `todoist.projects:list` | `api.todoist.com` |
| `spotify` | Personal & Media | `spotify.playback:read`, `spotify.playlists:list` | `api.spotify.com` |
| `strava` | Personal & Media | `strava.activities:list` | `www.strava.com` |
| `fitbit` | Personal & Media | `fitbit.activity:read`, `fitbit.sleep:read` | `api.fitbit.com` |
| `oura` | Personal & Media | `oura.readiness:read`, `oura.sleep:read` | `api.ouraring.com` |
| `custom:<slug>` | BYO OAuth 2.1 | `http:request` (pinned to registered `allowed_hosts`) | User-configured HTTPS hosts |

> **Incremental scopes & single-callback reuse:** Google connections always send `include_granted_scopes=true`, so pass only the exact minimal scopes each app needs (e.g. `calendar.readonly` or `tasks.readonly`) rather than asking for Gmail/Drive upfront — Google adds scopes bit by bit only when the user approves an integration that needs them. When a host does not set separate `OUTBOUND_OAUTH_CLIENTS_JSON` overrides for `github` or `google`, outbound connections automatically reuse the existing sign-in OAuth app and `/auth/callback/{github,google}` URL.

---

## 3. End-to-End Integration Recipes

### Recipe 1: Zero-Trust Local Agent Sync (Tier A `agent-held`)

Best when `tendril agent run` runs locally (or on your own server) and syncs external data into Chronolog. Plaintext tokens never persist on the Tendriller host.

```bash
# 1. Start the connection from the workspace and share `authorize_url` with the user in chat
tendril connection connect github --tier agent-held --scopes "read:user,repo" --page my-board

# 2. When the user approves in their browser:
#    - If `tendril agent run` is running, the host pushes `outbound-connection-ready` over AGENT_HUB,
#      and the agent automatically unseals into `.tendriller/private/connections/<id>.json` (0600)
#      and calls `/ack` to wipe the sealed envelope on the host.
#    - Otherwise, pull manually:
tendril connection pull

# 3. Inspect or revoke connections anytime
tendril connection list
tendril connection revoke <connection-id>
```

**Refreshing an expired Tier A token for confidential-client providers** (when `client_secret` lives on the host):
```js
import { unsealAgentTokens } from '@tendriller/core/connections';

// Host attaches confidential client_secret, exchanges with provider, re-seals to your wrapKey, stores NOTHING
const res = await fetch(`${serviceOrigin}/api/agent/connections/refresh`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${agentToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ provider: 'google', refresh_token: saved.tokens.refresh_token, connection_id: saved.id }),
});
const { sealed_tokens } = await res.json();
const fresh = await unsealAgentTokens(wrapKey.privateKey, wrapKey.publicKey, sealed_tokens, `${saved.id}:${agentId}:google`);
```

---

### Recipe 2: Personal Always-On Browser App (Tier B `host-brokered`, `custody: "personal"`)

Best for personal apps (Google Calendar, Spotify, Strava, Todoist) that must work on mobile even when your laptop/agent is offline. The connecting user's device holds `K_conn` locally (e.g., in IndexedDB); the host stores only AES-256-GCM ciphertext.

```js
import {
  consumeConnectionCallbackFragment,
  createPageConnectionsClient,
  listenForConnectionPopup,
} from '@tendriller/core/connections';

const conns = createPageConnectionsClient(window.tendril);

// 1. Handle zero-copy-paste K_conn handoff after OAuth approval (either redirect fragment or popup postMessage)
function savePersonalKey(connectionId, kConn) {
  // Store in device-local IndexedDB/storage; never commit K_conn into public HTML or server logs
  localStorage.setItem(`tendril:kconn:${connectionId}`, kConn);
}

const redirected = consumeConnectionCallbackFragment();
if (redirected?.connection_key) {
  savePersonalKey(redirected.connection.id, redirected.connection_key);
}
const stopPopup = listenForConnectionPopup(serviceOrigin, ({ connection, connection_key }) => {
  if (connection_key) savePersonalKey(connection.id, connection_key);
});

// 2. Start OAuth flow (user clicks a Connect button in your app or opens authorize_url shared in chat)
//    Pass `return_to: window.location.href` so the callback returns to your page with `#tendril-connection=...`
//    (URL fragments are never sent to the host).
//    POST <SERVICE_ORIGIN>/api/account/connections (credentials: 'include') or `tendril connection connect --tier host-brokered --custody personal --page <slug>`

// 3. Invoke an allowlisted action (host unwraps in RAM, auto-refreshes if expired, proxies with redirect:'manual')
const result = await conns.invoke(connectionId, localStorage.getItem(`tendril:kconn:${connectionId}`), {
  action: 'google.calendar.events:list',
  params: { calendar_id: 'primary' },
  query: { maxResults: '10', singleEvents: 'true', timeMin: new Date().toISOString() },
});
```

---

### Recipe 3: Shared Team App with Org Access & Auto-Offboarding (Tier B `page` Custody + Org Groups)

Best for team workspaces where every admitted teammate shares a single Linear/GitHub/Notion/Slack integration and teammates are admitted/offboarded automatically via GitHub Org/Team or Google Workspace domain.

1. **Include `pageConnectionCommands` & `pageConnectionQueries` in your Chronolog application definition** (`docs/tutorial/shared/helpers/connections.mjs`):
```js
import { defineApplication } from '@chronolog/peer-session';
import { pageConnectionCommands, pageConnectionQueries } from '../../shared/helpers/connections.mjs';

export const definition = defineApplication({
  id: 'team-sprint-board',
  version: '1',
  commands: { ...yourCommands, ...pageConnectionCommands },
  queries: { ...yourQueries, ...pageConnectionQueries },
});
```

2. **Wire automatic `K_conn` re-keying on epoch rotation** in both browser and native agent bootstrap so whenever any member is removed OR automatically offboarded from an org, `K_conn` rotates atomically on the host and inside the new Chronolog epoch:
```js
// Browser Worker (`worker.mjs`):
import { admitBrowserSession } from '../../shared/helpers/browser-bootstrap.mjs';
import { rekeyAllPageConnections } from '../../shared/helpers/connections.mjs';

const admission = admitBrowserSession(session, {
  peers,
  wrapKey,
  onEpochRotated: ({ epoch }) => rekeyAllPageConnections({ session, runtime: { identity: { base: pageBase } }, epoch }),
});

// Native Agent (`agent.mjs`):
import { openNativePage } from '../../shared/native-page.mjs';
import { rekeyPageConnectionsForAgent } from '../../shared/helpers/connections.mjs';

export function openPage(context) {
  return openNativePage(context, {
    definition,
    onEpochRotated: ({ epoch }) => rekeyPageConnectionsForAgent({
      session: context.session,
      serviceOrigin: context.credential.service,
      agentToken: context.credential.token,
      epoch,
    }),
  });
}
```

3. **Store `K_conn` in encrypted Chronolog state** once the owner completes the `custody: "page"` OAuth flow:
```js
await session.command('setPageConnectionKey', {
  connectionId: handoff.connection.id,
  provider: handoff.connection.provider,
  connectionKey: handoff.connection_key,
  epoch: admission.state.epoch,
});
```
Any admitted page member (including org-admitted guests) reads `K_conn` via `session.query('pageConnectionKeys', null)` and calls `conns.invoke(connectionId, kConn, ...)`.

4. **Configure admin-signed GitHub/Google org admission rules** (Team plan or self-hosted):
```bash
tendril page group my-board --add github-team:acme/eng --role writer
tendril page group my-board --add google-domain:acme.com --role reader
tendril page group my-board            # inspect active rules & pending departures
tendril page group my-board --remove r_github_team_acme_eng
```

---

### Recipe 4: Hosted MCP Assistant Access (Zero Browser UI & Zero Local Agent)

When a user links ChatGPT or Claude Desktop via Hosted `/mcp`, the assistant can connect and query external services 24/7 even when the user has no browser open and no `tendril agent run` running — while still storing **zero plaintext OAuth tokens and zero plaintext `K_conn` keys** at rest in D1:

1. Call `list_external_connections` to inspect configured providers, actions, and existing connections (`mcp_callable: true`).
2. Call `connect_external_provider({ provider: "google", scopes: ["https://www.googleapis.com/auth/calendar.readonly"] })` and share `authorize_url` with the user in chat.
3. When the user approves, the host wraps the OAuth tokens under a fresh `K_conn` **and** X25519-seals `K_conn` to the MCP OAuth grant's `wrap_public_key`.
4. Call `invoke_external_connection({ connection_id, action: "google.calendar.events:list", params: { calendar_id: "primary" } })`. On each call, the live MCP OAuth Bearer token unseals `wrap_private_key` → unseals `K_conn` → unwraps the OAuth token strictly in RAM (auto-refreshing if expired) → calls the allowlisted upstream endpoint with `redirect: "manual"` → discards RAM.

*(Workspace agents initiating Tier B via `tendril connection connect <provider> --tier host-brokered` get the same zero-copy-paste auto-handoff: `K_conn` X25519-seals to the agent's `wrapKey`, and `tendril agent run` / `tendril connection pull` saves `connection_key` to `.tendriller/private/connections/<id>.json` (`0600`) and wipes the host handoff on `/ack`.)*

---

### Recipe 5: Inbound Webhooks (Zero OAuth Token Decryption)

Configure a webhook secret on any connection without exposing or decrypting OAuth tokens:
```http
POST /api/account/connections/<connection-id>/webhook
Content-Type: application/json
{ "mode": "hmac" }
```
Point the third-party provider's webhook URL at the returned `webhook_url` (`/api/webhooks/connections/<connection-id>`). The host verifies HMAC-SHA256 (`X-Hub-Signature-256`, `Linear-Signature`, or `X-Tendriller-Signature-256`) against the envelope-encrypted webhook secret and delivers an `outbound-webhook` event over `AGENT_HUB` to wake your agent.

---

## 4. Org/Team Access & Seamless Zero-Trust Offboarding

- **Google Workspace (`google-domain:<domain>`):** Recorded automatically on Google sign-in from the verified `hd` claim whenever `email_verified === true` (consumer `gmail.com` / `googlemail.com` are rejected).
- **GitHub Organizations & Teams (`github-org:<org>`, `github-team:<org>/<slug>`):** Incremental `read:org` scope is requested only when needed (`/auth/github?org_sync=1`, also linked as **Sync GitHub Orgs & Teams** on `/connections`). Sync follows paginated `/user/orgs` & `/user/teams` (up to 5 pages) with a 30-minute cache TTL.
- **Admin-signed group policy (`tendriller-group-policy-v1`):** Signed by a current page administrator and verified against the page's Chronolog `AuthorityBundle` — the host can never forge or widen rules.
- **Seamless admission:** When a verified group member opens the page's normal URL, the host automatically opens a guest session and issues a companion host-signed `tendriller-group-attestation-v1` alongside their device attestation. The first online administrator browser or `tendril agent run` verifies both signatures against the pinned genesis host key and signed group policy, admits the device, and wraps epoch keys automatically.
- **Seamless zero-trust offboarding:** When a user leaves a GitHub org/team (via `POST /api/webhooks/github-org` or re-sync) or Google Workspace domain:
  1. **Immediate host gate:** Revokes org-derived `page_sessions`, blocks relays/introductions, and closes live WebSockets (`4001 Organization membership ended`).
  2. **Automatic cryptographic revocation & key rotation:** Signs `tendriller-org-departure-v1` with the pinned host key. The first online administrator browser or `tendril agent run` verifies the signature, enforces guardrails (never touches the page owner or individually invited guests), removes the device from Chronolog membership, rotates the epoch key to all remaining members, triggers `onEpochRotated` (rotating `page`-custody `K_conn`), and acknowledges the departure.

---

## 5. Account Dashboard & Troubleshooting for Agents

- **User dashboard (`/connections`):** Shows active hosted MCP pages, all external OAuth connections (with one-click **Revoke**), live built-in provider status, an inline **Register custom OAuth 2.1 provider (BYO)** form, and verified organization/team memberships with **Sync GitHub Orgs & Teams**.
- **Common failure modes & exact next actions:**
  - `provider_unconfigured` (503): The host hasn't configured a built-in OAuth app for that provider. Guide the user to register a BYO `custom:<slug>` provider on `/connections` (or `POST /api/account/oauth/providers`).
  - `plan_upgrade_required` (402): Tier B `personal` needs Pro; Tier B `page` custody and org/team group rules need Team. Offer free **Tier A (`agent-held`)**, `/pricing`, or self-hosting.
  - `connection_key_invalid` (403): `K_conn` was rotated (`rekey`) or doesn't match this connection. Re-read `pageConnectionKeys` from Chronolog (for `page` custody) or re-connect (for `personal` custody).
  - **GitHub org missing from `/api/account/groups`:** Many GitHub organizations enable **Third-party OAuth App access restrictions** — ask the org admin to approve the Tendriller OAuth app (or install the Tendriller GitHub App) and re-click **Sync GitHub Orgs & Teams** on `/connections`.
  - **3xx responses from `invoke`:** By design, the Tier B proxy uses `redirect: "manual"` to prevent cross-host SSRF. Inspect `result.headers.location` rather than expecting transparent redirects.
  - **Self-hosted / operator setup:** See [Self-hosting](SELF_HOSTING.md#outbound-oauth--orgteam-tie-ins-optional) and [Host operations](OPERATIONS.md) for `OUTBOUND_OAUTH_CLIENTS_JSON`, `OAUTH_CONFIG_KEY`, `GITHUB_ORG_WEBHOOK_SECRET`, and `scripts/setup-oauth.mjs`.
