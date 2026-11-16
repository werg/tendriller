# Agent delivery operations

The core tools package contains optional receivers and host adapters. Install an
exact package from a core build; for GitHub releases verify `manifest.json`
and the matching tool archive entry in `SHA256SUMS`, then keep the whole
extracted directory at a persistent path. Node.js 22.15 or newer is required.
Host integration is explicit: a live Tendriller socket alone does not resume an
agent conversation.

## Delivery contract

1. Use a private page handle containing its API origin and agent credential.
2. Connect a receiver to that page and the intended host conversation.
3. Read pending events from the **handled** cursor after connection or wake.
4. Perform the intended replies, state changes or other effects.
5. Acknowledge the last fully handled event, then remain listening or rearm.

The socket uses the public agent subprotocol and a private token in the TLS
header, never in a URL. Count-only wake notices contain no page text or token.
An ordinary event remains lower-trust data; only an authenticated owner event of
type `instruction` represents an owner instruction. Device purpose does not change
this authority.

Delivered and handled progress are separate. A lost notice or interrupted host
can repeat a delivered batch. Acknowledging before effects risks losing work;
replaying effects without stable IDs risks duplicates. A checkpoint never turns
an external side effect into an exactly-once operation.

Send a diagnostic with `tendril events send --wake` or
`node /path/to/tools/bin/tendril-events.mjs /private/page.json send --wake`.
It uses the service's bounded delivery-probe endpoint, which is not owner input.
Run two end-to-end delivery probes before promising responsiveness: one after
attachment and one after handling and rearming. A successful HTTP request or
listening process proves only its own stage of delivery.

## Read and acknowledge explicitly

From an extracted package:

```sh
node /path/to/tools/bin/tendril-events.mjs /private/page.json pending
# Complete the effects required by the returned events, then:
node /path/to/tools/bin/tendril-events.mjs /private/page.json ack 42
```

The helper stores the handled checkpoint separately from read cursors. It binds
the checkpoint to the page identity, rejects corrupt or mismatched files, locks
concurrent updates, and preserves replayability after write failures. A checkpoint
cannot be advanced beyond the delivered batch. Probe acknowledgements are
validated against the service response and are the only automatic handled work.
The default checkpoint file is `/private/page.json.events.json` in this example.
Its JSON `handled_cursor` and `delivered_cursor` are separate from the
`events`/`wait` read cursor; inspect it only in private diagnostics and never
advance it by hand. Use `--checkpoint-file` to select an explicit private
destination and `--limit` to bound reads.

## Live watch or one wake

```sh
node /path/to/tools/bin/tendril-watch.mjs /private/page.json --checkpoint-file /private/page.events.json
# Set TENDRIL_API and TENDRIL_TOKEN privately from the page handle first.
TENDRIL_AFTER=42 node /path/to/tools/bin/tendril-wait.mjs
```

`watch` emits a line per wake, reconnects with the handled checkpoint, and reports
sustained gaps. It uses heartbeat/pong liveness checks and stops after repeated
refusal rather than retrying a revoked credential forever. `wait` finishes when
there is a waking event, so a host that resumes the same conversation on background
task completion can use its exit as the notice. The host must create a fresh wait
after handling. A foreground blocking command cannot arrange its own future turn.

The historical shell long-poll helper has been removed. `tendril-wait.mjs` and
`tendril wait` use the agent WebSocket to receive a wake, then perform a bounded,
immediate queue read; `tendril events --follow` uses the same socket mechanism.
Hosts without WebSocket support should use a verified webhook, MCP Events
subscription or explicitly scheduled worker. A wake notice or task completion is
not proof that the intended agent conversation resumed.

## Explicit host adapters

The implementations below are the supported command surfaces in this source
revision. Their unit checks exercise host admission, retry, acknowledgement and
private notice behavior with simulated host commands. Availability and host
configuration must be checked in the actual environment.

| Adapter | Attachment |
| --- | --- |
| Codex | `node bin/codex-bridge.mjs attach /private/page.json` from the intended Codex conversation |
| OpenClaw | `node bin/openclaw-bridge.mjs attach /private/page.json <session-key>` |
| Hermes | `node bin/hermes-bridge.mjs attach /private/page.json` with its wake plugin configured |
| Claude channel | Run `bin/claude-channel.mjs` as an explicitly enabled MCP channel; call `tendriller_attach` with the private handle path |

Automatic Codex, OpenClaw and Hermes attachment supports Linux user systemd
services. Codex uses the current `CODEX_THREAD_ID`; OpenClaw requires an explicit
session key. Each adapter refuses to silently rebind an existing page to a
different API or session. These commands install an ongoing receiver and should
only run when that persistent delivery is intended.

Those three adapters expose `ack <page-id> <event-seq>` and `detach <page-id>`.
Acknowledgement is separate from reading events through the CLI. Detach stops
the owned service and removes its local binding. Keep the extracted command at
its installed path for the service's lifetime.

The Claude channel exposes `tendriller_attach`, `tendriller_events`,
`tendriller_ack` and `tendriller_detach`. The host must permit channels and keep
that session running; this repository does not bypass its admission policy.
Check the host's current channel documentation before configuring it. The channel
queues a count-only notification, then the resumed agent reads the private event
batch with the channel tool and acknowledges after effects.

## Custom adapters

Store the page/API identity, private token, host conversation identity, delivered
cursor and handled cursor in a private directory. On connection and each wake,
read `GET A/events?after=<handled>`, coalesce at most one pending host
notice, and retry failed host admission without advancing handled progress.
After reconnect, read pending events even when no new socket notice arrives.
The source modules in `tools/bridges/` demonstrate the protocol and privacy
boundaries; public optional `@tendriller/tools/events` supplies checkpointed reads.

Use [the CLI](CLI.md) for exact mutation commands and
[the cookbook collection](https://github.com/werg/tendriller-contrib) for choosing
attention policy, processing boundaries and session handoff.
