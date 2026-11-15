# Plan: Tendriller inside Claude artifacts

Status: proposal, 2026-11-15. Nothing here is built yet. `docs/PROTOCOL.md` still wins where the two differ.

## Goal

A Claude artifact should be able to use Tendriller the way a Tendriller page does: send events that wake the agent, read and write shared state, and hear what the agent says. The agent side should not change at all, so an agent listening with `tendril-watch` is woken by an artifact exactly as it is woken by a phone.

The work should add as little new machinery as possible. Wherever a page already has a path, the artifact uses the same path.

## Why it needs a connector

An artifact cannot reach tendriller.dev itself. On 2026-11-15 a private test artifact tried a plain request, the agent socket and a wake probe, and the frame's content security policy (`connect-src`) blocked all three. Details are in `docs/ARTIFACTS.md`.

Artifacts can call the viewer's claude.ai connectors through the `mcp` capability. The calls run on Anthropic's side as the viewer, so they are not subject to the frame's network rules, and the credential lives in the connector settings instead of the artifact's code. Tendriller already serves MCP, so a connector is the natural way in.

## What is reused

| Need | Already exists | Change |
| --- | --- | --- |
| A credential for one client of one page | Device rows with a secret (`devices`, `verifiedDevice` in `page.ts`) | Add a `connector` kind of device |
| Handling a page's messages | `HANDLERS` and the checks before them in `ws.ts` | Pull the checks into one function both callers use |
| Waking the agent, the page wake budget, quiet events | `addEvent` and `wakeDecide` in `events.ts` | None |
| Shared state with revisions | `applyState`, `validateOps`, `checkStateSessions` | None |
| What the agent said | The transcript (`addTranscript`, `transcript()`) | Add an `after` cursor to the read |
| JSON-RPC, tool listing, schema checks | `handleMcp`, `dispatch` and `callTool` in `mcp.ts` | Make the tool list a parameter |
| A capability URL for hosts that cannot send headers | `A/mcp/<token>` | Same pattern for devices |
| Revoking a device | `DELETE A/devices/<id>` and the page's device manager | None |
| The client library | `runtime/src/core.ts` (`tendril.send`, `tendril.state`, `tendril.on`) | Make the transport pluggable |

## Design

### 1. Connector devices

