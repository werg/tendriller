# Tendriller

Tendriller is an application-neutral engine for pages connected to an agent. The core provides authenticated pages, browser transport, shared state, events, blobs, streams, durable delivery, timers and publication lifecycle.

**Contract 2 is a pre-release redesign.** New clients use explicit commands and authoritative scope generations. Application JSON is opaque. Existing prototypes must be rebuilt for this contract.

## Start here

Read [agent.md](agent.md) for the generic service flow and [the protocol](docs/PROTOCOL.md) for guarantees. Optional CLI, collectors, host bridges, preview, browser components, workflows and examples live in [werg/tendriller-contrib](https://github.com/werg/tendriller-contrib).

- [Contrib release downloads](https://github.com/werg/tendriller-contrib/releases)
- [Machine-readable catalog discovery](https://github.com/werg/tendriller-contrib/releases/latest/download/catalog.json)
- [Core SDK/runtime releases](https://github.com/werg/tendriller/releases)
- [Architecture and ownership](docs/ARCHITECTURE.md)

Use discovery to choose a release, then lock exact URLs and SHA-256 digests. Optional components are vendored into a page publication, including lazy siblings, styles and workers.

## Build and verify

```sh
npm ci
npm run check
npm run build:service
npm run test:browser
```

`npm run build:engine` builds independently of contrib. `npm run build:artifacts` produces the public `@tendriller/core` and `@tendriller/runtime` archives. `npm run build:service` verifies and compiles the trusted module artifact selected in `composition.lock.json`. Core deployment does not install contrib tooling.

`npm run dev` runs the generic engine locally. [Development](docs/DEVELOPMENT.md) explains tests and [operations](docs/OPERATIONS.md) covers Cloudflare deployment. First-party preview belongs to contrib and runs from its distributed archive without a core checkout.

## Repository layout

| Directory | Responsibility |
| --- | --- |
| `contract/` | Generic executable schemas, SDK, browser declarations, trusted host types and resource policy |
| `server/` | Engine, identity and permission checks, atomic storage, delivery, serving and lifecycle |
| `runtime/` | Browser transport, durable outbox, state/streams, conversation and required controls |
| `preview-support/` | Declarations for released pure production algorithms |
| `composition/` | Trusted deployment selection and artifact lock |
| `scripts/` | Core build, independent consumer checks, artifact publication and operations |
| `docs/` | Generic protocol, architecture, resource guarantees and operations |

The detailed contract, artifact graph and transaction rules are documented in [the architecture decision](docs/ARCHITECTURE.md). Contrib preserves source provenance from the extraction; neither repository assumes a new project license.
