# Tendriller

<p align="center">
  <img src="docs/assets/tendriller-logo-ai-compressed.png" alt="Tendriller: a smiling vintage robot drill with vacuum tubes and curling green circuit tendrils" width="640">
</p>

Tendriller gives any agent session a URL. Whoever opens that URL gets a live web page
that the agent writes, controls and inspects. The page feeds the device's taps, voice,
camera, GPS and other sensors back into the agent's session. Each such page is a
**tendril**.

The name combines **tendrils** and a **drill**: the agent extends into other
interfaces and sensors, and Tendriller makes the opening for each connection.

- The **server** is a Cloudflare Worker with one Durable Object per tendril, plus R2. It
  serves the agent's HTML directly, queues events, and sends wakes through hibernating
  agent WebSockets, webhooks, or MCP Events.
- The **runtime**, `tendril.js`, is injected into every page. It provides `window.tendril`,
  the WebSocket, script execution and health reporting, plus an always-present control
  for push-to-talk, status and undo.
- **Agents** can create and control a page with HTTP. Live replies require a verified
  path that wakes their particular conversation. [`agent.md`](agent.md) explains the
  setup; Codex on Linux has a verified same-conversation WebSocket bridge. Claude Code has a
  first-party channel adapter tested in a live Claude Code session against a local API.
  OpenClaw and Hermes have Linux bridges awaiting real host tests. The guide also covers
  Muse, Grok Bot, OpenAI dots and Claude Duet, with their respective setup and limits.

The design is in [PLAN.md](PLAN.md). The binding interface contract is in
[docs/PROTOCOL.md](docs/PROTOCOL.md), with executable schemas and public types in
[contract/](contract/).

## Get started

For the public beta, give your agent `https://tendriller.dev/agent.md` and your verified
GitHub or Google email address. The agent creates a page, attaches a working event
receiver for its host, publishes it, and gives you the page URL. A page is not live
merely because it has an agent token or an event poll happened once.

For local development, use Node 22.15+, run `npm ci` and `npm run dev` (with continuous runtime/asset rebuilding). Try a page locally with `npm run preview -- recipes/field-notebook`. See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for the typed contract, actual-runtime previews and shipping gates. Use the local browser suite with
`npm run test:e2e`; it starts an isolated HTTPS Worker and temporary accounts. See
[docs/E2E_TESTING.md](docs/E2E_TESTING.md). The optional API CLI is in
[cli/README.md](cli/README.md).

Each tendril also exposes an MCP server at `<api>/mcp`, with an MCP Event for hosts
that support subscriptions. Connecting MCP tools alone does not establish a wake path.

## Build a complete experience

The [recipe catalog](recipes/README.md) includes six complete workflows with
runnable pages, event contracts, local scenarios, and instructions for the agent:

| Starting point | What it enables |
|---|---|
| Approval remote | Review an exact proposal, approve or request revision, and track its result |
| Field notebook | Durable notes/photos/places, editable interpretation, search and export |
| Hands-free guide | Spoken steps, local next/back/repeat, evidence and saved checkpoints |
| Multi-device workshop | Camera/controller/display/speaker purposes, annotations and completion receipts |
| Hardware experiment | Serial or labelled simulated traces, intervention notes and interpreted reports |
| Facilitated session | Private participant answers, facilitator review and deliberate shared summaries |

Server timers run with the page closed. Saved session briefs let a later agent
continue the task, and portable bundles/remixes create independent copies with
optional data and media. Device purpose is separate from access permission, and
one device speaks at a time. See [Experiences](docs/EXPERIENCES.md) for the APIs,
recovery behavior, lifetime bounds, and owner controls.

## Deploy to Cloudflare

Follow [docs/OPERATIONS.md](docs/OPERATIONS.md) for the two domains, OAuth providers,
isolated staging and production resources, secrets, migrations, and deployment steps.

## Repository layout

```
server/        Worker + Durable Object (src/), tests (test/), wrangler.jsonc; public/ is build output
runtime/       tendril.js (core, control, voice, push, rules, offline) and the service worker
snippets/      copyable page pieces (camera, probe, ptt, screenshot, glance, vad, wakeword, pose, objects, …)
agent.md       instructions served to agents at /agent.md
cli/           optional zero-dependency API CLI and Codex conversation bridge
contract/      executable public schemas, declarations and small typed fetch client
recipes/       complete workflows, starter inputs, event contracts and agent loops
scripts/       build.mjs (bundles runtime, copies snippets and agent.md), vapid-keys.mjs
test/e2e/      end-to-end Playwright tests
docs/          PROTOCOL.md
```

## Testing

```sh
npm run check               # schemas + types + build + contract/recipe/unit/Worker/CLI tests
npm run test:browser        # current runtime, control, speech, snippets, recipes and Worker browser flows
npm run check:release       # both gates; the same checks precede CI deployment
npm test                    # focused build + supported public Worker tests
npm run test:e2e            # focused current public Worker/browser flow
npm run test:e2e:speech-real # optional real speech-engine/model download test
```

Playwright needs browsers once: `npx playwright install chromium`.
Old anonymous-service and retired voice-layer suites are historical references;
see [Development](docs/DEVELOPMENT.md) for the explicit supported suite list.
