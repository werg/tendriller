# Tendriller — plan

Give any agent session a URL. Whoever opens it gets a live web page that the agent
writes, controls, inspects and rewrites, and that feeds the device's sensors, voice
and interactions back into the agent session. Each such page is a **tendril**: a
sensory and UI limb the agent grows on demand.

Status: agreed design, 2026-11-13, simplified the same day to serve agent pages
directly. Exact interfaces are in `docs/PROTOCOL.md`, which wins where the two differ.
Implementation started 2026-11-13; end-to-end encryption and the native wrapper are
deferred (phase 6). Nothing is built. Claims about other systems
come from reading their code and docs, not from running them; the ones that still
need a live test are listed in section 12.

---

## 1. The problem and the decisions it forces

| Need | Constraint | Decision |
|---|---|---|
| Sensors (camera, mic, GPS, motion) | Browsers expose them only over HTTPS with a real certificate, mostly only after a user tap. | Pages are served from a hosted server with real TLS. |
| Agent controls the page live | The agent sits in a sandbox or behind NAT, often behind an HTTP proxy, and is not a web server. | Both sides connect outbound to one small server. The agent uses plain HTTPS only. |
| Page events reach the agent | Agents are turn-based and often have no running process between turns. Sensors produce data at 60 Hz; turns take seconds to minutes. | Events queue on the server. Sensor-rate work runs on the page; only chosen events wake the agent. |

Settled along the way:

- **One server, no other infrastructure.** No dependency on Tincan or any messaging
  service; their wake techniques are copied as ideas (section 5).
- **Lightweight on the agent side.** No daemon, no MCP server, no required install.
  The agent builds its own page and glue from an instructions file and a few
  optional snippets.
- **No WebRTC in the core.** It would not remove the server, it fails behind the
  sandboxes' proxies, and our traffic is small. It is used only for live audio in
  the fast voice layer (section 13).
- **No third-party static hosting for pages.** It gives no queue, no live updates
  and no private URLs.

## 2. Architecture

```
 Agent in its own sandbox (Claude Code, Codex, Muse, Grok Bot, …)
   │  plain HTTPS with an agent token:
   │  upload files, run script in the page, long-poll for events
   ▼
 Server (Cloudflare) — one Durable Object per tendril
   │  files and their versions, event queue, state, blobs
   │  optional outbound webhook to wake the agent
   ▼  serves the agent's page directly; WebSocket for live traffic
 The page at the unguessable URL: the agent's own HTML, as written,
 plus one small script the server adds
```

### 2.1 Server
- Cloudflare Worker with one Durable Object per tendril (hibernating WebSockets,
  SQLite storage) and R2 for files and blobs. Close to free when idle.
- It routes, stores and authenticates. It contains no agent logic.
- Runs locally under `wrangler dev` for development.
- Each tendril has two secrets: the **page URL** given to the user, and an **agent
  token** that never reaches the page.

### 2.2 The page
The agent's HTML is served as the page itself, at the top level, so it is ordinary
web code and every browser API behaves the standard way. There is no frame, no
separate origin and no build step.

The server adds one script to the page (`tendril.js`). It:
- holds the WebSocket and reconnects;
- provides `tendril.send(data)` and, optionally, `tendril.state`;
- runs script the agent sends and returns the result;
- forwards console output and uncaught errors;
- reloads the page when the agent uploads a new version;
- draws the one always-present control (section 7) in an isolated element.

### 2.3 Agent side
One instructions file served by the server (`/agent.md`) describes the contract
below, platform caveats and the wake recipe for each host. Beyond that we provide
only optional pieces: copyable snippets (push-to-talk, camera capture, screenshot,
device probe) and a reference CLI that wraps the API.

## 3. Interface

The whole contract is three things:

1. **Push code.** Upload an HTML file. It is live on the page at once.
2. **Hear from the page.** Page code calls `tendril.send(data)`; the agent reads it
   from `events`.
3. **Reach into the page.** The agent posts JavaScript; it runs in the page and the
   result comes back.

Nothing else is required. No declarations, no handshake, no packaging.

```
POST   /new                      create a tendril → page URL, agent token
PUT    files/<path>              upload a file; `index.html` is the page
GET    events?after=<cursor>     long-poll, held up to 25 s
POST   eval                      run JavaScript in the page → JSON result
```

