# Tendriller

Tendriller hosts authenticated pages and participates in Chronolog through a filtered control transport. Each application uses one owned Chronolog session for commands, queries, applied views, operation state, live signals, replication and recovery. The host handles account access, signed membership and generation control, signed page-code publications, discovery and bounded connection introductions.

A page has one stable application identity, `{id}`, independent of its URL and the devices that join it. Native agents and browser Workers use the same application contract. The host's role and transport decide which protocol updates it receives; ordinary application commands, database history, content replication and live UI signals stay between peers.

Author HTML, JavaScript and assets for the task. The page owns its layout, application policy and ordinary web dependencies. A small runtime utility provides a management link and a stop action for tracked sensors. The headless kernel mounts no interface; voice is an explicit optional module.

## Start here

- [Agent guide](agent.md): create and claim a page, connect its session and publish signed code.
- [Application contract](docs/APPLICATION_BACKENDS.md): commands, applied operations, coherent reads and explicit recovery.
- [Browser API](docs/BROWSER_API.md): session installation, signals, host access, sensors and offline code.
- [Participant protocol](docs/PROTOCOL.md): role filters, authorization and signed publication atomicity.
- [Membership](docs/MEMBERSHIP.md): account access, independent device rights and control changes.
- [Peer connections](docs/PEER_CONNECTIONS.md): discovery, invitations and bounded SDP rendezvous.
- [Architecture](docs/ARCHITECTURE.md): ownership and public artifact boundaries.
- [CLI and preview](docs/tools/CLI.md): explicit public-session tools and authored-file preview.
- [Cookbooks](https://github.com/werg/tendriller-contrib): reasoning, application examples and independent qualification.

## Build and verify

Use Node 22.15 or newer:

```sh
npm ci
npm run check
npx playwright install --with-deps chromium
npm run test:browser
```

`npm run build` emits the SDK, runtime and engine archives. `npm run build:tools` builds the separate tools archive against those public artifacts. `npm run check:release` runs the core, tools and browser gates. Each artifact records its exact source and hashes; independent consumers use clean checkpoints.

`npm run dev` runs the local host. [Development](docs/DEVELOPMENT.md) describes verification; [operations](docs/OPERATIONS.md) describes fresh deployment provisioning. Deployments require separate authorization.

| Directory | Responsibility |
| --- | --- |
| `contract/` | Host SDK, participant transport, application binding, signals and browser declarations |
| `server/` | Accounts, filtered control participant, signed code storage, introductions and lifecycle |
| `runtime/` | Browser composition, immutable code cache, sensor tracking and optional voice |
| `preview-support/` | Public kernel and voice declarations |
| `tools/` | Session CLI, authored-file packing and explicit browser preview |
| `scripts/` | Builds, artifact checks, release publication and service operations |
| `docs/` | Current protocol, design, testing and operations |

This is one pre-release target. Development storage is recreated from its fresh schema. There are no compatibility readers, alternate application stacks or data migrations. Existing notices and source attribution remain; this refactor grants no new license.
