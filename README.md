# Tendriller

Tendriller gives any agent session a URL. Whoever opens that URL gets a live web page
that the agent writes, controls and inspects. The page feeds the device's taps, voice,
camera, GPS and other sensors back into the agent's session. Each such page is a
**tendril**.

- The **server** is a Cloudflare Worker with one Durable Object per tendril, plus R2. It
  serves the agent's HTML directly, queues events, keeps versions and state, and wakes
  the agent.
- The **runtime**, `tendril.js`, is injected into every page. It provides `window.tendril`,
  the WebSocket, script execution and health reporting, plus an always-present control
  for push-to-talk, status and undo.
- **Agents** need only `curl`. They read [`agent.md`](agent.md), which the server serves at
  `/agent.md`.

The design is in [PLAN.md](PLAN.md). The binding interface contract is in
[docs/PROTOCOL.md](docs/PROTOCOL.md).

## Quick start (local)

```sh
npm install
npm run dev                       # builds runtime/snippets/agent.md, then wrangler dev on :8787

# in another shell: create a tendril
curl -sS -X POST http://localhost:8787/api/tendrils \
  -H 'Content-Type: application/json' -d '{"name":"Hello"}'
# → {"id":"…","page_url":"http://localhost:8787/t/<id>/s/<key>/","api":"http://localhost:8787/api/t/<id>","token":"tk_…",…}

export TENDRIL_API=<api> TENDRIL_TOKEN=<token>
curl -sS -X PUT "$TENDRIL_API/files/index.html" -H "Authorization: Bearer $TENDRIL_TOKEN" \
  -H 'Content-Type: text/html' --data-binary '<button onclick="tendril.send({hi:1})">Hi</button>'
# open page_url in a browser, tap the button, then:
curl -sS "$TENDRIL_API/events?after=0" -H "Authorization: Bearer $TENDRIL_TOKEN"
```

To use it from an agent, point the agent at `http://localhost:8787/agent.md`. Phones
need HTTPS for sensors, so for real devices deploy the server or use a tunnel.

The optional CLI wraps the same API: `node cli/bin/tendril.mjs new Hello` (see
[cli/README.md](cli/README.md)).

## Deploy to Cloudflare

```sh
npx wrangler login
npx wrangler r2 bucket create tendriller-files
# set PUBLIC_BASE (and optionally PAGE_HOST_MODE / PAGE_BASE_DOMAIN) in server/wrangler.jsonc vars
npm run build && npx wrangler deploy --config server/wrangler.jsonc
```

Secrets (`npx wrangler secret put <NAME> --config server/wrangler.jsonc`):

| Secret | Purpose |
|---|---|
| `CREATE_KEY` | If set, `POST /api/tendrils` requires `Authorization: Bearer <CREATE_KEY>`. Set it on any public deployment. |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Web push notifications. Generate the keys with `node scripts/vapid-keys.mjs`. The subject is e.g. `mailto:you@example.com`. |
| `OPENAI_API_KEY`, `VOICE_PROVIDER`, `VOICE_MODEL` | The fast voice layer. `VOICE_PROVIDER=openai-realtime` is the default when an OpenAI key is present. `VOICE_MODEL` is optional. |

Optional bindings and modes:

- **Server-side transcription.** Add a Workers AI binding, `"ai": {"binding": "AI"}`, in
  `server/wrangler.jsonc`. Pages can then POST audio to `_tendril/transcribe`.
- **Subdomain mode** gives each tendril its own origin, so tendrils cannot read each
  other's storage. Set `PAGE_HOST_MODE=subdomain` and
  `PAGE_BASE_DOMAIN=tendril.example.com`, and add a wildcard route
  (`*.tendril.example.com/*`) with a matching wildcard certificate (a proxied wildcard
  DNS record on a zone you control). The server accepts both URL shapes on every
  deployment.

## Repository layout

```
server/        Worker + Durable Object (src/), tests (test/), wrangler.jsonc; public/ is build output
runtime/       tendril.js (core, control, voice, push, rules, offline) and the service worker
snippets/      copyable page pieces (camera, probe, ptt, screenshot, glance, vad, wakeword, pose, objects, …)
agent.md       instructions served to agents at /agent.md
cli/           optional zero-dependency CLI, wait-loop and listener scripts
scripts/       build.mjs (bundles runtime, copies snippets and agent.md), vapid-keys.mjs
test/e2e/      end-to-end Playwright tests
docs/          PROTOCOL.md
```

## Testing

```sh
npm test                    # build + server tests (vitest with the Workers pool)
npm run test:e2e            # build + end-to-end Playwright suite (test/e2e)
npm run typecheck
npx playwright test --config runtime/test/playwright.config.ts          # runtime core
npx playwright test --config runtime/test/control/playwright.config.ts  # control
npx playwright test --config runtime/test/voice/playwright.config.ts    # voice layer
npx playwright test --config runtime/test/push/playwright.config.ts     # push and rules
npx playwright test --config snippets/test/playwright.config.ts         # snippets
node --test cli/test/*.test.mjs                                         # CLI and wait script
```

Playwright needs browsers once: `npx playwright install chromium`.