Optional, used when wanted (all under `/t/<id>/`, agent token required):

```
GET    state      PATCH state    shared JSON that survives reloads and offline
GET    logs?after=<cursor>       console output and errors
GET    blob/<id>  PUT blob       photos, clips and other binary data
POST   rollback                  return to an earlier version
PUT    wake                      webhook URL + token, schedule hint, wake budget
GET    activity   POST activity  read the record; add an agent note
POST   check                     run an accessibility audit on the current page
POST   adopt                     exchange a one-time code for a new agent token
DELETE /                         revoke
```

What the server does without being asked: keeps every upload as a version, judges
whether a new version loaded healthily (section 9), records activity, and queues
events.

Choices left open for speed or polish, none of them required:
- **Update in place.** By default a new upload reloads the page. For a seamless
  change the agent can instead alter the running page through `eval`.
- **Several files.** One HTML file is the normal case; scripts, styles and assets
  can be uploaded by path when a page outgrows it.
- **Explicit ready signal.** A page with slow startup can call `tendril.ready()`
  itself in place of the automatic health check.

Continuous media does not go through the agent. Pages send snapshots, clips or
derived values.

## 4. What reaches the agent

Most page activity must not wake the agent. Three tiers:

1. **Reflex**: handled by page code (turn-by-turn from GPS, a game loop, counting
   reps from the accelerometer).
2. **Record**: written to state or the log, seen when the agent next looks.
3. **Wake**: `tendril.send(data)` (wakes by default; `{wake: false}` only records), a spoken or typed
   instruction, or an error in freshly pushed content.

The agent chooses the split by how it writes the page. The instructions file must
teach this, because the natural mistake is to stream a sensor into the session.

## 5. Waking the agent

Mechanisms copied as ideas from Agent Tincan (`mvanhorn/agent-tincan`, MIT). Its
rule is ours: **delivery never depends on wake.** Events wait in the queue; a wake
only prompts the agent to look, and carries a count, never content.

Three primitives on the server:

1. **Long-poll** on `events`. A shell loop around `curl` turns it into "block until
   something arrives, then exit".
2. **Outbound webhook**: the server POSTs "N events waiting" to a URL the agent
   registered, debounced and rate-capped.
3. **Schedule hint**: the agent says how often it checks, so the page can tell the
   user when to expect a response.

| Host | Recipe | Response time |
|---|---|---|
| Claude Code | The wait loop restarted per wake under the Monitor tool (one output line per wake starts a turn); or the wait loop as a background command, whose exit re-invokes the session. Channels are an alternative. | Seconds |
| Muse | Wait loop in the background; processes survive between turns and a finished background command starts a new turn. Backed by a scheduled check. | Seconds |
| Grok Bot | Webhook to its URL starts a turn. | Seconds |
| Hermes, OpenClaw | Webhook to their gateway. | Seconds |
| Codex and other terminal CLIs | A listener starts a fresh headless run per wake. It is a new run, so continuity comes from files or `codex exec resume`. | Seconds, new run |
| OpenAI dot | The tendril's MCP connector (PROTOCOL section 13): MCP Events push a signed "events waiting" and the dot reads them with a tool. Untested on a real dot. | Seconds (expected) |
| Claude Duet | Same connector, but Duet cannot be pushed to yet: chained `read_events` long-polls while a turn runs, a watched follow loop if its runtime offers one, its own check-ins between turns. Duet's network uses an allowlisted proxy, so our domain may need allowing. | Seconds in a turn, hours between |
| Schedule-only hosts | Their own schedule polls every few minutes. | Minutes |

Also copied: a wake that produces no check-in within a grace period is retried, and
the page tells the user the agent has not responded.

Because a turn-based agent cannot feel instant, the page acknowledges an
instruction immediately, shows the agent's status (listening, working, checks
every N minutes, not responding), and displays progress the agent writes to state.

## 6. Capabilities and platform limits

