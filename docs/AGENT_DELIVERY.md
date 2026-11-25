# Deliver a running connected application

When a user gives you a Tendriller domain and asks for an app, the intended result
is its **working hosted page, connected application session and verified signed
publication**. Provisioning, enrollment, publication and starting the participant
are part of that task. Source files support the result; a ZIP or local preview
alone does not establish it.

## Start provisioning early

1. Read the selected connector's service origin and `/api/readiness` before
   installing or building. Stop if creation is paused or readiness is unavailable;
   keep the same origin. Then read `/api/service`, onboarding descriptor and
   [capability map](CAPABILITIES.md). Identify the smallest native application path.
2. Register the workspace agent (`tendril workspace init` with the owner's
   verified email, `workspace join` with a dashboard code, or MCP
   `register_agent` plus `workspace adopt`; see [Build an app](BUILD_AN_APP.md)).
   The workspace holds one agent credential and one signing key for every page.
   Create the page with `npm run page:new` (the creating agent is granted it
   automatically) and continue through authority, initial generation, bundling
   and signed publication before requesting sign-in.
3. Start `npm run agent` and prepare any assistant-access proposal. Give
   the owner the ready `page_url` and actual permission-review URL together.
   Do not stop at an unclaimed page, ask for a "claimed" reply, or postpone
   publication until sign-in. If the URL was already shared, keep preparing.
4. Sign-in claims the agent and adopts the already-published app; no agent
   redeployment is necessary. Further pages the same agent creates need no new
   credential; an existing page needs the owner's explicit grant (a per-agent
   checkbox on the dashboard or the page's **Add people & devices → An agent**).
   Browser enrollment and assistant consent remain explicit authority decisions.
   Use their concrete public keys and permission-review forms for those actions.
5. Perform real shared commands in both directions and verify reopening before
   calling the app complete. Report the running process and saved resume state.

If an action is blocked, preserve completed setup and name the exact missing
permission, compatible artifact or runtime capability. Distinguish **not yet
attempted** from **attempted and failed**, with the observed error. An unfamiliar
bootstrap is work to perform; it is not evidence of a platform failure or a reason
to silently switch the user's application to another stack.

## Keep the agent program alive

The workspace has exactly one long-running local program:

```sh
npm run agent        # tendril agent run
```

