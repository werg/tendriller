# Optional operational tools

These tools support the Tendriller public contract. They are separate from the
Worker and browser runtime and impose no page layout or application schema.

| Command | Responsibility |
| --- | --- |
| `tendril` | Authenticated API requests, exact authored-file publication and health |
| `tendril-preview` | Production runtime with explicit local service fixtures |
| `tendril-events`, `tendril-wait`, `tendril-watch` | Immediate pending reads, durable handled checkpoints and WebSocket live delivery |
| `tendril-stream` | Bounded durable collector spools and explicit backpressure/loss |
| `codex-bridge`, `claude-channel`, `hermes-bridge`, `openclaw-bridge` | Explicit host-specific delivery adapters |

Run a command with `--help` for its operational arguments. A private page handle
contains an agent token; keep it out of source control and screenshots.

## Development

From the core repository, first build the public SDK/runtime, then install this
package's local artifact dependencies and run its checks:

```sh
npm run build
npm --prefix tools ci
node scripts/build-tools.mjs
npm --prefix tools test
```

The emitted `tendriller-tools-<version>.tgz` contains bundled commands and public
optional libraries, including `@tendriller/tools/preview`. A published release contains `manifest.json` and `SHA256SUMS`; the separate
`dist/tools-manifest.json` describes the local build only. The published
manifest records the target runtime and source revision. The preview library and CLI are
separate so ordinary publishing does not bundle browser models or fixture code.
Browser checks additionally require Playwright and the Chromium revision it
expects. For an external Playwright installation, the packaged preview accepts
`--playwright-path /path/to/node_modules/playwright`.

## Source and terms

The operational implementation and behavioral cases were extracted from
[`werg/tendriller-contrib` at `6554970c5b1dbf8a7cfb2ffcc22eeb437eede6ce`](https://github.com/werg/tendriller-contrib/tree/6554970c5b1dbf8a7cfb2ffcc22eeb437eede6ce/tools).
Core now owns these mechanisms. Existing project terms are unchanged; no new
license is granted by this move. Bundled third-party notices accompany artifacts.

Decision guides live in [the cookbook collection](https://github.com/werg/tendriller-contrib).
See the [CLI](../docs/tools/CLI.md), [preview](../docs/tools/PREVIEW.md),
[host](../docs/tools/AGENT_HOSTS.md), and [collector](../docs/tools/COLLECTOR.md) references.