| Capability | Notes |
|---|---|
| Geolocation | Everywhere. Stops when the page is backgrounded on mobile. |
| Motion, orientation | iOS requires a permission call from a tap. |
| Camera, microphone | Everywhere over HTTPS. |
| Speech recognition | Uneven across browsers. Start with the browser's own; add record-and-transcribe on the server where it is poor. |
| Speech synthesis | Everywhere; voices vary. |
| Wake lock, fullscreen | Good on current browsers. |
| Notifications | iOS only for pages installed to the home screen. |
| Bluetooth, NFC, Serial, USB, MIDI | Chromium only. Turns the page into a bridge to physical hardware. |
| Barcode detection, gamepad, clipboard, share, file picker | Varies; probe at runtime. |

- A device-probe snippet reports what the connected browser actually supports, so
  the agent codes against facts.
- Sensor permissions are the browser's own prompts, triggered from a tap in the
  agent's page. Nothing has to be declared in advance.
- **Backgrounding is the biggest limit.** A locked phone or a switched tab freezes
  the page. Wake lock and home-screen install help; navigation with the screen off
  needs a thin native wrapper around the same page, planned last.

## 7. Default experience

One small control added by `tendril.js`, which page code is asked not to remove: push-to-talk with a text fallback,
agent status, indicators for live sensors with a stop switch, and "restore previous
version" when content is unhealthy.

Later additions: display mode (fullscreen, wake lock, hands-free), driving mode
(voice first, very large targets), a QR code for joining, and the features in
section 13.

## 8. Trust and safety

- **The page is an instruction channel into an agent with real permissions.** Each
  connected device has a role: *owner* (speech and text are instructions), *guest*
  (can use the content, but nothing it produces is an instruction, so the back-seat
  game cannot direct the agent), *display* (read-only). Owner role needs pairing,
  not just the link.
- Sensor data and page-generated text reach the agent labelled as data.
- Links are unguessable, expiring and revocable. The agent token never reaches the
  page.
- Page code is the agent's own and is trusted as the agent. It can see the page
  URL, so third-party scripts the agent includes can too. If that matters later,
  the server can swap the URL secret for a cookie on first visit.
- Each tendril is served from its own subdomain, so one tendril's code cannot read
  another's storage.
- The server sees content and events. Retention is short; end-to-end encryption is
  a later phase.

Roles and pairing arrive in phase 3. Until then every link holder is treated as
owner, which is acceptable only while the user is the sole audience.

## 9. Not breaking the page

All of this is automatic; the agent does nothing for it.

- Every upload is a version. A version counts as healthy when the page loads and
  runs for a couple of seconds without an uncaught error.
- If a new version fails that test, the server goes back to the last healthy one,
  the page reloads onto it, and the errors go to the agent as a wake event.
- A page that hangs outright cannot report anything. Reloading it serves the last
  healthy version, because the new one never reported in.
- The always-present control offers "restore previous version" to the user.
- State lives on the server, so reloads and rollbacks lose nothing.
- Later: a headless preview with fake sensors.

## 10. Use cases

From the brief:
- **Road trip**: turn-by-turn from GPS on the page; voice asks for dining options;
  the agent swaps the view. The same channel carries "keep working on my
  presentation". A guest tendril runs a game written on the spot for the back seat.
- **Metrics wall**: walk up and say what to show.
- **Kitchen tablet**: shared shopping list, recipes, pantry database; point the
  camera at a drawer and the agent looks.

Others the same primitives enable:
- **Approval remote**: a long job pings the phone; approve, reject or redirect.
- **Hardware bench**: the agent talks to a microcontroller through the phone's
  Bluetooth or the laptop's serial port.
- **Repair guide**: camera snapshots, the agent annotates the next step, voice
  control for busy hands.
- **Workout coach**: reps counted on the page, the plan adjusted between sets.
- **Field inventory and expenses**: scan barcodes and receipts against a sheet.
- **Party or classroom**: every phone is a controller for a shared-screen game.
- **Music practice**: pitch and tempo analysed on the page, exercises chosen by
  the agent.
- **Walk-and-talk review**: the agent reads a summary aloud, the user dictates
  decisions.
- **Site survey**: photos tagged with location and heading assembled into a report.
- **Ambient display**: day plan in the morning, job status overnight.

## 11. Build order

TypeScript, one repository:
```
server/       Worker + Durable Object + R2
runtime/      tendril.js, the script added to every page
agent.md      instructions served to agents
snippets/     copyable page pieces
cli/          optional wrapper around the API
```