It holds one hub connection to the host for every page's control traffic (setup
notices, discovery, invitations, rendezvous, assistant adapter) and opens one
Chronolog session per initialized page, each with its own device store and the
agent's shared signing key. Page sync data (WebRTC, relay) keeps per-page
connections and never uses the hub. The program participates in each selected
application and observes real changes. It stays alive until stopped, including
while MCP access is unapproved or an optional adapter is disconnected.
Authenticated setup notifications let later devices pair without restarting it,
with no idle status polling. The private workspace (`.tendriller/`) must survive
future invocations. Start the program in the supported execution environment and
retain enough process information to monitor, stop and restart it. CLI queries,
commands and publication attach to it with `--page <slug|id>`; an unavailable
program is `OWNER_UNREACHABLE`, never a reason to open a second signer. UI
publication attaches through an explicitly authorized
[publication binding](tools/CLI.md#publication-capability-and-retained-bindings),
keeping that owner and its journals alive. Deliberate standalone
administration (`npm run enroll`) requires the agent program to be stopped.

For an agent integration, connect the session's public application tools and
changes to the agent's actual execution loop. `createApplicationTools` and
`serveApplicationToolLines` from `@chronolog/peer-session` are the public tooling
primitives. Merely printing changes in a terminal does not make an LLM respond.

Name the process lifetime explicitly:

| Environment | Honest delivery statement |
| --- | --- |
| A process verified running during the current task | The page and the agent program exchanged work during this run; identify the active process and how to resume it |
| A durable machine/service with a configured, verified process owner | Identify that owner, its restart mechanism and the persistent device location; test a restart |
| A temporary agent execution environment | State its known lifetime or that lifetime is unverified; arrange a supported persistent participant if ongoing service is required |
| Only the hosted page remains | The signed UI is available, but ongoing native coordination or agent responses still require the relevant participant |

Record whether a private checkpoint actually exists in storage that survives the
execution environment, and verify a same-device reopen before calling it
resumable. A local ZIP or failed upload is not a verified remote checkpoint.
Stop the owner before copying its private database unless the storage API
provides a consistent backup. Exclude tokens, epoch keys and device databases
from public source archives and authored page assets.

Page residency retains hosted control and code. It does not run a native process,
retain every application's data, or prevent browser suspension. The first-app
browser has explicit reader/writer grants and relies on its native coordinator
for applied writes. Changing that availability policy requires deliberate grants
and recovery choices, not a silent identity reset.

## An existing ChatGPT conversation

A user saying “connect this app to this conversation” has asked for an additional
host integration. The ordinary Tendriller MCP endpoint administers host/control
operations; application tools execute in the owned Chronolog session. The
optional [Cloudflare assistant](CLOUDFLARE_ASSISTANT.md) adds same-origin
OAuth-protected application tools, explicit MCP Events subscriptions and a
live inbox card. Use its route table and
`describe_application` to establish the connection's capabilities.

Claim, assistant permission review, and browser device enrollment are separate
states. A successful sign-in in the person's browser does not authenticate an
agent's independent browser. Keep that page at the owner sign-in handoff until
its own session is authenticated, then verify the displayed device public key.
Do not report a proposed review URL or an open socket alone as a completed
browser/MCP connection. Use the supported
[isolated local host](LOCAL_HOST.md) and synthetic owner for connected UX review
before production sign-in. Verify the actual production page with its own
authorized account separately, and state any remaining browser execution limit.

These routes do not provide or qualify a universal ChatGPT conversation wake
adapter. OAuth ownership alone does not subscribe a conversation. Establish
whether the actual agent host supports the selected route before promising
replies after its current turn/process ends. The
[resuming-agent cookbook](https://github.com/werg/tendriller-contrib/blob/main/cookbooks/connect-resuming-agent/COOKBOOK.md)
requires a real host admission/wake mechanism and probes across turn completion.
Its historical bridge links are not an active implementation to install.

Complete the authorized app provisioning and current live exchange first. If
conversation resumption remains unavailable, report that specific remaining
boundary, the still-working page/session functionality and a concrete supported
process handoff. Do not call a generic connected socket a verified chat handoff.

## Evidence in the final handoff

Lead with the live page and its current state. Include the facts the user needs
to return to the application:

| Item | Required evidence |
| --- | --- |
| Live application | Actual page URL, application identity, owner claim status and the workspace agent that maintains it |
| Selected code | Signed publication receipt and the visible release tested |
| Connected state | A browser command observed natively and a native command observed in the browser |
| Retained work | Same-device browser reload and native reopen, with the original work still present |
| Agent/process | What is running, where, its known lifetime, and the exact resume command |
| Reuse | Which supplied session, helper and capability modules the app uses |
| First visit and later visits | From a fresh phone-sized profile: the page connects by itself, showing only the connection state (no approval screen or other setup UI); a reload and a second tab connect with none |
| User experience | Before/after screenshots of every main flow on a phone-sized viewport and on desktop (below) |
| Remaining boundary | Concrete unverified or blocked behavior, including conversation wake if relevant |

## The user experience is part of the deliverable

Plumbing evidence (receipts, commands both ways, reload) does not show that the
app is usable. Before delivery, run a dedicated UX pass after the first working
version. The supported [local host](LOCAL_HOST.md) runs an exact sealed release
with its matching packages, synthetic owner and separate development identity.
Use the same application source and seed representative data through its real
commands. Production OAuth and owner sign-in do not block this connected UX
pass. Record the tested release/publication and distinguish that development
evidence from later production authorization and connectivity checks.

1. Walk every main user flow end to end in a real browser, from a fresh profile,
   at 1440×900 and 390×844. Take screenshots.
2. Judge each screen and fix friction before delivering: visual hierarchy and the
   one obvious next action, density, empty, loading and error states, long content
   (truncate or fold, never a wall of raw text), named links instead of raw URLs,
   URL-addressable state with a working back button, and keyboard use.
3. While disconnected, show one clear connection state
   ([the connection component](APP_PATTERNS.md#connect-the-browser)), not empty
   dashboards, stale-data warnings or raw error codes.
4. Design views that fit the data: conversations, timelines, diffs, tables with
   named links, inline editing with previews. A structured record editor (JSON or
   a form of fields) is a fallback, never the deliverable when the request is a
   "full-featured" or "rich" experience.
5. Report before/after screenshots and what changed.

### Run a separate second pass

After the implementation works, use this prompt as a new review task:

> Act as the person using this app for the first time. List their main goals and
> walk each one from arrival through its visible outcome on desktop and phone.
> Start with fresh browser profiles, then check later visits. For each flow,
> inspect hierarchy, density, the next action, keyboard focus, Back/deep links,
> long content, loading, empty data and recoverable errors. Compare the screen to
> the domain task, including named relationships and the most useful content
> first. Capture a before screenshot, fix the friction you find, repeat the flow,
> and capture the after screenshot. Verify that review, save, cancellation and
> undo have their stated effects and preserve uncertain operations. Report the
> evidence per flow and any checks still blocked. Do not declare completion
> from transport checks or a generic record editor.

Use a flow matrix in the handoff, with one row per main user goal and additional
rows for failure states that change the next action:

| Flow | Desktop and phone evidence | Required observations |
| --- | --- | --- |
| First visit / return | Fresh profiles, then reload and a second tab | One meaningful connection state, correct next action, retained work |
| Find / inspect | Search, filter, select, direct URL, reload, Back | Named links, useful detail first, preserved navigation and focus |
| Change / review | Edit, compare, save, cancel, undo if supported | Visible draft vs. saved result, error recovery, no duplicate uncertain command |
| Long / missing / unavailable data | Realistic long content, zero records, slow read, failed read | Readable density, folded context, useful empty states, honest progress and retry |
| Keyboard / narrow screen | Tab, Shift-Tab, Enter, visible focus; phone-width tap targets | Reachable controls, no trapped focus, no obscured controls or accidental horizontal scroll |

For each row record the actual viewport (for example 1440×900 and 390×844),
browser, tested page/publication, steps, outcome, before/after image links and
what changed. An unchanged flow may reference the same image with an explicit
“no change needed” finding; never invent a before screenshot. Screenshots are
review evidence, while the steps establish behavior. A phone-sized desktop
browser verifies responsive layout, not physical-device permissions or durability.
If a real browser is unavailable, state the exact remaining check
and complete the accessible flows without calling the whole app verified.

Supply editable source alongside this evidence when useful. Do not describe source
delivery as a deployed or connected application. The
[fresh-agent acceptance procedure](AGENT_ONBOARDING_TEST.md) scores the live result
and records whether the agent actually attempted provisioning.

## Verify consumers after a release or restart

Follow the [re-arm checklist](AGENT_RESTART.md) after republishing or replacing the
native participant. State which owner and consumer processes must remain alive,
and preserve their retained profiles, exact operations and handled cursors.
An attach client does not survive owner replacement automatically. For apps with
a request consumer, verify its recent check-in and request/receipt/answer flow
using its declared capabilities; report missing liveness/receipt support rather
than inventing commands. Other apps retain the ordinary domain command/read and
reload checks. `applied` and peer connectivity alone do not establish that an
agent read work. Use the [request lifecycle pattern](AGENT_REQUESTS.md) when a
new domain needs durable listener presence and addressed answers.
