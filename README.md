# Tendriller

Tendriller hosts authenticated pages for an agent and a selected application backend. A resident peer deployment keeps its durable application history and ordinary peer exchange in Chronolog over WebRTC. Tendriller supplies page assets, account access, participant administration, publication recovery and optional short-lived SDP rendezvous. Peer pages run without a background host socket or application-data relay. A separate Cloudflare JSON state/event backend remains available for generic hosted pages. The page owns its interface, application data and ordinary web dependencies.

Start with authored HTML, JavaScript and assets. There is no starter, component registry, required application schema or automatic dependency download. [Cookbooks](https://github.com/werg/tendriller-contrib) explain choices and failure cases that help an agent adapt an implementation to a task.

## Start here

- [Agent guide](agent.md): create a page, establish delivery and publish complete files.
- [Browser API](docs/BROWSER_API.md): transport, conversation, coherent state snapshots, conditional writes, durable timers, streams, captures and explicit device features.
- [Protocol](docs/PROTOCOL.md): identity, authorization, commands, transactions and publication guarantees.
- [Application backends](docs/APPLICATION_BACKENDS.md): one selected history, atomic programs, operation status and coherent event/query views.
- [Live application signals](docs/APPLICATION_SIGNALS.md): independent send/subscribe, FIFO or latest delivery, expiration and durable completion.
- [Peer architecture](docs/PEER_ARCHITECTURE.md): quiet hosting, reachable resident introductions, Worker ownership and authenticated WebRTC exchange.
- [Peer connections](docs/PEER_CONNECTIONS.md): bounded SDP rendezvous, optional endpoint hints and explicit transport configuration.
- [Membership](docs/MEMBERSHIP.md): the default portable administrator, account-bound device enrollment, certified bootstrap and native authority separation.
- [Retained record logs](docs/RECORD_LOG.md): exact bytes, retry-safe identity, bounded catch-up and peer adapters.
- [Operational tools](docs/tools/CLI.md): optional core-owned publishing, preview, collectors and host bridges.
- [Architecture](docs/ARCHITECTURE.md): ownership and public artifact boundaries.
- [Cookbooks](https://github.com/werg/tendriller-contrib): adaptable decision guides and reviewed reference implementations.

The hosted runtime adds a small operational link and a stop action while tracked sensors are active. Conversation, recording, voice, sharing and application navigation are page choices. A separate service-owned recovery page works even if the authored JavaScript is broken. The pure kernel export mounts no interface; voice is an explicit optional module.

## Build and verify

Use Node 22.15 or newer:

```sh
npm ci
npm run check
npx playwright install --with-deps chromium
npm run test:browser
```

`npm run build` emits the generic Worker and the public SDK, runtime and engine archives. `npm run build:tools` builds the optional operational archive against those public artifacts. `npm run build:artifacts` builds all four. `npm run check:release` runs the full core, tool and browser gates before release publication.

The generic engine has an empty trusted-extension registry. A deployment may deliberately select reviewed modules through `configureWorkflows`. Reading a cookbook or publishing page files never installs server code. Core builds independently of contrib; cookbook checks consume built public artifacts in one direction.

`npm run dev` runs the generic engine locally. [Development](docs/DEVELOPMENT.md) explains validation, and [operations](docs/OPERATIONS.md) describes fresh deployment provisioning. The optional preview runs from its self-contained core archive and serves exactly the authored files.

## Repository layout

| Directory | Responsibility |
| --- | --- |
| `contract/` | Executable schemas, SDK, browser declarations, trusted-host types and resource limits |
| `server/` | Identity, authorization, transactions, private records, delivery, serving and lifecycle |
| `runtime/` | Separate quiet peer and hosted browser runtimes, selected application backend, sensor tracking and optional voice |
| `preview-support/` | Public runtime and preview boundaries |
| `tools/` | Optional CLI, exact-file preview, host bridges and bounded collectors |
| `scripts/` | Build, artifact checks, release publication and service operations |
| `docs/` | Protocol, design, testing and operations |

This is one unreleased target baseline. Development state is recreated from its fresh schemas. Source history and provenance remain evidence; they are not supported runtime dependencies. No new license is inferred for extracted project code; third-party notices accompany distributed artifacts.