| Phase | Delivers | Proof |
|---|---|---|
| 0. Loop | Server, `tendril.js`, `new`, file upload, `eval`, events long-poll, logs, `agent.md` | From Claude Code: build a page with a button; the tap wakes the idle session through the background wait; the agent changes the page. |
| 1. Senses | Blobs, snippets for camera capture, device probe and push-to-talk, presence indicator | Photograph a drawer and the agent describes it. Speak an instruction and the agent acts. |
| 2. Hosts | Outbound webhook, schedule hint, wake budget, retry and "not responding" status, wake recipes, live tests on Muse, Grok Bot, Duet, dot and Codex | The phase 0 proof repeated on each host, with measured response times. A page that fires wakes in a loop is throttled. |
| 3. Safety | Shared state, automatic health check and rollback, undo for the user, roles and pairing, expiry and revocation | A deliberately broken push never reaches the user. A guest device cannot instruct the agent. "Go back" restores the previous view. |
| 4. Durability | Offline cache and outbound queue, resident tendrils and adoption, activity record, accessibility check on request | Drive through a tunnel and nothing is lost. A new session adopts the kitchen tablet and carries on. The owner can see and delete what the agent received. |
| 5. Experience | Fast voice layer, proactive tendrils (home-screen install, notifications, device rules), several surfaces as one, personal library, display and driving modes, wake lock | Road-trip and kitchen scenarios end to end on real phones, with spoken replies in under a second for small requests. |
| 6. Reach | On-device perception snippets, point and ask, shared tendrils between people, encryption, server-side transcription, headless preview, native wrapper | Navigation with the screen off. Two people's agents keep one list. |

## 12. Assumptions to confirm

Defaults I have assumed; say if any is wrong:
- The server runs on your Cloudflare account.
- The first users are you and your own devices, so accounts and quotas wait.
- Speech starts browser-only; audio leaves the device only once server-side
  transcription is added in phase 6.

Needs a live test (phase 2):
- Muse and Grok Bot wake as Agent Tincan documents, against a public server.
- Duet and dot: can each reach our domain, how long can a polling turn run, does a
  finished background command start a turn, what schedule interval is allowed.
- Codex: whether resuming the same session per wake is practical.

## 13. Ambitious features (agreed 2026-11-13)

| # | Feature | What it is | Phase | Depends on |
|---|---|---|---|---|
| 1 | **Fast voice layer** | A small real-time speech model answers instantly and handles small requests itself through functions the agent exposes ("next step", "zoom out", "tick milk"). Larger requests go to the agent as wake events, and the user is told so. | 5 | Live audio over WebRTC to a speech model; a way for the agent to declare page functions and give the layer context. Which model and where it runs is undecided. |
| 2 | **Proactive tendrils** | The agent starts the interaction: a notification when a job needs a decision, or rules it sets that fire on the device ("when I reach the shop, open the list"). | 5 | Home-screen install and web push (on iOS, notifications work only for installed pages). |
| 3 | **Several surfaces as one** | The phone as remote, microphone and camera for a wall display; "send this to the big screen"; pairing by pointing the phone at a code on the other screen. | 5 | Roles and pairing (phase 3); per-device addressing in `eval` and `state`. |
| 4 | **On-device perception** | Wake word, voice activity, pose, object and text recognition running in the browser, as copyable snippets. Pages send conclusions instead of raw data. Includes a "glance" camera mode that uploads a frame only when the scene changes. | 6 | Browser model runtimes; varies by device, so each snippet reports whether it can run. |
| 5 | **Point and ask** | The agent draws on the live camera view: an arrow to the right screw, a box around the item it means. | 6 | Camera and overlay snippets that share coordinates. |
| 6 | **Undo for the user** | Version history by voice or gesture: "go back", "show me the one from before". | 3 | Content versions and rollback, already in phase 3. |
| 7 | **Personal library** | The agent keeps tendrils that worked as templates in its own workspace and improves them with use. Each can be installed to the home screen with its own name and icon. | 5 | A convention in `agent.md` for saving and reusing pages; per-tendril install metadata. |
| 8 | **Presence** | One consistent indicator, with sound and haptics, for listening, working and done. | 1 | Part of the always-present control. Haptics are unavailable on iOS browsers. |
| 9 | **Shared tendrils between people** | Two people's agents co-own one page, such as a household list. | 6 | Roles, plus more than one agent token per tendril and attribution of each change. |

