# Deployment & Hosting Decision Guide

Choose the lightest hosting tier that matches your application's availability requirement. Every tier executes the exact same Chronolog application contract and operation IDs.

| Tier | When to choose it | Installs | State location | Inbound ports | Post-exit availability |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **1. Agent's existing cloud computer** | Persistent cloud VM with durable project disk (e.g., Grok `/workspace`, Muse VM) | Starter + `@tendriller/core` + `@chronolog/peer-session` | Project `.tendriller/` | None (outbound only) | Lives while VM process runs; nondestructive reinstall if `node_modules` is wiped |
| **2. Bounded local + checkpoint** | Turn-scoped sandboxes (e.g., Instinct, Codex Cloud) with no daemon persistence | Minimal relay-only bundle (`events-relay-only` or `sql-portable-relay-only`) | Project dir or AES-256-GCM checkpoint | None | **Unavailable after exit** until reopened or handed off |
| **3. Browser participant / coordinator or Remote `/mcp`** | Interactive browser apps or zero-install assistant calls to an existing participant | Static page bundle (0 MB local for `/mcp`) | Browser OPFS / IndexedDB (with `navigator.storage.persist()`) | None | Browser tab unavailable when closed/suspended; `/mcp` follows remote participant |
| **4. Standalone Node process** *(default external host)* | Simplest always-on remote participant without containers or systemd | Node 22.15+ + project packages | Local `.tendriller/` directory | None (outbound relay/WebRTC) | Runs while process is up; clean `SIGTERM` flush |
| **5. Container (OCI / Docker)** | Reproducible cloud deployment (`deploy/Dockerfile`) | Non-root `node:22-alpine` image | Mounted volume `/data/.tendriller` | None (outbound) | Managed by orchestrator; flushes cleanly on `SIGTERM` |
| **6. OS Service** | Dedicated Linux/macOS/Windows machine (`deploy/tendriller.service`, `launchd`, Windows Service) | Node 22.15+ + OS unit | Service-owned private state dir | None (outbound) | Starts on boot; restarts cleanly on crash |
| **7. Request-Driven / Serverless (`ServerlessHostAdapter`)** | Stateless Worker / Durable Object / KV runtimes (`@tendriller/core/serverless`) | Bundled ESM Worker + transactional storage | Transactional KV / Durable Object storage | Standard HTTPS 443 | Available on demand per HTTPS request; zero idle sockets |

## Continuity & migration between tiers

- **Before initialization (source only):** `tendril handoff source handoff.tgz` — packs non-secret source files with zero keys or device state.
- **Move an initialized device:** `tendril checkpoint export state.clcp --device .tendriller/device.sqlite` (encrypts with AES-256-GCM and retires the source store to prevent split-brain), then `tendril checkpoint restore state.clcp --device .tendriller/device.sqlite` on the destination.
- **Add another active device:** use browser pairing or `npm run enroll -- <publicKey>` so each device keeps its own signing key.

## Templates

- Non-root container: [deploy/Dockerfile](../deploy/Dockerfile)
- Linux `systemd` unit: [deploy/tendriller.service](../deploy/tendriller.service)
- macOS `launchd` plist: [deploy/dev.tendriller.participant.plist](../deploy/dev.tendriller.participant.plist)
- Windows Service script: [deploy/install-windows-service.ps1](../deploy/install-windows-service.ps1)
- Serverless request adapter: `@tendriller/core/serverless` (`createServerlessHostAdapter`, `createTransactionalBytesStore`)
