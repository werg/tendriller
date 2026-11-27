---
name: tendriller
description: >-
  Build, connect, and wake live browser-first Tendriller apps from Google Antigravity
  (CLI, App, IDE, or SDK) using Chronolog v2, hosted MCP, terminal sandbox diagnostics,
  and consumers/antigravity-bridge.mjs.
---

# Tendriller for Google Antigravity

Use this skill when the user wants to launch a live Tendriller dashboard, connect an existing Tendriller page over hosted `/mcp`, diagnose sandbox/network issues, or wake this Antigravity conversation from browser page requests.

## 1. Choose the right path

- **Hosted MCP (`/mcp`):** Call `tendril_guide` (`topic: "start"` or `"build"`), `list_tendrils`, `query_sql`, or `open_tendriller_inbox` (renders inline / in Antigravity App's side panel `aux_pane` and full-page `global` views, with plain-text fallback on CLI/IDE).
- **Local Chronolog v2 workspace (recommended for building & live UI updates):**
  1. Verify `<origin>/api/readiness` (`mode: "open"`, `creation.available: true`), `<origin>/api/service`, and `<origin>/.well-known/tendriller.json`.
  2. Install with `npm ci --ignore-scripts` (Node 22.15+, zero native builds).
  3. Register once (`tendril workspace key` + `register_agent` + `tendril workspace adopt`, or `tendril workspace init --owner EMAIL --handle HANDLE`).
  4. `npm run page:new -- <slug> --template inventory|notes|knowledge|call`, `npm run init -- <slug>`, `npm run deploy -- <slug>`, and launch `npm run agent` (`IsDaemon: true`).
  5. Hand the ready page URL to the owner without waiting for a claimed reply.

## 2. Wake this Antigravity conversation from live pages

Run the bundled multi-page Antigravity bridge alongside `npm run agent`:

```sh
# Preflight sandbox, agentapi, ConversationService, and workspace binding:
node consumers/antigravity-bridge.mjs --doctor --workspace /abs/workspace

# Continuous same-conversation bridge (verified on agy CLI & Antigravity App):
node consumers/antigravity-bridge.mjs \
  --workspace /abs/workspace \
  --conversation-cwd /abs/antigravity-project-root \
  --pages <slug1,slug2> \
  --conversation "$ANTIGRAVITY_CONVERSATION_ID" \
  --topics chat,agents \
  --mode agentapi
```

- **Fallback when `agentapi` is unavailable:** run `--mode wait --timeout 0` as a non-daemon background task (`IsDaemon: false`) and re-arm after each handled wake.
- **Unattended server / CI without an open UI:** run `--mode headless-stream` (never pass the currently open `$ANTIGRAVITY_CONVERSATION_ID`) for a warm `agy --input-format stream-json` process with live `streamAgentReply` previews and soft-deny detection.

## 3. Verification checklist

- Verify local browser authoring, offline reload persistence, peer convergence, and signed publication receipt.
- For same-conversation wake, verify both active-turn delivery and two sequential idle-wake turns with durable `agentReceipt` and `agentMessage` (`inReplyTo`) replies in `agentFeed`.