## 14. Durability and care (agreed 2026-11-13)

### 14.1 Offline and poor signal (phase 4)
- **Cache.** The server supplies a fixed service worker that caches every file of
  the current version, so a reload with no signal still shows the page.
- **Outbound queue.** Events, state patches and blobs are stored on the device
  with client-generated ids and sent in order on reconnect. The ids make resending
  safe.
- **State while offline.** The local copy drives the page. On reconnect, patches
  merge with last-writer-wins per path, in the server's order. The instructions
  file tells agents to model lists as records keyed by id, so two sides adding
  items do not overwrite each other. No merge library in the first version.
- **Agent side.** An `eval` on an offline page fails fast with "offline, last seen
  at …". Uploads and state patches are held and applied on reconnect.
- **Provisioning.** The instructions file includes a recipe for preparing a page
  for a trip: fetch the route, map tiles for the corridor and likely options in
  advance.
- **Limits.** Browser speech recognition and the fast voice layer need a
  connection; offline, the text field and on-page controls still work. iOS may
  evict stored data for pages not installed to the home screen.

### 14.2 Resident tendrils (phase 4)
- **Lifetime.** A tendril is ad hoc (expires after 24 hours idle) or resident (no
  expiry). The agent chooses at creation and can change it.
- **Ownership is the agent token.** The agent keeps tokens in its own durable
  workspace. A later session of the same agent reads them and carries on.
- **Adoption without the token.** From an owner device, the page control offers "connect
  an agent": it shows a one-time code, the user gives it to the new agent, and the
  agent exchanges it for a fresh token. The old token is revoked.
- **Handover note.** State has a reserved `_about` entry the agent maintains:
  purpose, how the content is organised, where its source lives. A new session
  reads this, then the files, state and recent activity.
- **Unattended.** The page keeps working on its own code. The presence indicator
  shows "no agent attached, last heard from 3 days ago". Instructions given
  meanwhile are queued, capped and shown to the user as saved for later.

### 14.3 Wake budget (phase 2)
- Enforced by the server, per tendril, in two classes: **owner instructions**
  (speech and text from an owner device) and **page-generated** wakes. Starting
  defaults: 60 and 12 per hour, with bursts merged into one wake.
- Over budget, events still queue; only the wake is withheld. The page says "the
  agent will see this at its next check", and the agent sees how many wakes were
  withheld.
- A content error after a push wakes the agent once per version, so a broken page
  cannot loop.
- The agent sets the budget through `wake`; an owner can lower it from the page control.

### 14.4 Activity record (phase 4)
- Built by the server from the traffic it already routes, so it does not depend on
  the agent reporting honestly: photos and clips sent (with thumbnails),
  instructions sent, location and sensor samples sent (as counts), calls the agent
  made to the page, versions pushed, wakes sent and withheld.
- The agent can add plain notes ("added three items"), shown as agent-reported.
- Shown in a panel behind the always-present control, to owner devices only.
- Kept 30 days by default. The owner can delete an entry and its stored data from
  the server. This cannot remove what the agent has already read, and the panel
  says so.
- Data handled only by page code never leaves the device and does not appear; the
  live-sensor indicator covers that case.

### 14.5 Accessibility (control from phase 0, check in phase 4)
- **The always-present control.** Built accessible from the first version, because retrofitting costs
  more: labelled controls, keyboard and switch operation, large touch targets,
  respect for the device's text size, contrast and reduced-motion settings.
  Presence changes are announced to screen readers and never signalled by colour
  or sound alone. Spoken replies always have a visible transcript, and voice is
  never the only way in.
- **Agent content.** The instructions file carries a short checklist, and the
  copyable snippets are accessible by default.
- **Automated check.** On request (`check`), a standard accessibility audit runs
  in the page and the findings go back to the agent. It is never part of a push.
- **Preferences.** State has a reserved `_prefs` entry (text size, contrast, no
  audio, language) set by the user in the page control. Agent content is expected to
  honour it.