A connector device is an ordinary row in `devices` with a new `kind` column (`browser` for today's devices, `connector` for the new one). Its role is `owner`, because only the owner creates one and only the owner's claude.ai account holds the URL. It has no socket, so it never counts toward presence and never receives broadcasts.

A connector device may only do three things: send events, change shared state and send log lines. It may never send `kind: "instruction"`. An instruction means "the owner's own words", and artifact code is written by an agent, so allowing it would let an agent speak as the owner. The allowlist lives next to `OWNER_ONLY` in `ws.ts` as `CONNECTOR_ALLOWED`.

Owner pages create connector devices through a new owner-only page route, `POST _tendril/connectors`, handled beside `devices` in `handleExperience`. The route returns the connector URL once. Listing, renaming and deleting use the existing device routes, so a connector shows up in the device manager like any other device and can be removed there.

The agent API cannot create connector devices. An agent that could would be minting itself an owner credential, and the URL could not reach the owner through chat anyway, because it holds a secret.

### 2. One dispatch path for page messages

Today the socket handler in `ws.ts` does the checks (device exists, role still valid, page not held, owner not suspended, rate limit, `OWNER_ONLY`) and then calls `HANDLERS[msg.t]` with a context whose `ws` receives the replies.

The refactor moves those checks into `dispatchDeviceMessage(t, conn, msg)`. `conn` carries the device, the account and a `reply(frame)` function. For a socket, `reply` sends on the socket. For a connector call, `reply` collects frames into an array that becomes the tool result. The handlers keep their code and only swap `c.t.send(c.ws, …)` for `c.reply(…)`. That is a mechanical change inside `ws.ts`, and the socket tests cover it.

### 3. A device-scoped MCP endpoint

`A/device-mcp/<device id>.<secret>` serves MCP for one connector device. It reuses `handleMcp`'s JSON-RPC handling with a second tool list, `DEVICE_TOOLS`:

- `send_event({data, wake?})`: calls the shared dispatch with `{t:"send", kind:"event"}`. It wakes the agent by default, like `tendril.send`.
- `update_state({ops})`: calls the shared dispatch with `{t:"state"}` and returns the new revision.
- `sync({after_rev?, after_transcript?})`: returns the shared state if its revision moved, plus agent messages from the transcript after the cursor. The runtime polls this.
- `page_info()`: the page's name and the agent's presence, read from the same data `tendril_info` uses.

The router adds one branch next to the existing `A/mcp` branch. Rate limits reuse the per-device message limit the socket already applies.

### 4. A pluggable transport in the runtime

`core.ts` opens a WebSocket and turns frames into events. The plan splits that into a `Transport` interface (`connect`, `send(frame)`, `onFrame`, `onStatus`) with two implementations:

- `socketTransport`: today's code, moved, not rewritten.
- `connectorTransport({server})`: uses `claude.use("mcp")`. `send` and `state` frames become `callTool` calls, and their collected reply frames are fed back as if they had come from a socket. Incoming changes come from `watchTool(server, "sync", …)` with a refetch interval of a few seconds. The cursors are kept in memory.

Everything above the transport stays the same: the offline outbox, optimistic state, `tendril.on`, the transcript. Calls that need a live socket, such as `eval` and sensor capture, report that they are unavailable in an artifact instead of failing silently.

The artifact build is a third esbuild entry in `scripts/build.mjs`: `runtime/src/artifact.ts` produces `tendril-artifact.js`. Artifacts may only load scripts from a few CDNs and tendriller.dev is not one of them. At first, agents paste the file inline, downloading it from `https://tendriller.dev/tendril-artifact.js` the same way they download `tendril-watch.mjs`. Later it can be published to npm, so artifacts can load it from `cdn.jsdelivr.net/npm/`.

### 5. Setup for the owner

1. On the owner's page, the device manager gets a "Connect to Claude" button. It calls `POST _tendril/connectors` and shows the URL with a copy button, plus the steps to add it under Connectors in claude.ai settings.
2. The dashboard card for each page links to that device manager with the button in view.
3. The agent tells the user which connector name to use. The artifact declares `capabilities: {mcp: {servers: [{server: "<that name>", tools: ["send_event", "update_state", "sync", "page_info"]}]}}` and calls `connectorTransport({server})`.

No secret ever passes through chat, the artifact or the agent.

## Security

- **No owner voice:** connector devices cannot send instructions, so artifact code never becomes the owner's words.
- **Wake budget:** connector events are page events. `wakeDecide` applies the same streak limit, so a looping artifact cannot wake the agent endlessly. A click in an artifact cannot be proved to be a person, so connector events never count as human gestures.
- **Revocation:** deleting the device in the device manager, or holding the page, ends the connector at once. The shared dispatch checks this on every call.
- **Scope:** the connector URL reaches one page and only the three allowed actions. It cannot read events, write files or run code. The existing agent connector (`A/mcp/<token>`) remains the way to do those, and it carries the agent's full power.
- **Consent:** claude.ai asks the viewer before an artifact first uses a connector, and only the account that added it can use it.

## Phases

1. **Refactor, no behaviour change.** Extract `dispatchDeviceMessage`. Make `handleMcp` take a tool list. Add the transcript cursor. The existing socket, MCP and runtime tests must pass unchanged.
2. **Connector devices.** Add the `kind` column, `CONNECTOR_ALLOWED`, `POST _tendril/connectors`, the `A/device-mcp/…` route and `DEVICE_TOOLS`. Tests: a connector event wakes the agent socket; an instruction is refused; a deleted device is refused; the wake budget withholds a burst.
3. **Runtime transport.** Split `socketTransport` out of `core.ts`, add `connectorTransport`, and build `tendril-artifact.js`. Test it against a mock MCP host in `runtime/test`.
4. **Owner UI.** Add the "Connect to Claude" button in the device manager and the dashboard link.
5. **Live test from Duet.** Add a page's connector in claude.ai, publish an artifact that calls `send_event`, and confirm that `tendril-watch` wakes the listening session. Update `agent.md` with an artifact recipe.

## To confirm in the live test

- claude.ai accepts a custom connector URL without OAuth, with the credential in the path. `A/mcp/<token>` assumes so, but it has not been tried from an artifact.
- How fast `watchTool` can refetch, and whether `callTool` has a timeout short enough to matter.
- Whether the artifact's consent prompt names the connector clearly enough for the owner to recognise it.

## Out of scope

- Running agent `eval` inside an artifact. The artifact is not the tendril page, and the agent already has the live page for that.
- Sensors in artifacts. Artifacts have their own capabilities for camera, microphone and location, which the artifact can read and forward through `send_event`.
