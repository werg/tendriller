# Tendriller for Google Antigravity

Give Antigravity a live, private web page you can open on your phone, laptop, or tablet — backed by end-to-end encrypted local-first SQL & CRDT state (Chronolog), optional camera/microphone/GPS/hardware sensors, and private guest invites.

## What this plugin includes

- **Zero-config hosted MCP (`https://tendriller.dev/mcp`):** OAuth 2.1 with PKCE and Client ID Metadata Documents (CIMD). Click **Authenticate** once and sign in with GitHub or Google — no API keys or manual client IDs.
- **Docked Tendriller Inbox (`open_tendriller_inbox`):** In Antigravity App (`v2.34.0+`), opens an interactive MCP App side panel (`aux_pane`) and full-page (`global`) view of your connected Tendriller pages and `agent_feed` messages, with one-click follow-up into the current or a new conversation. On Antigravity CLI and IDE, returns the same data as plain text.
- **Automatic workspace lifecycle hooks (`SessionStart` & `Stop`):** Silently detects resumed Tendriller workspaces and catches pending page requests on turn boundaries with zero manual configuration.
- **Tendriller Skill & Rules (`/tendriller`):** Guides Antigravity through building, publishing, and evolving Chronolog v2 apps with zero native C/C++ builds.

## Get started

After installing, sign in when prompted or just ask Antigravity:

> *"Build me a live Tendriller dashboard with a shared SQL database and voice controls."*

Or open **Tendriller Inbox** from the Antigravity App side panel.

- Human & AI guide: https://tendriller.dev/agents/antigravity
- Integration reference: https://tendriller.dev/docs/ANTIGRAVITY_INTEGRATION.md
- Manage connected pages & OAuth grants: https://tendriller.dev/connections · https://tendriller.dev/oauth/connections
