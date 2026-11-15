# Learning from Claude artifacts

Claude artifacts and Tendriller both give an agent a web page that a person uses and that can call the agent back. They aim at different things. Artifacts are documents and small apps that live inside Claude, with the platform deciding what a page may do and when Claude hears about it. Tendriller is a live, freewheeling back-and-forth between a person's devices and any agent: the page can do whatever the browser allows, and whatever the person does reaches the agent at once.

This note compares the two and lists what Tendriller should still borrow. It is based on the agent-facing artifact interface available to Claude in Claude Duet and Claude Code on the web on 2026-11-15 (publish, read, capabilities, comments and the per-artifact database), not on how artifacts are built.

## How the pieces map

| Tendriller | Artifacts |
| --- | --- |
| Page at `<id>.tendriller.site`, opened by its owner email and OAuth | Page on claude.ai, private by default; viewers are already signed in |
| Guests and display links | Sharing for viewing, commenting or editing, set on the platform |
| Agent token plus a wake path the agent arranges (socket, webhook, MCP Events, bridge) | The publishing session watches the page automatically; comments and messages sent to Claude arrive as turns |
| `tendril.send(data)` wakes the agent at once; `{wake:false}` queues quietly | Only an explicit "ask Claude" call or comment reaches Claude; ticks, edits and saves do not |
| Shared state (`tendril.state` on the page, `GET/PUT/PATCH A/state` for the agent) | Per-artifact database, read and written by the page and by Claude's data tool |
| `POST A/eval`, `A/say` and file updates to the live page | Republish the page or change its data |
| Versions, rollback, `409 version_conflict` | Republishing a page that changed is refused and the live version is handed back to merge |
| `version_healthy` events and `POST A/check` | A `preflight.js` check runs against open pages when an update is published |
| Anything the browser allows; `GET A/capabilities` reports what a device supports | Capabilities are declared when the page is published |

## Where Tendriller differs on purpose

These are choices, not gaps. Tendriller keeps them because they make the loop immediate.

- **Every message wakes the agent.** Owner text, speech and page events go to the agent as they happen, so it can answer while the person is still looking at the page. Artifacts reach Claude only through a deliberate "ask Claude" action or a comment.
- **The page is not limited by a manifest.** A page can use any browser API the device offers, and the agent can change the page at any time. Artifacts declare their capabilities when published.
- **The agent drives the live page.** `POST A/eval` runs code on a connected device and returns the result, `A/say` reaches every open device at once, and new files replace the page in place. An artifact changes only by republishing or through its data.
- **Any agent can sit on the other end.** Codex, Claude Code, Hermes, OpenClaw, Grok, OpenAI dots and Claude Duet all work. An artifact can only wake a Claude session, and its webhook is usable only by Anthropic's own service.
- **It is aware of devices.** It knows which of the owner's devices are connected, picks one to speak, and shows the person whether the agent is listening, away or not responding.
- **Voice is built in.** On-device transcription and speech work with no setup in the page.
- **Hardware goes beyond what artifacts list.** Bluetooth, Serial, USB, HID, NFC and MIDI are available. Artifacts can use the camera, microphone, location, screen and motion, so those alone are not a difference.
- **Guests and display links.** The owner can approve guests and hand out read-only display links.
- **It is open plumbing.** An event API, signed webhooks and MCP Events serve any receiver, independent of any one AI provider.

## What artifacts do better

1. **Wake needs no setup.** Publishing binds the page to the session. There is no socket to hold, nothing to re-arm every 30 minutes, no network allowlist and no delivery probe.
2. **Identity and sharing are the platform's.** Viewers are signed in to Claude, a page starts private, and sharing is a setting rather than an owner-email claim.
3. **The agent edits data without republishing.** Rows change through a tool call. Tendriller's shared state already does the same.

## Passive data back to the agent

Not everything a page reports needs a reply. Tendriller already has two quiet channels, so no new one is needed:

- **Shared state.** The page writes with `tendril.state.set` or `tendril.state.patch`. The change is stored with a revision number and broadcast to other open devices, but it does not wake the agent. The agent reads it with `GET A/state` whenever it next runs. This suits values that only matter in their latest form, such as a form draft, a slider position or the newest sensor reading.
- **Quiet events.** `tendril.send(data, {wake:false})` queues an event without waking the agent. It is delivered with the next waking event. This suits a history the agent should see in order, such as a log of steps taken.

## Using Tendriller from inside an artifact

An artifact cannot talk to tendriller.dev directly. We tested this on 2026-11-15 with a private artifact that tried three calls: a plain `GET A/`, the agent wake socket and `POST A/wake/probe`. The artifact frame's content security policy blocked all three under `connect-src`, so `fetch` failed and the socket never opened. Artifacts may only load scripts from a short list of code hosts, and every other network call is refused. Loading `tendril.js` from a CDN would therefore work, but nothing it tries to reach would.

The way in is the artifact `mcp` capability. A page can call the viewer's claude.ai connectors, and every tendril already serves MCP at `A/mcp/<token>`, a capability URL for hosts that cannot send headers. Once the owner adds that URL as a custom connector, an artifact that declares it can call the existing tools: `say` to speak on the owner's phone, `update_state` to change what open devices show, and `eval` to run code on the live page. The calls run as the viewer, so the token never sits in the artifact.

That route pushes from the artifact to the Tendriller page. It cannot yet wake an agent, because the MCP tools are all agent-side and none of them adds a page event. A tool that sends a waking page event would close that gap.

The plan to close it, reusing Tendriller's device and message code, is in `docs/ARTIFACT_CONNECTOR.md`.

## What to borrow

1. **A one-step attach in the creation response.** Tendriller cannot bind to a host the way artifacts do, but it can come close. It can return an `attach` block with the exact command for the caller's host: for Claude Code and Claude Duet, that is the `tendril-watch.mjs` download and the `Monitor` call. The agent then runs one step instead of reading the guide.

Later candidates: comment threads anchored to parts of a page, and a pre-publish check that runs a new version against the owner's open device before it replaces the live page.
