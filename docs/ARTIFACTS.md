# Learning from Claude artifacts

Claude artifacts and Tendriller both give an agent a web page that a person uses and that can call the agent back. Artifacts do it from inside Claude; Tendriller does it for any agent host. This note compares the two and lists what Tendriller should borrow.

It is based on the agent-facing artifact interface available to Claude in Claude Duet and Claude Code on the web on 2026-11-15 (publish, read, capabilities, comments and the per-artifact database), not on how artifacts are built.

## How the pieces map

| Tendriller | Artifacts |
| --- | --- |
| Page at `<id>.tendriller.site`, opened by its owner email and OAuth | Page on claude.ai, private by default; viewers are already signed in |
| Guests and display links | Sharing for viewing, commenting or editing, set on the platform |
| Agent token plus a wake path the agent arranges (socket, webhook, MCP Events, bridge) | The publishing session watches the page automatically; comments and messages sent to Claude arrive as turns |
| `tendril.send(data)`, waking by default, `{wake:false}` to stay quiet | Only an explicit "ask Claude" call or comment reaches Claude; ticks, edits and saves do not |
| Shared state (`GET/PUT/PATCH A/state`) | Per-artifact database, read and written by the page and by Claude's data tool |
| Versions, rollback, `409 version_conflict` | Republishing a page that changed is refused and the live version is handed back to merge |
| `version_healthy` events and `POST A/check` | A `preflight.js` check runs against open pages when an update is published |
| `GET A/capabilities`, probed on a live device | Capabilities are declared when the page is published |

## What artifacts do better

1. **Wake needs no setup.** Publishing binds the page to the session. There is no socket to hold, nothing to re-arm every 30 minutes, no network allowlist and no delivery probe.
2. **Identity and sharing are the platform's.** Viewers are signed in to Claude, a page starts private, and sharing is a setting, not an owner-email claim.
3. **Intent is explicit.** Only a control built to message Claude produces a turn. Everything viewers write reaches Claude labelled as data, never as an instruction.
4. **Capabilities are declared up front.** A page states what it needs (live data, shared storage, viewer identity, uploads, asking Claude) before anyone uses it.
5. **The agent edits data without republishing.** Rows change through a tool call; the page code stays the same.

## What Tendriller does that artifacts do not

- Works for any agent host: Codex, Claude Code, Hermes, OpenClaw, Grok, OpenAI dots, Claude Duet.
- Uses real device inputs: camera, microphone, motion, location, Bluetooth, Serial, USB, MIDI.
- Speaks and transcribes on the device, and runs agent-sent code live in the page with `POST A/eval`.
- Lets the owner approve guests and hand out read-only display links.
- Runs independently of any one AI provider.

## What to borrow first

1. **A declared capability manifest.** Let a version declare the inputs it uses and the events it sends (for example in a `tendril.json` next to `index.html`). Show it to the owner on first open and whenever a new version widens it, and refuse runtime calls the manifest does not name. This extends the existing high-risk version gate from "is this risky" to "this is exactly what it can do".
2. **Quiet by default, waking on purpose.** Add `tendril.ask(...)` as the call that wakes the agent, and make `tendril.send` default to `{wake:false}`. Owner text and speech already wake. Telemetry and UI state would stop costing agent turns, and the agent sees a clear line between "the person asked" and "the page reported".
3. **A one-step attach in the creation response.** Tendriller cannot bind to a host the way artifacts do, but it can come close: return an `attach` block with the exact command for the caller's host (for Claude Code and Claude Duet, the `tendril-watch.mjs` download and the `Monitor` call). The agent then runs one step instead of reading the guide.

Later candidates: comment threads anchored to parts of a page, and a pre-publish check that runs a new version against the owner's open device before it replaces the live page.
