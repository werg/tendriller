# Tendriller

<p align="center">
  <img src="docs/assets/tendriller-logo-ai-compressed.png" alt="Tendriller: a smiling vintage robot drill with vacuum tubes and curling green circuit tendrils" width="640">
</p>

Tendriller gives any agent session a URL. Whoever opens that URL gets a live web page
that the agent writes, controls and inspects. The page feeds the device's taps, voice,
camera, GPS and other sensors back into the agent's session. Each such page is a
**tendril**.

- The **server** is a Cloudflare Worker with one Durable Object per tendril, plus R2. It
  serves the agent's HTML directly, queues events, and sends wakes through configured
  host adapters.
- The **runtime**, `tendril.js`, is injected into every page. It provides `window.tendril`,
  the WebSocket, script execution and health reporting, plus an always-present control
  for push-to-talk, status and undo.
- **Agents** can create and control a page with HTTP. Live replies require a verified
  path that wakes their particular conversation. [`agent.md`](agent.md) explains the
  setup; Codex on Linux has a first-party same-conversation bridge.

The design is in [PLAN.md](PLAN.md). The binding interface contract is in
[docs/PROTOCOL.md](docs/PROTOCOL.md).

## Get started

For the public beta, give your agent `https://tendriller.dev/agent.md` and your verified
GitHub or Google email address. The agent creates a page, attaches a working event
receiver for its host, publishes it, and gives you the page URL. A page is not live
merely because it has an agent token or an event poll happened once.

For local development, run `npm ci` and `npm run dev`. Use the local browser suite with
`npm run test:e2e`; it starts an isolated HTTPS Worker and temporary accounts. See
[docs/E2E_TESTING.md](docs/E2E_TESTING.md). The optional API CLI is in
[cli/README.md](cli/README.md).

Each tendril also exposes an MCP server at `<api>/mcp`, with an MCP Event for hosts
that support subscriptions. Connecting MCP tools alone does not establish a wake path.

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
scripts/       build.mjs (bundles runtime, copies snippets and agent.md), vapid-keys.mjs
test/e2e/      end-to-end Playwright tests
docs/          PROTOCOL.md
```

## Testing

```sh
npm test                    # build + server tests (vitest with the Workers pool)
npm run test:e2e            # build + end-to-end Playwright suite (test/e2e)
npm run typecheck
npm run test:tts             # neural speech, fallback, cancellation, and device preference tests
npx playwright test --config runtime/test/playwright.config.ts          # runtime core
npx playwright test --config runtime/test/control/playwright.config.ts  # control
npx playwright test --config runtime/test/voice/playwright.config.ts    # voice layer
npx playwright test --config runtime/test/push/playwright.config.ts     # push and rules
npx playwright test --config snippets/test/playwright.config.ts         # snippets
node --test cli/test/*.test.mjs                                         # CLI, bridge, and wait script
```

Playwright needs browsers once: `npx playwright install chromium`.
