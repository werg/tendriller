# Connect Tendriller to Google Antigravity

Google Antigravity runs across four surfaces — **Antigravity CLI (`agy`)**, **Antigravity App (2.0)**, **Antigravity IDE / IDE Extensions (ACP)**, and the **Antigravity Python SDK**. This guide documents what each surface supports for Tendriller, how to install the **native Antigravity plugin**, how to connect both **local Chronolog v2 workspaces** and **account-linked `/mcp`** (including the Antigravity App side-panel MCP App), how to wake conversations reliably with `consumers/antigravity-bridge.mjs`, and the real platform boundaries that remain.

Start from the exact service origin requested by the user (e.g. `https://tendriller.dev` or staging). For building an app from scratch, follow [Build an app](BUILD_AN_APP.md) and [State models](STATE_MODELS.md); for multi-page conversation wake qualification, read [Same-conversation delivery](CONVERSATION_DELIVERY.md).

## Capability matrix by Antigravity surface

| Capability | Antigravity CLI (`agy`) | Antigravity App (2.0) | Antigravity IDE / ACP | Antigravity Python SDK |
| --- | --- | --- | --- | --- |
| Workspace `AGENTS.md`, `.agents/skills/`, `.agents/rules/` | Auto-discovered | Auto-discovered | Auto-discovered | Auto-discovered |
| Native Tendriller plugin (`plugin/antigravity/`, strict-validated, zero findings) | `agy plugin install tendriller@antigravity-plugins-partners` | 1-click Marketplace install (immediately enabled) | Auto-discovered in `.agents/plugins/` | Discovers `.agents/mcp_config.json` |
| Node 22.15+ shell & `tendril agent run` | Yes (check sandbox via `--doctor`) | Yes (check sandbox via `--doctor`) | Yes (check sandbox via `--doctor`) | Yes (with `CapabilitiesConfig()`) |
| Streamable HTTP MCP (`/mcp`) + OAuth PKCE / CIMD | Yes (`agy mcp add` or plugin `mcp_config.json`) | Yes (Customizations → MCP Servers) | Yes (`v2.6.0+` for CIMD) | Yes (`.agents/mcp_config.json`) |
| Interactive MCP Apps (`open_tendriller_inbox` → `ui://tendriller/inbox.html`) | Plain-text fallback | Yes (`v2.34.0+`: `aux_pane` side panel + `global` full page) | Plain-text fallback | Plain-text fallback |
| Same-conversation continuous bridge (`--mode agentapi`) | Yes while `agy` session stays open; auto-releases lock on LS exit | Yes — and survives restarts via supervised Sidecar | Session-scoped when `agentapi` is exposed | Programmatic via `agent.chat()` |
| Unattended headless streaming (`--mode headless-stream`) | Yes (`agy --input-format stream-json`, live `streamAgentReply`, soft-deny detection) | N/A | N/A | Native async `Agent` |
| Reactive one-shot wake (`--mode wait`, `IsDaemon: false`) | Yes (re-arm after each delivery) | Yes (re-arm after each delivery) | Yes (re-arm after each delivery) | Not needed (caller owns loop) |
| Lifecycle hooks (`SessionStart` + `Stop` in plugin `hooks.json`) | Alerts on resumed LS mismatch & catches turn-end pending work | Alerts on resumed LS mismatch & catches turn-end pending work | Supported when hooks are enabled | SDK lifecycle hooks |

## 1. Zero-setup start for end users

End users do **not** need to edit config files, create OAuth apps, or configure sidecars to use Tendriller with Antigravity:

1. **Prompt-only (works today with zero install):** Tell Antigravity what to build, mention `https://tendriller.dev` (or your service origin), and give your sign-in email. Antigravity reads `BUILD_AN_APP.md`, installs the Chronolog v2 starter (`npm ci --ignore-scripts`), publishes the signed browser UI, starts `npm run agent`, and — when live page wake is requested — starts `node consumers/antigravity-bridge.mjs --workspace /abs/workspace --pages <slug>` automatically using `$ANTIGRAVITY_CONVERSATION_ID`.
2. **One-click MCP & Side-Panel Inbox (after operator CIMD/Marketplace setup):** Install the **Tendriller** plugin from the Antigravity Marketplace (or run `agy mcp add tendriller https://tendriller.dev/mcp`) and click **Authenticate**. On Antigravity App (`v2.34.0+`), `open_tendriller_inbox` immediately docks the interactive **Tendriller Inbox** in the side panel (`aux_pane`) and left sidebar (`global`) with zero extra setup.

## 2. One-time operator setup (enables zero-setup for all Antigravity users)

As the Tendriller host operator, two one-time steps eliminate manual setup for every Antigravity user:

1. **Allowlist Google Antigravity's OAuth CIMD client once in `OAUTH_CONFIG_JSON`:** Add `https://antigravity.google/oauth/client-metadata.json` (`redirectUris: ["https://antigravity.google/oauth-callback"]`, `metadataDocument: true`, `tokenEndpointAuthMethod: "none"`) as documented in [Integration OAuth](INTEGRATION_OAUTH.md#configuration-schema-oauth_config_json). Every Antigravity CLI, App, and IDE (`v2.6.0+`) user then gets automatic PKCE OAuth with zero client IDs or secrets.
2. **Publish `plugin/antigravity/` to the Antigravity Partner Marketplace:** The bundled plugin passes `agy plugin validate ./plugin/antigravity --strict` with zero warnings and zero sidecar permission blockers, bundling `/mcp` (with eager core tools), `SessionStart` + `Stop` lifecycle hooks, and the `/tendriller` skill. Submit it once through the [Antigravity Marketplace partner intake form](https://forms.gle/2EX5RFYPoJe1UgxR9) so users get 1-click install via `antigravity://customizations/marketplaces/antigravity-plugins-partners/plugins/tendriller` and `agy plugin install tendriller@antigravity-plugins-partners` (with automatic App ↔ CLI sync).

## 3. Agent & troubleshooting reference (local workspace & sandbox)

Follow the standard Chronolog v2 zero-native-build flow (Node 22.15+, `npm ci --ignore-scripts`):

```sh
npx tendril workspace init --service https://tendriller.dev --owner you@example.com --handle atlas
npm run page:new -- tracker --template inventory --name "Team Tracker"
npm run init -- tracker
npm run deploy -- tracker
npm run agent
```

### Diagnose sandbox & connectivity (`--doctor`)

Antigravity CLI (`auto` / `proceed-in-sandbox`) and Antigravity App (**Default** / **Auto** presets) isolate shell commands inside OS-level sandboxes with **no outbound network access by default**. Run the built-in read-only doctor inside your workspace:

```sh
node consumers/antigravity-bridge.mjs --doctor --workspace /absolute/workspace
```

`--doctor` checks `tendriller.json`, `.tendriller/agent/attach.json`, `agentapi`, `agy --version`, conversation `workspaceUris` binding, `ConversationService/GetConversation` live `runState`, and outbound `/api/readiness` reachability. When the terminal sandbox blocks outbound network access, `--doctor` prints the exact scoped snippet to add to `~/.gemini/antigravity-cli/settings.json` (or Project Settings):

```json
{
  "permissions": {
    "allow": [
      "command(npx tendril)",
      "command(node consumers/antigravity-bridge.mjs)",
      "read_url(tendriller.dev)"
    ]
  }
}
```

## 3. Account-linked hosted MCP & Antigravity App MCP App

Antigravity natively speaks Streamable HTTP MCP (`/mcp`) and OAuth 2.1 with PKCE `S256` and **Client ID Metadata Documents (CIMD)** (`https://antigravity.google/oauth/client-metadata.json`, redirect `https://antigravity.google/oauth-callback`).

- **CLI one-liner (without the full plugin):** `agy mcp add tendriller https://tendriller.dev/mcp`
- **Antigravity App side panel & full-page Inbox (`open_tendriller_inbox`):**
  Tendriller's `/mcp` server exposes `open_tendriller_inbox` bound to the self-contained MCP App resource `ui://tendriller/inbox.html` (`text/html;profile=mcp-app`, zero external `connectDomains`) with Antigravity entrypoints `{ type: "aux_pane", title: "Tendriller Inbox" }` and `{ type: "global", title: "Tendriller" }`. In Antigravity App (`v2.34.0+`), you can keep connected Tendriller pages and their `agent_feed` docked beside chat and click **Handle in this chat** (`ui/message`) or **New conversation** (`com.google.antigravity/message: { target: "new" }`). On Antigravity CLI and IDE, calling `open_tendriller_inbox` returns the exact same connected-page and feed summary as plain text + `structuredContent`.
- **Host operator requirement:** Tendriller intentionally uses an explicit OAuth client allowlist in `OAUTH_CONFIG_JSON`. Register Google Antigravity's CIMD entry as documented in [Integration OAuth](INTEGRATION_OAUTH.md#configuration-schema-oauth_config_json).

## 4. Waking an Antigravity conversation from Tendriller pages

A connected `tendril agent run` process or `tendril watch --events` stream does not wake an Antigravity conversation on its own. Run `consumers/antigravity-bridge.mjs` in the mode matching your surface:

### Route A: Continuous same-conversation bridge (`--mode agentapi` — recommended)

```sh
node consumers/antigravity-bridge.mjs \
  --workspace /absolute/workspace \
  --conversation-cwd /absolute/antigravity-project-root \
  --pages tracker,notes \
  --conversation "$ANTIGRAVITY_CONVERSATION_ID" \
  --topics chat,agents \
  --coalesce-ms 250 \
  --mode agentapi
```

Key protections built into `--mode agentapi`:

1. **Preflight & workspace URI binding:** Verifies `agentapi get-conversation-metadata` returns `workspaceUris` matching `--conversation-cwd` before reporting `conversation_route_ready`.
2. **Respects `RUN_STATE_CANCELLING`:** Checks `ConversationService/GetConversation` before sending; if the user just interrupted the turn, defers delivery until the conversation returns to `RUN_STATE_IDLE` or `RUN_STATE_RUNNING` (`deferred_cancelling`).
3. **Optional burst coalescing (`--coalesce-ms`):** Batches rapid multi-message bursts into one clean wake notice carrying authenticated message references (never raw untrusted user text as instructions).
4. **Graceful CLI LS exit (`--ls-loss-threshold`, default `3`):** When `agy` exits and `$ANTIGRAVITY_LS_ADDRESS` stops responding for 3 consecutive probes, the bridge immediately drops Live presence, writes `state: "ls_gone"` to `bridge-status.json`, releases its checkpoint `.lock`, and exits with `ANTIGRAVITY_LS_GONE` so a resumed CLI session can re-attach with zero lock conflict.
5. **Durable outbox & broadcast wake:** Persists `invoking` before calling `agentapi send-message`, stops as `uncertain` (`ANTIGRAVITY_DELIVERY_UNCERTAIN`) on unconfirmed outcomes (never blindly retries), and delivers Ed25519-verified platform broadcasts without auto-acknowledging (`broadcastAcknowledged: false`).

### Route B: Persistent Antigravity App Sidecar (`sidecar.json` — optional power-user route)

On **Antigravity App (2.0)**, users who want restart-surviving same-conversation delivery can optionally define a local sidecar at `~/.gemini/config/sidecars/tendriller-bridge/sidecar.json` (`restart_policy: "always"`) pointing at `consumers/antigravity-bridge.mjs --mode agentapi` and enable it in the Automations / Sidecars dashboard with their `projectId`. *(The Marketplace plugin intentionally omits a bundled sidecar so installing it requires zero permission-review friction.)*

### Route C: Unattended headless streaming (`--mode headless-stream`)

For dedicated Linux/macOS servers or CI where no interactive `agy` UI is kept open:

```sh
node consumers/antigravity-bridge.mjs \
  --workspace /absolute/workspace \
  --pages tracker,notes \
  --topics chat \
  --execution-mode auto \
  --mode headless-stream
```

- Holds one warm `agy --input-format stream-json --output-format stream-json` process (eliminating per-turn cold-start latency).
- Pipes live `step_update.text_delta` chunks directly into Tendriller's `streamAgentReply` so users see real-time typing previews on the web page.
- Watches `stderr` and `tool_info.error` for Antigravity headless **soft-denied tool notices** (`headless_soft_deny_detected`) instead of trusting exit code `0`, and checks `agentFeed` afterward (`durableReplyVerified`).
- **Safety guard:** Refuses (`ANTIGRAVITY_HEADLESS_CONCURRENT_CONVERSATION`) to attach to the currently open `$ANTIGRAVITY_CONVERSATION_ID` so headless turns never race an interactive TUI.

### Route D: Reactive one-shot waiter (`--mode wait`) and isolated threads (`--mode new-conversation`)

- **`--mode wait --timeout 0`**: Universal fallback when `agentapi` is unavailable — run as a non-daemon background task (`IsDaemon: false`), exits `0` with one `antigravity_wake_notice` JSON object when an unanswered request or broadcast arrives, and must be re-armed after each batch.
- **`--mode new-conversation`**: Dispatches each unhandled request into a fresh isolated Antigravity conversation via `agentapi new-conversation` (`--model`, `--profile`).

## 5. Remaining Antigravity platform boundaries

These boundaries belong to Google Antigravity itself (verified on Antigravity CLI `1.5.18`, 2026-11-27) and are mitigated rather than removed:

| Platform boundary | Real behavior | Built-in Tendriller mitigation |
| --- | --- | --- |
| **Ephemeral CLI Language Server** | `$ANTIGRAVITY_LS_ADDRESS` & `$ANTIGRAVITY_CSRF_TOKEN` end when `agy` closes. | Bridge auto-releases its checkpoint lock (`ANTIGRAVITY_LS_GONE`), `SessionStart` hook prompts rebind on resume, Antigravity App Sidecars survive restarts, and `--mode headless-stream` runs unattended on servers. |
| **No `SendMessage` RPC on `ConversationService`** | `ConversationService` has `GetConversation`/`CreateConversation`, not `SendMessage`. | Uses `agentapi send-message` for delivery and `ConversationService/GetConversation` for live `runState` & `RUN_STATE_CANCELLING` deferral. |
| **No atomic `expectedTurnId` CAS** | `agentapi send-message` has no server-side turn-ID precondition (unlike Codex `turn/steer`). | Durable per-page `delivered` checkpoint + `agentFeed` `inReplyTo` deduplication + `RUN_STATE_CANCELLING` check + `Stop` hook turn-boundary check. |
| **Turn-scoped synchronous hooks** | `hooks.json` cannot wake an idle conversation on its own. | `SessionStart` + `Stop` hooks complement `antigravity-bridge.mjs` rather than replacing it. |
| **MCP Apps UI is Antigravity App-only** | `ui://` iframes render only in Antigravity App `v2.34.0+`. | `open_tendriller_inbox` returns full plain-text + `structuredContent` on CLI/IDE, while full multi-device UI & sensors live on the native Tendriller page. |

## Related guides

- [Same-conversation delivery](CONVERSATION_DELIVERY.md) — host qualification rules and two-request rehearsal
- [Build an app](BUILD_AN_APP.md) — complete Chronolog v2 starter workflow
- [MCP agent guide](MCP_AGENT_GUIDE.md) — `tendril_guide`, `register_agent`, and hosted `/mcp` tools
- [Integration OAuth](INTEGRATION_OAUTH.md) — configuring `OAUTH_CONFIG_JSON` CIMD clients on a Tendriller host
- [Agent requests and receipts](AGENT_REQUESTS.md) — `agentMessage`, `agentReceipt`, `agentFeed`, and presence cards
